---
name: loop
description: >-
  완성도 루프 엔진 — 임의의 코드 프로젝트에 까는 재사용 loop engineering 프레임워크
  (Addy Osmani "Build the loop, stay the engineer"). "잘됨"을 계산 가능한 0~100 score 로 정의하고
  score→triage→fix→verify→rescore 사이클을 돌려 숫자를 올리되, 모든 상승은 실환경 신호(DB 불변식·200+실데이터·
  비-권한 403·벤치)에 결박한다(anti-gaming). 단일 진입점에서 4모드를 의도 추론으로 분기:
  init(코드베이스 스캔+인터뷰→.loop/ 생성) · score(재채점) · run N(N=1 attended 1바퀴+게이트, N≥2 무인 드라이버) · status(현황).
  **반드시 사용**: '루프 셋업', '루프 시작', 'loop init', '재채점', '완성도 몇 점', 're-score',
  '루프 N라운드 돌려', 'loop engineering N라운드', '다음 deficit', 'STOP 판정', '루프 현황',
  '다음 뭐 해야 돼' — 완성도 루프를 셋업·측정·전진·조회하려는 모든 맥락.
  코드 프로젝트 전용(probe/fix=local 범위만, auto-merge 금지, maker≠verifier).
  단순 단일 버그수정·일반 구현 요청엔 쓰지 말 것(그건 일반 작업 흐름).
---

# /caseworker:loop — 완성도 루프 (단일 진입점)

> *"Build the loop, stay the engineer."* — Addy Osmani
> 임의의 코드 프로젝트를 *계산 가능한 완성도 점수*로 측정→triage→fix→verify→re-score 하는 루프.
> 엔진·절차는 이 스킬과 `references/`, 프로젝트별 rubric·probe·env 는 `<project>/.loop/` 에 산다.
>
> **이 스킬은 *디스패처*다.** 절차 본문은 `references/*.md` 에, 데이터(rubric/weights/evidence/env)는
> `<project>/.loop/loop.json` + `scorecard.md` 에, **장부와 판정**은 `scripts/loop.mjs` 에 있다 —
> 중복 정의 금지. 각 모드는 해당 reference 만 펼쳐 읽고 위임한다(통독 금지 — §2 컨텍스트 규율).

`<P>` = 플러그인 루트 절대 경로. 이 스킬이 로드될 때 표시되는 `Base directory for this skill` 의
**두 단계 위**다(`skills/loop` 의 부모의 부모). 아래 모든 명령의 `<P>` 를 그 경로로 치환하고,
프로젝트 루트(또는 그 worktree)에서 실행한다.

---

## 0. 정수 — 5 invariants (모든 모드가 지킨다)

루프가 의미를 가지려면 이 5개가 깨지면 안 된다. 어떤 모드든 출력 전에 이 5개로 자기점검한다.

1. **"잘됨"을 숫자로** — 성공을 계산 가능한 0~100 score 로. 막연한 "make it better"·"production-ready 인 것 같다" 금지.
2. **숫자를 올린다** — score → triage(최약 고리) → fix → verify → rescore 사이클로만 전진.
3. **숫자를 못 속인다 (anti-gaming)** — 모든 점수 상승은 **실환경 신호**(DB 불변식·200+실데이터·비-권한 403·벤치)에 결박. 테스트 *개수* 증가·정적 grep "0건"·"코드가 존재함"을 PASS 로 세지 않는다. (자세히 → [references/scoring.md](references/scoring.md))
4. **결정론적 종료** — STOP / ESCALATE / CONTINUE 는 **`loop.mjs record` 가 계산한다.** 스킬이 직접 세지 않는다. (자세히 → [references/stop.md](references/stop.md))
5. **사람이 루프 안에 (stay the engineer)** — 브랜치만, **auto-merge 금지**, 게이트. fix·probe 는 **local 범위만**(prod/remote/자격증명/force push 금지). (자세히 → [references/safety.md](references/safety.md))

> **판정은 스크립트가 한다.** 이 스킬의 산문은 STOP·ESCALATE 규칙을 *설명*할 뿐이고,
> 실제 판정은 `node "<P>/scripts/loop.mjs" record …` 의 출력(`verdict`)을 따른다.
> 모델이 "연속 2회 달성했으니 STOP" 이라고 손으로 세면 상한·브레이커·no-progress 축과 어긋난다.

---

## ⛔ Guard — 스킬 시작 즉시 (가장 먼저 실행)

```bash
node "<P>/scripts/loop.mjs" check --json
```

| 결과 | 뜻 | 다음 |
|------|----|------|
| exit 2 · `.loop/loop.json 이 없다` | 셋업 전 | → **무조건 init 모드** (다른 의도여도 먼저 셋업해야 측정 가능) |
| exit 2 · `errors[]` | 설정 무효(Σweight≠1 · caps 없음 · auto_merge≠false) | → 그 항목만 고치고 재-check. 고치기 전 다른 모드 진입 금지 |
| exit 0 | 정상 | → 사용자 발화로 의도 분류 → score / run / status |

`.loop/` 가 없는데 "재채점/루프 돌려"를 요청받았다면 측정할 rubric 자체가 없는 것이다 →
"아직 루프가 셋업되지 않았습니다. `loop init` 을 먼저 돌려 `.loop/` 를 만들까요?" 로 안내하고 init 으로 진입.

---

## 1. 모드 분기표 (의도 추론 — 플래그 explosion 없음)

| 모드 | 트리거(자연어) | 무엇을 하나 | 위임 reference | 정지 |
|------|---------------|------------|----------------|------|
| **init** | `.loop/` 없음 · "루프 셋업/시작/init" | 코드베이스 스캔 → 풀 인터뷰 → `loop.mjs init` + `.loop/`(scorecard.md·driver.js) 생성 | [references/init-flow.md](references/init-flow.md) | 생성 후 baseline score 제안 |
| **score** | "재채점/완성도 몇 점/re-score/full re-audit" | rubric+probe 로 측정 → `loop.mjs record` 로 기록·판정 | [references/scoring.md](references/scoring.md) | record 의 verdict |
| **run [N]** | "루프 N라운드 돌려/N바퀴/loop engineering N" | **N=1**: attended 1바퀴+게이트 / **N≥2**: 무인 드라이버 2방식 중 하나 | [references/cycle.md](references/cycle.md)(+[stop.md](references/stop.md)) | verdict / caps / 브레이커 |
| **status** | "루프 현황/다음 뭐/지금 몇 점" | `loop.mjs status` 요약(측정 안 함) | — (스크립트만 호출) | 즉시 |

> **N 단일 다이얼**: "루프 10" = 10 라운드(직관 일치). N 만으로 attended↔무인 자동 전환 —
> **N=1 게이트**(첫 바퀴는 항상 보여주고 검증), **N≥2 무인 드라이버**(나머지는 맡긴다). 별도 플래그 없음.
> N 미지정 "루프 돌려"는 **N=1 로 해석**(보수적 — 한 바퀴 보여주고 사람이 이어가게).

각 모드는 **그 모드의 reference 만** 펼쳐 읽는다. 4개를 한꺼번에 읽지 않는다(컨텍스트 규율).

---

## 2. 컨텍스트 규율 — "메모리는 컨텍스트가 아니라 디스크에"

이 스킬은 메인 세션에서 돈다. 통독·전수 inline 채점·멀티라운드 인라인은 컨텍스트를 폭발시킨다.
어느 모드든 다음 4규율을 지킨다:

- **선택적 읽기**: `scorecard.md`(산문 rubric, 클 수 있음)·reference 를 통독하지 말 것. 필요한 절(per-round 면 해당 dimension 의 §정의 + `scorecard.md` 마지막 점수이력 행만 / full 이면 §헤더 점수 + weights 만)만 offset/Grep 으로 읽는다. evidence anchor 는 필요할 때 그 `file:line` 만.
- **heavy work 는 sub-agent 위임, compact 만 회수**: dimension probe(HTTP/DB/테스트 묶음)·maker(구현)·verifier(실 probe)·코드리뷰는 sub-agent 가 자기 컨텍스트에서 실행하고 **{대상, 점수/verdict, 핵심증거 3~5줄}만** 반환. full 모드 = dimension 별 sub-agent fan-out(병렬), 메인은 compact 결과만 합산. probe 출력 raw·파일 전체내용을 메인이 들고 있지 말 것 = **컨텍스트 방화벽** + 진짜 maker≠verifier.
- **상태는 디스크에**: 결과는 컨텍스트가 아니라 `loop.mjs record` 가 쓰는 `.loop/scorecard.json` + `.loop/checkpoint.json` + `scorecard.md §점수이력` 으로 영속. 다음 라운드/세션(fresh 여도)은 `loop.mjs status` 만 읽고 재진입 — 컨텍스트 의존 0.
- **멀티라운드는 인라인 금지**: `run N≥2` 는 인라인 "계속"이 아니라 §4 의 두 무인 방식 중 하나. 스크립트/훅이 compact 상태만 들고 라운드를 sub-agent 로 반복하므로 메인 컨텍스트가 폭발하지 않는다.

---

## 3. `.loop/` 레이아웃 (init 이 생성, 다른 모드가 읽음)

```
<project>/.loop/
├── loop.json          # 기계 설정: dimensions·weights·evidence·probe·env·stop·caps·breaker·triage_order·safety
│                      #   (스키마 정본 = <P>/schemas/loop.schema.json · 검증 = loop.mjs check)
├── scorecard.md       # 산문 SSoT: 각 dimension FULL/PARTIAL/CONFLICT/MISSING 정의 + §점수이력(append-only)
├── scorecard.json     # 런타임 점수 (loop.mjs record 가 씀 — round·mode·active_total·domains·blocked)
├── checkpoint.json    # 런타임 상태 (loop.mjs record 가 씀 — rounds[]·verdict·no_progress·연속·브레이커 카운터)
├── session.local.json # Stop 훅 루프 활성 표식 (loop.mjs session start 가 씀 · gitignore)
└── driver.js          # (선택) Workflow 무인 드라이버 — templates/driver.js.tmpl 을 채운 것
```

**보편(이 스킬·references·templates·scripts) = 엔진·절차·장부. 프로젝트별(`.loop/`) = rubric·probe·env.**
`.loop/loop.json` 스키마는 `<P>/schemas/loop.schema.json` 이 정본이고 `loop.mjs check` 가 강제한다 —
**설정은 JSON 이다. YAML 형식은 이 프레임워크에 없다.**

---

## 4. 모드별 진입 (요지 + 위임)

> 각 항목은 *언제 무엇을 위임하나*만 적는다. 절차 본문은 reference 가 SSoT.

### init — 스캔 + 풀 인터뷰 → `.loop/` 생성
`.loop/` 가 없거나 사용자가 셋업을 원할 때. **여기가 "기획" 엔진** — 스캔이 초안을 제안하고 인터뷰가 확정한다.

```
A 스캔(read-only)  언어/프레임워크(package.json·build.gradle·go.mod·pyproject…)·테스트/기동/DB/인증·
                   도메인/모듈 경계(→ dimension 후보)·CI 스크립트(→ probe 후보) 자동 탐지
B 인터뷰(풀)        스캔 결과를 보여주고 사람이 확정/보정: ①목표 한 줄 ②dimensions+weights(Σ=1.0)
                   ③각 축 probe="코드 존재 아닌 실동작" 신호(+held_out 여부) ④env ⑤stop.target
                   ⑥★caps(상한) — max_rounds|max_cost_usd|max_minutes 중 최소 1개
C 생성             loop.mjs init 으로 골격 → 인터뷰 결과로 loop.json 편집 → loop.mjs check → scorecard.md(+driver.js)
D baseline         "지금 baseline 잴까요?" → score(full) 1회 → record --mode full 로 R0 기록
```

> ★ **caps 없이는 `loop init` 이 거부된다** — `loop.mjs init` 은 `--max-rounds` / `--max-cost-usd` /
> `--max-minutes` 중 하나도 없으면 exit 2 로 멈춘다("상한 없는 루프는 시작할 수 없다").
> 서킷브레이커(`breaker.no_change_rounds` 연속 파일 변경 0 · `same_error_rounds` 같은 에러 반복)도
> 같은 자리에서 확정한다 — 둘 다 열리면 verdict 는 ESCALATE 다.

**위임**: 전체 절차·스캔 휴리스틱·인터뷰 질문 세트·Σweights=1.0 검산·템플릿 채우기는
[references/init-flow.md](references/init-flow.md) 가 SSoT. 스캔만 믿으면 dimension 오판,
인터뷰만이면 매번 처음부터 — **둘 다** 한다.

### score — 측정 엔진 (재채점)
"재채점/몇 점/re-score". 먼저 범위를 정한다:

| 모드 | 시점 | 범위 | 비용 |
|------|------|------|------|
| **per-round**(기본) | fix 라운드 직후 | 터치한 deficit + 그 dimension 1개만 | 저 |
| **full** | `stop.full_audit_every` 라운드마다 + STOP 후보 도달 시 | 전 dimension | 고 |

"full/전체/re-audit"이면 full(dimension fan-out), 도메인 지정이면 per-round.
측정이 끝나면 **반드시** 장부에 기록한다 — 여기서 판정이 나온다:

```bash
node "<P>/scripts/loop.mjs" record --mode full --active 74 \
  --domains .loop/round-domains.json --deficit inventory --changed-files 6 --json
```

**STOP 판정은 full 점수로만 인정**(`record` 도 `--mode full` 일 때만 연속 카운터를 올린다 —
per-round 부분점수로 STOP 선언 금지: 국소회귀·교차오염 미검출).
band 표(FULL 80~90 / PARTIAL 40~78 / CONFLICT 25~55 / MISSING 12~30)·5대 감점 원칙·
active 재정규화 공식·anti-gaming 자기점검은 **[references/scoring.md](references/scoring.md)** 가 SSoT. → 위임.

### run [N] — attended / 무인 분기
**N=1 (attended)**: 한 바퀴를 사람 앞에서 돈다.
```
triage(다음 deficit) →★게이트 "Rank N 맞나?" → fix(maker=sub-agent)
  → verify(verifier≠maker: 코드리뷰 + held-out 포함 실 probe) → score(per-round)
  → loop.mjs record → verdict 대로 보고 후 정지
```
**N≥2 (무인)**: 인라인 반복 금지 → 두 방식 중 하나(자세히 → [references/cycle.md](references/cycle.md)):

| 방식 | 시동 | 라운드를 누가 이어붙이나 | 언제 |
|------|------|------------------------|------|
| **(a) Stop 훅 모드** | `loop.mjs session start --session-id <id> --prompt "<라운드 프롬프트>"` | 세션이 끝나려 할 때마다 `hooks/hooks.json` 의 Stop 훅(`scripts/stop-loop.mjs`)이 다음 라운드 프롬프트를 되먹인다. `session_id` 로 격리되어 같은 프로젝트의 다른 세션은 막지 않는다. verdict 가 STOP/ESCALATE 이거나 caps 에 닿으면 세션 파일을 비활성화하고 통과 | 이 세션에서 그대로 계속 돌릴 때 |
| **(b) Workflow 드라이버** | `templates/driver.js.tmpl` 을 채운 `.loop/driver.js` 를 `Workflow` 로 실행 | 드라이버가 라운드마다 maker/verifier sub-agent 를 위임하고, **판정은 agent 가 실행한 `loop.mjs record` 의 JSON 을 읽어** 따른다(스크립트 자체 STOP 계산 금지) | 별도 컨텍스트에서 배치로 돌릴 때 |

멈추려면 `loop.mjs session stop`(a) 또는 Workflow 중단(b). 어느 쪽도 **auto-merge 안 함** — 브랜치 핸드오프.

### status — 현황 (측정 안 함)
```bash
node "<P>/scripts/loop.mjs" status --json
```
현재 active_total·round·target 연속·no_progress·caps 소진(분/USD)·last_verdict·next(라운드·모드)·
Stop 훅 활성 여부를 요약한다. probe·fix 안 함, 디스크만 읽음.

---

## 5. caseworker 다른 스킬과의 관계

루프는 이슈 워크플로를 대체하지 않는다 — **`/caseworker:issue` 의 implement→verify 사이를 여러 번 도는 엔진**이다.

- **위치**: 이슈 한 건의 구현이 "됐나?"를 한 번 묻는 게 issue 스킬의 verify 라면, 루프는 그 질문을
  점수로 바꿔 **여러 라운드** 반복한다. 루프가 끝나도 종결(complete)은 issue 스킬이 한다.
- **커밋/푸시 판정은 그대로 훅이 한다** — 루프의 maker 가 무엇을 고쳤든 `git commit`/`git push` 는
  PreToolUse 훅 `commit-gate.mjs` 가 브랜치 상태 JSON(`.claude/runtime/issues/<slug>.json`)의
  게이트 지문·리뷰 기록으로 판정한다. 루프는 게이트를 우회하는 경로가 아니다.
- **held-out 은 양쪽에서 같은 뜻**: `loop.json` 의 `dimension.probe.held_out=true` 인 probe 는
  maker 레인 프롬프트에 노출하지 않고 verifier/full 에서만 돈다(anti-gaming). 상태 JSON 의 DoD 에도
  `held_out:true` 가 있으면 `gate.mjs --commit` 은 그 항목을 건너뛰고 `--full` 에서만 돈다 — 같은 규율이다.
- **보호 파일**: `.claude/harness.json` 의 `protected[]` 글롭(테스트·DoD 자산·게이트 스크립트)은
  PreToolUse 훅 `protect-gate.mjs` 가 Edit/Write 를 막는다 — maker 가 검증 자산을 고쳐 초록을 만드는
  경로를 차단한다. 루프의 fix 레인도 예외가 아니다.

---

## 6. 불변식 — 어떤 모드도 넘지 않는 선

루프는 점수를 올리는 기계지만, 검증·머지 판단은 사람 몫이다. 다음은 reference 가 무엇을 시키든
**항상** 강제된다([references/safety.md](references/safety.md) SSoT, `loop.json.safety.forbid` 가 차단 목록):

- **local-only** — probe·fix·마이그레이션은 local 범위만. prod/remote write·외부 API cutover·자격증명·force push 금지. DB probe 는 **read-only**. 원격 마이그/배포는 인간 게이트.
- **auto_merge: false** — 스키마가 `false` 만 허용한다(`enum:[false]`). 항상 브랜치/PR 핸드오프.
- **maker ≠ verifier** — fix 한 주체와 검증한 주체가 달라야 한다. 자기검증·정적 리뷰만으로 PASS 선언 금지 — 실환경 재 probe(비-권한 토큰·실DB·캐시 더블콜)가 진짜 결함을 잡는다. held-out probe 는 maker 가 보지 못한다.
- **anti-gaming** — 테스트 개수·정적 grep 0건·BLOCKED 억지상승·죽은 live 를 PASS 로 세지 않는다. 의심되면 낮게 + STALE/UNCERTAIN.
- **코드 프로젝트 전용** — `probe.kind` 는 코드 신호(`db`/`http`/`test`/`shell`/`grep`). 글쓰기·리서치 루프는 범위 밖.
- **상한 필수** — caps 없는 루프는 시작조차 못 한다. 브레이커(변경 0 연속 N · 같은 에러 연속 M)는 ESCALATE.
- **판정은 스크립트** — STOP/ESCALATE/CONTINUE 는 `loop.mjs record` 의 출력이다. 모델이 세지 않는다.

> 이 스킬은 한 라운드(또는 셋업/측정/현황)를 *준비*해서 당신 앞에 가져다 놓는다 —
> 시작 버튼이 아니라 엔지니어로 남으라.

---

## 7. references

| 파일 | 무엇의 SSoT |
|------|------------|
| [references/init-flow.md](references/init-flow.md) | 스캔 휴리스틱 · 인터뷰 6단계 · `.loop/` 생성 · baseline |
| [references/scoring.md](references/scoring.md) | band · 5대 감점 · 가중 blend · BLOCKED 재정규화 · anti-gaming |
| [references/cycle.md](references/cycle.md) | 라운드 6단계 · maker/verifier 규약 · 무인 2방식 · 재진입 |
| [references/stop.md](references/stop.md) | verdict 해석 · caps · 브레이커 · ESCALATE/BLOCKED 처리 |
| [references/safety.md](references/safety.md) | local-only · forbid · 보호 파일 · 머지 게이트 |
| [references/design.md](references/design.md) | SSoT 계약 — `.loop/` 파일 구조 · 플러그인 스크립트/스키마 책임 분담 · 불변 조건 |
| `templates/loop.json.tmpl` · `scorecard.md.tmpl` · `driver.js.tmpl` | init 이 채우는 골격 |
