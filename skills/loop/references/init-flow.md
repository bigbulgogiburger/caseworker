# `loop init` — 코드베이스 스캔 + 풀 인터뷰 → `.loop/` 생성

> `init` 모드는 loop 프레임워크의 **"기획" 엔진**이다 — read-only 스캔이 `dimensions`·`probe`·`env`
> 초안을 *제안*하고, 풀 인터뷰가 그것을 *확정*한다. 스캔만 믿으면 dimension 오판, 인터뷰만이면 매번
> 처음부터 — 둘을 합쳐 자동의 속도 + 사람의 정확도를 얻는다.
>
> **쓰기는 스크립트가 한다.** `.loop/loop.json`·`checkpoint.json`·`scorecard.json` 골격은
> `loop.mjs init` 이 만들고, 유효성은 `loop.mjs check` 가 판정한다. 이 문서는 *무엇을 물어
> 무엇을 채우나*만 정한다. `<P>` 표기는 SKILL.md 상단 규약을 따른다.

---

## ⛔ Guard — 언제 init 으로 들어오나 (SKILL.md 가 호출)

```bash
node "<P>/scripts/loop.mjs" check --json
```

| 결과 | 결론 |
|------|------|
| `.loop/loop.json 이 없다` (exit 2) | → **init 모드** (이 문서) |
| exit 0 | → score / run / status 의도 분류 (init 아님) |
| exit 2 + `errors[]` | → 설정은 있으나 무효. **재-init 아님** — 그 항목만 고치고 재-check (§0.6) |
| 사용자가 명시적으로 "루프 셋업/시작/init" | → init 모드 (이미 있으면 §0) |

### § 0. 재-init (이미 `.loop/` 가 있는데 init 요청)

기존 자산을 **덮어쓰지 않는다**. `loop.mjs init` 은 `loop.json` 이 이미 있으면 `--force` 없이는
거부한다. 다음을 사용자에게 제시 후 1회 확인:

```
ℹ️ .loop/ 가 이미 존재합니다 (loop.json: <N> dimensions, 마지막 라운드: R<k>=<active_total>).
   무엇을 하시겠어요?
     1) 재-스캔만 (스택 변동 감지 → 제안만, 기존 loop.json 보존)
     2) dimension 추가/수정 (인터뷰 §B 부분 실행 → 해당 항목만 patch → loop.mjs check)
     3) 전체 재생성 (.loop/loop.json.bak 백업 후 loop.mjs init --force — 점수이력은 scorecard.md 에 보존)
     4) 취소
```

`scorecard.md` 의 §점수이력과 `checkpoint.json` 의 `rounds[]` 는 **절대 파기하지 않는다**
(append-only 자산). 3) 을 고르더라도 §이력 블록은 carry-over 하고, `--force` 가 재초기화한
`checkpoint.json` 의 손실을 사용자에게 명시한다.

### § 0.5. init 파라미터 (목표·상한 사전 입력)

init 호출 인자에 `key=value` 형식이 있으면 해당 값을 **사전 채택**하고 [B-5]/[B-6] 의 그 질문을
생략한다(나머지 인터뷰 단계는 그대로). 지원 파라미터:

| param | 매핑 (`loop.mjs init` 플래그) | 예 | 미지정 시 |
|-------|------------------------------|-----|----------|
| `target=<N>` | `--target` → `stop.target` | `target=95` | [B-5] 질문 — 기본 **90** |
| `consecutive=<N>` | `--consecutive` → `stop.consecutive` | `consecutive=3` | 기본 **2** |
| `full_audit_every=<N>` | `--full-audit-every` → `stop.full_audit_every` | `full_audit_every=5` | 기본 **3** |
| `max_rounds=<N>` | `--max-rounds` → `caps.max_rounds` | `max_rounds=8` | [B-6] 질문 — ★필수 3종 중 1 |
| `max_cost_usd=<X>` | `--max-cost-usd` → `caps.max_cost_usd` | `max_cost_usd=25` | 〃 |
| `max_minutes=<M>` | `--max-minutes` → `caps.max_minutes` | `max_minutes=180` | 〃 |

- **파싱**: 인자에서 `key=value`(공백·콤마 구분 허용) 추출 → 범위 검증(`target` 1~100, 나머지 ≥1).
  형식오류면 무시하고 질문으로 폴백.
- **범위**: param 은 **목표·종료·상한만** 받는다 — `dimensions`/`weights`/`probe`/`env` 는 코드베이스
  고유라 param 화하지 않고 스캔+인터뷰로 확정(invariant #5: 사람이 루프 안에).

### § 0.6. 설정은 있는데 `check` 가 거부할 때

`loop.mjs check` 가 뱉는 실패는 셋 뿐이고, 전부 고치기 전에는 다른 모드로 갈 수 없다:

| 에러 | 뜻 | 고치는 법 |
|------|----|----------|
| `dimensions.weight 합이 …` | Σ≠1.000 | 비례 정규화(`w_i / Σw`) 제안 → 사용자 확인 → 편집 |
| `caps 에 max_rounds · max_cost_usd · max_minutes 중 하나 이상이 필요하다` | 상한 없음 | [B-6] 질문 1개 |
| `safety.auto_merge 는 false 여야 한다` | 불변 위반 | 되돌린다. 사용자가 원해도 거부하고 이유 설명 |

---

## [A] 스캔 — 코드베이스 자동 탐지 (read-only, 부작용 0)

목표: 사람이 처음부터 채우지 않도록 `dimensions`·`env`·`probe` **초안**을 제안한다.
**모든 스캔은 read-only** — 빌드/테스트/DB write 실행 금지(스캔 단계에서는 신호 *수집처*만 식별,
실행은 [D] baseline 에서). `safety.scope=local-only` 선언 전이므로 원격 접근도 금지.

### A-1. 언어 / 프레임워크 / 빌드 도구

manifest 파일 존재로 스택을 판정 (우선순위: 루트 → 서브디렉토리):

| 탐지 파일 | 스택 | 추론하는 `env` 초안 |
|-----------|------|---------------------|
| `package.json` | Node / JS·TS (scripts 파싱) | `test`= `scripts.test`, `start`= `scripts.dev\|start` |
| `build.gradle(.kts)` / `gradlew` | JVM (Gradle) | `test`= `./gradlew test`, `start`= `bootRun`(Spring) |
| `pom.xml` | JVM (Maven) | `test`= `mvn test`, `start`= `spring-boot:run` |
| `go.mod` | Go | `test`= `go test ./...`, `start`= `go run .` |
| `requirements.txt`/`pyproject.toml`/`setup.py` | Python | `test`= `pytest`, `start`= uvicorn/manage.py |
| `Cargo.toml` | Rust | `test`= `cargo test`, `start`= `cargo run` |
| `Gemfile` | Ruby | `test`= `rspec\|rake test` |
| `composer.json` | PHP | `test`= `phpunit` |

> **Glob/Grep 우선** (Bash `cat`/`find` 금지): `Glob "**/{package.json,build.gradle,go.mod,pom.xml,Cargo.toml,requirements.txt,pyproject.toml}"`
> 로 매니페스트 위치 수집 → 각 파일 `Read`.
> Monorepo (매니페스트 다수) → 서브프로젝트별 스택을 표로 모아 인터뷰에서 "어느 경계를 dimension 으로 쓸지" 질문.

### A-2. 테스트 / 기동 / DB / 인증 신호 채집

`env.{start,test,db,auth}` 초안의 근거를 코드/설정/스크립트에서 채집:

- **test 커맨드**: 매니페스트 scripts + CI 파일(`.github/workflows/*.yml`, `.gitlab-ci.yml`, `Makefile`)에서 실제 테스트 호출 라인 추출. CI 가 SSoT — 로컬 README 추정보다 신뢰.
  - ⚠️ **함정 grep**: 데몬/워커 플래그 주의 라인이 있는지(`--no-daemon`, `-T`, `--runInBand`, `maxWorkers`). 프로젝트별 테스트 함정을 `env.test` 값 안에 주석처럼 병기한다.
- **기동(start) + readiness**: dev 서버 명령 + "떴다" 신호 패턴. 포트만으로 판정 금지 — 로그 토큰(`Started`/`Listening on`/`ready in`) 또는 health 엔드포인트가 readiness SSoT(stale 프로세스의 포트 점유 오판 방지). `env.start` 는 "기동 + readiness 폴링"을 한 줄로.
- **DB 설정**: `application*.yml`/`.env`/`docker-compose*.yml`/`*.properties` 에서 로컬 DB host·port·schema·driver 추출. **read-only probe 명령**만 초안(`SELECT … LIMIT`/`SHOW`). 접속 문자열·자격증명은 `loop.json` 에 **평문 저장 금지** — 환경변수 참조 또는 "사용자가 로컬에 보유" 로 표기.
- **인증(auth)**: 로그인 엔드포인트 + 토큰 발급 방식 탐지(`/login`, JWT, 세션). IDOR/scope probe 를 위해 **비-권한(non-admin) 계정**으로 토큰 얻는 법이 핵심 — 관리자 계정으로만 probe 하면 전부 200 이라 누설을 못 본다. 테스트 계정이 코드/문서에 있으면 후보로, 없으면 인터뷰에서 질문.

### A-3. 모듈 경계 → dimension 후보 자동 제안

dimension(=score function 의 축)을 코드 구조에서 유추:

1. **도메인 디렉토리**: `src/{domain,modules,features}/*`, 패키지 트리(`com.x.{order,payment,…}`), `apps/*`(monorepo) → 각 1차 후보.
2. **라우트/컨트롤러 그룹**: REST 컨트롤러·라우터 파일의 prefix 묶음(`/orders`, `/users`) → 기능 축.
3. **기존 품질 신호**: 커버리지 리포트·E2E 디렉토리·`SECURITY.md`·성능 벤치 → "테스트/보안/성능" 같은 **횡단(cross-cutting) dimension** 후보.
4. **기존 스코어카드가 있으면 import**: `docs/*scorecard*.md` 류 문서를 발견하면 그 도메인·가중치를 그대로 초안으로 쓴다(마이그레이션 경로).

> dimension 은 **3~8개** 권장. 너무 잘게 쪼개면(파일 단위) blend 가 무의미, 너무 뭉치면(전체 1개)
> binding-constraint 진단이 불가능하다. 스캔은 후보를 넉넉히 제안하고 인터뷰에서 병합/삭제.

### A-4. probe 후보 수집 (실동작 신호 ≠ 코드 존재)

각 dimension 후보마다 **"코드가 있다"가 아니라 "관찰된 동작이 충족한다"** 를 증명할 probe 초안
(`probe.{kind,cmd,expect,held_out}`). 스캔이 제안하는 5종 kind:

| kind | 무엇을 신호로 | 초안 출처 | anti-gaming 가치 |
|------|--------------|-----------|------------------|
| `db` | 불변식·보존법칙 (예: 출고 전후 `SUM(qty)` 보존, UNIQUE 제약 존재) | DDL/마이그레이션 + 도메인 규칙 | 앱레벨 race 우회를 DB 진실로 검증 |
| `http` | 200 + **실데이터** / 비-권한 토큰 **403** / 계약 위반 시 **4xx 기대** | 컨트롤러 + auth 신호 | 정적 grep 이 못 보는 런타임 500·IDOR |
| `test` | 특정 스위트 통과(개수 아님, **회귀 기준선** + 커버 지점) | CI 테스트 호출 | "개수만 늘림" gaming 차단 |
| `shell` | 벤치/스크립트의 정량 임계(레이턴시·exit code) | Makefile/bench | 성능 회귀 |
| `grep` | dead-path 탐지 (호출처 0건 = producer 부재) — **보조로만** | 소스 트리 | "자산 존재 ≠ 운영 배선" |

> ⚠️ `grep` 단독으로 PASS 매기지 말 것. "grep 0건"은 거짓음성(이름만 다른 호출처 존재 가능) —
> 가능하면 db/http 실신호로 교차확인. `probe.expect` 는 **PASS 의 모습**을 한 줄로
> (예: `"출고 후 SUM 불변(증가=0)"`, `"비-권한 토큰 403"`, `"200 & body[].id 존재"`).

### A-4b. held-out 후보 표시 (anti-gaming 의 두 번째 층)

probe 중 **maker 에게 보여주면 그것만 맞춰 통과시킬 수 있는 것**은 `held_out: true` 로 표시한다.
held-out probe 는 fix 레인 프롬프트에 **문구조차 노출하지 않고** verifier/full 채점에서만 돈다.

- 좋은 held-out 후보: 보존법칙 `db` probe, 비-권한 403 `http` probe, 계약 위반 4xx 기대.
- 나쁜 held-out 후보: maker 가 그걸 모르면 애초에 구현 방향을 못 잡는 기능 정의 자체.
- 같은 규율이 caseworker 상태 JSON 의 DoD 에도 있다 — `held_out: true` 인 DoD 항목은
  `gate.mjs --commit` 이 건너뛰고 `--full` 에서만 돈다. 축을 맞춰 두면 두 게이트가 같은 뜻을 갖는다.

### A-5. 스캔 요약 (인터뷰 입력)

스캔이 끝나면 사용자에게 **초안 카드**를 한 번에 제시(여기서 결정하지 않음 — [B] 로 넘김):

```
🔍 코드베이스 스캔 결과 (read-only, 0 부작용)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
스택        : <Node 20 + Express (backend) + React (web)> [monorepo 2-subdir]
env 초안    :
  start = <npm --prefix backend run dev & until curl -sf localhost:8080/health; do sleep 2; done>
  test  = <npm test  ⚠ CI 는 --runInBand 로 돈다(병렬 시 DB 충돌)>
  db    = <psql -h 127.0.0.1 -p 5432 -U app -d appdev  (read-only: SELECT/SHOW)>  ⚠ 자격증명 평문 금지
  auth  = <POST /auth/login (JWT). 비-admin 토큰 필요 — 계정 미발견, 인터뷰에서 질문>
dimension 후보 (스캔 제안, weight 미정):
  1. orders     (src/domain/orders — 주문 결제 흐름)   probe: db 금액 합계 보존
  2. inventory  (src/domain/inventory — 재고)          probe: db SUM 불변
  3. catalog    (src/domain/catalog — 상품 마스터)     probe: db UNIQUE 제약
  4. security   (횡단 — IDOR/scope)                    probe: http 비-권한 403  [held-out 후보]
  … (총 <K>개)
기존 스코어카드 발견: <docs/quality-scorecard.md → 5도메인 import 가능 | 없음>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
이제 인터뷰로 이 초안을 확정합니다. (6단계)
```

---

## [B] 인터뷰 — 풀 확정 (스캔 제안 → 사람 보정)

**풀 인터뷰** — 6단계 순서대로, 각 단계는 스캔 제안을 보여주고 수정만 받는다(빈 화면에서 묻지 않음).
사용자가 "스캔대로 OK" 하면 그 단계 즉시 통과. 선택형은 **한 번에 하나씩** 묻는다.

### B-1. 목표 (goal — 한 줄 성공 기준)

```
1️⃣ 목표 — 루프가 끝나면 "무엇이 참"이어야 하나요? (한 줄)
   예: "주문 결제 흐름이 실환경에서 정합 — 금액 누설 0, 재고 보존법칙 위반 0, 활성 종합 ≥95×2연속"
   스캔 추정: <기존 스코어카드 goal | 미정 — 직접 입력>
```

`goal` 은 막연("더 좋게") 금지 — **검증 가능한 종단 상태**여야 한다(invariant #1). 모호하면 1회 되물음.

### B-2. dimensions + weights (Σ = 1.0 검산 ★)

스캔 후보를 제시하고 **병합/삭제/추가 + weight 배정**:

```
2️⃣ dimensions + weights — 점수 축과 비중을 정합니다. Σ weights = 1.0
   (스캔 제안 <K>개. 비중은 "실패 시 가장 아픈 곳"에 높게)

   id          label            weight   probe(요약)
   inventory   재고/보존        0.22     db SUM 보존
   orders      주문 결제        0.24     http 결제 200 + 원장 행
   catalog     상품 마스터      0.16     db UNIQUE
   security    IDOR/scope       0.10     http 비-권한 403   [held-out]
   …                            ─────
                                Σ=1.00   ← 검산
   조정할 축/비중을 알려주세요 (병합·삭제·추가·weight 변경). OK면 'OK'.
```

⚠️ **Σ=1.0 은 [C] 의 하드 게이트다** — `loop.mjs check` 가 ±0.001 밖이면 거부한다. 어긋나면:
- 자동 제안: 비례 정규화(`w_i / Σw`) 결과를 보여주고 수용 여부 확인.
- 점수를 못 올릴 BLOCKED 축이 있어도 **weight 에서 빼지 않는다** — 포함해 두고 채점 때 분자·분모에서
  제외해 재정규화한다(scoring.md). 룰이 확정되면 활성 복귀.

`id` 는 소문자 슬러그(`^[a-z0-9][a-z0-9_-]*$`)여야 하고 `scorecard.md` 섹션과 1:1 이다.

### B-3. 각 축 probe = 실동작 신호 (확정 + held-out 지정)

```
3️⃣ probe — 각 축의 "점수를 올렸다"를 증명할 실환경 신호입니다.
   (코드 존재가 아니라 관찰된 동작 — anti-gaming 핵심)

   inventory →  kind: db
                cmd : SELECT SUM(on_hand_qty) FROM inventory_stock   (출고 전후 2회)
                expect: 출고 후 SUM 불변 (증가분 0 — 보존법칙)
                held_out: true   ← maker 에게 안 보여줍니다
   security  →  kind: http
                cmd : curl -H "Authorization: Bearer $NONADMIN" localhost:8080/orders/<남의것>
                expect: 403 (비-권한 토큰)
                held_out: true
   …
   probe 가 비현실적이거나(환경 부재) 더 강한 신호가 있으면 알려주세요.
   held-out 으로 감출 축이 더 있나요?
```

probe 가 환경상 불가능한 축(예: 외부 인증서 필요)은 **BLOCKED** 로 표기 후 진행(분모 제외 대상).
`expect` 가 비어 있으면 채우도록 요구 — expect 없는 probe 는 PASS/FAIL 판정이 불가능하다.

### B-4. env 확정 (기동/DB/test/auth)

```
4️⃣ env — 루프가 "세계를 살리는" 법입니다. (스캔 초안 확인)
   start: <…>                     ← 기동+readiness, 맞나요?
   test : <…>  ⚠ 함정: <플래그…>   ← 테스트 커맨드 + 주의
   db   : <… read-only>           ← local only, 자격증명은 환경변수/로컬 보유
   auth : <비-권한 토큰 획득법>    ← 미발견 시 여기서 입력
```

**핵심 게이트**: `auth` 의 비-권한 계정이 확정돼야 IDOR/scope probe 가 의미를 갖는다 — 누락 시 명시적으로
질문한다. DB 자격증명을 `loop.json` 에 평문으로 받지 않는다(safety.md).

### B-5. stop — 종료 조건

```
5️⃣ 종료 조건   (★ §0.5 param 으로 받은 값은 질문 생략·확인만)
   stop.target          : <param 있으면 그 값 / 없으면 질문 — 기본 90>  ← 이 점수 이상이 done
   stop.consecutive     : <기본 2>   ← full audit 에서 target 을 연속 몇 회 (국소회귀 방지)
   stop.full_audit_every: <기본 3>   ← 권위 재채점 주기(라운드)
```

### B-6. caps + breaker + 범위 가드 (★ 없으면 init 이 거부된다)

```
6️⃣ 상한과 안전   ← ★caps 는 선택이 아닙니다
   caps (최소 1개 필수):
     max_rounds    : <예 8>     ← 라운드 상한
     max_cost_usd  : <예 25>    ← 누적 비용 상한(record --cost-usd 로 적립)
     max_minutes   : <예 180>   ← 시작 이후 경과 상한
   breaker:
     no_change_rounds : 2       ← 연속 N 라운드 "파일 변경 0" 이면 OPEN → ESCALATE
     same_error_rounds: 3       ← 같은 에러 시그니처 M 회 반복이면 OPEN → ESCALATE
   safety.scope     : local-only            (고정 — 변경 불가)
   safety.forbid    : ["git push", "rm -rf", "--force", <프로젝트 prod-write 패턴…>]
   safety.auto_merge: false                 (고정 — 스키마가 false 만 허용)
   추가로 금지할 명령/경로가 있으면 알려주세요.
```

**왜 필수인가**: 상한 없는 루프는 "언제 멈추나"를 점수에만 맡긴다 — 점수가 오르지 않는 국면에서
비용만 태운다. `loop.mjs init` 은 caps 3종이 모두 비면 exit 2 로 거부한다.
`safety.scope=local-only` 와 `auto_merge=false` 는 **불변** — 사용자가 바꾸려 해도 거부하고 이유를 설명한다.
`forbid` 에는 프로젝트별 prod-write 패턴(원격 마이그레이션 명령, 운영 도메인 호출, 배포 CLI)을 보강한다.

---

## [C] 생성 — 스크립트로 골격, 편집으로 확정

**생성 전 1회 최종 확인**:

```
📁 다음 자산을 .loop/ 에 생성합니다:
   loop.json       (설정 — dimensions <K>개, Σweight=1.00 ✓, target=<95>×<2>, caps={max_rounds:8})
   checkpoint.json (런타임 상태 — 빈 골격)
   scorecard.json  (런타임 점수 — baseline 후 채워짐)
   scorecard.md    (rubric 산문 + §점수이력 헤더)
   driver.js       (선택 — Workflow 무인 드라이버)
진행할까요? (yes / 항목 수정 / 취소)
```

승인 시 순서대로:

**1. 골격 생성 (스크립트)** — dimensions 는 인터뷰 결과를 JSON 파일로 써서 넘긴다:

```bash
# 인터뷰 확정 dimensions 를 임시 JSON 으로 저장 (Write 툴)
#   .loop/dimensions.init.json  = [{ "id": "...", "label": "...", "weight": 0.22,
#                                    "evidence": ["path:line — 무엇을 증명/반증하는가"],
#                                    "probe": { "kind": "db", "cmd": "...", "expect": "...", "held_out": true } }, …]
node "<P>/scripts/loop.mjs" init \
  --name <project-slug> --goal "<한 줄 성공 기준>" \
  --target 95 --consecutive 2 --full-audit-every 3 \
  --max-rounds 8 \
  --dimensions .loop/dimensions.init.json --json
```

`--dimensions` 를 생략하면 `core` 한 축(weight 1)의 placeholder 가 들어간다 — 인터뷰를 마쳤다면
반드시 넘긴다. caps 플래그가 하나도 없으면 여기서 거부된다(§B-6).

**2. loop.json 편집 (Edit 툴)** — 스크립트가 채우지 못하는 값은 인터뷰 결과로 직접 넣는다:

| 키 | 무엇 |
|----|------|
| `env.start` / `env.db` / `env.test` / `env.auth` | [B-4] 확정값 (init 은 `null` 로 둔다) |
| `safety.forbid` | [B-6] 에서 보강한 프로젝트 패턴 (기본 3개에 추가) |
| `breaker` | 기본 `{no_change_rounds:2, same_error_rounds:3}` 에서 바꿀 때만 |
| `triage_order` | `"auto"`(weakest-link-first) 또는 dimension id 배열 |

⚠️ 스키마에 없는 키를 새로 만들지 않는다. 자격증명 평문 0건을 쓰기 직전 확인한다.

**3. 검증 (하드 게이트)**:

```bash
node "<P>/scripts/loop.mjs" check --json
```

`ok:true` 가 아니면 §0.6 표대로 고치고 다시 돌린다. **여기를 통과하지 못한 채 [D] 로 가지 않는다.**

**4. `scorecard.md` 작성** — `templates/scorecard.md.tmpl` 을 채워 `.loop/scorecard.md` 로 쓴다.
dimension 마다 FULL/PARTIAL/CONFLICT/MISSING 산문 정의를 초안으로 채우고, §점수이력은 헤더만 남긴다.
이게 사람이 읽는 rubric SSoT(`loop.json` 은 기계용) — 숫자(weight)는 JSON, 산문·이력은 md.

**5. `driver.js`(선택)** — 무인 Workflow 방식을 쓸 계획이면 `templates/driver.js.tmpl` 의
`{{NAME}}`·`{{BRANCH_FALLBACK}}`·`{{PLUGIN_ROOT}}`·`{{ENV_*}}`·`{{FORBID_LIST}}` 를 확정값으로 치환해
`.loop/driver.js` 로 쓴다. **STOP 상수는 치환하지 않는다** — 판정은 드라이버가 아니라 `loop.mjs record`
가 하므로 target/consecutive 를 드라이버에 복제하지 않는다(SSoT drift 방지). Stop 훅 방식만 쓸 거라면
이 단계는 건너뛴다.

> 멱등성: 재-init(§0)이 아닌 한 기존 파일 덮어쓰기 금지. 모든 쓰기 전 `Read` 로 존재/내용 확인.

---

## [D] Baseline — R0 측정 (생성 직후 chain)

```
✅ .loop/ 생성 완료. 지금 baseline 점수를 잴까요?
   → score(full) 1회 → loop.mjs record --mode full 로 R0 기록 → 다음 deficit 식별
   (live 환경이 떠 있어야 정확 — 죽어 있으면 STALE 표기로 진행)
   진행? (yes / 나중에)
```

승인 시:

1. **사전조건 확인**(scoring.md §1): `env.start` 가 살아있나(readiness 신호), DB 도달, 비-권한 토큰 확보.
   죽었으면 해당 probe = **STALE**(거짓상승 방지)로 표기하고 결정론-정적 파트만 채점한다.
2. `score(full)` 실행 — dimension 별 sub-agent fan-out(병렬), compact 결과만 회수(컨텍스트 규율).
   **held-out probe 는 이 단계에서 전부 돈다**(baseline 은 verifier 역할).
3. **R0 기록** — 판정까지 한 번에:
   ```bash
   node "<P>/scripts/loop.mjs" record --mode full --active 58 \
     --domains .loop/r0-domains.json --note "baseline (init 직후)" --json
   ```
   `record` 가 `checkpoint.json`·`scorecard.json` 을 쓰고 `verdict` 를 돌려준다.
   `scorecard.md` §점수이력에는 그 결과로 R0 행을 append 한다(md 는 스크립트가 안 건드린다).
4. **출력**(아래 § 종료 출력).

> baseline 을 "나중에" 하면 `checkpoint.json.rounds` 가 빈 채 남고, 첫 `score` 호출이 R1 을 채운다.

---

## § 종료 출력 (init 완료 카드)

```
🔧 loop init 완료 — <project>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ loop.json       : <K> dimensions, Σweight=1.00, target=<95>×<2>, caps={max_rounds:8}
✓ check           : ok (Σ·caps·auto_merge=false 통과)
✓ scorecard.md    : rubric 산문 + §점수이력
✓ driver.js       : Workflow 무인 드라이버 (생성함 | 생략 — Stop 훅 모드 사용)
✓ baseline (R0)   : active_total=<58>  [inventory 37 / orders 70 / …]   <STALE: live N건 | clean>
✓ held-out probe  : <2개 (inventory·security) — maker 레인 비노출>
✓ safety          : local-only, forbid=<git push, rm -rf, --force, …>, auto_merge=false
⚠ BLOCKED         : <settlement (룰 미확정) — 분모 제외 | 없음>

다음 단계:
  loop run 1     # attended 1라운드 (triage→fix→verify→rescore, 게이트)
  loop run <N>   # 무인 N라운드 (Stop 훅 모드 또는 .loop/driver.js)
  loop status    # 현황·다음 라운드 모드
```

---

## § 안전·범위 재확인 (init 단계 불변)

- **read-only 스캔**: [A] 는 부작용 0. 빌드/테스트/DB write 는 [D] baseline 에서만, 그것도 local·
  read-only(db) 또는 격리(test).
- **자격증명 비-영속**: DB·토큰 자격증명을 `loop.json` 에 평문 저장 금지 — 환경변수 참조 또는
  "로컬 보유" 표기.
- **코드 프로젝트 전용**: `probe.kind` 는 db/http/test/shell/grep 만. 매니페스트·테스트·라우트가
  전무한 비-코드 저장소면 init 을 거부하고 사유를 설명한다.
- **상한 필수**: caps 없이는 생성 자체가 안 된다. 사용자가 "무제한" 을 원해도 큰 값을 넣게 하고
  무제한은 허용하지 않는다.
- **사람이 루프 안에**: dimension·weight·probe·target·caps 는 전부 사람이 확정(스캔은 제안만).
  `auto_merge`·`scope` 는 고정 불변.
