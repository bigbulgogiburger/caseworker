// trackers/github/adapter.mjs — GitHub Issues(gh CLI). direct 어댑터: 스크립트가 `gh` 를 그 자리에서 부른다(네트워크 필요).
//
// 상태 5종 → 라벨/열림닫힘 사상: in_progress → +start_label · review → +done_label(−start_label) · done → close · open/abandoned → reopen/close.
// 키 = <issue_prefix>-<번호> (예: GH-42). 번호가 GitHub 이슈 번호다. 설정:
//   trackers.github = { repo: "owner/name"(생략 시 gh 의 현재 저장소), start_label: "in-progress", done_label: "review", close_on_done: false }
// gh 가 없거나 실패하면 {ok:false, reason} — 코드 진행은 막지 않는다.
// 테스트 셈: CASEWORKER_GH=node:<script.mjs> 면 그 스크립트를 gh 대신 node 로 실행한다.
import { spawnSync } from 'node:child_process';

export const capabilities = { direct: true, offline: false, create: true, transitions: true, comments: true, links: true, search: true };
export const DEFAULT_KEY_BODY = '\\d+';

function tcfg(cfg) { return { repo: null, start_label: 'in-progress', done_label: 'review', close_on_done: false, ...(cfg.trackers?.github ?? {}) }; }
function num(key) { const m = /-(\d+)$/.exec(String(key)); return m ? m[1] : null; }

export function gh(args, ctx) {
  const t = tcfg(ctx.cfg);
  const full = t.repo ? [...args, '-R', t.repo] : args;
  const bin = process.env.CASEWORKER_GH ?? 'gh';
  const r = bin.startsWith('node:')
    ? spawnSync(process.execPath, [bin.slice(5), ...full], { cwd: ctx.root, encoding: 'utf8', windowsHide: true })
    : spawnSync(bin, full, { cwd: ctx.root, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
  if (r.error) return { ok: false, reason: `gh 실행 불가: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, reason: `gh ${args.slice(0, 2).join(' ')} exit ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}` };
  return { ok: true, out: (r.stdout ?? '').trim() };
}

export function read(keys, ctx) {
  const out = {};
  for (const key of keys) {
    const n = num(key);
    if (!n) { out[key] = { ok: false, reason: '키에서 이슈 번호를 못 읽음' }; continue; }
    const r = gh(['issue', 'view', n, '--json', 'title,body,state,labels,number'], ctx);
    if (!r.ok) { out[key] = r; continue; }
    try {
      const j = JSON.parse(r.out);
      const labels = (j.labels ?? []).map(l => l.name ?? l);
      const t = tcfg(ctx.cfg);
      const status = j.state === 'CLOSED' ? 'done' : labels.includes(t.done_label) ? 'review' : labels.includes(t.start_label) ? 'in_progress' : 'open';
      out[key] = { title: j.title, body: j.body ?? '', status, type: 'task', parent: null, labels, links: [] };
    } catch (e) { out[key] = { ok: false, reason: `gh 출력 파싱 실패: ${e.message}` }; }
  }
  return out;
}

export function create(spec, ctx) {
  const args = ['issue', 'create', '--title', spec.title, '--body', spec.body ?? ''];
  for (const l of spec.labels ?? []) args.push('--label', l);
  const r = gh(args, ctx);
  if (!r.ok) return r;
  const m = /\/issues\/(\d+)\s*$/.exec(r.out) ?? /(\d+)\s*$/.exec(r.out);
  if (!m) return { ok: false, reason: `이슈 번호를 출력에서 못 읽음: ${r.out.slice(0, 120)}` };
  return { ok: true, key: `${ctx.cfg.issue_prefix}-${m[1]}` };
}

export function transition(key, to, ctx) {
  const n = num(key); if (!n) return { ok: false, reason: '키에서 이슈 번호를 못 읽음' };
  const t = tcfg(ctx.cfg);
  switch (to) {
    case 'in_progress': return gh(['issue', 'edit', n, '--add-label', t.start_label, '--remove-label', t.done_label], ctx);
    case 'review': {
      const r = gh(['issue', 'edit', n, '--add-label', t.done_label, '--remove-label', t.start_label], ctx);
      if (!r.ok || !t.close_on_done) return r;
      return gh(['issue', 'close', n], ctx);
    }
    case 'done': return gh(['issue', 'close', n], ctx);
    case 'abandoned': return gh(['issue', 'close', n, '--reason', 'not planned'], ctx);
    case 'open': return gh(['issue', 'reopen', n], ctx);
    default: return { ok: false, reason: `모르는 상태: ${to}` };
  }
}

export function comment(key, text, ctx) {
  const n = num(key); if (!n) return { ok: false, reason: '키에서 이슈 번호를 못 읽음' };
  return gh(['issue', 'comment', n, '--body', text], ctx);
}

/** GitHub 에는 링크 종류가 없다 — 댓글 한 줄(`<type> #n`)로 남긴다. 닫는 키워드는 쓰지 않는다(자동 close 방지). */
export function link(a, b, type, ctx) {
  const nb = num(b); if (!nb) return { ok: false, reason: '대상 키에서 이슈 번호를 못 읽음' };
  return comment(a, `${type}: #${nb}`, ctx);
}

export function search(query, ctx) {
  const r = gh(['issue', 'list', '--search', query, '--state', 'all', '--json', 'number,title,state', '--limit', '50'], ctx);
  if (!r.ok) return [];
  try { return JSON.parse(r.out).map(j => `${ctx.cfg.issue_prefix}-${j.number}`); } catch { return []; }
}

export function planOps(phase, keys, ctx, extra = {}) {
  const ops = [];
  for (const key of keys) {
    if (phase === 'start') {
      ops.push({ op: 'transition', key, to: 'in_progress' });
      ops.push({ op: 'comment', key, text: extra.comment ?? `브랜치 ${extra.branch ?? '?'} 에서 착수` });
    } else if (phase === 'complete') {
      ops.push({ op: 'transition', key, to: 'review' });
      ops.push({ op: 'comment', key, text: extra.comment ?? '구현 완료' });
    }
  }
  return ops;
}

export function apply(op, ctx) {
  switch (op.op) {
    case 'transition': return transition(op.key, op.to, ctx);
    case 'comment': return comment(op.key, op.text, ctx);
    case 'create': return create(op.spec, ctx);
    case 'link': return link(op.from, op.to, op.type, ctx);
    default: return { ok: false, reason: `모르는 op: ${op.op}` };
  }
}
