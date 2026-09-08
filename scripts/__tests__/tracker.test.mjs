// tracker.test.mjs — 트래커 어댑터 층 통합 테스트. 실제 임시 git 저장소에서 local 어댑터 round-trip · 키 규칙 · v3/v4 설정 호환을 실행한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseBranch } from '../lib/config.mjs';
import { keyPattern, keysToken, normalizeKey, expandKeysWith, loadTracker, runPhaseOps } from '../lib/tracker.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const NODE = process.execPath;

function sh(cmd, args, cwd, input) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', input, windowsHide: true }); }
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }

const LOCAL_CFG = {
  version: 4, mode: 'auto', tracker: 'local', issue_prefix: 'HX',
  branch_pattern: '^(feat|fix)/(?<keys>HX-(?:[0-9a-f]{4,6}(?:\\.\\d+)*|\\d+)(?:-(?:[0-9a-f]{4,6}(?:\\.\\d+)*|\\d+))*)(?:-[a-z0-9]+)*$',
  stacks: { be: { dir: 'backend', compile: 'echo ok', test: "echo '1 tests completed'" } },
};
const V3_JIRA_CFG = {
  version: 3, mode: 'auto', issue_prefix: 'ABC',
  branch_pattern: '^(feat|fix)/(?<keys>ABC-\\d+(?:-\\d+)*)(?:-[a-z0-9]+)*$',
  stacks: { be: { dir: 'backend', compile: 'echo ok' } },
  jira: { start_transition: '진행 중', done_transition: 'QA' },
};

function makeRepo(cfg) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-tracker-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'core.autocrlf', 'false');
  for (const d of ['backend', '.claude']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'backend/App.java'), 'class App {}\n');
  writeFileSync(join(dir, '.gitignore'), '.claude/runtime/\n');
  writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify(cfg, null, 2) + '\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function cases(dir, ...args) {
  const r = sh(NODE, [join(SCRIPTS, 'cases.mjs'), ...args, '--cwd', dir, '--json'], dir);
  let out = null; try { out = JSON.parse(r.stdout.trim()); } catch { /* not json */ }
  return { status: r.status, out, err: r.stderr, raw: r.stdout };
}
function start(dir, keysArg) {
  const r = sh(NODE, [join(SCRIPTS, 'issue-start.mjs'), keysArg, '--cwd', dir, '--json'], dir);
  let out = null; try { out = JSON.parse(r.stdout.trim()); } catch { /* not json */ }
  return { status: r.status, out, err: r.stderr };
}

test('키 규칙: local 은 해시(hex 4~6 + .n)와 순번 둘 다, jira 는 숫자만 · 정규화는 접두사 대문자·본문 소문자', () => {
  const dir = makeRepo(LOCAL_CFG);
  const cfg = loadConfig(join(dir, '.claude/harness.json'));
  const kp = keyPattern(cfg);
  for (const ok of ['HX-a3f8', 'HX-a3f8.1', 'HX-a3f8.1.2', 'HX-abcdef', 'HX-1', 'HX-1234']) assert.ok(kp.test(ok), ok);
  for (const bad of ['HX-zz', 'HX-a3f', 'HX-a3f8-', 'hx-a3f8', 'HX-abcdefg']) assert.ok(!kp.test(bad), bad);
  assert.equal(normalizeKey('hx-A3F8', cfg), 'HX-a3f8');
  assert.equal(keysToken(['HX-a3f8', 'HX-b2c1'], cfg), 'HX-a3f8-b2c1');
  assert.deepEqual(expandKeysWith('a3f8-b2c1-login', 'HX', cfg.trackers.local.key_body), ['HX-a3f8', 'HX-b2c1']);
  assert.deepEqual(parseBranch('feat/HX-a3f8.1-b2c1-login', cfg).keys, ['HX-a3f8.1', 'HX-b2c1']);
  assert.equal(parseBranch('feat/login', cfg), null);

  const jdir = makeRepo(V3_JIRA_CFG);
  const jcfg = loadConfig(join(jdir, '.claude/harness.json'));
  assert.ok(keyPattern(jcfg).test('ABC-12'));
  assert.ok(!keyPattern(jcfg).test('ABC-a3f8'), 'jira 키는 숫자만');
  assert.equal(normalizeKey('abc-12', jcfg), 'ABC-12');
});

test('v3 설정(jira 블록만) → jira 트래커로 읽힌다(무변경 호환) · v4 local 은 local', () => {
  const jdir = makeRepo(V3_JIRA_CFG);
  const jcfg = loadConfig(join(jdir, '.claude/harness.json'));
  assert.equal(jcfg.tracker, 'jira');
  assert.equal(jcfg.trackers.jira.start_transition, '진행 중');
  assert.equal(jcfg.trackers.jira.done_transition, 'QA');
  assert.equal(jcfg.trackers.jira.comment_lang, 'ko', '기본값이 채워진다');
  assert.equal(jcfg.jira.done_transition, 'QA', '구 코드 호환 별칭');
  const ldir = makeRepo(LOCAL_CFG);
  const lcfg = loadConfig(join(ldir, '.claude/harness.json'));
  assert.equal(lcfg.tracker, 'local');
  assert.equal(lcfg.trackers.local.dir, '.caseworker');
  assert.equal(lcfg.trackers.jira.start_transition, 'In Progress', '안 쓰는 어댑터도 기본값은 있다');
});

test('local round-trip: new(해시 키) → 하위 .1 → show/list/search → status → comment → link → PROGRESS append-only', () => {
  const dir = makeRepo(LOCAL_CFG);
  const n1 = cases(dir, 'new', '로그인 자동완성 버그', '--type', 'bug', '--label', 'frontend,bug');
  assert.equal(n1.status, 0, n1.err);
  const key = n1.out.key;
  assert.match(key, /^HX-[0-9a-f]{4,6}$/, key);
  const n2 = cases(dir, 'new', '위젯 골격', '--parent', key);
  assert.equal(n2.status, 0, n2.err);
  assert.equal(n2.out.key, `${key}.1`);
  const n3 = cases(dir, 'new', '스타일', '--parent', key);
  assert.equal(n3.out.key, `${key}.2`, '하위 순번은 부모 안에서 증가');

  const show = cases(dir, 'show', key);
  assert.equal(show.status, 0, show.err);
  const c = show.out.cases[key];
  assert.equal(c.title, '로그인 자동완성 버그');
  assert.equal(c.type, 'bug');
  assert.equal(c.status, 'open');
  assert.deepEqual(c.labels, ['frontend', 'bug']);
  assert.ok(c.links.some(e => e.type === 'parent-child' && e.to === `${key}.1`), JSON.stringify(c.links));
  assert.ok(existsSync(join(dir, '.caseworker/cases', key, 'body.md')));

  const list = cases(dir, 'list');
  assert.equal(list.out.cases.length, 3);
  assert.equal(cases(dir, 'list', '--q', '골격').out.cases.length, 1);
  assert.equal(cases(dir, 'list', '--status', 'open').out.cases.length, 3);

  assert.equal(cases(dir, 'status', key, 'in_progress').out.ok, true);
  assert.equal(cases(dir, 'status', key, 'nope').status, 2, '허용 밖 상태는 사용법 오류');
  assert.equal(cases(dir, 'show', key).out.cases[key].status, 'in_progress');

  assert.equal(cases(dir, 'comment', key, '첫 댓글').out.ok, true);
  assert.equal(cases(dir, 'comment', key, '둘째 댓글').out.ok, true);
  const after = cases(dir, 'show', key).out.cases[key];
  assert.equal(after.comments.length, 2, '댓글은 파일당 1건');
  assert.ok(after.comments[1].text.includes('둘째'));

  assert.equal(cases(dir, 'link', `${key}.1`, `${key}.2`, 'blocks').out.ok, true);
  assert.equal(cases(dir, 'link', `${key}.1`, `${key}.2`, 'blocks').out.duplicate, true, '같은 엣지는 중복 기록하지 않는다');
  const graph = readFileSync(join(dir, '.caseworker/graph.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(graph.filter(e => e.type === 'blocks').length, 1);

  assert.equal(cases(dir, 'progress', key, '작업 메모').out.ok, true);
  const prog = readFileSync(join(dir, '.caseworker/cases', key, 'PROGRESS.md'), 'utf8');
  assert.ok(prog.includes('생성 (bug)') && prog.includes('open → in_progress') && prog.includes('작업 메모'), prog);

  assert.equal(cases(dir, 'show', 'HX-ffff').out.ok, false, '없는 키는 ok:false');
  assert.equal(cases(dir, 'new', '').status, 2, '제목 없으면 사용법 오류');
});

test('issue-start(local): 착수 op 가 그 자리에서 실행된다 · 없는 키는 자리표시 case 생성 · RESUMED 는 op 없음', () => {
  const dir = makeRepo(LOCAL_CFG);
  const key = cases(dir, 'new', '기능 A').out.key;
  const r = start(dir, key);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.code, 'STARTED');
  assert.equal(r.out.branch, `feat/${key}`);
  assert.equal(r.out.tracker.name, 'local');
  assert.equal(r.out.tracker.direct, true);
  assert.equal(r.out.tracker.applied, true);
  assert.ok(r.out.tracker.ops.every(o => o.via === 'script' && o.result?.ok), JSON.stringify(r.out.tracker.ops));
  assert.ok(r.out.tracker.read_hint.command.includes('cases.mjs'));
  const c = cases(dir, 'show', key).out.cases[key];
  assert.equal(c.status, 'in_progress');
  assert.equal(c.branch, `feat/${key}`, '착수 브랜치가 case 에 남는다');
  assert.equal(c.comments.length, 1);

  const again = start(dir, key);
  assert.equal(again.out.code, 'RESUMED');
  assert.equal(again.out.tracker.ops.length, 0);
  assert.equal(cases(dir, 'show', key).out.cases[key].comments.length, 1, 'RESUMED 는 댓글을 또 달지 않는다');

  g(dir, 'checkout', '-q', 'main');
  const r2 = start(dir, 'HX-7');
  assert.equal(r2.out.code, 'STARTED');
  const auto = cases(dir, 'show', 'HX-7').out.cases['HX-7'];
  assert.ok(auto, '키만 있고 case 가 없으면 자리표시 case 를 만든다');
  assert.equal(auto.title, 'HX-7');
  assert.equal(auto.status, 'in_progress');
});

test('issue-start(jira, v3 설정): op 는 router 로 나가고 스크립트는 아무것도 실행하지 않는다 · cases.mjs 는 힌트만', async () => {
  const dir = makeRepo(V3_JIRA_CFG);
  const r = start(dir, 'ABC-12');
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.tracker.name, 'jira');
  assert.equal(r.out.tracker.direct, false);
  assert.equal(r.out.tracker.applied, false);
  const tr = r.out.tracker.ops.find(o => o.op === 'transition');
  assert.equal(tr.to, '진행 중');
  assert.equal(tr.via, 'router');
  assert.equal(tr.tool, 'transitionJiraIssue');
  assert.ok(!('result' in tr));
  assert.equal(r.out.tracker.read_hint.tool, 'getJiraIssue');
  assert.ok(!existsSync(join(dir, '.caseworker')), 'jira 트래커는 로컬 case 파일을 만들지 않는다');
  const h = cases(dir, 'show', 'ABC-12');
  assert.equal(h.status, 2);
  assert.equal(h.out.ok, false);
  assert.equal(h.out.hint.tool, 'getJiraIssue');

  // 어댑터 직접 호출도 같은 결과
  const cfg = loadConfig(join(dir, '.claude/harness.json'));
  const adapter = await loadTracker(cfg);
  const out = await runPhaseOps(adapter, 'complete', ['ABC-12'], { cfg, root: dir, now: '2026-01-01T00:00:00Z' }, { comment: '끝' });
  assert.equal(out.applied, false);
  assert.equal(out.ops.find(o => o.op === 'transition').to, 'QA');
});

test('모르는 트래커 이름은 NO_TRACKER 로 거부한다(설정 오류, exit 2)', () => {
  const dir = makeRepo({ ...LOCAL_CFG, tracker: 'gitlab' });
  const r = start(dir, 'HX-1');
  assert.equal(r.status, 2);
  assert.ok(r.err.includes('트래커 어댑터가 없다'), r.err);
});
