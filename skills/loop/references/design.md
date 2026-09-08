# `loop` — 설계 계약 (SSoT contract)

> Addy Osmani 의 "Build the loop, stay the engineer" 를 **아무 코드 프로젝트에나** 까는 재사용 프레임워크.
> "잘됨" 을 계산 가능한 0~100 점으로 정의하고 score→triage→fix→verify→rescore 를 돌려 숫자를 올리되,
> 모든 상승을 실환경 신호에 결박한다.
>
> 이 문서는 **계약**이다. `SKILL.md` 와 다른 `references/*.md` 는 여기서 갈라져 나온 절차이고, 서로 어긋나면
> 이 문서가 기준이다. 단, **실행 판정**만은 예외다 — 그건 `scripts/loop.mjs` 가 정본이고 이 문서도 그것을 따른다.

---

## 0. 정수 (5 invariants — 모든 모드가 지킨다)

1. **"잘됨" 을 숫자로** — 성공을 계산 가능한 0~100 점으로. 막연한 "make it better" 금지.
2. **숫자를 올린다** — score→triage→fix→verify→rescore 사이클.
3. **숫자를 못 속인다(anti-gaming)** — 모든 점수 상승은 **실환경 신호**(DB SUM · 200+실데이터 · 비-권한 403 ·
   벤치)에 결박한다. 테스트 개수·정적 grep "0건" 을 PASS 로 세지 않는다.
4. **결정론적 종료** — 판정은 사람의 직감이 아니라 순수 함수다. `loop.mjs` 가 계산하고 나머지는 따른다.
5. **사람이 루프 안에(stay the engineer)** — 브랜치만, **auto-merge 금지**, 게이트는 사람이 넘는다.

여기에 caseworker 판에서 추가된 두 가지:

6. **상한 없는 루프는 없다** — `caps`(라운드·비용·시간) 중 하나 이상이 없으면 `init` 이 거부한다.
7. **검증 자산은 maker 가 못 만진다** — held-out 프로브 + `protected[]` 글롭. "테스트를 고쳐 통과" 경로를
   파일 권한 수준에서 끊는다.

---

## 1. 아키텍처 — 보편 엔진 + 프로젝트 설정

```
<플러그인 루트>/                         # 보편 (모든 프로젝트 공유)
├── skills/loop/
│   ├── SKILL.md                        # 단일 진입점 (init/score/run/status 모드 분기)
│   ├── references/
│   │   ├── design.md                   # ← 이 문서 (계약)
│   │   ├── init-flow.md                # 스캔 + 인터뷰 → .loop/ 생성
│   │   ├── scoring.md                  # band · 가중 blend · 정규화 · anti-gaming
│   │   ├── cycle.md                     # 라운드 절차 (triage→fix→verify→rescore)
│   │   ├── stop.md                     # 종료 판정 (loop.mjs judge() 의 산문)
│   │   └── safety.md                   # local-only 가드 · protected · held-out
│   └── templates/
│       ├── loop.json.tmpl              # 설정 골격
│       ├── scorecard.md.tmpl           # 사람용 rubric SSoT
│       └── driver.js.tmpl              # 무인 Workflow 드라이버 뼈대
├── schemas/loop.schema.json            # ★ 설정 스키마 정본
├── scripts/loop.mjs                    # ★ 장부·판정 (check/init/record/verdict/status/session)
├── scripts/stop-loop.mjs               # Stop 훅 — 다음 라운드 프롬프트 되먹임
├── scripts/protect-gate.mjs            # PreToolUse 훅 — 보호 파일 편집 차단
└── hooks/hooks.json                    # 위 훅 등록

<project>/.loop/                        # 프로젝트별 (init 이 생성)
├── loop.json                           # 설정: dimensions · env · stop · caps · breaker · safety
├── scorecard.md                        # rubric 산문 + §점수이력 (사람이 읽고 편집)
├── scorecard.json                      # 최신 점수 (라운드·mode·active_total·domains·blocked)
├── checkpoint.json                     # 종료 상태 (rounds[] · 카운터 · verdict · next)
├── session.local.json                  # Stop 훅 루프 활성 상태 — ★gitignore
└── driver.js                           # 무인 Workflow 드라이버 (템플릿 + 프로젝트 값)
```

**보편 = 엔진·절차·스키마. 프로젝트별 = rubric·probe·env.**
`.loop/session.local.json` 은 세션 로컬 상태다 — 프로젝트 `.gitignore` 에 `.loop/*.local.json` 을 넣는다.

---

## 2. 단일 진입점, 의도 추론 (플래그 explosion 없음)

| 모드 | 트리거(자연어) | 동작 | 정지 |
|------|---------------|------|------|
| **init** | `.loop/` 없거나 "루프 셋업" | 코드베이스 스캔 → 인터뷰 → `loop.mjs init` | 생성 후 baseline 제안 |
| **score** | "재채점 / 완성도 몇 점" | rubric + probe → 점수 → `record` | 측정 후 |
| **run [N]** | "루프 N라운드 돌려" | **N=1** attended 1바퀴 / **N≥2** 무인(§6) | verdict 또는 caps |
| **status** | "루프 현황 / 다음 뭐" | `loop.mjs status` 요약 | — |

⛔ **Guard(스킬 시작 즉시)**: `.loop/loop.json` 이 없으면 → **init**. 있으면 → 의도 분류.

> **N 단일 다이얼**: "루프 10" = 10라운드(직관 일치). N=1 은 게이트를 끼운 attended, N≥2 는 무인.
> 첫 바퀴는 항상 보여주고 나머지를 맡긴다 — 그게 "stay the engineer" 의 실무 형태다.

---

## 3. `.loop/loop.json` 스키마 — 정본은 `schemas/loop.schema.json`

```jsonc
{
  "version": 1,
  "name": "<slug>",
  "goal": "<한 줄 — 끝나면 무엇이 참인가>",

  "dimensions": [                       // score function 의 축들. weight 합 = 1.000 (loop.mjs 가 검산)
    {
      "id": "checkout",                 // ^[a-z0-9][a-z0-9_-]*$ · 중복 불가
      "label": "주문 결제 흐름",
      "weight": 0.25,
      "evidence": ["src/order/Checkout.java:88 — 결제 확정 경로"],
      "probe": {                        // ★실환경 신호 (anti-gaming · local only)
        "kind": "http",                 // db | http | test | shell | grep
        "cmd": "curl -s localhost:8080/orders/1/settle -X POST",
        "expect": "200 + 원장 합계 불변",
        "held_out": false               // true = maker 에게 안 보인다, verify/full 에서만
      }
    }
  ],

  "env": { "start": "...", "db": "...", "test": "...", "auth": "..." },

  "stop":    { "target": 90, "consecutive": 2, "full_audit_every": 3 },
  "caps":    { "max_rounds": 12, "max_cost_usd": 8, "max_minutes": 180 },   // 하나 이상 필수
  "breaker": { "no_change_rounds": 2, "same_error_rounds": 3 },
  "triage_order": "auto",               // 또는 ["checkout", "inventory", ...]

  "safety": { "scope": "local-only", "forbid": ["git push", "rm -rf"], "auto_merge": false }
}
```

**설정을 손으로 쓰지 않는다** — 만들 때는 `loop.mjs init`, 고친 뒤에는 항상:

```bash
node "<P>/scripts/loop.mjs" check --json    # weight Σ=1 · caps ≥1 · auto_merge=false · id 중복
```

`<P>` = 플러그인 루트 절대 경로. `scorecard.md` 는 같은 rubric 의 **산문 SSoT**(축별 FULL/PARTIAL/MISSING
정의 + §점수이력 append). 기계는 json 을 파싱하고, 사람은 md 를 읽는다.

---

## 4. `init` — 스캔 + 인터뷰 (여기가 "기획" 엔진)

```
[A 스캔]  read-only 자동 탐지: 언어·프레임워크 · 테스트 커맨드 · 기동 방법 · DB 설정 · 인증 방식
          · 모듈 경계 → dimension 후보 · CI 스크립트 → probe 후보
   ↓
[B 인터뷰] 스캔 결과를 보여주고 사람이 확정: ①목표 한 줄 ②dimensions + weights(Σ=1)
          ③각 축 probe = "코드 존재가 아닌 실동작" 신호 ④env ⑤stop.target ⑥★caps
   ↓
[C 생성]  loop.mjs init --name --goal --max-rounds … --dimensions <json>
          → .loop/{loop.json, checkpoint.json, scorecard.json} + scorecard.md + driver.js
   ↓
[D baseline] "지금 baseline 잴까요?" → score(full) 1회 → record → §점수이력 R0
```

**caps 없이는 생성되지 않는다.** `--max-rounds`/`--max-cost-usd`/`--max-minutes` 중 하나도 없으면 `init` 이
exit 2 로 거부한다("상한 없는 루프는 시작할 수 없다"). 인터뷰에서 반드시 묻는 항목이다.

> 스캔이 **초안을 제안**하고 인터뷰가 **확정**한다. 스캔만 믿으면 축을 오판하고, 인터뷰만이면 매번 처음부터다.

---

## 5. `score` — 측정 엔진 (`references/scoring.md`)

```
1 사전조건: env.start 가 살아 있나? 죽었으면 live probe 신호 = STALE (거짓 상승 방지)
2 신호수집: dimension 별 probe 실행 — full 은 축별 fan-out(병렬, compact 결과만 회수) / per-round 는 1축만
3 band:     관찰된 동작 → FULL / PARTIAL / CONFLICT / MISSING
4 blend:    축 점수 = 가중 blend (단순평균 ❌) — 최약 고리가 지배해야 한다
5 normalize: BLOCKED 축을 분자·분모에서 함께 제외 → active_total
6 기록:     loop.mjs record --mode … --active … → verdict · next 반환
```

**출력 전 anti-gaming 자기점검**: 테스트 개수로만 올렸나 / 정적 grep 0건을 PASS 로 셌나 / BLOCKED 를 억지로
늘려 분모를 줄였나 / 앱이 죽었는데 PASS 로 셌나 → 의심되면 낮게 + STALE.

---

## 6. `run [N]` — attended / 무인

**N=1 (attended, `references/cycle.md`)**

```
triage(checkpoint.next) → ★게이트 "이 deficit 맞나?" → fix(maker sub-agent)
  → verify(다른 sub-agent · held-out 포함 실probe) → score(per-round)
  → loop.mjs record → verdict 보고 후 정지
```

**N≥2 (무인) — 두 방식**

| 방식 | 뼈대 | 언제 |
|------|------|------|
| **Stop 훅 모드** | `loop.mjs session start --session-id <id> --prompt "<라운드 프롬프트>"` 뒤, 세션이 끝나려 할 때마다 `stop-loop.mjs`(Stop 훅)가 다음 라운드 프롬프트를 되먹인다 | 한 세션 안에서 계속 돌 때. 가장 가볍다 |
| **Workflow 드라이버** | `templates/driver.js.tmpl` 을 채운 `.loop/driver.js` 를 Workflow 로 실행. 라운드마다 maker/verifier 를 sub-agent 에 위임 | 라운드마다 컨텍스트를 갈아야 할 때 |

두 방식 모두 **판정을 자체 계산하지 않는다.** 매 라운드 `loop.mjs record --json` 을 부르고 반환된
`verdict`(및 exit 1)로 탈출한다. Stop 훅은 `session_id` 로 격리되어 같은 프로젝트의 다른 세션을 막지 않고,
verdict 가 STOP/ESCALATE 이거나 상한에 닿으면 세션 파일을 비활성화하고 통과시킨다.

드라이버 반환: `{ rounds, last_active, cap_hit, stop_reason, branch, produced[] }` — **머지는 안 한다.**

---

## 7. 종료 (`references/stop.md`)

```
caps 도달                              → STOP (cap_hit: true — "됐다" 가 아니라 "예산이 끝났다")
full 에서 active ≥ target × consecutive → STOP (done)
변경 0 / 같은 에러 / no-progress        → ESCALATE (사람 호출)
외부 의존 부재                          → BLOCKED 라벨 + 분자·분모 제외 + surface + CONTINUE
그 외                                   → CONTINUE
```

`consecutive_at_target` 은 **full 라운드에서만** 증감하고 target 미달이면 0 으로 리셋된다. per-round 부분
점수로 STOP 을 선언하지 않는다 — 방금 고친 축만 보고 끝내면 국소 회귀를 못 본다.

---

## 8. 안전·범위 (`references/safety.md`)

- **local-only** — probe·fix 는 local 범위만. 운영/원격 write · 외부 cutover · 자격증명 · force push 금지.
  `safety.forbid` 가 차단 목록이고, 걸리면 abort + surface(그 라운드는 점수 미반영).
- DB probe 는 **read-only**. 마이그레이션은 local 적용만(원격은 사람 게이트).
- **`auto_merge: false` 는 불변** — 스키마가 `false` 만 허용하고 `loop.mjs` 가 설정을 거부한다.
- **code-only** — `probe.kind` 는 코드 신호(db/http/test/shell/grep)뿐. 글쓰기·리서치 루프는 범위 밖.
- **held-out + protected** — maker 는 판정 프로브를 보지 못하고, `protected[]` 글롭의 검증 자산을 편집하지
  못한다(`protect-gate.mjs`). maker ≠ verifier.

---

## 9. 이슈 워크플로와의 관계

루프는 독립 도구가 아니라 `/caseworker:issue` 워크플로의 **implement→verify 구간을 여러 번 도는 엔진**이다.

| 층 | 소유 | 상태 파일 |
|----|------|----------|
| 이슈 한 건의 생애 | issue 워크플로 | `.claude/runtime/issues/<slug>.json` |
| 그 안에서 도는 완성도 라운드 | loop | `.loop/checkpoint.json` |
| 커밋·push 허가 | commit-gate 훅 | 위 상태 JSON + 게이트 지문 + 리뷰 기록 |

- **held-out 은 두 층에서 같은 축이다** — loop 의 `probe.held_out` 과 상태 JSON DoD 의 `held_out` 둘 다
  "maker 가 보는 게이트 ≠ 판정하는 게이트" 를 만든다. `gate.mjs --commit` 은 held-out DoD 를 건너뛰고
  `--full` 에서만 돈다.
- **루프는 커밋 권한을 만들지 않는다.** STOP 이 났다고 push 가 열리지 않는다 — commit/push 는 여전히
  `commit-gate.mjs` 가 판정하고, 머지는 사람이 한다.

---

## 10. 검증 계획 (이 설계가 참인지 어떻게 아나)

1. **스키마 왕복** — `loop.mjs init` 산출물이 `loop.mjs check` 를 통과하는가. weight 합을 1 이 아니게,
   caps 를 비게, `auto_merge: true` 로 각각 망가뜨려 **셋 다 exit 2 가 나는지** 확인한다(존재 ≠ 실효).
2. **판정 왕복** — `record` 를 인위적 시퀀스로 먹여 STOP(target 연속)·STOP(cap)·ESCALATE(변경 0)·
   ESCALATE(같은 에러)·CONTINUE 다섯 갈래가 모두 발화하는지 본다.
3. **격리** — Stop 훅이 다른 `session_id` 의 세션을 막지 않는지.
4. **보편성** — 성격이 다른 두 번째 프로젝트에 `init`→`score`→`run 1` 을 돌려, 축·probe 를 새로 짜는 것만으로
   엔진 수정 없이 도는지 확인한다.
