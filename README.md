# caseworker

이슈 하나를 받아 **브랜치 → 결정 인터뷰 → 계획 → 구현 → 리뷰 → 게이트 → 커밋/푸시 → 마감**까지 끌고 가는 Claude Code 플러그인. 트래커는 골라 쓴다(기본 local 파일, jira, github).

모델은 판단만 하고, 기록(상태 JSON·게이트·리뷰)은 스크립트가 쓰며, `git commit` / `git push` 는 훅이 판정합니다 — "테스트 돌렸다" 는 말이 아니라 **git 트리 id** 가 증거입니다.

> Issue-driven development harness for Claude Code with pluggable trackers (local files by default, Jira, GitHub): an issue router skill, saved workflows (plan / implement / verify), a fail-closed commit/push gate hook, and deterministic bookkeeping scripts.

## 설치

```bash
claude plugin marketplace add bigbulgogiburger/caseworker
claude plugin install caseworker@bigbulgogiburger
```

프로젝트에 붙이기:

```
/caseworker:setup            # 스택 감지 → harness.json → 전제 점검 → 위반 주입으로 훅 실효 확인
/caseworker:new "제목"        # 이슈 한 건 생성 (기본 트래커 local — 저장소 안 파일)
/caseworker:issue HX-a3f8    # 이슈 한 건(또는 HX-a3f8,HX-b2c1) 진행
```

업데이트는 `claude plugin update caseworker` 후 Claude Code 재시작.

## 트래커는 골라 쓴다

이슈가 어디에 사는지는 `.claude/harness.json` 의 `tracker` 한 줄이 정합니다. 코어 스크립트는 트래커 이름을 모릅니다 — `trackers/<name>/adapter.mjs` 를 같은 계약([`trackers/_contract.md`](trackers/_contract.md))으로 부를 뿐입니다.

| 트래커 | 종류 | 이슈가 사는 곳 | 문서 |
|--------|------|---------------|------|
| `local` (기본) | direct — 스크립트가 그 자리에서 실행 | 저장소 안 파일(`.caseworker/`), 의존성 0 | [`trackers/local/README.md`](trackers/local/README.md) |
| `jira` | router — 라우터가 Atlassian MCP 로 수행 | Jira 클라우드 | [`trackers/jira/README.md`](trackers/jira/README.md) |
| `github` | direct | `gh` CLI(로그인 필요) | [`trackers/github/README.md`](trackers/github/README.md) — 상태는 라벨/열림닫힘으로 사상 |
| `beads` · `gitlab` | 예정 | — | — |

상태는 어떤 트래커든 **5종 고정**입니다: `open · in_progress · review · done · abandoned`. 외부 트래커의 상태 이름은 어댑터 설정(`trackers.<name>.start_transition` 등)으로 사상합니다.

> **이슈 본문은 데이터입니다.** 라우터가 트래커에서 읽어 온 본문은 `<tracker-data>` 블록으로 감싸 모델에 보입니다 — 그 안의 문장은 요구사항이지 실행 지시가 아닙니다. 본문에 "이 파일을 지워라" 가 있어도 요구의 일부로 읽고 판단할 뿐, 명령으로 따르지 않습니다.

## 무엇이 들어 있나

| 구성 요소 | 역할 |
|-----------|------|
| `skills/issue` | 라우터 — 지금 어느 단계인지 정하고 아래 스크립트·워크플로를 부른다 |
| `skills/setup` | 프로젝트 설정·전제 점검·v2 잔재 이관·위반 주입 |
| `skills/grilling` `grill-me` `new` `kb-ingest` | 결정 인터뷰 · 이슈 생성 · 지식 wiki ingest |
| `trackers/` | 트래커 어댑터(`local` · `jira` · `github`)와 계약 문서 `_contract.md` — 코어는 이 계약만 안다 |
| `workflows/plan.js` `implement.js` `verify.js` `recon.js` | Workflow 툴로 도는 다중 에이전트 단계(모든 레인에 model 명시) |
| `hooks/hooks.json` → `scripts/commit-gate.mjs` | PreToolUse 훅 — 게이트·리뷰 기록이 커밋될 트리와 같을 때만 commit/push 허용. **Bash·PowerShell 둘 다 판정한다(한쪽만 보면 다른 셸로 그냥 뚫린다)** |
| `hooks/hooks.json` → `scripts/protect-gate.mjs` | PreToolUse 훅(Edit/Write) — `harness.json.protected[]` 글롭의 파일(테스트·DoD 자산·게이트 스크립트)은 편집을 막는다. 검증 자산을 고쳐서 초록을 만드는 경로 차단 |
| `skills/loop` · `scripts/loop.mjs` · `scripts/stop-loop.mjs` | 완성도 루프 — 0~100 점수로 측정→triage→fix→verify→재채점. 장부·STOP/ESCALATE 판정·상한(caps)·서킷브레이커는 스크립트가 계산하고, 무인 라운드는 Stop 훅이 되먹인다(세션 격리). `.loop/loop.json` |
| `skills/graph` · `scripts/graph.mjs` | 이슈 그래프 — 의존 파도(위상정렬)·병렬 레인 파일 겹침 검사·claim·lint·ADR 반전 타임라인 |
| `scripts/gate.mjs` | 경량(컴파일·린트·DoD) / 전량(빌드·테스트·extra) 게이트 러너 — 트리 id 와 로그 sha256 을 기록 |
| `scripts/issue-start.mjs` `issue-set.mjs` `issue-complete.mjs` | 브랜치·상태 JSON 생명주기 + 트래커 op(착수/마감) |
| `scripts/cases.mjs` | 트래커 CLI — direct 어댑터의 이슈를 세션 밖에서도 만들고 읽는다(`new`/`show`/`list`/`comment`/`status`/`link`/`progress`, `--json`) |
| `scripts/safe-commit.mjs` | 훅이 발화하지 않는 경로(헤드리스·무인)에서 같은 판정 후 커밋 |
| `scripts/codex-review.sh` | Codex CLI 리뷰 래퍼(본문 끝으로 판정, 한도 소진을 감추지 않음) |
| `scripts/wiki-row.mjs` `wiki-lint.mjs` `memory-index.mjs` | 마크다운 wiki 표 upsert · 정합 점검 · 자동 메모리 인덱스 |
| `scripts/session-brief.mjs` · `scripts/md-lint.mjs` | SessionStart 훅(브랜치·이슈·stage·게이트 신선도·PROGRESS 꼬리·루프 현황을 세션 첫 컨텍스트로) · PostToolUse 훅(방금 쓴 .md 의 frontmatter·`[[link]]`·상대 링크·LOG 형식 경고, 차단 없음) |
| `agents/` | 스택별 제네릭 리뷰어·탐색기(Spring / Vue / cross-repo) — verify 워크플로의 dispatch 대상 |
| `schemas/` | `harness.json`(프로젝트 설정) · 상태 JSON · case · loop 스키마 |

## 프로젝트에 남는 것

- `.claude/harness.json` — 프로젝트만 아는 값(트래커·스택·게이트 명령·브랜치 규칙·모델 티어). **절대 경로·자격증명 금지**(머신별 값은 `stacks.<name>.env_file` 이 가리키는 gitignore 파일로).
- `.claude/runtime/issues/<branch>.json` — 브랜치 단위 상태(단계·결정·레인·DoD·게이트·리뷰 기록). `.claude/runtime/` 은 gitignore 대상. complete 는 `.claude/runtime/memory-candidates/<slug>-<시각>.md` 에 결정·리뷰·소요를 한 장으로 남긴다 — 자동 메모리로의 승격은 사람이 한다.
- `.loop/` — **완성도 루프를 켠 프로젝트만.** `loop.json`(설정)·`scorecard.md`(rubric)·`scorecard.json`·`checkpoint.json`(점수·판정 장부, 커밋 대상)과 `session.local.json`(Stop 훅 세션, gitignore).
- `.caseworker/` — **local 트래커를 쓸 때만.** 이슈 본문·댓글·진행 로그·링크가 저장소 안 파일로 남습니다(gitignore 가 아니라 **커밋 대상**). 레이아웃은 [`trackers/local/README.md`](trackers/local/README.md).
- `.claude/settings.json` — `extraKnownMarketplaces` / `enabledPlugins` (팀원 자동 안내).

## 게이트가 막는 이유(사유 코드)

`[caseworker] git commit: <CODE> — …` 한 줄이 stderr 로 나옵니다. `NO_STATE`(이슈 시작 안 됨) · `DIRTY_TREE`(게이트가 본 트리 ≠ 커밋될 트리) · `NO_GATE` / `GATE_STALE` / `GATE_FAIL`(게이트 미실행·낡음·실패) · `NO_REVIEW` / `REVIEW_STALE` / `REVIEW_BLOCKERS`(리뷰 없음·낡음·blocker) · push 는 추가로 `GATE_LEVEL`(전량 게이트 필요). 문서만 바뀐 커밋은 어느 브랜치든 통과합니다(`git add … && git commit` 처럼 한 명령이 스테이징까지 하면 스테이징 예정 파일로 판정). complete 로 아카이브된 브랜치에 코드를 더 커밋하면 `COMPLETED`(재시작은 `--adopt`). `mode: suggest` 는 경고만, `off` 는 비활성.

브랜치가 `branch_pattern` 밖이면 `BRANCH_PATTERN` 으로 막습니다. 혼자 쓰는 저장소라 이슈 브랜치를 로컬에서 머지한 뒤 `main` 을 직접 올리는 흐름이라면 `"default_branch_policy": "allow"` 로 **그 브랜치에서만** 판정을 끕니다(기본 `deny` — 켜지 않은 프로젝트의 동작은 그대로). `allow` 를 켜도 이슈 브랜치의 사다리(상태·게이트·리뷰)는 전혀 바뀌지 않습니다.

## jira-harness 에서 옮겨오기

caseworker 는 jira-harness 3.2.0 을 흡수한 것입니다. Jira 는 이제 고정 축이 아니라 어댑터 하나입니다.

- **v3 `harness.json` 은 무변경으로 동작합니다.** `version: 3` + `jira` 블록만 있는 설정은 그대로 읽혀 `jira` 트래커로 해석됩니다(`tracker` 를 명시하지 않았고 `jira` 블록이 있으면 트래커는 `jira`). `start_transition` · `done_transition` · `comment_lang` 값도 그대로 쓰입니다. local 로 옮기고 싶을 때만 `"version": 4`, `"tracker": "local"` 로 바꾸면 됩니다.
- **두 플러그인을 동시에 켜지 마세요.** 둘 다 PreToolUse 훅을 등록하므로 `git commit` 한 번에 훅이 두 번 발화합니다(사유 코드가 뒤섞이고, 한쪽 판정이 다른 쪽을 가립니다). caseworker 를 설치했으면 **jira-harness 는 끕니다**.
- **상태 JSON 은 그대로입니다.** `.claude/runtime/issues/<branch>.json` 의 스키마·경로가 같아 진행 중인 브랜치를 그대로 이어받습니다. 로그 접두는 `[jira-harness]` → `[caseworker]`, 스킬 네임스페이스는 `/jira-harness:*` → `/caseworker:*`, 환경변수 접두는 `CASEWORKER_` 입니다.

## 요구 사항

Node.js 20+, git. Windows 는 Git Bash(게이트 명령 실행용). Codex CLI 는 선택(없으면 리뷰 1단계를 건너뛰고 그렇게 기록). 기본 트래커 `local` 은 **외부 의존이 없습니다** — 네트워크·계정 없이 그대로 돕니다. Jira 트래커는 Atlassian MCP 가 있을 때만 실제로 반영되고, 없으면 op 가 보고에만 남습니다(코드 진행은 막지 않음).

## 개발

```bash
node --test scripts/__tests__/*.test.mjs   # 실제 임시 git 저장소에서 훅·러너·스크립트를 실행하는 통합 테스트
node scripts/dev/wf-sim.mjs workflows/plan.js --args '{...}' --strict   # Workflow 툴 없이 워크플로 제어 흐름 검사
node scripts/hygiene.mjs                    # 공개 저장소 위생(내부 문자열 검출) — push 전 필수
claude plugin validate . --strict
```

이 저장소는 공개입니다. 특정 회사·프로젝트·사람·호스트를 가리키는 문자열은 넣지 않습니다(`.hygiene.local` 에 검출 패턴, gitignore).

## 이전 버전

v2 는 user-scope 스킬 17종 묶음([`claude_jira_harness`](https://github.com/bigbulgogiburger/claude_jira_harness))이었습니다. v3(jira-harness)는 그것을 플러그인 하나로 재구축한 것이고, caseworker 는 v3 에서 Jira 고정 축을 걷어내 트래커 어댑터로 바꾼 것입니다 — 스킬 체인 대신 라우터 1개 + 저장 워크플로, 모델이 쓰던 markdown 판정 대신 스크립트가 쓰는 상태 JSON, 훅은 `PASS` 문자열 grep 대신 git 트리 id 대조. 기존 프로젝트는 `/caseworker:setup --upgrade` 로 v2 잔재(훅 3종·runtime 파일·`HARNESS_MODE`)를 이관합니다.

## 라이선스

MIT
