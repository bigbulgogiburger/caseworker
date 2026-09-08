# `loop run` — 루프 사이클 절차 (the heart of run mode)

> 보편(universal) 절차만 기술한다 — 프로젝트 고유값(어떤 deficit 부터·어떤 probe·어떤 토큰)은 전부
> `<project>/.loop/loop.json` + `.loop/scorecard.md` 에서 읽는다.
> `<P>` = 플러그인 루트 절대 경로(이 스킬의 `Base directory` 두 단계 위).

루프를 한 라운드(또는 무인 N라운드) 돈다: **score → triage → fix → verify → rescore → 기록(판정) →
보고**. 교리는 *"Build the loop, stay the engineer"* (Addy Osmani). 그래서 한 라운드도
**maker≠verifier**(자기가 짠 코드를 자기가 검증 금지)·**auto-merge 금지**·**디스크=메모리**(컨텍스트
폭발 방지)를 불변으로 지킨다.

---

## 0. 사이클 한눈에

```
[1 triage]  .loop/checkpoint.json + scorecard.md §history 마지막 행
            + loop.json: triage_order 만 선택적 Read → 다음 미완 deficit 선택
     ↓  ★ (N=1 only) 인간 게이트: "이번 라운드 = <deficit>, 맞습니까?"
[2 fix]     루프 브랜치 → maker(sub-agent)가 해당 dimension 체크리스트대로 구현
     ↓          (held-out 프로브는 maker 프롬프트에 넣지 않는다)
[3 verify]  maker≠verifier: 리뷰 fan-out + loop.json: dimensions[].probe 실환경 재probe
              verify FAIL → 같은 라운드 1회 재fix → 또 실패면 error 시그니처와 함께 기록
     ↓
[4 rescore] scoring.md 절차로 채점 (per-round = 터치 dimension 1개만) → active_total 산출
     ↓
[5 record]  node "<P>/scripts/loop.mjs" record …  → verdict(STOP|ESCALATE|CONTINUE) 수령
     ↓        ⚠ 판정은 이 스크립트가 한다. 스킬이 직접 계산하지 않는다.
[6 report]  점수 델타·변경파일·verify 결과·verdict·다음 deficit 보고
            → ★(N=1)정지 / (N≥2)verdict CONTINUE 면 다음 round
```

각 단계가 어떤 디스크 파일을 읽고/쓰는지가 핵심이다 — **메인 세션은 얇은 드라이버**, heavy work 는
전부 sub-agent 가 자기 컨텍스트에서 수행하고 **compact 결과만** 반환한다(컨텍스트 방화벽).

---

## 1. 컨텍스트 규율 (모든 모드 불변 — 왜 sub-agent 위임인가)

scorecard 산문이 수만 토큰일 수 있고, 라운드를 한 세션에서 연달아 돌리면 컨텍스트가 폭발한다.
*"메모리는 컨텍스트가 아니라 디스크에."* 그래서:

- **선택적 읽기**: triage 는 `.loop/checkpoint.json` + `scorecard.md` **§history 마지막 행 + 대상
  dimension 의 rubric 블록만** Read(`offset`/`Grep`). 문서 통독 금지.
- **heavy work 전면 sub-agent 위임**: maker(구현)·실환경 probe·리뷰·re-score 는 전부 sub-agent 가
  자기 컨텍스트에서 수행하고 **compact 결과만** 반환. 메인은 maker 의 파일내용/추론을 안 본다 =
  컨텍스트 방화벽이자 maker≠verifier 의 구조적 보장.
- **상태는 디스크에**: 라운드 끝에 `loop.mjs record` 가 `.loop/checkpoint.json`·`scorecard.json` 을
  갱신한다. 다음 라운드는 **fresh 세션이어도 디스크만 읽고 재진입** — 컨텍스트 의존 0.
- **멀티라운드는 인라인 금지**: N=1 은 이 attended 절차로 1라운드 후 정지. N≥2 무인 연속은 §2 의 두
  방식(Stop 훅 / Workflow 드라이버)으로만. 인라인 "계속"은 컨텍스트 폭발.

---

## 2. N=1 (attended) vs N≥2 (무인) 분기

`loop run [N]` 의 단일 다이얼 N 이 게이트 강도를 결정한다.

| | **N=1 (attended)** | **N≥2 (무인)** |
|--|--------------------|----------------|
| 주체 | 메인 세션이 본 절차를 1회 직접 오케스트레이션 | Stop 훅 모드 또는 `.loop/driver.js`(Workflow) |
| 인간 게이트 | **[1]triage 후 ★게이트** + 라운드 끝 정지 | 게이트 없음 — verdict·caps·브레이커에서만 멈춤 |
| 정지 | **1라운드 후 무조건 정지** (인간 재트리거 대기) | verdict 가 CONTINUE 가 아니거나 상한 도달까지 |
| full re-audit | 선택(STOP 후보면 1회) | `record` 가 돌려주는 `next.mode` 가 지시 |
| 용도 | 신중 — 루프 기판 검증·고위험 deficit·처음 도입 | 맡김 — 검증된 기판 위 연속 진전 |

> 첫 바퀴는 항상 보여주고(검증), 나머지는 맡긴다 — "stay the engineer". 그래서 권장 진입은 **항상
> `loop run 1` 먼저**(기판/점수함수/verifier 분리가 실제로 도는지 1바퀴로 확인) → 이후 `loop run N`.
> 세 경로 모두 **본 문서의 [1]~[6] 동일 절차**를 돈다.

### (a) Stop 훅 모드 — 이 세션이 스스로 되먹는다

```bash
node "<P>/scripts/loop.mjs" session start --session-id <이 세션 id> \
  --prompt "loop 다음 라운드를 돌려라: cycle.md [1]~[6] 절차, checkpoint.json 의 next 부터."
```

이후 세션이 끝나려 할 때마다 `hooks/hooks.json` 의 Stop 훅(`scripts/stop-loop.mjs`)이 `.loop/
session.local.json` 을 보고 종료를 막고 그 프롬프트를 다음 입력으로 되먹인다. 훅은 **판정하지 않는다**
— `checkpoint.json` 의 `last_verdict` 가 STOP/ESCALATE 이거나 `max_rounds`·`max_minutes` 에 닿으면
세션 파일을 비활성화하고 통과시킨다. `session_id` 가 다르면 무시하므로 같은 프로젝트의 다른 세션은
잡지 않는다. 손으로 멈추려면 `loop.mjs session stop`.

### (b) Workflow 드라이버 — `.loop/driver.js`

[`../templates/driver.js.tmpl`](../templates/driver.js.tmpl) 을 채운 `.loop/driver.js` 를 Workflow 로
실행한다. 드라이버는 라운드마다 Triage/Fix/Verify/Rescore 를 sub-agent 로 위임하고, 라운드 끝에
`loop.mjs record --json` 을 호출해 **그 출력의 `verdict` 를 그대로 따른다**. 드라이버 안에서 target·
연속·no-progress 를 자체 계산하지 말 것 — 장부와 어긋나는 두 번째 판정자가 생긴다.

---

## 3. 단계별 상세

### [1] Triage — 다음 deficit 선택

`.loop/checkpoint.json` + `scorecard.md §history` 마지막 행 + `loop.json: triage_order` 를 읽어 **다음
미완 deficit** 을 고른다.

- `triage_order` 가 **명시 배열**이면 그 실행순서대로(raw weight 순위와 다를 수 있음 — 단일 모듈·검증
  명확·선행의존 없음인 deficit 을 파일럿으로 앞당기는 판단이 여기 박힌다).
- `triage_order: "auto"` 이면 **weakest-link-first**(blend 종합을 지배하는 최약 dimension 부터,
  [`scoring.md`](./scoring.md) 의 binding-constraint 원칙). 큰 deficit 은 sub-deficit(`1a`/`1b`/`1c`)
  으로만 진입 — **한 라운드 = 한 sub-deficit**.
- 이미 목표 도달했거나 BLOCKED 표기된 deficit 은 건너뛴다.

**checkpoint.json 에서 읽는 결정값**: `next`(다음 라운드 번호·mode·why) · `last_verdict` ·
`last_deficit` · `no_progress` · `consecutive_at_target` · `no_change_streak` · `same_error_streak` ·
`spent_cost_usd` · `rounds[]`. 현황을 사람이 볼 형태로 보려면 `node "<P>/scripts/loop.mjs" status`.

**★ 인간 게이트 (N=1 only)**: 고른 deficit 을 사용자에게 확인받고 시작한다("이번 라운드 =
`<deficit>`, 맞습니까?"). 사용자가 다른 deficit 을 원하면 따른다. **N≥2 무인은 게이트 없음.**

**선(先) 정지 체크** (triage 직후, fix 전에): 직전 라운드의 verdict 가 이미 STOP/ESCALATE 면 라운드를
시작하지 않는다 — `node "<P>/scripts/loop.mjs" verdict` 로 디스크 상태를 다시 물어 확인한다(exit 1 이면
정지). 종료 규칙의 의미는 [`stop.md`](./stop.md).

### [2] Fix — maker = sub-agent (메인은 직접 안 짬)

maker 는 **sub-agent** 가 수행한다(메인 세션이 직접 코드를 짜지 않는다 — 그래야 [3]의 verify 가
*자기가 안 짠 코드*를 보는 진짜 maker≠verifier 가 되고, 메인 컨텍스트도 보호된다).

- **브랜치 선택 규칙** (run 진입 시 **오케스트레이터(메인)가 1회 결정** → `args.branch` 로 드라이버에
  고정 전달. 드라이버는 Workflow 런타임상 git 접근이 제한되므로 메인이 결정해 넘긴다):
  - **현재 브랜치가 이미 루프 브랜치(`loop/*`)면 → 그 브랜치에 계속 적층**(세션 이어가기).
  - **아니면 → `loop/<name>_YYYYMMDD` 를 현재 브랜치에서 새로 생성**해 시작. ⚠️ 기존 동명 루프
    브랜치(`loop/<name>`)는 이미 인간이 머지해 stale(base 가 기준 브랜치보다 뒤처짐 — 그 위에 쌓으면
    옛 코드로 빌드/probe)일 수 있으므로 **재사용 금지** — 날짜 suffix 로 세션을 격리한다.
  - 어느 경우든 **기준 브랜치 직접 커밋 금지**. commit/push 판정은 여전히 caseworker 의 commit-gate
    훅이 한다 — 루프는 그 훅을 우회하지 않는다.
- **sub-agent 에 전달**: 대상 deficit + `scorecard.md` 의 해당 dimension 체크리스트(FULL 정의/잔여
  갭) + rubric evidence anchor(file:line). `loop.json` 의 `dimensions[].evidence` 가 grounding.
  ⚠️ **`probe.held_out: true` 인 프로브의 cmd/expect 는 이 프롬프트에 넣지 않는다** — 채점 문항을 본
  maker 는 문항만 맞춘다.
- **sub-agent 반환 (compact만)**: `{branch, files[], summary(≤5줄), self_test_pass}`. 파일 전체내용·
  추론은 반환 금지.
- **자체 빌드/테스트**: maker 가 `loop.json: env.test` 로 자체 검증(임의 플래그 추가 금지 — 명시된 그대로).

**NEVER (safety 가드 — [`safety.md`](./safety.md) + `loop.json: safety.forbid`):**
- **probe·fix 는 local 범위만**: prod/remote write·외부 cutover·자격증명·force push·`push` 금지.
  `safety.forbid` 목록을 maker 가 시도하면 abort + surface.
- **DB 마이그레이션은 local 적용만**. 원격 적용은 **인간 수동 게이트** — 루프는 마이그 파일 작성 +
  local 검증까지만.
- **`safety.auto_merge: false` 불변** — maker 는 커밋만, 머지 금지(스키마가 `false` 외의 값을 거부한다).
- **검증 자산은 못 고친다** — `.claude/harness.json.protected[]` 글롭(테스트·DoD 자산·게이트 스크립트)
  은 PreToolUse 훅 `protect-gate.mjs` 가 Edit/Write 를 막는다.

### [3] Verify — verifier ≠ maker ⚠️ 정적 리뷰만으로 끝내지 말 것

두 층을 모두 수행하되, **maker 와 다른 주체가** 한다. 실환경 재probe 는 **별도 sub-agent(또는 N=1 이면
메인)**가 maker 브랜치를 체크아웃해 돌리고 compact verdict 만 반환 — **maker 자신의 자기검증 금지**.
정적 리뷰만으로 PASS 선언 금지 — 정적 grep "0건"·테스트 개수는 anti-gaming 이 막는 묘지다(정적
0건이어도 실DB 누설·native SQL·UNIQUE 위반은 실probe 로만 잡힌다).

1. **리뷰 fan-out** — 코드리뷰 sub-agent(또는 `/caseworker:issue` 의 verify 레인)로 maker 와 다른
   에이전트가 정적 검토. verdict 수령.
2. **실환경 재probe (★필수, 이게 진짜 결함을 잡는다)** — `loop.json: dimensions[].probe` 의 해당
   dimension probe 를 실행하고 `expect` 와 대조. **held-out 프로브는 여기서 처음 돈다.**
   - `probe.kind` 별 신호: `db`(read-only SUM/COUNT 불변·orphan 0), `http`(200+실데이터 / 비-권한
     403/404 — IDOR·scope), `test`(env.test 플래그 준수), `shell`/`grep`(벤치·계약).
   - **비-권한 토큰**으로 권한/scope probe (`loop.json: env.auth` — 관리자 계정은 전부 통과라
     IDOR/scope 미검출).
   - **실DB**(`env.db`, read-only) — mock/in-memory 는 native SQL·UNIQUE·암묵 INNER JOIN 미검출.
   - **사전조건**: `env.start` 가 살아있나? 죽었으면 live probe 신호 = STALE(거짓상승 방지,
     [`scoring.md`](./scoring.md) §3).

**verify 분기:**
```
PASS  (리뷰 OK AND 실probe expect 충족) → [4] rescore
FAIL  → 같은 라운드에서 1회 재fix([2] 재진입)
        또 실패 → [4]~[5] 로 진행하되 record 에 --error "<에러 시그니처>" 를 붙인다
                 (같은 시그니처가 breaker.same_error_rounds 회 반복되면 스크립트가 ESCALATE)
```
verdict 반환 (compact): `{pass, verdict, evidence(상태코드/DB SUM/403 등 실신호)}`. **리뷰 verdict
만으로 PASS 금지 — evidence 에 실probe 신호가 없으면 PASS 무효.**

### [4] Rescore — 채점

[`scoring.md`](./scoring.md) 절차로 채점한다. per-round 모드면 터치한 dimension 1개만, `record` 가
직전에 `next.mode: "full"` 을 지시했으면 전 dimension fan-out.
- 그 dimension 의 probe 신호 → band(FULL/PARTIAL/CONFLICT/MISSING) → dimension 보정점수.
- BLOCKED 분자·분모 제외 → `active_total` 재정규화(scoring.md §6).
- `--domains` 로 넘길 JSON `{ "<id>": { "score": N, "evidence": [...] } }` 를 만든다.

> per-round 는 **빠른 국소 갱신**일 뿐 — STOP 확정에는 못 쓴다. 국소 회귀(다른 dimension 교차오염)는
> per-round 가 못 본다. per-round 점수가 target 을 넘기면 `record` 가 다음 라운드를 full 로 지시한다.

### [5] Record — 판정은 스크립트가 한다 ⚠️

라운드의 마지막 쓰기는 반드시 이 호출이다. **호출을 빠뜨리면 그 라운드는 장부에 없는 라운드가 되고,
상한·브레이커·연속 카운터가 전부 어긋난다.**

```bash
node "<P>/scripts/loop.mjs" record --mode per-round --active 62 \
  --domains .loop/domains.json --deficit auth-scope \
  --changed-files 7 --cost-usd 0.31 [--error "<시그니처>"] [--blocked <id,…>] \
  [--note "<한 줄>"] --json
```

**exit 코드 해석:**

| exit | verdict | 해야 할 일 |
|------|---------|-----------|
| **0** | `CONTINUE` | 다음 라운드로. `next.mode`(per-round/full)와 `next.why` 를 그대로 따른다 |
| **1** | `STOP` | 라운드 종료. target 연속 달성이거나 caps 도달(`cap_hit: true`) — 브랜치 핸드오프 |
| **1** | `ESCALATE` | 사람 호출. 브레이커 OPEN(변경 0 연속 · 같은 에러 반복) 또는 no-progress |
| **2** | — | 사용법/설정 오류. `.loop/loop.json` 이 없거나 무효 → `loop.mjs check` 로 확인 |

exit 1 은 **실패가 아니라 "멈춰라"** 다. 실패로 보고하지 말 것. 판정 사유는 `reasons[]` 에 문자열로
들어 있으니 그대로 인용한다 — 스킬이 사유를 재구성해 쓰지 않는다.

### [6] Report & 정지

**N=1 은 보고 후 멈춘다**(자동으로 다음 라운드 진입 금지 — 인간 재트리거). **N≥2 는 verdict 가
`CONTINUE` 일 때만 다음 round 로**.

```
## Loop Round Rx 결과
- deficit: <id — 작업명> (dimension <id>)
- 변경: <파일 목록 / 브랜치>  (★auto-merge 안 함)
- verify: review=<verdict> · 실probe=<핵심 신호: 상태코드/DB SUM/403 등>
- 점수: <dimension> <before>→<after>, 활성 종합 <before>→<after>
- verdict: <record 가 준 CONTINUE|STOP|ESCALATE> — <reasons 그대로>
- 다음: <next.round next.mode (next.why)> 또는 (정지)
- ★ 머지 게이트: 인간 리뷰 후 머지하세요. (원격 마이그/cutover 필요시 별도 수동 게이트 안내)
```

---

## 4. 게이트 (매 라운드 불변 — 절대 우회 금지)

- **auto-merge 금지** — 브랜치만 열고 인간이 리뷰·머지(`safety.auto_merge: false` 불변). 저위험군
  (lint/포맷/console-only)도 전부 게이트.
- **maker ≠ verifier** — fix 를 짠 sub-agent 가 verify 를 못 한다. 실환경 재probe 는 코드 안 짠 별도 주체.
- **held-out 은 maker 에게 안 보인다** — 프롬프트에도, commit 게이트에도 안 넣는다(`gate.mjs --full`
  에서만 실행).
- **앱 재기동은 clean** — 서버측 코드 수정 후 증분/hot 재기동 금지, clean 재기동(kill + fresh start +
  readiness 폴링). 안 그러면 stale 프로세스가 옛 코드로 응답해 probe 가 거짓 PASS.
- **1라운드 후 정지 (N=1)** — 무인 연속은 Stop 훅 또는 `.loop/driver.js` 로만. 인라인 "계속"은 금지.
- **caps 없이는 시작도 못 한다** — `loop init` 이 `max_rounds|max_cost_usd|max_minutes` 중 하나도
  없으면 거부한다. 상한 없는 무인 루프는 만들지 않는다.
- **local-only** — 모든 probe/fix 는 local 범위. 원격 write·외부 cutover·자격증명 접근 0.

> 루프는 점수를 올리는 기계지만, 검증과 머지 판단은 사람 몫이다. 본 사이클은 한 라운드를 *준비*해
> 사람 앞에 가져다 놓는다 — 시작 버튼이 아니라 엔지니어로 남으라.

---

## 5. 참조 (cross-ref)

| 무엇 | 어디 |
|------|------|
| 모드 분기(init/score/run/status)·이슈 워크플로와의 관계 | [`../SKILL.md`](../SKILL.md) |
| band·blend·정규화·anti-gaming·`record --domains` 모양 | [`./scoring.md`](./scoring.md) |
| STOP/ESCALATE/BLOCKED 종료 규칙 상세 | [`./stop.md`](./stop.md) |
| local-only 안전 가드·forbid·보호 파일 | [`./safety.md`](./safety.md) |
| init(스캔+인터뷰→`.loop/` 생성)·caps 필수 | [`./init-flow.md`](./init-flow.md) |
| 설정 스키마(dimensions·env·probe·caps·breaker·triage_order·safety) | `<P>/schemas/loop.schema.json` |
| 무인 N≥2 워크플로 뼈대 | [`../templates/driver.js.tmpl`](../templates/driver.js.tmpl) |
