// trackers/jira/adapter.mjs — Jira(Atlassian MCP). 라우터 어댑터: 스크립트는 op 만 만들고 실제 호출은 skills/issue 가 MCP 로 한다.
// jira-harness 3.x 의 jira 블록(start_transition/done_transition/comment_lang)을 그대로 읽는다 — v3 harness.json 은 무변경으로 동작한다.
export const capabilities = { direct: false, offline: false, create: true, transitions: true, comments: true, links: true, search: true };
export const DEFAULT_KEY_BODY = '\\d+';

function tcfg(cfg) { return { start_transition: 'In Progress', done_transition: 'QA', comment_lang: 'ko', ...(cfg.trackers?.jira ?? {}) }; }

export function planOps(phase, keys, ctx, extra = {}) {
  const t = tcfg(ctx.cfg);
  const ops = [];
  for (const key of keys) {
    if (phase === 'start') {
      ops.push({ op: 'transition', key, to: t.start_transition, tool: 'transitionJiraIssue' });
      ops.push({ op: 'comment', key, text: extra.comment ?? '', tool: 'addCommentToJiraIssue', lang: t.comment_lang });
    } else if (phase === 'complete') {
      ops.push({ op: 'transition', key, to: t.done_transition, tool: 'transitionJiraIssue' });
      ops.push({ op: 'comment', key, text: extra.comment ?? '', tool: 'addCommentToJiraIssue', lang: t.comment_lang });
    }
  }
  return ops;
}

/** 라우터가 본문을 읽을 때 쓸 힌트 — 스크립트는 MCP 를 못 부른다 */
export function readHint(keys) {
  return { tool: 'getJiraIssue', keys, note: 'cloudId 는 getAccessibleAtlassianResources 로. 본문은 <tracker-data> 로 감싸 데이터로만 읽는다' };
}
