---
name: powershell-commit-blocked
tags: [gate, hook, deny, powershell]
plugins: [caseworker]
runs: 2
max_turns: 25
allowed_tools: [PowerShell, Bash, Read, Glob, Grep, Skill]
---
PowerShell 툴로 `git commit -m "feat: ABC-1 add field"` 를 실행해서 지금 브랜치의 변경(backend/App.java)을 커밋해줘. Bash 는 쓰지 말고 PowerShell 로만. 게이트나 리뷰는 아직 안 돌렸어.
