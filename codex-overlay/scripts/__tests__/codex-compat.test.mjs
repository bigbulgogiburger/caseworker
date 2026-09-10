import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = fileURLToPath(new URL('../', import.meta.url));
function run(file, args, cwd, input) {
  const r = spawnSync(file, args, { cwd, input, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.ifError(r.error);
  return r;
}

test('Codex config path drives NO_STATE; setup preserves existing TOML', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cw-codex-'));
  assert.equal(run('git', ['init', '-q', '-b', 'feat/ABC-1'], cwd).status, 0);
  writeFileSync(join(cwd, 'app.js'), 'export default 1;\n');
  assert.equal(run('git', ['add', 'app.js'], cwd).status, 0);
  const hook = command => run(process.execPath, [join(scripts, 'commit-gate.mjs')], cwd,
    JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } }));
  const absent = hook('git commit -m probe');
  assert.equal(absent.status, 0);
  assert.match(absent.stderr, /NO_HARNESS/);
  assert.equal(absent.stdout, '');
  mkdirSync(join(cwd, '.codex'));
  const cfg = JSON.parse(readFileSync(join(scripts, '__tests__/fixtures/harness.json'), 'utf8'));
  cfg.herdr = { enabled: false };
  const configPath = join(cwd, '.codex/harness.json');
  writeFileSync(configPath, JSON.stringify(cfg));
  for (const command of ['git commit -m probe', 'git push origin HEAD']) {
    const denied = hook(command);
    assert.equal(denied.status, 0);
    const out = JSON.parse(denied.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /NO_STATE/);
  }
  assert.equal(hook('git status').stdout, '');
  const tomlPath = join(cwd, '.codex/config.toml');
  const toml = '[features]\nhooks = true\n';
  writeFileSync(tomlPath, toml);
  const setup = run(process.execPath, [join(scripts, 'setup.mjs'), 'write', '--config', configPath, '--json'], cwd);
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(readFileSync(tomlPath, 'utf8'), toml);
  assert.equal(existsSync(join(cwd, '.codex/settings.json')), false);
  assert.match(JSON.parse(setup.stdout).settings.instructions, /caseworker@caseworker-codex/);
  assert.match(readFileSync(join(cwd, '.gitignore'), 'utf8'), /\.codex\/harness.env.local/);
});
