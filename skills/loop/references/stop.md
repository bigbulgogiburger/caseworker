# `loop` — 종료 판정 (STOP / ESCALATE / BLOCKED)

> **정본 알고리즘은 산문이 아니라 코드다** — `<P>/scripts/loop.mjs` 의 `judge()` 가 유일한 판정자다.
> 이 문서는 그 함수를 사람이 읽을 수 있게 풀어 쓴 것이지, 별도의 규칙이 아니다.
> 스킬·드라이버·사람 누구도 **점수를 보고 직접 STOP 을 선언하지 않는다** — `loop.mjs record` 를 부르고,
> 그 출력의 `verdict` 를 따른다. 산문과 코드가 어긋나면 **코드가 맞다**(그리고 이 문서가 버그다).

판정은 4갈래다 — `STOP` / `ESCALATE` / `BLOCKED` / `CONTINUE`. "거의 다 됐다" 로 멈추는 길은 없다.

---

## 0. 왜 종료를 스크립트에 맡기나

종료가 세션의 직감에 맡겨지면 두 가지가 동시에 깨진다:

- **거짓 STOP** — 국소 회귀를 못 본 채 "done" 을 선언한다. 방금 고친 축만 보고 끝내는 것이다.
- **무한 루프** — 무엇이 "끝" 인지 숫자로 안 박혀서 영원히 다음 deficit 만 처리한다. 비용은 계속 나간다.

그래서 종료는 **디스크 상태(`.loop/checkpoint.json`) + 설정(`.loop/loop.json`)의 순수 함수**로만 계산한다.
같은 입력이면 언제 몇 번을 불러도 같은 답이 나오고, 세션이 죽어도 재진입이 된다.

```bash
node "<P>/scripts/loop.mjs" record --mode full --active 91 --deficit money-flow \
     --changed-files 4 --cost-usd 0.42 --json
# → { "verdict": "CONTINUE", "reasons": [...], "next": { "round": 7, "mode": "full", "why": "..." }, ... }
```

`<P>` = 플러그인 루트 절대 경로. 종료 코드는 **0 = CONTINUE**, **1 = STOP 또는 ESCALATE**(실패가 아니라
"멈춰라"), **2 = 사용법·설정 오류**. 무인 드라이버의 탈출 조건은 이 exit 1 또는 `verdict !== 'CONTINUE'` 다.

---

## 1. 판정 우선순위 (judge 가 위→아래로 본다)

| 순위 | 조건 | verdict | 뜻 |
|-----|------|---------|-----|
| 1 | `caps` 도달 — `max_rounds` · `max_cost_usd` · `max_minutes` 중 하나 | **STOP** (`cap_hit: true`) | 예산 소진. 목표 달성이 아니다 |
| 2 | `mode: full` 이고 `consecutive_at_target ≥ stop.consecutive` | **STOP** | 진짜 done |
| 3 | 브레이커 OPEN — 파일 변경 0 연속 / 같은 에러 연속 | **ESCALATE** | 헛돌고 있다 |
| 4 | `no_progress ≥ stop.consecutive` | **ESCALATE** | 같은 deficit 에서 못 나온다 |
| 5 | 그 외 | **CONTINUE** | 다음 라운드 |

**cap 이 STOP 보다 위**인 게 중요하다. 상한은 목표보다 강하다 — 90 점을 못 찍었어도 라운드·비용·시간이
소진되면 멈춘다. 그리고 그 STOP 은 `cap_hit: true` 를 달고 나오므로 **"목표 달성 STOP" 과 구별된다**.
보고할 때 둘을 섞지 말 것: 하나는 "됐다", 다른 하나는 "예산이 끝났다" 다.

**BLOCKED 는 verdict 가 아니라 라벨이다** — `record --blocked a,b` 로 넘기면 그 dimension 이 분자·분모에서
빠진 채(§4) scorecard 에 기록되고, 루프는 그 dimension 을 triage 풀에서 제외한 뒤 **CONTINUE 한다**.
BLOCKED 하나가 전체 루프를 세우지 않는다.

---

## 2. STOP — full 점수로만

`consecutive_at_target` 은 **`--mode full` 라운드에서만 증감한다.** per-round 라운드는 이 카운터를 건드리지
않는다. 코드 그대로:

```
if (mode === 'full')
    consecutive_at_target = (active >= stop.target) ? consecutive_at_target + 1 : 0
// per-round 라운드 — 카운터 그대로 유지
```

- **target 미달이면 즉시 0 리셋.** "연속" 은 말 그대로 연속이다. 중간에 한 번이라도 떨어지면 처음부터다.
- per-round 는 **방금 고친 축만** 본다. 그 fix 가 옆 축을 회귀시켰을 수 있다(공유 모듈 수정이 다른 도메인의
  계약을 깨는 식). 시스템 전체가 target 에 닿았다는 신호는 전수 재채점에서만 나온다.

### full 은 언제 도나

`judge()` 가 매 라운드 `next` 필드에 다음 라운드의 mode 를 미리 박아 준다. full 이 되는 두 경우:

1. **주기** — `nextIndex % stop.full_audit_every === 0` (예: 3·6·9 라운드째).
2. **per-round 가 target 을 넘겼을 때** — `mode: 'per-round'` 인데 `active >= target` 이면 다음은 무조건
   full 이다(`why: "per-round 가 target 을 넘겼다 — full 로 확정"`). per-round 단독 STOP 금지의 실천이다.

드라이버·세션은 이 `next.mode` 를 읽어 다음 라운드의 채점 범위를 정한다 — 스스로 주기를 계산하지 않는다.

> `full_audit_every: 3`, `consecutive: 2` 라면 STOP 에는 최소 두 번의 full audit 가 깔린다(예: R6 full 91,
> R9 full 93 → 연속 2 → STOP). 그 사이 per-round 가 target 아래로 떨어져도 카운터는 full 시점끼리만 비교하므로
> per-round 노이즈가 STOP 을 막지도, 앞당기지도 않는다.

---

## 3. ESCALATE — 헛돌면 사람을 부른다

세 축이 각각 독립으로 ESCALATE 를 낸다. 어느 하나만 걸려도 나온다.

### 3.1 no-progress (점수 정체 + 같은 deficit)

```
improved     = prev ? (active > prev.active) : true
sameDeficit  = deficit != null && deficit === last_deficit
no_progress  = (!improved && (sameDeficit || deficit == null)) ? no_progress + 1 : 0
→ no_progress >= stop.consecutive  ⇒  ESCALATE
```

점수가 **오르지 않았고**(같거나 떨어졌고) **같은 deficit** 을 또 잡았으면 카운트가 오른다. deficit 을 아예
안 넘겼으면(`--deficit` 생략) 그것도 정체로 센다 — 무엇을 고쳤는지 못 말하는 라운드는 진전이 아니다.
한 번이라도 점수가 오르면 0 으로 리셋된다.

### 3.2 서킷브레이커 — 파일 변경 0 (`breaker.no_change_rounds`, 기본 2)

```bash
--changed-files 0     # 이 라운드가 코드를 한 줄도 안 바꿨다
```

연속 N 라운드 변경 0 이면 OPEN. 점수가 우연히 흔들려 no-progress 를 피해 가도 이 축이 잡는다.
maker 가 "분석만 하고 끝난" 라운드를 무한 반복하는 패턴의 정지 장치다.

### 3.3 서킷브레이커 — 같은 에러 (`breaker.same_error_rounds`, 기본 3)

```bash
--error "NullPointerException at OrderService.settle:212"
```

직전 라운드의 `last_error` 와 **문자열이 같으면** 연속으로 센다. 다르면 1 로 리셋. 그래서 에러 시그니처는
타임스탬프·랜덤 ID 를 뺀 **안정된 한 줄**로 정규화해서 넘겨야 한다 — 매번 달라지는 문자열은 브레이커를
영원히 열지 못하게 만든다.

> ESCALATE 는 실패가 아니다. "이 deficit 은 자동 루프의 범위를 넘었다" 는 정직한 정지다.
> 사람은 (a) 막힌 원인을 풀거나 (b) 그 축을 BLOCKED 로 재분류하거나 (c) triage 순서를 바꿔 우회시킨 뒤
> 다시 트리거한다. 거짓 진전보다 정지가 싸다.

---

## 4. BLOCKED — 분자·분모에서 함께 뺀다

`blocker` 는 루프가 코드로 풀 수 없는 외부 의존이다 — 미확정 업무 규칙, 미수령 스펙/인증서, 외부 API
cutover, 사람 결정 대기. 이런 dimension 을 분모에 남겨두면 `active_total` 이 영원히 target 에 못 닿아
STOP 조건 자체가 거짓이 된다.

```
blocked_weight  = Σ( weight_b )              # BLOCKED dimension 들의 가중 지분 합
blocked_contrib = Σ( score_b × weight_b )    # 그 dimension 들의 점수 기여 합

active_total = ( Σ_all( score_i × weight_i ) − blocked_contrib ) / ( 1 − blocked_weight )
```

검산 (단일 BLOCKED, weight 0.05, score 50, raw Σ = 62.0):

```
blocked_contrib = 50 × 0.05 = 2.5
active_total    = (62.0 − 2.5) / (1 − 0.05) = 59.5 / 0.95 ≈ 62.6   ✓
# ⚠ 흔한 오류: 62.0 / 0.95 = 65.3  ← 분자에서 blocked_contrib 를 안 뺀 값. 틀렸다.
```

이 재정규화는 **채점 쪽(`references/scoring.md`)의 일**이고, `loop.mjs` 는 그 결과인 `--active` 값을 받는다.
`--blocked a,b` 는 무엇이 빠졌는지 장부에 남기기 위한 것이다.

### anti-gaming — BLOCKED 남용 금지

분모가 줄면 점수가 오른다. 그래서 BLOCKED 는 **외부 의존 부재**일 때만이다.

- ✅ BLOCKED: 우리 코드 밖의 입력(미확정 규칙, 미수령 명세/인증서)이 없으면 *원리적으로* 못 고치는가?
- ❌ BLOCKED 아님: 코드로 고칠 수 있는데 어려워서 미룬 것. 그건 그냥 미해결 deficit 이다(점수 낮게 유지,
  triage 풀에 남김). 막혀서 못 풀면 그건 ESCALATE(§3)지 BLOCKED 가 아니다.

> **BLOCKED = 외부가 막음**(분모 제외 정당) / **ESCALATE = 루프가 못 풂**(분모 유지, 사람 호출).

blocker 가 해소되면 다음 `record` 에서 `--blocked` 목록에서 빼면 된다. 복귀 라운드는 점수가 출렁이므로
그 라운드를 STOP 후보로 보지 말고 다음 full 에서 안정화를 확인한다.

---

## 5. `checkpoint.json` — 종료 상태의 디스크 표현

`loop.mjs` 가 원자적으로(tmp → rename) 쓴다. **사람도 스킬도 손으로 고치지 않는다** — 카운터 조작은
그 자체가 점수 사기다.

| 필드 | 뜻 | 누가 바꾸나 |
|------|-----|-----------|
| `rounds[]` | 라운드 전체 이력 — `{index, at, mode, active, domains, deficit, changed_files, error, cost_usd, blocked, note, verdict, reason}` | `record` 가 append |
| `consecutive_at_target` | full audit 연속 target 도달 횟수 (§2) | full 라운드만 |
| `no_progress` | 동일 deficit 연속 미진전 (§3.1) | 매 라운드 |
| `no_change_streak` | 연속 파일 변경 0 (§3.2) | 매 라운드 |
| `same_error_streak` / `last_error` | 같은 에러 반복 (§3.3) | 매 라운드 |
| `last_deficit` | 직전 라운드가 잡은 deficit id | 매 라운드 |
| `spent_cost_usd` | 누적 비용 — `caps.max_cost_usd` 의 입력 | `--cost-usd` 누계 |
| `last_verdict` / `last_reason` | 마지막 판정과 사유 문자열 | 매 라운드 |
| `cap_hit` | 이번 STOP 이 상한 때문인가 | 매 라운드 |
| `next` | `{round, mode, why}` — 다음 라운드 지시. 정지면 `null` | 매 라운드 |
| `started_at` | 첫 라운드 시각 — `caps.max_minutes` 의 기준 | init/첫 record |

읽기만 하는 두 명령:

```bash
node "<P>/scripts/loop.mjs" verdict   # 디스크 상태로 마지막 판정 재계산(아무것도 안 바꾼다)
node "<P>/scripts/loop.mjs" status    # 현황 요약 — 라운드·점수·caps·소요·비용·next·Stop 훅 활성 여부
```

세션이 중간에 죽어도 `verdict` 한 번이면 어디서 멈췄는지 복원된다. 컨텍스트가 아니라 디스크가 기억한다.

---

## 6. 설정 (이 문서가 읽는 값)

```jsonc
// .loop/loop.json
{
  "stop":    { "target": 90, "consecutive": 2, "full_audit_every": 3 },
  "caps":    { "max_rounds": 12, "max_cost_usd": 8, "max_minutes": 180 },  // 셋 중 하나 이상 필수
  "breaker": { "no_change_rounds": 2, "same_error_rounds": 3 }
}
```

- **하드코딩 금지.** 이 문서의 알고리즘은 값에 독립이다. 어떤 프로젝트는 90×2×3, 다른 프로젝트는 85×3×5 다.
- `stop.consecutive` 가 STOP(연속 target)과 ESCALATE(연속 no-progress) 양쪽에 쓰이는 건 의도된 단일 다이얼이다
  — "얼마나 끈질기게 볼까" 노브 하나.
- `caps` 는 **비어 있을 수 없다.** `loop init` 이 거부한다(`checkConfig`). 상한 없는 무인 루프는 시작 자체가
  안 된다 — 자세한 건 `references/init-flow.md`.

---

## 7. 안전과의 교차

종료 로직도 안전 불변(`references/safety.md`)을 넘지 않는다.

- **`auto_merge: false` 불변** — STOP 은 "done 선언 + 브랜치 핸드오프" 까지다. 머지는 항상 사람이다.
  STOP 이 머지를 트리거하지 않는다.
- **local-only** — `safety.forbid` 위반을 요구하는 deficit 은 자동 실행하지 않고 BLOCKED 또는 ESCALATE 로
  surface 한다. 차단된 fix 로 점수를 올리는 것은 점수 사기다.
- **원격 반영** — 마이그레이션·배포처럼 원격 쓰기가 남은 축은 local 검증까지만 점수에 넣고 "원격 게이트 대기"
  로 BLOCKED 표기 후 surface 한다.

---

## 8. 한 줄 요약

> **판정은 `loop.mjs record` 가 한다.** cap 도달 → STOP(`cap_hit`) · full 에서 target 연속 `consecutive` 회
> → STOP · 변경 0/같은 에러/no-progress → ESCALATE · 외부 의존 부재 → BLOCKED 라벨 + 분자·분모 제외 후
> CONTINUE · 그 외 CONTINUE. 상태는 `checkpoint.json` 에 영속하고, 머지는 끝까지 사람이 한다.
