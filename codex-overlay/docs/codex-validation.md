# Codex 설치 및 검증

8개 스킬은 $caseworker:issue 등의 명시 호출 또는 자연어로 선택한다. 역할 원고 15개는 subagents/*.toml에 있다.

플러그인 설치만으로 훅이 신뢰되지는 않는다. Codex CLI에서 /hooks로 현재 정의를 검토하고 신뢰해야 한다. features.hooks=true도 필요하다. 설치 후 반드시 하네스 설정은 있고 상태 JSON은 없는 시험 브랜치에서 실제 shell 도구의 커밋을 시도하여 NO_STATE 차단을 확인한다. 스크립트 직접 실행은 런타임 훅 검증을 대신하지 않는다.

NO_HARNESS는 원본 계약상 하네스 미설치 저장소의 통과다. NO_STATE를 재현하려면 설정 및 이슈 브랜치가 필요하다.

공식 규격: https://learn.chatgpt.com/docs/hooks (2026-09-10 확인). inline hooks, Bash matcher, PLUGIN_ROOT를 지원한다.

현재 Codex 포팅 범위: verify는 scripts/lanes-codex.mjs, recon/plan/implement는 문서의 입력·출력 계약을 메인이 수행하거나 허용된 spawn_agent에 전달한다. loop의 Workflow driver 템플릿은 Codex에서 실행하지 않는다. Stop 훅 모드를 사용하고 실제 발화를 별도로 검증한다.
