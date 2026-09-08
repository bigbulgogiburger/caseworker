#!/usr/bin/env node
// graph.mjs — 이슈·ADR 그래프. local 트래커의 case 메타 + graph.jsonl(엣지) 를 읽어 계산만 한다(외부 DB 없음, Node 20).
//
//   node graph.mjs build                       노드·엣지 파생 인덱스(.caseworker/index.json — 지문 포함, 재생성 가능)
//   node graph.mjs ready [--by <이름>]          착수 가능 프론티어 = open ∧ 미차단(blocks 의 from 이 done/abandoned 아님) ∧ 미선점
//   node graph.mjs claim KEY --by <이름>        배타 선점(파일 open 'wx' — 두 레인이 같은 키를 동시에 잡지 못한다) / --release 로 해제
//   node graph.mjs lanes KEY[,KEY…] [--touched <json 파일>]
//                                              위상정렬(Kahn) 파도(wave) + 파일 집합 disjoint 검사 → 병렬 가능 여부
//   node graph.mjs lint                        사이클 · 없는 키를 가리키는 엣지 · 상태 모순(부모 done 인데 자식 open) · 중복 엣지
//   node graph.mjs adr-timeline [--docs <dir>] [--pattern <정규식>] [--write]
//                                              마크다운에서 ADR-N 헤딩·날짜·supersedes/반전 을 뽑아 타임라인(--write 면 graph.jsonl 에 supersedes 엣지 추가)
//   공통: [--cwd <dir>] [--json]
// 종료 코드: 0 · 1(lint 위반 있음 / lanes 에 파일 충돌 있음 / claim 실패) · 2 사용법·설정 오류·local 아님
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { locateProject, loadConfig } from './lib/config.mjs';
import { loadTracker, LINK_TYPES } from './lib/tracker.mjs';

const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json' || a === '--write' || a === '--release') flags[a.slice(2)] = true;
  else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
  else pos.push(a);
}
const [cmd, ...rest] = pos;
const asJson = !!flags.json;
function fail(code, msg) { console.error(`[graph] ${msg}`); process.exit(code); }
function out(obj, code = 0, human = []) { if (asJson) console.log(JSON.stringify(obj, null, 2)); else for (const l of human) console.log(l); process.exit(code); }

if (!cmd) fail(2, '사용법: graph.mjs build|ready|claim|lanes|lint|adr-timeline … [--cwd <dir>] [--json]');
const proj = locateProject(resolve(flags.cwd ?? process.cwd()));
if (!proj || !proj.configPath) fail(2, 'harness.json 이 없다 — /caseworker:setup 으로 설치할 것');
const cfg = loadConfig(proj.configPath);
const root = proj.configRoot;
const tracker = await loadTracker(cfg).catch(e => fail(2, e.message));
const DONE = new Set(['done', 'abandoned']);

// ---------- 읽기 ----------
function trackerDir() { return join(root, cfg.trackers?.local?.dir ?? '.caseworker'); }
function readGraph() {
  if (tracker.name !== 'local') {
    // 다른 트래커도 graph.jsonl 은 쓸 수 있다(링크만). 노드는 엣지에 등장하는 키로 만든다.
  }
  const nodes = new Map();
  const casesDir = join(trackerDir(), 'cases');
  if (existsSync(casesDir)) {
    for (const key of readdirSync(casesDir)) {
      const f = join(casesDir, key, 'issue.json');
      if (!existsSync(f)) continue;
      try { const m = JSON.parse(readFileSync(f, 'utf8')); nodes.set(m.key, { key: m.key, type: 'case', status: m.status, title: m.title, parent: m.parent ?? null, branch: m.branch ?? null, kind: m.type }); } catch { /* skip */ }
    }
  }
  const edges = [];
  const gf = join(trackerDir(), 'graph.jsonl');
  if (existsSync(gf)) {
    for (const line of readFileSync(gf, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e.from && e.to && e.type) edges.push(e); } catch { /* skip */ }
    }
  }
  // parent 필드도 엣지다(엣지 파일에 없더라도)
  for (const n of nodes.values()) if (n.parent && !edges.some(e => e.type === 'parent-child' && e.from === n.parent && e.to === n.key)) edges.push({ from: n.parent, to: n.key, type: 'parent-child', derived: true });
  for (const e of edges) for (const k of [e.from, e.to]) if (!nodes.has(k)) nodes.set(k, { key: k, type: /^ADR-\d+$/i.test(k) ? 'adr' : 'external', status: null, title: null, parent: null, branch: null });
  return { nodes, edges };
}
function fingerprint() {
  const h = createHash('sha1');
  const d = trackerDir();
  const walk = p => { if (!existsSync(p)) return; for (const n of readdirSync(p).sort()) { const f = join(p, n); const s = statSync(f); if (s.isDirectory()) { if (n !== 'index.json') walk(f); } else if (n === 'issue.json' || n === 'graph.jsonl') h.update(relative(d, f) + '\n' + readFileSync(f, 'utf8') + '\n'); } };
  walk(d);
  return h.digest('hex');
}
function claimsDir() { return join(trackerDir(), 'claims'); }
function claimOf(key) { const f = join(claimsDir(), `${key}.claim`); if (!existsSync(f)) return null; try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return { by: '?', at: null }; } }

// ---------- 계산 ----------
function blockersOf(key, g) {
  return g.edges.filter(e => e.type === 'blocks' && e.to === key).map(e => e.from).filter(k => { const n = g.nodes.get(k); return !(n && DONE.has(n.status)); });
}
function readyList(g) {
  const list = [];
  for (const n of g.nodes.values()) {
    if (n.type !== 'case' || n.status !== 'open') continue;
    const blockers = blockersOf(n.key, g);
    const claim = claimOf(n.key);
    if (!blockers.length && !claim) list.push({ key: n.key, title: n.title, kind: n.kind });
  }
  return list.sort((a, b) => a.key.localeCompare(b.key));
}
/** Kahn 위상정렬 — 의존 엣지(blocks: from→to 순서 · parent-child: 부모 뒤에 자식이 아니라 자식 뒤에 부모(부모는 자식이 끝나야 닫힌다)) */
function waves(keys, g) {
  const set = new Set(keys);
  const deps = new Map(keys.map(k => [k, new Set()]));
  for (const e of g.edges) {
    if (e.type === 'blocks' && set.has(e.from) && set.has(e.to)) deps.get(e.to).add(e.from);
    if (e.type === 'parent-child' && set.has(e.from) && set.has(e.to)) deps.get(e.from).add(e.to);
  }
  const result = [];
  const done = new Set();
  let remaining = new Set(keys);
  while (remaining.size) {
    const wave = [...remaining].filter(k => [...deps.get(k)].every(d => done.has(d))).sort();
    if (!wave.length) return { waves: result, cycle: [...remaining].sort() };
    result.push(wave);
    for (const k of wave) { done.add(k); remaining.delete(k); }
  }
  return { waves: result, cycle: null };
}
function disjoint(keys, touched) {
  const conflicts = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = new Set(touched[keys[i]] ?? []);
    const files = (touched[keys[j]] ?? []).filter(f => a.has(f));
    if (files.length) conflicts.push({ a: keys[i], b: keys[j], files });
  }
  return conflicts;
}
function findCycles(g) {
  // blocks + parent-child(자식→부모 방향) 위에서 DFS
  const adj = new Map();
  const add = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const e of g.edges) { if (e.type === 'blocks') add(e.from, e.to); if (e.type === 'parent-child') add(e.to, e.from); }
  const color = new Map(); const cycles = [];
  const dfs = (u, path) => {
    color.set(u, 1); path.push(u);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === 1) cycles.push([...path.slice(path.indexOf(v)), v]);
      else if (!color.get(v)) dfs(v, path);
    }
    path.pop(); color.set(u, 2);
  };
  for (const k of adj.keys()) if (!color.get(k)) dfs(k, []);
  return cycles;
}
function lint(g) {
  const v = [];
  const seen = new Set();
  for (const e of g.edges) {
    const id = `${e.from}|${e.to}|${e.type}`;
    if (seen.has(id)) v.push({ rule: 'duplicate-edge', detail: id }); seen.add(id);
    if (!LINK_TYPES.includes(e.type)) v.push({ rule: 'unknown-edge-type', detail: id });
    for (const k of [e.from, e.to]) { const n = g.nodes.get(k); if (n && n.type === 'external') v.push({ rule: 'dangling-key', detail: `${id} — ${k} 는 case 도 ADR 도 아니다` }); }
    if (e.from === e.to) v.push({ rule: 'self-edge', detail: id });
  }
  for (const c of findCycles(g)) v.push({ rule: 'cycle', detail: c.join(' → ') });
  for (const n of g.nodes.values()) {
    if (n.type !== 'case' || !n.parent) continue;
    const p = g.nodes.get(n.parent);
    if (p && p.type === 'case' && DONE.has(p.status) && !DONE.has(n.status)) v.push({ rule: 'parent-closed-child-open', detail: `${n.parent}(${p.status}) ← ${n.key}(${n.status})` });
  }
  for (const n of g.nodes.values()) {
    if (n.type === 'case' && n.status === 'in_progress' && !n.branch) v.push({ rule: 'in-progress-without-branch', detail: `${n.key} — issue-start 를 거치지 않은 착수` });
  }
  return v;
}

// ---------- ADR 타임라인 ----------
function adrTimeline(docsDir, pattern) {
  // 기본: ADR-N 으로 **시작하는** 헤딩만(장식 `**`·`[`·`~~` 허용). "9.7 판매 트랙 (ADR-052 참고)" 같은 언급 헤딩을 ADR 정의로 읽지 않는다. --pattern 으로 바꿀 수 있다
  const headRe = new RegExp(pattern ?? '^#{1,4}\\s*[\\*\\[~`]*\\s*(ADR-\\d+)\\b', 'i');
  const dateRe = /(\d{4}-\d{2}-\d{2})/;
  const anyHead = /^#{1,4}\s/;
  // 반전 추출 3패스 — ① 영문 키워드 뒤의 ADR("supersedes ADR-1") ② 한국어 키워드 앞의 ADR("ADR-1 을 대체한다") ③ 화살표("ADR-1 → ADR-2" = ADR-2 가 ADR-1 을 대체)
  const supEn = /\b(?:supersedes?|replaces?|obsoletes?|reverses?)\s+\b(ADR-\d+)\b/gi;
  // 한국어는 조사를 **요구**한다 — "ADR-001 을 대체한다"(이 ADR 이 ADR-001 을 대체) / "ADR-083 으로 대체됨"(ADR-083 이 이 ADR 을 대체).
  // 조사 없는 "…(ADR-066 반전)" 같은 괄호 언급은 다른 ADR 의 이력을 인용한 것이라 세지 않는다.
  const supKoObj = /\b(ADR-\d+)\b\s*(?:을|를)\s*(?:대체|반전|되돌|폐기|무효화|철회)/g;
  // 키워드가 앞에 오는 표기 — "반전 대상 | **ADR-094 …**" · "대체: ADR-12" (표 셀·콜론·장식 허용)
  const supKoBefore = /(?:반전 대상|대체 대상|폐기 대상|철회 대상|반전|대체|폐기|철회)\s*[:：|]?\s*[\*_`\[\s]*\b(ADR-\d+)\b/g;
  const supKoBy = /\b(ADR-\d+)\b(?:\([^)\n]*\))?\s*(?:으로|로)\s*(?:대체|반전|되돌|교체|이관)/g;
  const arrow = /\b(ADR-\d+)\b\s*(?:→|->|⇒)\s*\b(ADR-\d+)\b/g;
  /** @returns {{supersedes:string[], supersededBy:string[]}} */
  function supersedesOf(id, block) {
    const sup = new Set(), by = new Set();
    for (const re of [supEn, supKoObj, supKoBefore]) { re.lastIndex = 0; let s; while ((s = re.exec(block))) { const t = s[1].toUpperCase(); if (t !== id) sup.add(t); } }
    supKoBy.lastIndex = 0; let b; while ((b = supKoBy.exec(block))) { const t = b[1].toUpperCase(); if (t !== id) by.add(t); }
    arrow.lastIndex = 0; let a; while ((a = arrow.exec(block))) { const from = a[1].toUpperCase(), to = a[2].toUpperCase(); if (to === id && from !== id) sup.add(from); else if (from === id && to !== id) by.add(to); }
    return { supersedes: [...sup], supersededBy: [...by] };
  }
  const entries = [];
  const files = [];
  const walk = p => { if (!existsSync(p)) return; for (const n of readdirSync(p)) { const f = join(p, n); const s = statSync(f); if (s.isDirectory()) { if (!['node_modules', '.git'].includes(n)) walk(f); } else if (n.endsWith('.md')) files.push(f); } };
  walk(docsDir);
  for (const f of files.sort()) {
    const lines = readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = headRe.exec(lines[i]);
      if (!m) continue;
      const id = m[1].toUpperCase();
      // 블록 = 헤딩부터, 같은 레벨 이하의 다음 헤딩 **또는** 다음 ADR 헤딩 전까지(하위 `###` 절은 같은 ADR 의 일부, 최대 80줄) — 다음 ADR 의 문장을 이 ADR 것으로 읽지 않는다
      const level = (/^(#+)/.exec(lines[i])?.[1].length) ?? 2;
      let end = i + 1;
      while (end < lines.length && end < i + 81) {
        const hl = /^(#{1,6})\s/.exec(lines[end]);
        if (hl && (hl[1].length <= level || headRe.test(lines[end]))) break;
        end++;
      }
      const block = lines.slice(i, end).join('\n');
      const date = (dateRe.exec(lines[i]) ?? dateRe.exec(block))?.[1] ?? null;
      const rel = supersedesOf(id, block);
      entries.push({ id, date, file: relative(root, f).replace(/\\/g, '/'), line: i + 1, title: lines[i].replace(/^#+\s*/, '').trim(), supersedes: rel.supersedes, by_hint: rel.supersededBy });
    }
  }
  // 같은 ADR 이 여러 파일에 있으면 첫 정의를 정본으로, 나머지는 mentions. "X 으로 대체됨" 힌트는 X.supersedes 에 합친다(방향 통일)
  const byId = new Map();
  for (const e of entries) {
    if (!byId.has(e.id)) byId.set(e.id, { id: e.id, date: e.date, file: e.file, line: e.line, title: e.title, supersedes: [], mentions: [] });
    else byId.get(e.id).mentions.push({ file: e.file, line: e.line });
    const cur = byId.get(e.id);
    for (const t of e.supersedes) if (!cur.supersedes.includes(t)) cur.supersedes.push(t);
  }
  for (const e of entries) for (const x of e.by_hint) {
    if (!byId.has(x)) byId.set(x, { id: x, date: null, file: null, line: null, title: '(정의 헤딩 없음 — 다른 ADR 의 "…으로 대체됨" 문장에서만 등장)', supersedes: [], mentions: [] });
    const other = byId.get(x); if (!other.supersedes.includes(e.id)) other.supersedes.push(e.id);
  }
  const list = [...byId.values()].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.id.localeCompare(b.id));
  const supersededBy = new Map();
  for (const e of list) for (const t of e.supersedes) supersededBy.set(t, [...(supersededBy.get(t) ?? []), e.id]);
  for (const e of list) e.superseded_by = supersededBy.get(e.id) ?? [];
  return list;
}

// ---------- 진입 ----------
const g = readGraph();
switch (cmd) {
  case 'build': {
    const fp = fingerprint();
    const idx = { built_at: new Date().toISOString(), fingerprint: fp, nodes: [...g.nodes.values()], edges: g.edges, ready: readyList(g).map(r => r.key) };
    mkdirSync(trackerDir(), { recursive: true });
    writeFileSync(join(trackerDir(), 'index.json'), JSON.stringify(idx, null, 2) + '\n', 'utf8');
    out(idx, 0, [`[graph] nodes ${idx.nodes.length} · edges ${idx.edges.length} · ready ${idx.ready.length} · fingerprint ${fp.slice(0, 12)}`]);
  }
  case 'ready': {
    const list = readyList(g);
    const stale = existsSync(join(trackerDir(), 'index.json')) ? (JSON.parse(readFileSync(join(trackerDir(), 'index.json'), 'utf8')).fingerprint !== fingerprint()) : null;
    out({ ok: true, ready: list, index_stale: stale }, 0, list.length ? list.map(r => `${r.key.padEnd(14)} ${r.kind ?? ''}  ${r.title ?? ''}`) : ['(착수 가능한 open case 없음)']);
  }
  case 'claim': {
    const key = rest[0];
    if (!key) fail(2, 'claim: KEY 가 필요하다');
    mkdirSync(claimsDir(), { recursive: true });
    const f = join(claimsDir(), `${key}.claim`);
    if (flags.release) { if (existsSync(f)) unlinkSync(f); out({ ok: true, released: key }, 0, [`[graph] ${key} 선점 해제`]); }
    if (!flags.by) fail(2, 'claim: --by <이름> 이 필요하다');
    if (!g.nodes.has(key)) fail(2, `claim: 모르는 키 ${key}`);
    try {
      const fd = openSync(f, 'wx'); // 배타 생성 — 이미 있으면 EEXIST
      writeFileSync(fd, JSON.stringify({ key, by: flags.by, at: new Date().toISOString() }) + '\n'); closeSync(fd);
      out({ ok: true, claimed: key, by: flags.by }, 0, [`[graph] ${key} 선점 — ${flags.by}`]);
    } catch (e) {
      if (e.code === 'EEXIST') { const c = claimOf(key); out({ ok: false, reason: 'ALREADY_CLAIMED', by: c?.by, at: c?.at }, 1, [`[graph] ${key} 는 이미 ${c?.by} 가 잡았다(${c?.at})`]); }
      throw e;
    }
  }
  case 'lanes': {
    const keys = (rest[0] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (!keys.length) fail(2, 'lanes: KEY[,KEY…] 가 필요하다');
    const unknown = keys.filter(k => !g.nodes.has(k));
    let touched = {};
    if (flags.touched) { try { touched = JSON.parse(readFileSync(resolve(flags.touched), 'utf8')); } catch (e) { fail(2, `--touched 파일을 읽을 수 없다: ${e.message}`); } }
    const w = waves(keys, g);
    const conflicts = flags.touched ? disjoint(keys, touched) : null;
    const parallelOk = !w.cycle && (conflicts ? conflicts.length === 0 : null);
    const human = [];
    w.waves.forEach((wv, i) => human.push(`wave ${i + 1}: ${wv.join(', ')}`));
    if (w.cycle) human.push(`⚠ 사이클 — 순서를 정할 수 없다: ${w.cycle.join(', ')}`);
    if (conflicts) human.push(conflicts.length ? `⚠ 파일 겹침 ${conflicts.length}쌍: ` + conflicts.map(c => `${c.a}×${c.b}(${c.files.slice(0, 3).join(', ')})`).join(' · ') : '파일 집합 disjoint — 같은 wave 안에서 병렬 가능');
    if (unknown.length) human.push(`(그래프에 없는 키: ${unknown.join(', ')} — 엣지 없음으로 취급)`);
    out({ ok: !w.cycle && !(conflicts?.length), waves: w.waves, cycle: w.cycle, conflicts, parallel_ok: parallelOk, unknown }, (w.cycle || conflicts?.length) ? 1 : 0, human);
  }
  case 'lint': {
    const v = lint(g);
    out({ ok: v.length === 0, violations: v, nodes: g.nodes.size, edges: g.edges.length }, v.length ? 1 : 0, v.length ? v.map(x => `${x.rule.padEnd(28)} ${x.detail}`) : [`[graph] 위반 0 (nodes ${g.nodes.size} · edges ${g.edges.length})`]);
  }
  case 'adr-timeline': {
    const docs = resolve(root, flags.docs ?? 'docs');
    if (!existsSync(docs)) fail(2, `docs 디렉터리가 없다: ${docs}`);
    const list = adrTimeline(docs, flags.pattern);
    let written = 0;
    if (flags.write) {
      for (const e of list) for (const t of e.supersedes) { const r = tracker.link ? tracker.link(e.id, t, 'supersedes', { cfg, root, now: new Date().toISOString() }) : { ok: false }; if (r.ok && !r.duplicate) written++; }
    }
    const reversals = list.filter(e => e.supersedes.length);
    out({ ok: true, count: list.length, reversals: reversals.length, written, timeline: list }, 0, [
      `[graph] ADR ${list.length}건 · 반전(supersedes) ${reversals.length}건${flags.write ? ` · 엣지 기록 ${written}` : ''}`,
      ...list.map(e => `${(e.date ?? '????-??-??')}  ${e.id.padEnd(8)} ${e.supersedes.length ? `⟲ ${e.supersedes.join(',')} ` : ''}${e.superseded_by.length ? `(→ ${e.superseded_by.join(',')} 로 반전됨) ` : ''}${e.title.slice(0, 70)}`),
    ]);
  }
  default: fail(2, `모르는 명령: ${cmd}`);
}
