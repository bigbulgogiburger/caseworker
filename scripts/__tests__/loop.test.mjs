// loop.mjs · stop-loop.mjs · protect-gate.mjs · gate held_out — 임시 저장소에서 실행 실측
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newState, writeState, readState } from '../lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const NODE = process.execPath;

function sh(cmd, args, cwd, input) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', input, windowsHide: true }); }
function g(cwd, ...args) { const r = sh('git', args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }
function node(script, args, cwd, input) { return sh(NODE, [join(SCRIPTS, script), ...args], cwd, input); }
function loop(cwd, ...args) { const r = node('loop.mjs', [...args, '--json', '--cwd', cwd], cwd); let value = null; try { value = JSON.parse(r.stdout); } catch { /* */ } return { ...r, value }; }

function makeRepo({ protectedGlobs = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-loop-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  for (const d of ['backend', 'frontend', '.claude', 'tests/heldout']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'backend/App.java'), 'class App {}\n');
  writeFileSync(join(dir, 'frontend/app.js'), 'export default 1\n');
  writeFileSync(join(dir, 'tests/heldout/probe.txt'), 'x\n');
  const cfg = JSON.parse(readFileSync(join(HERE, 'fixtures/harness.json'), 'utf8'));
  if (protectedGlobs) cfg.protected = protectedGlobs;
  writeFileSync(join(dir, '.claude/harness.json'), JSON.stringify(cfg, null, 2) + '\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// ---------------------------------------------------------------- loop.mjs

test('loop init: caps 없으면 거부, 있으면 .loop/ 3파일 생성 · check 통과', () => {
  const dir = makeRepo();
  const bad = loop(dir, 'init', '--name', 'demo');
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /caps/);
  const ok = loop(dir, 'init', '--name', 'demo', '--goal', 'x', '--max-rounds', '5');
  assert.equal(ok.status, 0, ok.stderr);
  for (const f of ['loop.json', 'checkpoint.json', 'scorecard.json']) assert.ok(existsSync(join(dir, '.loop', f)), f);
  const chk = loop(dir, 'check');
  assert.equal(chk.status, 0, chk.stderr);
  assert.equal(chk.value.ok, true);
});

test('loop check: 가중치 합 ≠ 1 · auto_merge true 는 무효', () => {
  const dir = makeRepo();
  loop(dir, 'init', '--name', 'demo', '--max-rounds', '3');
  const p = join(dir, '.loop/loop.json');
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  cfg.dimensions = [{ id: 'a', label: 'A', weight: 0.5 }, { id: 'b', label: 'B', weight: 0.3 }];
  cfg.safety.auto_merge = true;
  writeFileSync(p, JSON.stringify(cfg));
  const chk = loop(dir, 'check');
  assert.equal(chk.status, 2);
  assert.ok(chk.value.errors.some(e => /weight/.test(e)), JSON.stringify(chk.value.errors));
  assert.ok(chk.value.errors.some(e => /auto_merge/.test(e)));
});

test('loop record: STOP 은 full 연속 consecutive 회 · per-round 는 세지 않는다 · target 넘긴 per-round 다음은 full', () => {
  const dir = makeRepo();
  loop(dir, 'init', '--name', 'demo', '--max-rounds', '20', '--target', '90', '--consecutive', '2', '--full-audit-every', '100');
  let r = loop(dir, 'record', '--mode', 'per-round', '--active', '92', '--changed-files', '3');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.value.verdict, 'CONTINUE');
  assert.equal(r.value.consecutive_at_target, 0, 'per-round 는 카운터를 올리지 않는다');
  assert.equal(r.value.next.mode, 'full', 'target 을 넘긴 per-round 다음은 full 로 확정');
  r = loop(dir, 'record', '--mode', 'full', '--active', '93', '--changed-files', '2');
  assert.equal(r.value.verdict, 'CONTINUE');
  assert.equal(r.value.consecutive_at_target, 1);
  r = loop(dir, 'record', '--mode', 'full', '--active', '91', '--changed-files', '1');
  assert.equal(r.status, 1, 'STOP 은 exit 1');
  assert.equal(r.value.verdict, 'STOP');
  assert.equal(r.value.next, null);
  const v = loop(dir, 'verdict');
  assert.equal(v.value.verdict, 'STOP');
});

test('loop record: full 에서 target 아래로 떨어지면 연속 카운터 0 으로 리셋', () => {
  const dir = makeRepo();
  loop(dir, 'init', '--name', 'demo', '--max-rounds', '20', '--target', '90', '--consecutive', '2');
  loop(dir, 'record', '--mode', 'full', '--active', '95', '--changed-files', '1');
  const r = loop(dir, 'record', '--mode', 'full', '--active', '80', '--changed-files', '1', '--deficit', 'auth');
  assert.equal(r.value.verdict, 'CONTINUE');
  assert.equal(r.value.consecutive_at_target, 0);
});

test('loop record: 파일 변경 0 이 연속 2회면 서킷브레이커 ESCALATE', () => {
  const dir = makeRepo();
  loop(dir, 'init', '--name', 'demo', '--max-rounds', '20');
  loop(dir, 'record', '--mode', 'per-round', '--active', '50', '--changed-files', '0');
  const r = loop(dir, 'record', '--mode', 'per-round', '--active', '55', '--changed-files', '0');
  assert.equal(r.value.verdict, 'ESCALATE', JSON.stringify(r.value));
  assert.ok(r.value.reasons.some(s => /breaker/.test(s)));
});

test('loop record: 점수 정체 + 같은 deficit 이 consecutive 회면 no-progress ESCALATE', () => {
  const dir = makeRepo();
  loop(dir, 'init', '--name', 'demo', '--max-rounds', '20', '--consecutive', '2');
  loop(dir, 'record', '--mode', 'per-round', '--active', '70', '--changed-files', '2', '--deficit', 'auth');
  loop(dir, 'record', '--mode', 'per-round', '--active', '70', '--changed-files', '2', '--deficit', 'auth');
  const r = loop(dir, 'record', '--mode', 'per-round', '--active', '70', '--changed-files', '2', '--deficit', 'auth');
  assert.equal(r.value.verdict, 'ESCALATE', JSON.stringify(r.value));
  assert.ok(r.value.reasons.some(s => /no-progress/.test(s)));
});

test('loop record: max_rounds 상한에 닿으면 점수와 무관하게 STOP(cap_hit)', () => {
  const dir = makeRepo();
  loop(dir, 'init', '--name', 'demo', '--max-rounds', '2');
  loop(dir, 'record', '--mode', 'per-round', '--active', '10', '--changed-files', '5');
  const r = loop(dir, 'record', '--mode', 'per-round', '--active', '20', '--changed-files', '5');
  assert.equal(r.value.verdict, 'STOP');
  assert.equal(r.value.cap_hit, true);
});

// ---------------------------------------------------------------- stop-loop.mjs (Stop 훅)

function stopHook(dir, sessionId) {
  const r = node('stop-loop.mjs', [], dir, JSON.stringify({ session_id: sessionId, cwd: dir, stop_hook_active: false }));
  let out = null; try { out = JSON.parse(r.stdout); } catch { /* */ }
  return { ...r, out };
}

test('stop 훅: 세션 활성이면 block + 다음 라운드 프롬프트 · 다른 session_id 는 통과 · STOP 판정 뒤엔 통과·비활성화', () => {
  const dir = makeRepo();
  loop(dir, 'init', '--name', 'demo', '--max-rounds', '5');
  // 세션 파일 없음 → 통과
  assert.equal(stopHook(dir, 'S1').out, null);
  const s = loop(dir, 'session', 'start', '--session-id', 'S1', '--prompt', '다음 라운드');
  assert.equal(s.status, 0, s.stderr);
  const h1 = stopHook(dir, 'S1');
  assert.equal(h1.out?.decision, 'block', h1.stdout + h1.stderr);
  assert.match(h1.out.reason, /다음 라운드/);
  assert.match(h1.out.reason, /R1\/5/);
  assert.equal(stopHook(dir, 'OTHER').out, null, '다른 세션은 막지 않는다');
  // 라운드 기록 후 R2
  loop(dir, 'record', '--mode', 'per-round', '--active', '50', '--changed-files', '1');
  assert.match(stopHook(dir, 'S1').out.reason, /R2\/5/);
  // STOP 판정 → 통과 + session 비활성
  loop(dir, 'init', '--name', 'demo', '--max-rounds', '5', '--target', '90', '--consecutive', '1', '--force');
  loop(dir, 'session', 'start', '--session-id', 'S1', '--prompt', 'p');
  loop(dir, 'record', '--mode', 'full', '--active', '95', '--changed-files', '1');
  const h3 = stopHook(dir, 'S1');
  assert.equal(h3.out, null, h3.stdout);
  assert.match(h3.stderr, /STOP/);
  const session = JSON.parse(readFileSync(join(dir, '.loop/session.local.json'), 'utf8'));
  assert.equal(session.active, false);
  assert.equal(stopHook(dir, 'S1').out, null, '비활성 뒤 재호출도 통과');
});

test('stop 훅: session.local.json 손상은 루프 정지(통과)', () => {
  const dir = makeRepo();
  loop(dir, 'init', '--name', 'demo', '--max-rounds', '5');
  writeFileSync(join(dir, '.loop/session.local.json'), '{not json');
  const h = stopHook(dir, 'S1');
  assert.equal(h.status, 0);
  assert.equal(h.out, null);
  assert.match(h.stderr, /손상/);
});

// ---------------------------------------------------------------- protect-gate.mjs

function protectHook(dir, filePath, { tool = 'Edit', cwd = dir } = {}) {
  const r = node('protect-gate.mjs', [], cwd, JSON.stringify({ tool_name: tool, tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' }, cwd }));
  let out = null; try { out = JSON.parse(r.stdout); } catch { /* */ }
  return { ...r, out };
}

test('protect 훅: protected 글롭에 맞는 파일은 deny(PROTECTED) · 밖은 통과 · 상대 경로도 판정 · 프로젝트 밖은 통과', () => {
  const dir = makeRepo({ protectedGlobs: ['tests/heldout/**', 'scripts/gate*.mjs'] });
  const d = protectHook(dir, join(dir, 'tests/heldout/probe.txt'));
  assert.equal(d.out?.hookSpecificOutput?.permissionDecision, 'deny', d.stdout + d.stderr);
  assert.match(d.out.hookSpecificOutput.permissionDecisionReason, /PROTECTED/);
  assert.equal(protectHook(dir, join(dir, 'backend/App.java')).out, null, '보호 밖은 통과');
  assert.equal(protectHook(dir, 'tests/heldout/probe.txt').out?.hookSpecificOutput?.permissionDecision, 'deny', '상대 경로');
  assert.equal(protectHook(dir, join(tmpdir(), 'elsewhere.txt')).out, null, '프로젝트 밖');
  assert.equal(protectHook(dir, join(dir, 'tests/heldout/probe.txt'), { tool: 'Bash' }).out, null, '편집 툴이 아니면 무시');
});

test('protect 훅: protected 비어 있으면 통과 · mode=suggest 는 경고만', () => {
  const none = makeRepo();
  assert.equal(protectHook(none, join(none, 'tests/heldout/probe.txt')).out, null);
  const dir = makeRepo({ protectedGlobs: ['tests/heldout/**'] });
  const p = join(dir, '.claude/harness.json');
  const cfg = JSON.parse(readFileSync(p, 'utf8')); cfg.mode = 'suggest'; writeFileSync(p, JSON.stringify(cfg));
  const w = protectHook(dir, join(dir, 'tests/heldout/probe.txt'));
  assert.ok(w.out?.systemMessage, w.stdout);
  assert.equal(w.out.hookSpecificOutput, undefined);
});

// ---------------------------------------------------------------- gate held_out

test('gate: held_out DoD 프로브는 --commit 에서 돌지 않고 full 에서만 돈다', () => {
  const dir = makeRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/ABC-1');
  const st = newState('feat/ABC-1', ['ABC-1']);
  st.dod = [
    { id: 'visible', text: '보이는 프로브', probe: 'echo visible-ok', expect: { pattern: 'visible-ok' } },
    { id: 'hidden', text: 'held-out 프로브', probe: 'echo hidden-ok', expect: { pattern: 'hidden-ok' }, held_out: true },
  ];
  const sPath = join(dir, '.claude/runtime/issues/feat-ABC-1.json');
  writeState(sPath, st);
  const dry = sh(NODE, [join(SCRIPTS, 'gate.mjs'), '--commit', '--dry-run', '--json', '--cwd', dir], dir);
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.deepEqual(plan.dod_probes.map(d => d.id), ['visible']);
  assert.deepEqual(plan.dod_held_out, ['hidden']);
  const full = sh(NODE, [join(SCRIPTS, 'gate.mjs'), '--full', '--dry-run', '--json', '--cwd', dir], dir);
  const fplan = JSON.parse(full.stdout);
  assert.deepEqual(fplan.dod_probes.map(d => d.id).sort(), ['hidden', 'visible']);
  assert.deepEqual(fplan.dod_held_out, []);
  // 실제 실행: commit 게이트 뒤 hidden 은 PENDING 그대로
  const run = sh(NODE, [join(SCRIPTS, 'gate.mjs'), '--commit', '--json', '--cwd', dir], dir);
  assert.equal(run.status, 0, run.stderr);
  const after = readState(sPath);
  assert.equal(after.dod.find(d => d.id === 'visible').last, 'PASS');
  assert.notEqual(after.dod.find(d => d.id === 'hidden').last, 'PASS');
});
