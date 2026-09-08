#!/usr/bin/env node
// cases.mjs — 트래커 CLI. direct 어댑터(local 등)의 이슈를 세션 밖에서도 만들고 읽는다. 사람이 쳐도 되고 라우터가 불러도 된다.
//
//   node cases.mjs new "<제목>" [--body <파일|->] [--type task|bug|story|epic|subtask] [--parent KEY] [--label a,b] [--assignee <이름>]
//   node cases.mjs show KEY[,KEY…]
//   node cases.mjs list [--status open|in_progress|review|done|abandoned] [--q <검색어>]
//   node cases.mjs comment KEY "<텍스트>"      (또는 --body -  로 stdin)
//   node cases.mjs status KEY <상태>
//   node cases.mjs link KEY_A KEY_B <blocks|parent-child|relates-to|duplicates|supersedes|discovered-from>
//   node cases.mjs progress KEY "<한 줄>"
//   node cases.mjs info                         (트래커 이름·direct 여부·키 규칙 — router 어댑터에서도 동작)
//   공통: [--cwd <dir>] [--json]
// 종료 코드: 0 성공 · 1 어댑터 거부(ok:false) · 2 사용법/설정 오류/router 어댑터(직접 실행 불가 — 힌트만 출력)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { locateProject, loadConfig } from './lib/config.mjs';
import { loadTracker, STATUSES, LINK_TYPES, normalizeKey, keyPattern } from './lib/tracker.mjs';

const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') flags.json = true;
  else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
  else pos.push(a);
}
const [cmd, ...rest] = pos;
const asJson = !!flags.json;
function fail(code, msg) { console.error(`[cases] ${msg}`); process.exit(code); }
function out(obj, code = 0) { if (asJson) console.log(JSON.stringify(obj, null, 2)); process.exit(code); }
function readBody(v) { if (v == null) return undefined; if (v === '-') return readFileSync(0, 'utf8'); return readFileSync(resolve(v), 'utf8'); }

if (!cmd) fail(2, '사용법: cases.mjs new|show|list|comment|status|link|progress … [--cwd <dir>] [--json]');
const proj = locateProject(resolve(flags.cwd ?? process.cwd()));
if (!proj || !proj.configPath) fail(2, 'harness.json 이 없다 — /caseworker:setup 으로 설치할 것');
const cfg = loadConfig(proj.configPath);
let tracker;
try { tracker = await loadTracker(cfg); } catch (e) { fail(2, e.message); }
const ctx = { cfg, root: proj.configRoot, now: new Date().toISOString() };
if (cmd === 'info') {
  const info = { ok: true, tracker: tracker.name, direct: !!tracker.capabilities?.direct, capabilities: tracker.capabilities ?? {}, issue_prefix: cfg.issue_prefix, key_pattern: String(keyPattern(cfg)), config: cfg.trackers?.[tracker.name] ?? {}, root: proj.configRoot.replace(/\\/g, '/') };
  if (!asJson) console.log(`${info.tracker} (${info.direct ? 'direct' : 'router'}) · prefix ${info.issue_prefix} · key ${info.key_pattern}`);
  out(info, 0);
}
if (!tracker.capabilities?.direct) {
  const hint = typeof tracker.readHint === 'function' ? tracker.readHint(rest.map(k => normalizeKey(k, cfg))) : null;
  out({ ok: false, reason: `트래커 ${tracker.name} 은 direct 가 아니다 — 라우터가 MCP 로 수행한다`, hint }, 2);
}

let r;
switch (cmd) {
  case 'new': {
    const title = rest.join(' ').trim();
    if (!title) fail(2, 'new: 제목이 필요하다');
    r = tracker.create({ title, body: readBody(flags.body), type: flags.type, parent: flags.parent ? normalizeKey(flags.parent, cfg) : undefined, labels: flags.label ? flags.label.split(',').map(s => s.trim()).filter(Boolean) : undefined, assignee: flags.assignee }, ctx);
    if (!asJson && r.ok) console.log(`${r.key}  ${title}`);
    break;
  }
  case 'show': {
    const keys = (rest[0] ?? '').split(',').map(k => normalizeKey(k, cfg)).filter(Boolean);
    if (!keys.length) fail(2, 'show: KEY 가 필요하다');
    const data = tracker.read(keys, ctx);
    r = { ok: keys.every(k => data[k]), cases: data };
    if (!asJson) for (const k of keys) {
      const c = data[k];
      if (!c) { console.log(`${k}  (없음)`); continue; }
      console.log(`${c.key}  [${c.status}] ${c.type}  ${c.title}${c.parent ? `  ← ${c.parent}` : ''}${c.branch ? `  @${c.branch}` : ''}`);
      console.log(c.body.trim().split('\n').map(l => '    ' + l).join('\n'));
      for (const cm of c.comments) console.log(`    -- ${cm.at}\n${cm.text.trim().split('\n').map(l => '       ' + l).join('\n')}`);
      for (const e of c.links) console.log(`    ~ ${e.from} -${e.type}-> ${e.to}`);
    }
    break;
  }
  case 'list': {
    const hits = tracker.search(flags.q ?? '', ctx).filter(h => !flags.status || h.status === flags.status);
    r = { ok: true, cases: hits };
    if (!asJson) for (const h of hits) console.log(`${h.key.padEnd(14)} [${h.status}] ${h.type.padEnd(7)} ${h.title}`);
    break;
  }
  case 'comment': {
    const key = normalizeKey(rest[0] ?? '', cfg);
    const text = flags.body ? readBody(flags.body) : rest.slice(1).join(' ');
    if (!key || !text) fail(2, 'comment: KEY 와 텍스트가 필요하다');
    r = tracker.comment(key, text, ctx);
    break;
  }
  case 'status': {
    const key = normalizeKey(rest[0] ?? '', cfg);
    const to = rest[1];
    if (!key || !STATUSES.includes(to)) fail(2, `status: KEY 와 상태(${STATUSES.join('|')})가 필요하다`);
    r = tracker.transition(key, to, ctx);
    break;
  }
  case 'link': {
    const [a, b, type] = [normalizeKey(rest[0] ?? '', cfg), normalizeKey(rest[1] ?? '', cfg), rest[2]];
    if (!a || !b || !LINK_TYPES.includes(type)) fail(2, `link: KEY_A KEY_B 타입(${LINK_TYPES.join('|')})이 필요하다`);
    r = tracker.link(a, b, type, ctx);
    break;
  }
  case 'progress': {
    const key = normalizeKey(rest[0] ?? '', cfg);
    const line = rest.slice(1).join(' ');
    if (!key || !line) fail(2, 'progress: KEY 와 한 줄이 필요하다');
    r = tracker.progress ? tracker.progress(key, line, ctx) : { ok: false, reason: '이 어댑터는 progress 를 지원하지 않는다' };
    break;
  }
  default: fail(2, `모르는 명령: ${cmd}`);
}
if (!asJson && r && r.ok === false) console.error(`[cases] ${r.reason}`);
out(r, r && r.ok === false ? 1 : 0);
