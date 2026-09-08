// github 어댑터(gh 대역) · session-brief(SessionStart) · md-lint(PostToolUse) 실측
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newState, writeState, statePath, loadConfig } from '../lib/config.mjs';
import { loadTracker, runPhaseOps } from '../lib/tracker.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const NODE = process.execPath;
const FAKE_GH = `node:${join(HERE, 'fixtures/fake-gh.mjs')}`;

function sh(cmd, args, cwd, input, env = {}) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', input, windowsHide: true, env: { ...process.env, ...env } }); }
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }

function makeRepo(cfgPatch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-know-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  for (const d of ['backend', '.claude', 'docs']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'backend/App.java'), 'class App {}\n');
  const cfg = { ...JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8')), ...cfgPatch };
  writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify(cfg, null, 2) + '\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// ---------------------------------------------------------------- github 어댑터

test('github 어댑터: start/complete op 가 gh 라벨 편집·댓글로 실행되고 결과가 ops[].result 에 남는다', async () => {
  const dir = makeRepo({ version: 4, tracker: 'github', issue_prefix: 'GH', branch_pattern: '^(feat|fix)/(?<keys>GH-\\d+(?:-\\d+)*)(?:-[a-z0-9]+)*$', trackers: { github: { repo: 'o/r', start_label: 'wip', done_label: 'needs-review' } }, jira: undefined });
  const log = join(dir, 'gh.log');
  process.env.CASEWORKER_GH = FAKE_GH; process.env.FAKE_GH_LOG = log; process.env.FAKE_GH_LABEL = 'wip';
  try {
    const cfg = loadConfig(join(dir, '.claude/harness.json'));
    const tracker = await loadTracker(cfg);
    assert.equal(tracker.capabilities.direct, true);
    const ctx = { cfg, root: dir, now: new Date().toISOString() };
    const r = await runPhaseOps(tracker, 'start', ['GH-12'], ctx, { branch: 'feat/GH-12' });
    assert.equal(r.applied, true);
    assert.ok(r.ops.every(o => o.result?.ok), JSON.stringify(r.ops));
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(calls[0], ['issue', 'edit', '12', '--add-label', 'wip', '--remove-label', 'needs-review', '-R', 'o/r']);
    assert.equal(calls[1][1], 'comment');
    assert.ok(calls[1].includes('--body'));
    const c = await runPhaseOps(tracker, 'complete', ['GH-12'], ctx, { comment: '끝' });
    const calls2 = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(calls2[2].slice(0, 5), ['issue', 'edit', '12', '--add-label', 'needs-review']);
    assert.ok(!calls2.some(a => a[1] === 'close'), 'close_on_done 기본 false — 닫지 않는다');
    // read / create / search
    const rd = tracker.read(['GH-12'], ctx);
    assert.equal(rd['GH-12'].status, 'in_progress');
    assert.equal(rd['GH-12'].title, '제목 12');
    assert.equal(tracker.create({ title: 't' }, ctx).key, 'GH-77');
    assert.deepEqual(tracker.search('x', ctx), ['GH-3', 'GH-9']);
  } finally { delete process.env.CASEWORKER_GH; delete process.env.FAKE_GH_LOG; delete process.env.FAKE_GH_LABEL; }
});

test('github 어댑터: gh 실패는 throw 가 아니라 result.ok:false — runPhaseOps 가 계속 돈다', async () => {
  const dir = makeRepo({ version: 4, tracker: 'github', issue_prefix: 'GH', branch_pattern: '^(feat|fix)/(?<keys>GH-\\d+)$', jira: undefined });
  process.env.CASEWORKER_GH = FAKE_GH; process.env.FAKE_GH_FAIL = '1';
  try {
    const cfg = loadConfig(join(dir, '.claude/harness.json'));
    const tracker = await loadTracker(cfg);
    const r = await runPhaseOps(tracker, 'start', ['GH-1'], { cfg, root: dir, now: new Date().toISOString() }, {});
    assert.equal(r.ops.length, 2);
    assert.ok(r.ops.every(o => o.result?.ok === false && /boom|exit 1/.test(o.result.reason)), JSON.stringify(r.ops));
  } finally { delete process.env.CASEWORKER_GH; delete process.env.FAKE_GH_FAIL; }
});

// ---------------------------------------------------------------- session-brief

function brief(dir, input) {
  return sh(NODE, [join(SCRIPTS, 'session-brief.mjs')], dir, input ?? JSON.stringify({ cwd: dir, session_id: 'S', source: 'startup' }));
}

test('session-brief: 하네스 밖은 무출력 · 이슈 브랜치는 키·stage·게이트·PROGRESS 꼬리를 additionalContext 로 · 상한 이내', () => {
  const plain = mkdtempSync(join(tmpdir(), 'cw-nobrief-'));
  g(plain, 'init', '-q');
  assert.equal(brief(plain).stdout, '');
  const dir = makeRepo({ version: 4, tracker: 'local', jira: undefined, protected: ['tests/heldout/**'] });
  // 기본 브랜치
  const onMain = JSON.parse(brief(dir).stdout);
  assert.equal(onMain.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(onMain.hookSpecificOutput.additionalContext, /기본 브랜치/);
  // 이슈 브랜치 + 상태 + PROGRESS
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-7');
  const cfg = loadConfig(join(dir, '.claude/harness.json'));
  const st = newState('feat/ABC-7', ['ABC-7']);
  st.stage = 'implement';
  st.decisions = [{ q: '축은?', a: 'A 를 B 로 한다', at: new Date().toISOString() }];
  st.dod = [{ id: 'H1', text: '사람 확인', human: true, last: 'PENDING' }];
  writeState(statePath(cfg, dir, 'feat-ABC-7'), st);
  mkdirSync(join(dir, '.caseworker/cases/ABC-7'), { recursive: true });
  writeFileSync(join(dir, '.caseworker/cases/ABC-7/PROGRESS.md'), '# ABC-7\n\n- 1 첫 줄\n- 2 둘째 줄\n- 3 셋째\n- 4 넷째\n- 5 다섯째\n- 6 여섯째\n');
  const r = brief(dir);
  assert.equal(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /feat\/ABC-7/);
  assert.match(ctx, /stage implement/);
  assert.match(ctx, /게이트 없음/);
  assert.match(ctx, /사람 확인 DoD 미완: H1/);
  assert.match(ctx, /A 를 B 로 한다/);
  assert.match(ctx, /6 여섯째/);
  assert.ok(!ctx.includes('1 첫 줄'), '꼬리 5줄만');
  assert.match(ctx, /보호 파일.*tests\/heldout/);
  assert.ok(ctx.length <= 3500, `상한: ${ctx.length}`);
  // --print 는 사람용 텍스트
  const p = sh(NODE, [join(SCRIPTS, 'session-brief.mjs'), '--print', '--cwd', dir], dir);
  assert.match(p.stdout, /\[caseworker\] 브랜치 feat\/ABC-7/);
});

// ---------------------------------------------------------------- md-lint

function mdlint(dir, file) {
  return sh(NODE, [join(SCRIPTS, 'md-lint.mjs')], dir, JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file }, cwd: dir }));
}

test('md-lint: 깨진 [[link]]·상대 링크·frontmatter·LOG 형식은 경고(additionalContext) — 차단 아님 · 깨끗하면 무출력 · .md 아니면 무시', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-mdlint-'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs/ok.md'), '---\nname: ok\n---\n# ok\n');
  writeFileSync(join(dir, 'docs/bad.md'), '---\nname: bad\nno colon here\n# bad\n[[ok]] [[missing-page]] [a](ok.md) [b](nope.md) [c](https://x/y.md)\n');
  const good = mdlint(dir, join(dir, 'docs/ok.md'));
  assert.equal(good.status, 0); assert.equal(good.stdout, '');
  const bad = mdlint(dir, join(dir, 'docs/bad.md'));
  assert.equal(bad.status, 0, 'PostToolUse 는 차단하지 않는다');
  const out = JSON.parse(bad.stdout);
  const msg = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(msg, /missing-page/);
  assert.match(msg, /nope\.md/);
  assert.match(msg, /frontmatter/);
  assert.ok(!/https/.test(msg), 'http 링크는 검사 밖');
  assert.ok(!msg.includes('[[ok]]'), '실재하는 위키링크는 경고 없음');
  writeFileSync(join(dir, 'docs/LOG.md'), '# LOG\n[2026-09-08 10:00 KST AUTO ABC-1 closure] ok\n산문 줄\n');
  const log = JSON.parse(mdlint(dir, join(dir, 'docs/LOG.md')).stdout).hookSpecificOutput.additionalContext;
  assert.match(log, /LOG\.md 3행/);
  assert.ok(!/2행/.test(log));
  writeFileSync(join(dir, 'a.txt'), '[[x]]');
  assert.equal(mdlint(dir, join(dir, 'a.txt')).stdout, '');
  // CLI 모드 --strict
  const strict = sh(NODE, [join(SCRIPTS, 'md-lint.mjs'), '--file', join(dir, 'docs/bad.md'), '--strict'], dir);
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /W: \[\[missing-page\]\]/);
});
