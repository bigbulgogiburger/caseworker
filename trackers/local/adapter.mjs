// trackers/local/adapter.mjs — 기본 트래커. 외부 의존 0: 이슈는 저장소 안 파일이다(커밋 대상).
//
//   <trackers.local.dir>/cases/<KEY>/issue.json      메타(스키마 schemas/case.schema.json)
//                                   /body.md         요구·수용 기준(사람이 편집)
//                                   /PROGRESS.md     사람용 진행 로그 — append-only
//                                   /comments/<시각>.md   댓글 — 파일당 1건(append-only, 병렬 레인이 같은 파일을 안 건드린다)
//   <trackers.local.dir>/graph.jsonl                  링크(엣지) 1줄 1건 — append-only
//
// 키 = <PREFIX>-<hash4>(.n) — 제목+시각+난수의 sha1 앞 4자(hex). 브랜치·worktree 병렬 생성에서 순번처럼 충돌하지 않는다.
// counter:"seq" 면 <PREFIX>-<max+1> (혼자 쓰는 저장소용 — 두 브랜치가 동시에 만들면 충돌할 수 있다).
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { assertValid } from '../../scripts/lib/schema.mjs';

export const capabilities = { direct: true, offline: true, create: true, transitions: true, comments: true, links: true, search: true };
export const DEFAULT_KEY_BODY = '(?:[0-9a-f]{4,6}(?:\\.\\d+)*|\\d+)';
const STATUSES = ['open', 'in_progress', 'review', 'done', 'abandoned'];

function tcfg(cfg) { return { dir: '.caseworker', counter: 'hash', start_status: 'in_progress', done_status: 'review', ...(cfg.trackers?.local ?? {}) }; }
export function casesDir(ctx) { return join(ctx.root, tcfg(ctx.cfg).dir, 'cases'); }
export function caseDir(key, ctx) { return join(casesDir(ctx), key); }
function graphFile(ctx) { return join(ctx.root, tcfg(ctx.cfg).dir, 'graph.jsonl'); }
function now(ctx) { return ctx.now ?? new Date().toISOString(); }
function stamp(iso) { return iso.replace(/[:.]/g, '-'); }

function readMeta(key, ctx) {
  const f = join(caseDir(key, ctx), 'issue.json');
  if (!existsSync(f)) return null;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  assertValid(j, 'case', f);
  return j;
}
function writeMeta(meta, ctx) {
  meta.updated_at = now(ctx);
  assertValid(meta, 'case', meta.key);
  const dir = caseDir(meta.key, ctx);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'issue.json');
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  renameSync(tmp, f);
  return meta;
}
export function progress(key, line, ctx) {
  const dir = caseDir(key, ctx);
  if (!existsSync(dir)) return { ok: false, reason: `case 없음: ${key}` };
  const f = join(dir, 'PROGRESS.md');
  if (!existsSync(f)) writeFileSync(f, `# ${key} — 진행 로그\n\n`, 'utf8');
  appendFileSync(f, `- ${now(ctx)} ${line}\n`, 'utf8');
  return { ok: true };
}

export function listKeys(ctx) {
  const d = casesDir(ctx);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter(n => existsSync(join(d, n, 'issue.json')));
}

function newKey(spec, ctx) {
  const cfg = ctx.cfg; const t = tcfg(cfg); const prefix = cfg.issue_prefix;
  const existing = new Set(listKeys(ctx));
  if (spec.parent) {
    const n = [...existing].filter(k => k.startsWith(`${spec.parent}.`)).length + 1;
    return `${spec.parent}.${n}`;
  }
  if (t.counter === 'seq') {
    const max = [...existing].map(k => Number((k.split('-')[1] ?? '').split('.')[0])).filter(Number.isInteger).reduce((a, b) => Math.max(a, b), 0);
    return `${prefix}-${max + 1}`;
  }
  const h = createHash('sha1').update(`${spec.title}|${now(ctx)}|${randomBytes(8).toString('hex')}`).digest('hex');
  for (const len of [4, 5, 6]) { const k = `${prefix}-${h.slice(0, len)}`; if (!existing.has(k)) return k; }
  throw new Error('키 생성 실패(해시 6자까지 충돌)');
}

export function create(spec, ctx) {
  if (!spec?.title) return { ok: false, reason: 'title 이 필요하다' };
  if (spec.parent && !readMeta(spec.parent, ctx)) return { ok: false, reason: `부모 case 없음: ${spec.parent}` };
  const key = newKey(spec, ctx);
  const meta = { version: 1, key, title: spec.title, type: spec.type ?? (spec.parent ? 'subtask' : 'task'), status: 'open', parent: spec.parent ?? null, labels: spec.labels ?? [], assignee: spec.assignee ?? null, branch: null, created_at: now(ctx), updated_at: now(ctx), closed_at: null };
  writeMeta(meta, ctx);
  const dir = caseDir(key, ctx);
  writeFileSync(join(dir, 'body.md'), (spec.body ?? `# ${spec.title}\n\n## 배경\n\n## 작업 범위\n\n## 인수조건\n- [ ] \n`).replace(/\r\n/g, '\n'), 'utf8');
  mkdirSync(join(dir, 'comments'), { recursive: true });
  progress(key, `생성 (${meta.type})`, ctx);
  if (spec.parent) link(spec.parent, key, 'parent-child', ctx);
  return { ok: true, key };
}

/** issue-start 가 부른다 — 키만 있고 case 파일이 없으면(외부에서 정한 키·순번) 자리표시 case 를 만든다. 있으면 그대로. */
export function ensure(key, ctx) {
  if (readMeta(key, ctx)) return { ok: true, existed: true };
  const meta = { version: 1, key, title: key, type: 'task', status: 'open', parent: null, labels: [], assignee: null, branch: null, created_at: now(ctx), updated_at: now(ctx), closed_at: null };
  writeMeta(meta, ctx);
  const dir = caseDir(key, ctx);
  if (!existsSync(join(dir, 'body.md'))) writeFileSync(join(dir, 'body.md'), `# ${key}\n\n(issue-start 가 자동 생성 — 제목·요구를 채울 것)\n`, 'utf8');
  mkdirSync(join(dir, 'comments'), { recursive: true });
  progress(key, '자리표시 case 자동 생성 (issue-start)', ctx);
  return { ok: true, existed: false };
}

export function read(keys, ctx) {
  const out = {};
  for (const key of keys) {
    const meta = readMeta(key, ctx);
    if (!meta) { out[key] = null; continue; }
    const dir = caseDir(key, ctx);
    const body = existsSync(join(dir, 'body.md')) ? readFileSync(join(dir, 'body.md'), 'utf8') : '';
    const cdir = join(dir, 'comments');
    const comments = existsSync(cdir) ? readdirSync(cdir).sort().map(f => ({ at: f.replace(/\.md$/, ''), text: readFileSync(join(cdir, f), 'utf8') })) : [];
    out[key] = { ...meta, body, comments, links: linksOf(key, ctx) };
  }
  return out;
}

export function transition(key, to, ctx) {
  if (!STATUSES.includes(to)) return { ok: false, reason: `상태 아님: ${to} (허용 ${STATUSES.join('|')})` };
  const meta = readMeta(key, ctx);
  if (!meta) return { ok: false, reason: `case 없음: ${key}` };
  const from = meta.status;
  meta.status = to;
  if (to === 'done' || to === 'abandoned') meta.closed_at = now(ctx); else meta.closed_at = null;
  if (ctx.branch) meta.branch = ctx.branch;
  writeMeta(meta, ctx);
  progress(key, `상태 ${from} → ${to}${ctx.branch ? ` (브랜치 ${ctx.branch})` : ''}`, ctx);
  return { ok: true, from, to };
}

export function comment(key, text, ctx) {
  const dir = caseDir(key, ctx);
  if (!existsSync(dir)) return { ok: false, reason: `case 없음: ${key}` };
  mkdirSync(join(dir, 'comments'), { recursive: true });
  let name = `${stamp(now(ctx))}.md`;
  let n = 1;
  while (existsSync(join(dir, 'comments', name))) name = `${stamp(now(ctx))}-${++n}.md`;
  writeFileSync(join(dir, 'comments', name), String(text).replace(/\r\n/g, '\n') + '\n', 'utf8');
  return { ok: true, file: name };
}

export function link(a, b, type, ctx) {
  const line = JSON.stringify({ from: a, to: b, type, at: now(ctx) });
  const f = graphFile(ctx);
  mkdirSync(join(ctx.root, tcfg(ctx.cfg).dir), { recursive: true });
  if (existsSync(f) && readFileSync(f, 'utf8').split('\n').some(l => { try { const j = JSON.parse(l); return j.from === a && j.to === b && j.type === type; } catch { return false; } })) return { ok: true, duplicate: true };
  appendFileSync(f, line + '\n', 'utf8');
  return { ok: true };
}
export function linksOf(key, ctx) {
  const f = graphFile(ctx);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e && (e.from === key || e.to === key));
}

export function search(query, ctx) {
  const q = String(query ?? '').toLowerCase();
  const hits = [];
  for (const key of listKeys(ctx)) {
    const meta = readMeta(key, ctx);
    const body = existsSync(join(caseDir(key, ctx), 'body.md')) ? readFileSync(join(caseDir(key, ctx), 'body.md'), 'utf8') : '';
    if (!q || meta.title.toLowerCase().includes(q) || body.toLowerCase().includes(q) || key.toLowerCase().includes(q)) hits.push({ key, title: meta.title, status: meta.status, type: meta.type });
  }
  return hits;
}

/** start: in_progress + 착수 댓글 · complete: done_status + 마감 댓글 */
export function planOps(phase, keys, ctx, extra = {}) {
  const t = tcfg(ctx.cfg);
  const ops = [];
  for (const key of keys) {
    if (phase === 'start') {
      ops.push({ op: 'transition', key, to: t.start_status });
      ops.push({ op: 'comment', key, text: extra.comment ?? `브랜치 ${extra.branch ?? '?'} 에서 착수` });
    } else if (phase === 'complete') {
      ops.push({ op: 'transition', key, to: t.done_status });
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
