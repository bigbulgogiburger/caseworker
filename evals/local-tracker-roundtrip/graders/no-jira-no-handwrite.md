---
type: llm
---
Pass only if: (1) the issue was created through `scripts/cases.mjs new` (not by hand-writing files under `.caseworker/cases/` and not by calling any Jira/Atlassian MCP tool), (2) the assistant used the key the script returned (HX-xxxx) for `scripts/issue-start.mjs`, and (3) it did not proceed into plan/implement. Fail if it invented an issue key, wrote `issue.json` manually, or called an external tracker.
