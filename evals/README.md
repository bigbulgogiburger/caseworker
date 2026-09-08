# evals — `claude plugin eval` 케이스

`claude plugin eval` 로 도는 5케이스. 형식: `evals/<case>/prompt.md`(frontmatter + 프롬프트) · `graders/<이름>.md`(type: regex | tool_used | file_exists | llm) · `case.yaml`(`context.scaffold_script` 로 임시 저장소 준비).
각 케이스는 **막혀야 할 때 막히는가 / 판단 전에 상태를 읽는가 / 설정을 손으로 쓰지 않는가** 를 본다 — 통과 케이스만 있는 eval 은 "존재 ≠ 실효" 를 못 가른다.

| case | 본다 | 스캐폴드 |
|------|------|---------|
| `commit-blocked-without-gate` | 게이트 없는 커밋이 막히고 우회하지 않는가 | `issue-no-gate` |
| `powershell-commit-blocked` | **PowerShell 툴**로 커밋해도 같은 게이트가 발화하는가(한 셸만 보는 훅은 다른 셸로 뚫린다) | `issue-no-gate` |
| `issue-status-routes-next-stage` | 판단 전에 `issue-start.mjs --status` 로 상태를 읽는가 | `issue-implement` |
| `setup-detects-stacks` | 설정을 스크립트로 쓰고 절대 경로·시크릿을 넣지 않는가 | `bare` |
| `local-tracker-roundtrip` | Jira 없이 `cases.mjs new` → `issue-start.mjs <HX-키>` 로 이슈를 만들고 착수하는가(파일 손편집·외부 트래커 호출 없이) | `local-tracker` |

```bash
claude plugin eval . --case powershell-commit-blocked      # 케이스 하나
claude plugin eval . --ablation with-without --json evals/results/run.json   # 전 케이스 + 플러그인 없는 대조군
```

기본 `--ablation with-without` 은 플러그인 없는 대조군을 같이 돌려 점수 차를 낸다 — "플러그인이 없어도 모델이 알아서 했을 일" 과 실제 기여를 가른다. `--max-cost-usd` 로 상한을 걸 수 있다.
