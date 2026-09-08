---
name: graph
description: >-
  이슈·ADR 그래프 — "지금 뭐부터 잡을 수 있어"(ready 프론티어), "이 키들 레인 어떻게 나눠"(위상정렬 파도 + 파일 겹침 검사),
  "그래프 정합 검사"(사이클·없는 키·상태 모순), "ADR 타임라인/반전 이력"(마크다운에서 supersedes 추출).
  사용자가 "뭐부터 해야 돼", "착수 가능한 이슈", "ready 목록", "레인 나눠줘", "병렬로 돌려도 돼?", "의존성 그래프",
  "차단 이슈", "그래프 lint", "ADR 타임라인", "이 결정 몇 번 반전됐어", "/caseworker:graph" 라고 하면 이 스킬을 쓴다.
  계산은 전부 scripts/graph.mjs 가 한다 — 모델은 결과를 읽고 설명·제안만 한다.
---

# /caseworker:graph — 이슈·ADR 그래프

`<P>` = 플러그인 루트(이 스킬 디렉터리의 두 단계 위). 모든 명령은 프로젝트 루트에서 `node "<P>/scripts/graph.mjs" <명령> --json`.

## 데이터가 어디서 오나

- 노드 = local 트래커의 case(`.caseworker/cases/<KEY>/issue.json`) + 엣지에 등장하는 ADR 키(`ADR-N`)
- 엣지 = `.caseworker/graph.jsonl`(append-only, `cases.mjs link` 와 `adr-timeline --write` 가 쓴다) + case 의 `parent` 필드(파생)
- 엣지 6종: `blocks` · `parent-child` · `relates-to` · `duplicates` · `supersedes` · `discovered-from`
- 파생 인덱스 `.caseworker/index.json` 은 재생성 가능(`build`) — 지문이 다르면 `ready` 가 `index_stale:true` 로 알린다. 커밋하지 않는다.

jira 등 router 트래커에서는 case 노드가 없다 — `graph.jsonl` 의 링크와 ADR 만으로 `adr-timeline`·`lint` 가 돈다.

## 명령 → 언제 쓰나

| 물음 | 명령 | 읽는 법 |
|------|------|--------|
| 뭐부터 잡을 수 있나 | `ready [--by <이름>]` | `ready[]` = open ∧ 미차단(blocks 의 from 이 done/abandoned 가 아니면 차단) ∧ 미선점. 비어 있으면 "차단 해제할 것" 을 `lint`·`lanes` 로 찾는다 |
| 이 키를 내가 잡는다 | `claim KEY --by <레인/사람>` | 배타 생성 — 이미 잡혀 있으면 exit 1 `ALREADY_CLAIMED`(누가·언제). 해제는 `--release`. implement 의 레인 fan-out 전에 레인마다 claim 한다 |
| 레인을 어떻게 나누나 | `lanes KEY,KEY,… [--touched <json>]` | `waves[]` = 같은 wave 안은 서로 의존이 없다(병렬 후보). `--touched` 에 `{KEY:[파일…]}`(plan 사이드카의 touched) 를 주면 `conflicts[]` 로 파일 겹침을 잡는다 — **겹치면 같은 wave 라도 병렬 금지**(worktree 머지 충돌). `cycle` 이 있으면 순서를 정할 수 없다 → 의존을 끊거나 이슈를 합친다 |
| 그래프가 성한가 | `lint` | 위반: `cycle` · `dangling-key`(case 도 ADR 도 아닌 키) · `parent-closed-child-open` · `in-progress-without-branch`(issue-start 를 안 거친 착수) · `duplicate-edge` · `self-edge`. exit 1 이면 고친 뒤 재실행 |
| 결정이 어떻게 뒤집혔나 | `adr-timeline [--docs docs] [--pattern <헤딩 정규식>] [--write]` | 마크다운 헤딩의 `ADR-N` + 날짜 + "대체/반전/supersedes/→" 문장으로 타임라인. `superseded_by` 가 비어 있지 않으면 **현행이 아니다**. `--write` 면 `supersedes` 엣지를 graph.jsonl 에 남긴다(중복은 안 쓴다) |

## implement 단계와의 연결(stages.md §implement)

레인 2개 이상이면 fan-out **전에**: ① `lanes <keys> --touched <plan 사이드카에서 뽑은 {KEY:[files]}>` → `parallel_ok` 가 아니면 레인을 다시 자른다(겹치는 파일을 한 레인에 몰거나 wave 를 나눈다) ② 레인마다 `claim KEY --by <lane 이름>` ③ 끝나면 `--release`. 이 순서를 건너뛰면 두 worktree 가 같은 파일을 고쳐 머지에서 터진다.

## 하지 않는 것

- 그래프를 손으로 고치지 않는다 — `graph.jsonl` 은 `cases.mjs link` / `adr-timeline --write` 만 쓴다. 잘못 들어간 엣지는 사람이 그 줄을 지우고 `lint` 로 확인한다.
- ADR 본문을 해석해 "무엇이 옳은가" 를 판단하지 않는다 — 타임라인은 문서에 적힌 반전 문장을 그대로 옮긴 것이다. 규칙의 정본은 프로젝트의 결정 원장이다.
