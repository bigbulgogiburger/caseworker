# `loop` — 안전 가드 (local-only · code-only)

> **이 문서는 `loop` 의 안전 계약이다.** `references/design.md` §8(local-only / code-only)과 정수 #5
> ("stay the engineer")를 절차로 구체화한다.
> init/score/run/드라이버의 모든 모드가 fix·probe 를 실행하기 **직전**에 이 가드를 통과시켜야 한다.
> 위반은 "경고" 가 아니라 **abort + surface**(즉시 정지하고 사람에게 보고)다. 자동 우회는 없다.

핵심 한 줄: **루프는 자기 워킹트리의 local 범위 안에서만 코드를 만지고, 머지·배포·원격쓰기·자격증명·외부
cutover 직전에 멈춰 사람에게 넘긴다.**

---

## 0. 두 결정 (절대 불변)

| 결정 | 내용 | 이 문서가 강제하는 것 |
|------|------|----------------------|
| **local-only** | probe·fix 는 **local 범위만**. 운영/원격 write · 외부 cutover · 자격증명 · force push · 원격 마이그레이션 금지 | `safety.forbid` 매칭 → abort. DB probe read-only. 마이그레이션 local 적용만 |
| **code-only** | 코드 프로젝트 전용. `probe.kind` 는 코드 신호(db/http/test/shell/grep)만 | 글쓰기·리서치 루프·비-코드 probe kind 거부 |

그리고 여기서 파생되는 **auto_merge 불변**:

> **`safety.auto_merge: false` 는 설정값이 아니라 불변식이다.** `.loop/loop.json` 에서 `true` 로 바꾸면
> 스키마(`schemas/loop.schema.json` 의 `enum: [false]`)와 `loop.mjs` 의 `checkConfig` 가 **설정 자체를 거부**한다
> — `check`·`init`·`record` 가 exit 2 로 죽는다. 루프는 언제나 브랜치 핸드오프로 끝난다.

---

## 1. 가드 적용 시점

```
init  : loop.json 생성 시 — probe.kind allowlist · forbid 기본값 · auto_merge:false · caps 검산
score : probe 실행 전 — 각 dimension.probe.kind/cmd 를 §2·§3 으로 검증
run 1 : maker 위임 전 + verify(probe) 전 + 정지·핸드오프 시 §4
무인   : 매 라운드 fix·verify·rescore 호출 전 + 종료 return 전 §4
```

원칙: **가드는 실행 직전의 마지막 관문이다.** maker/verifier 프롬프트에 forbid 목록을 그대로 주입하되
(자기검열), 가드는 그것을 **신뢰하지 않고** 커맨드 문자열을 다시 매칭한다(이중 방어). 레인이 forbid 를
어기면 그 결과를 PASS 로 세지 않고 abort 한다.

---

## 2. `probe.kind` allowlist — 코드 신호만

`loop.json` 의 모든 `dimensions[].probe.kind` 는 아래 5종 중 하나여야 한다(스키마 `enum` 강제).

| kind | 의미 | 안전 제약 |
|------|------|-----------|
| `db` | DB 질의로 실데이터 신호(SUM·COUNT·제약 검증) | **read-only only** — §3.1. write/DDL 금지 |
| `http` | 기동된 앱에 요청해 상태코드·실데이터·권한(403) 관찰 | **local 호스트만** — §3.2. 외부 outbound 금지 |
| `test` | 테스트 스위트 실행 결과 | local. 데몬·플래그 주의(`env.test`) |
| `shell` | 빌드·린트·스크립트 종료코드 | **forbid 매칭 후** 실행 — §3.3 |
| `grep` | 코드 신호 정적 검색(보조) | 부작용 없음. ⚠ grep "0건" 을 단독 PASS 로 세지 말 것 |

> **비-코드 kind 거부**: 사람손 QA, 외부 설문, "문서 읽고 판단" 같은 비결정적 신호는 probe 가 아니다.
> init 인터뷰에서 코드 신호로 재정의하도록 되돌린다.

---

## 3. local-only 세칙

### 3.1 `db` — read-only 불변

- **허용**: `SELECT` · `SHOW` · `EXPLAIN` · `DESCRIBE`, read-only 트랜잭션.
- **금지(매칭 즉시 abort)**: `INSERT`/`UPDATE`/`DELETE`/`REPLACE`/`MERGE`/`TRUNCATE`/`DROP`/`ALTER`/`CREATE`/
  `GRANT`/`LOAD DATA` 및 모든 DDL·DML write.
- **원격 금지**: 접속 대상이 local/dev 가 아니면(운영 DB·원격 write 엔드포인트) abort. `env.db` 에 명시된
  local 호스트만.
- **계정**: 가능하면 쓰기 권한 없는 계정을 쓰도록 init 인터뷰에서 권한다 — 사고 시 물리적으로 막힌다.

```jsonc
// 좋음 — read-only 실데이터 신호(보존법칙·orphan 검출)
{ "kind": "db", "cmd": "mysql -h 127.0.0.1 -e 'SELECT SUM(qty) FROM stock'", "expect": "SUM 불변" }

// 금지 — abort
{ "kind": "db", "cmd": "... -e 'UPDATE stock SET qty=0'" }      // ✗ DML write
{ "kind": "db", "cmd": "... -e 'TRUNCATE audit_log'" }          // ✗ 파괴
```

### 3.2 `http` — local 호스트만

- **허용**: `env.start` 로 띄운 local 앱(`http://localhost:8080`, `127.0.0.1`)에 대한 요청. 권한 probe 는
  비-권한 토큰(`env.auth`)으로 403/스코프를 관찰한다.
- **금지**: 외부 도메인 outbound(운영 도메인·서드파티 API·결제/배송/알림 outbound). 외부 cutover 는 §3.5.
- **부작용 주의**: probe 가 mutation 엔드포인트를 호출해 **local DB 를 바꾸는 것**은 local 범위라 허용되지만,
  멱등하지 않으면 다음 probe 를 오염시켜 신호가 거짓이 된다. 가능하면 read 경로로 신호를 잡고, mutation
  probe 는 cleanup 까지 포함하거나 일회성으로 표시한다.

```jsonc
// 좋음 — local 200 + 실데이터 / 비-권한 403
{ "kind": "http", "cmd": "curl -s localhost:8080/orders -H \"Authorization: Bearer $VIEWER\"", "expect": "200 + 목록 비어있지 않음" }
{ "kind": "http", "cmd": "curl -s -o /dev/null -w '%{http_code}' localhost:8080/orders/999 -H \"Authorization: Bearer $VIEWER\"", "expect": "403(타 조직 접근 차단)" }

// 금지 — abort
{ "kind": "http", "cmd": "curl https://api.example.com/live/send" }   // ✗ 외부 outbound
```

### 3.3 `shell` / fix 커맨드 — forbid 매칭 후 실행

`shell` probe 와 maker 의 fix(빌드·스크립트·git)는 §4 의 forbid 패턴을 통과한 뒤에만 실행한다.

### 3.4 마이그레이션 — local 적용만

- **허용**: 새 스키마 마이그레이션을 **local/dev DB 에만** 적용·검증(기동 시 자동 적용, 또는 수동 적용 후
  read-only probe 로 검증).
- **금지(abort)**: 원격/스테이징/운영 DB 로의 적용. 루프는 마이그레이션 파일을 만들고 local 검증까지만 하고,
  원격 적용은 사람이 SOP 로 한다.
- **함정**: maker 가 local DB 에 붙지 않으면 실데이터 결함(UNIQUE 추가 시 기존 중복으로 인한 적용 실패 등)을
  blind 로 통과시킨다 → 제약 마이그레이션은 dedup 선행 + local 재기동 검증을 fix 안에 포함해야 verify 가 잡는다.

### 3.5 외부 cutover — 범위 밖

mock 어댑터 → live 전환(외부 결제/배송/알림 벤더의 운영 키 사용)은 **루프 범위 밖**이다. 별도의 사람 주도
단계다. probe 도 fix 도 외부 live 엔드포인트를 건드리지 않는다.

---

## 4. `safety.forbid` — 매칭 → abort + surface

`loop.json` 의 `safety.forbid` 는 **커맨드 문자열 차단 패턴 목록**이다. fix·probe·드라이버가 실행하려는 모든
커맨드를 이 목록과 매칭하고, 하나라도 걸리면:

```
1. 실행하지 않는다 (abort)
2. 점수에 반영하지 않는다 (그 라운드의 fix/probe 를 PASS 로 세지 않음)
3. surface: 어떤 커맨드가 어떤 패턴에 걸렸는지 보고하고 정지
```

### 4.1 매칭 규칙

- 패턴은 부분 일치(substring) 또는 glob 으로 해석한다. 대소문자 무시 권장.
- **★bare 동사 금지 — 연산에 앵커할 것**: `merge`·`push`·`force`·`pull` 같은 맨몸 동사를 substring 으로 쓰지
  말고 `git merge`·`git push`·`push --force` 처럼 커맨드에 앵커한다. 맨몸 `merge` 는 `git commit … (no push/merge)`
  같은 **부정 주석**과 `merged`·`submerge` 에, 맨몸 `force` 는 `enforce`·`workforce` 에 오발해 무해한 라운드를
  자폭시킨다(실사고: maker 가 "머지 안 함" 을 정직하게 보고한 문장의 `merge` 글자에 가드가 걸려 abort —
  **정직을 처벌했다**). 부정·주석·합성어에서 동사가 등장해도 실제 *연산*이 아니면 막지 않아야 한다.
- 레인의 자기검열을 **신뢰하지 않는다** — "안 했다" 는 주장과 무관하게 보고된 커맨드를 다시 매칭한다.
- 모호하면 차단(fail-safe).
- **구현상의 한계를 명시한다**: 드라이버는 sub-agent 의 내부 툴콜을 직접 가로챌 수 없다. 그래서 maker/verifier
  의 반환 스키마(`risky_cmds: string[]`)로 **보고된** 부작용 커맨드를 재매칭하고, 히트하면 그 라운드를 PASS 로
  세지 않는다. **레인이 위반 커맨드를 `risky_cmds` 에 누락하면 못 잡는다** — 비적대적 maker 를 전제한 **보조**
  결정론 가드이지 OS 샌드박스가 아니다. 진짜 방어선은 3겹이다: ① maker 프롬프트의 forbid 지시 ② 드라이버의
  재매칭(보조) ③ **auto-merge 금지 + 사람 머지 게이트**(최종).

### 4.2 기본 forbid (init 이 심는 baseline)

스택 무관하게 항상 들어가야 하는 보편 차단. init 인터뷰에서 **추가**는 되지만 아래는 제거하지 않는다.

```jsonc
"safety": {
  "scope": "local-only",
  "auto_merge": false,
  "forbid": [
    // ── 머지·원격 push (stay the engineer) ──
    "push --force", "push -f", "push --force-with-lease",
    "git push",                 // 루프는 push 안 한다 — 브랜치는 local, 원격은 사람 게이트
    "git merge", "gh pr merge", // ★bare "merge" 금지(§4.1) — 부정 주석에 오발한다
    "reset --hard origin",
    // ── 파괴적 파일/디스크 ──
    "rm -rf", "rm -fr", "mkfs", "dd if=", "> /dev/sd",
    // ── 원격 DB write·마이그레이션 ──
    "DROP ", "TRUNCATE ", "DELETE FROM", "UPDATE ", "INSERT INTO",
    // ── 자격증명·secret ──
    ".env.prod", "PRIVATE_KEY", "SECRET_ACCESS_KEY", "credentials",
    // ── 외부 cutover(§3.5) — 프로젝트별 벤더 live 호스트를 여기에 ──
    "<external-live-endpoint>"
  ]
}
```

> 일부 항목(`UPDATE `, `INSERT INTO`)은 §3.1 read-only 가드와 중복으로 잡힌다 — 의도된 이중 방어다. shell
> 커맨드 안에 SQL 이 인라인될 수 있으므로 문자열 매칭으로도 한 번 더 거른다.

### 4.3 프로젝트별 추가

스캔으로 감지된 위험 표면을 넣는다: 원격 origin URL 패턴, 외부 벤더 호스트, 배포 트리거 스크립트,
`terraform apply` · `kubectl … delete` · `docker … down -v`(볼륨 삭제) 같은 인프라 변경.

---

## 5. 보호 파일 — maker 가 검증 자산을 못 고친다

forbid 가 *커맨드* 를 막는다면, **`.claude/harness.json` 의 `protected[]` 글롭은 *파일 편집* 을 막는다.**
PreToolUse 훅 `scripts/protect-gate.mjs` 가 `Edit`/`Write`/`MultiEdit`/`NotebookEdit` 를 가로채, 글롭에 걸린
경로면 차단한다(`mode: auto`=차단 · `suggest`=경고 · `off`=무시).

여기에 들어가야 할 것: **게이트가 기대는 테스트, held-out 검증 자산, 게이트 스크립트.** 루프에서 이게
결정적인 이유는 단순하다 — maker 는 점수를 올리라는 압력을 받는다. 검증 자산이 열려 있으면 **코드 대신
검증을 고쳐서** 초록을 만드는 경로가 열린다. 점수는 올라가고 시스템은 그대로다.

두 가지를 기억할 것:

- **예외는 훅을 끄는 게 아니라 `protected` 에서 그 글롭을 빼는 것이다.** 그러면 설정 변경이 diff 에 남고
  사람이 리뷰에서 본다. 훅을 끄면 아무 흔적도 남지 않는다.
- **훅은 Edit/Write 툴만 본다.** 셸의 `sed -i` · 리다이렉트로 쓰는 경로는 못 잡는다. 그 축은 게이트의 트리
  지문이 잡는다(보호 파일이 바뀌면 게이트가 STALE 을 낸다).

---

## 6. held-out probe — maker 가 못 보는 검증

`dimensions[].probe.held_out: true` 인 프로브는 **maker 레인 프롬프트에 노출하지 않는다.** verifier 와 full
채점에서만 돈다. 이유는 §5 와 같다: maker 가 통과 조건의 정확한 문구를 알면, 그 문구를 만족시키는 최소한을
짜 맞추는 쪽으로 수렴한다(그리고 그건 결함을 안 고친 채 초록이다).

같은 규율이 이슈 워크플로 쪽에도 있다 — 상태 JSON 의 DoD 항목에 `held_out: true` 가 있으면
`scripts/gate.mjs --commit` 은 그 프로브를 건너뛰고(`SKIPPED`) **`--full` 에서만** 돈다. 루프의 held-out
프로브와 게이트의 held-out DoD 는 같은 축이다: **maker 가 보는 게이트와 판정하는 게이트를 분리한다.**

운용 규칙:

- held-out 프로브를 **모든 축에 달지 말 것.** 그러면 maker 가 아무 피드백 없이 눈감고 고친다. 축마다 "보이는
  프로브(빠른 신호) + held-out 프로브(판정)" 두 층으로 두는 편이 낫다.
- held-out 프로브의 `cmd`·`expect` 를 라운드 보고서나 커밋 메시지에 **인용하지 말 것** — 인용하는 순간
  다음 라운드의 maker 컨텍스트로 새어 들어간다.

---

## 7. maker ≠ verifier — 컨텍스트 방화벽

한 라운드 안에서 **고치는 레인과 검증하는 레인은 다른 sub-agent** 다. 컨텍스트를 공유하지 않는다.

- **maker** 는 deficit·관련 파일·보이는 프로브를 받는다. held-out 프로브와 정답 문구는 받지 않는다.
- **verifier** 는 변경된 파일 목록과 **전체 프로브**(held-out 포함)를 받고, maker 가 "고쳤다" 고 한 주장은
  **입력이 아니라 검증 대상**으로 받는다. 같은 세션이 고치고 같은 세션이 채점하면, 그 채점은 자기 작업의
  요약일 뿐이다.
- verifier 가 FAIL 을 내면 그 라운드의 점수 상승은 없다. 같은 라운드에서 1회까지 재fix 하고, 또 실패하면
  `no_progress` 로 집계한다(`references/stop.md` §3.1).

---

## 8. 정지·핸드오프 (auto-merge 금지의 실제 형태)

STOP/ESCALATE/BLOCKED/상한 어느 사유로 끝나든 종료 행위는 동일하다.

```
1. fix 결과는 루프 브랜치에만 존재한다(머지되지 않았다).
2. 반환: { stop_reason, rounds, last_active, cap_hit, branch, produced[] }
3. surface: "이 브랜치를 사람이 리뷰·머지하세요. 원격 마이그레이션이 필요하면 프로젝트 SOP 로 수동 적용.
   (auto-merge 안 함)"
```

forbid 위반 abort 도 같은 형태로 surface 하되, 그 라운드는 점수 미반영이고 `stop_reason` 에 위반 커맨드와
매칭된 패턴을 적어 사람이 원인을 즉시 알게 한다.

커밋·push 자체는 루프가 판정하지 않는다 — `scripts/commit-gate.mjs`(PreToolUse) 가 브랜치 상태 JSON·게이트
지문·리뷰 기록으로 판정한다. 루프는 그 게이트를 우회하지 않는다.

---

## 9. 왜 안전이 점수 정직성과 묶이나

local-only·read-only 가드는 점수 정직성을 지키는 부수효과가 있다:

- DB probe 가 read-only 이므로 **probe 자신이 상태를 바꿔 좋아 보이게 만들 수 없다.**
- 외부 outbound 금지이므로 "실제로는 mock 인데 live 인 척" 하는 신호가 섞이지 않는다.
- auto-merge 금지이므로 검증 안 된 fix 가 기본 브랜치로 새지 않는다. STOP 은 full 점수로만 인정되고, 그
  점수는 사람이 머지한 코드가 아니라 **브랜치 위 실probe** 로 잰다.
- protected + held-out 이 "검증을 고쳐서 통과" 경로를 끊는다.

**차단된 fix 로 점수를 올리는 것은 점수 사기다** — §4 의 "PASS 로 세지 않는다" 가 곧 anti-gaming 규칙이다.

---

## 10. 실행 직전 체크리스트

- [ ] 이 커맨드가 `safety.forbid` 에 걸리나? → abort + surface
- [ ] DB 면 read-only(SELECT/SHOW/EXPLAIN)인가? write/DDL 이면 abort
- [ ] HTTP 면 대상이 local(`env` 명시 호스트)인가? 외부면 abort
- [ ] 마이그레이션이면 local DB 에만 적용하나? 원격이면 사람 게이트로 surface
- [ ] `probe.kind` 가 db/http/test/shell/grep 중 하나인가?
- [ ] maker 프롬프트에 held-out 프로브가 새지 않았나?
- [ ] 이 편집이 `protected[]` 글롭(테스트·검증 자산·게이트)에 닿나?
- [ ] 검증한 레인이 고친 레인과 다른가?
- [ ] 종료할 때 머지하려 하나? → `auto_merge: false` — 브랜치 핸드오프로만 끝낸다

하나라도 "위반/모호" 면 **fail-safe = abort + surface**. 루프는 멈추고 사람이 결정한다.
그게 "stay the engineer" 의 운영적 형태다.
