// graph.test.mjs — graph.mjs 통합 테스트. local 트래커 case 를 실제로 만들고 ready/claim/lanes/lint/adr-timeline 을 실행한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const NODE = process.execPath;
function sh(cmd, args, cwd, input) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', input, windowsHide: true }); }
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }

const CFG = {
  version: 4, mode: 'auto', tracker: 'local', issue_prefix: 'HX',
  branch_pattern: '^(feat|fix)/(?<keys>HX-(?:[0-9a-f]{4,6}(?:\\.\\d+)*|\\d+)(?:-(?:[0-9a-f]{4,6}(?:\\.\\d+)*|\\d+))*)(?:-[a-z0-9]+)*$',
  stacks: { be: { dir: 'backend', compile: 'echo ok' } },
};
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-graph-'));
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'user.email', 't@e.com'); g(dir, 'config', 'user.name', 't'); g(dir, 'config', 'core.autocrlf', 'false');
  mkdirSync(join(dir, 'backend'), { recursive: true }); mkdirSync(join(dir, '.claude'), { recursive: true }); mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'backend/App.java'), 'class App {}\n');
  writeFileSync(join(dir, '.gitignore'), '.claude/runtime/\n');
  writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify(CFG, null, 2) + '\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function cases(dir, ...args) { const r = sh(NODE, [join(SCRIPTS, 'cases.mjs'), ...args, '--cwd', dir, '--json'], dir); let out = null; try { out = JSON.parse(r.stdout.trim()); } catch { /* */ } return { status: r.status, out, err: r.stderr }; }
function graph(dir, ...args) { const r = sh(NODE, [join(SCRIPTS, 'graph.mjs'), ...args, '--cwd', dir, '--json'], dir); let out = null; try { out = JSON.parse(r.stdout.trim()); } catch { /* */ } return { status: r.status, out, err: r.stderr, raw: r.stdout }; }
function seed(dir) {
  const a = cases(dir, 'new', 'A 공통 계약').out.key;
  const b = cases(dir, 'new', 'B 백엔드').out.key;
  const c = cases(dir, 'new', 'C 프론트').out.key;
  const d = cases(dir, 'new', 'D 통합').out.key;
  assert.equal(cases(dir, 'link', a, b, 'blocks').out.ok, true);
  assert.equal(cases(dir, 'link', a, c, 'blocks').out.ok, true);
  assert.equal(cases(dir, 'link', b, d, 'blocks').out.ok, true);
  assert.equal(cases(dir, 'link', c, d, 'blocks').out.ok, true);
  return { a, b, c, d };
}

test('ready: blocks 의 from 이 열려 있으면 차단 · done 되면 풀린다 · claim 은 배타(두 번째는 ALREADY_CLAIMED)', () => {
  const dir = makeRepo();
  const { a, b, c, d } = seed(dir);
  let r = graph(dir, 'ready');
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.out.ready.map(x => x.key), [a], 'A 만 착수 가능');
  assert.equal(cases(dir, 'status', a, 'done').out.ok, true);
  r = graph(dir, 'ready');
  assert.deepEqual(r.out.ready.map(x => x.key).sort(), [b, c].sort(), 'A 가 끝나면 B·C 가 풀린다(D 는 아직)');
  const c1 = graph(dir, 'claim', b, '--by', 'lane-be');
  assert.equal(c1.status, 0, c1.err); assert.equal(c1.out.claimed, b);
  const c2 = graph(dir, 'claim', b, '--by', 'lane-other');
  assert.equal(c2.status, 1); assert.equal(c2.out.reason, 'ALREADY_CLAIMED'); assert.equal(c2.out.by, 'lane-be');
  assert.deepEqual(graph(dir, 'ready').out.ready.map(x => x.key), [c], '선점된 B 는 프론티어에서 빠진다');
  assert.equal(graph(dir, 'claim', b, '--release').status, 0);
  assert.deepEqual(graph(dir, 'ready').out.ready.map(x => x.key).sort(), [b, c].sort());
  assert.equal(graph(dir, 'claim', 'HX-none', '--by', 'x').status, 2, '모르는 키는 설정 오류');
  void d;
});

test('lanes: 위상정렬 파도 + 파일 disjoint 검사 · 사이클이면 exit 1', () => {
  const dir = makeRepo();
  const { a, b, c, d } = seed(dir);
  let r = graph(dir, 'lanes', [a, b, c, d].join(','));
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.out.waves, [[a], [b, c].sort(), [d]]);
  assert.equal(r.out.cycle, null);
  assert.equal(r.out.conflicts, null, '--touched 없으면 파일 검사는 안 한다(null 이지 0 이 아니다)');

  const touched = join(dir, 'touched.json');
  writeFileSync(touched, JSON.stringify({ [b]: ['backend/App.java', 'backend/Svc.java'], [c]: ['frontend/app.js'], [d]: ['backend/App.java'] }));
  r = graph(dir, 'lanes', [b, c, d].join(','), '--touched', touched);
  assert.equal(r.status, 1, 'B 와 D 가 같은 파일을 만진다');
  assert.equal(r.out.parallel_ok, false);
  assert.deepEqual(r.out.conflicts, [{ a: b, b: d, files: ['backend/App.java'] }]);
  r = graph(dir, 'lanes', [b, c].join(','), '--touched', touched);
  assert.equal(r.status, 0); assert.equal(r.out.parallel_ok, true); assert.deepEqual(r.out.conflicts, []);

  assert.equal(cases(dir, 'link', d, a, 'blocks').out.ok, true, 'D→A 를 더하면 사이클');
  r = graph(dir, 'lanes', [a, b, c, d].join(','));
  assert.equal(r.status, 1); assert.ok(Array.isArray(r.out.cycle) && r.out.cycle.length === 4, JSON.stringify(r.out));
});

test('lint: 사이클 · 없는 키 엣지 · 부모 done 자식 open · 브랜치 없는 in_progress 를 잡는다 · 깨끗하면 exit 0', () => {
  const dir = makeRepo();
  const { a, b } = seed(dir);
  let r = graph(dir, 'lint');
  assert.equal(r.status, 0, r.err); assert.deepEqual(r.out.violations, []);
  const sub = cases(dir, 'new', '하위', '--parent', a).out.key;
  assert.equal(cases(dir, 'status', a, 'done').out.ok, true);
  assert.equal(cases(dir, 'status', b, 'in_progress').out.ok, true, 'cases.mjs 로 바꾸면 branch 없이 in_progress 가 된다');
  writeFileSync(join(dir, '.caseworker/graph.jsonl'), readFileSync(join(dir, '.caseworker/graph.jsonl'), 'utf8') + JSON.stringify({ from: 'HX-zzzz', to: a, type: 'blocks', at: 'x' }) + '\n' + JSON.stringify({ from: b, to: a, type: 'blocks', at: 'x' }) + '\n');
  r = graph(dir, 'lint');
  assert.equal(r.status, 1);
  const rules = r.out.violations.map(v => v.rule);
  assert.ok(rules.includes('dangling-key'), rules.join(','));
  assert.ok(rules.includes('parent-closed-child-open'), rules.join(','));
  assert.ok(rules.includes('in-progress-without-branch'), rules.join(','));
  assert.ok(rules.includes('cycle'), rules.join(','));
  void sub;
});

test('build: index.json 에 지문이 남고, case 가 바뀌면 ready 가 index_stale 를 알린다', () => {
  const dir = makeRepo();
  seed(dir);
  const b = graph(dir, 'build');
  assert.equal(b.status, 0, b.err);
  assert.ok(existsSync(join(dir, '.caseworker/index.json')));
  assert.match(b.out.fingerprint, /^[0-9a-f]{40}$/);
  assert.equal(graph(dir, 'ready').out.index_stale, false);
  cases(dir, 'new', '새 case');
  assert.equal(graph(dir, 'ready').out.index_stale, true, '노드가 늘면 지문이 달라진다');
  assert.equal(graph(dir, 'build').out.nodes.length, 5);
});

test('adr-timeline: 헤딩·날짜·supersedes/반전 을 뽑고 --write 면 supersedes 엣지를 graph.jsonl 에 남긴다', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'docs/decisions.md'), [
    '# 결정 기록', '',
    '## ADR-001 — 캐시 정책 (2026-01-10)', '캐시는 5분.', '',
    '## ADR-002 — 캐시 무효화 (2026-02-03)', '이 결정은 ADR-001 을 대체한다.', '',
    '### ADR-003 배정 축', '2026-03-01 확정. 감지축은 ADR-002 → ADR-003 으로 반전.', '',
    '## ADR-004 — 무관', '날짜 없음',
  ].join('\n'));
  writeFileSync(join(dir, 'docs/other.md'), '## ADR-001 재언급\n다른 파일에서 다시 언급.\n');
  const r = graph(dir, 'adr-timeline');
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.count, 4);
  const by = Object.fromEntries(r.out.timeline.map(e => [e.id, e]));
  assert.equal(by['ADR-001'].date, '2026-01-10');
  assert.equal(by['ADR-001'].mentions.length, 1, '다른 파일의 재언급은 mentions');
  assert.deepEqual(by['ADR-002'].supersedes, ['ADR-001']);
  assert.deepEqual(by['ADR-001'].superseded_by, ['ADR-002']);
  assert.equal(by['ADR-003'].date, '2026-03-01');
  assert.ok(by['ADR-003'].supersedes.includes('ADR-002'), JSON.stringify(by['ADR-003']));
  assert.equal(by['ADR-004'].date, null);
  assert.deepEqual(r.out.timeline.map(e => e.id), ['ADR-004', 'ADR-001', 'ADR-002', 'ADR-003'], '날짜 없는 것은 앞, 나머지는 날짜순');
  const w = graph(dir, 'adr-timeline', '--write');
  assert.equal(w.out.written, 2);
  const edges = readFileSync(join(dir, '.caseworker/graph.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(edges.some(e => e.from === 'ADR-002' && e.to === 'ADR-001' && e.type === 'supersedes'));
  assert.equal(graph(dir, 'adr-timeline', '--write').out.written, 0, '두 번째는 중복이라 0');
  assert.equal(graph(dir, 'lint').status, 0, 'ADR 노드는 dangling 이 아니다');
});
