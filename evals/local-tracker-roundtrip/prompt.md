---
name: local-tracker-roundtrip
tags: [tracker, local, issue-start]
plugins: [caseworker]
runs: 2
max_turns: 30
allowed_tools: [Bash, Read, Glob, Grep, Skill]
---
이 프로젝트는 Jira 없이 local 트래커를 쓴다. "로그인 화면 자동완성 버그" 라는 버그 이슈를 하나 만들고, 그 이슈로 작업을 착수해줘(브랜치까지). 계획·구현은 아직 하지 마.
