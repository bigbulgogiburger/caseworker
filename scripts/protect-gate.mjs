#!/usr/bin/env node
// protect-gate.mjs — PreToolUse(Edit|Write|MultiEdit|NotebookEdit) 훅. harness.json.protected[] 글롭에 맞는 파일 편집을 막는다.
// 무엇을 보호하나: 게이트·DoD probe 가 기대는 테스트, held-out 검증 자산, 그래프 원장, 게이트 스크립트 — "테스트를 고쳐서 통과시키는" 경로를 파일 권한 수준에서 끊는다.
// mode: auto=차단 · suggest=경고 · off=무시. 예외는 훅을 끄는 게 아니라 harness.json.protected 에서 그 글롭을 빼는 것이다(설정 변경이 diff 에 남는다).
// ⚠ Bash/PowerShell 의 sed -i · 리다이렉트로 쓰는 경로는 이 훅이 못 본다 — 그 축은 gate 의 트리 지문(보호 파일이 바뀌면 GATE_STALE)이 잡는다.
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { locateProject, loadConfig, matchesAny } from './lib/config.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
let event = {};
try { event = raw ? JSON.parse(raw) : {}; } catch { event = {}; }
if (event.tool_name && !EDIT_TOOLS.has(event.tool_name)) process.exit(0);

const target = event.tool_input?.file_path ?? event.tool_input?.notebook_path ?? null;
if (!target) process.exit(0);

const cwd = event.cwd && isAbsolute(event.cwd) ? event.cwd : process.cwd();
let verdict = null;
try {
  const proj = locateProject(cwd);
  if (!proj || !proj.configPath) process.exit(0);
  const cfg = loadConfig(proj.configPath);
  const globs = Array.isArray(cfg.protected) ? cfg.protected : [];
  if (!globs.length || cfg.mode === 'off') process.exit(0);
  const abs = isAbsolute(target) ? target : resolve(cwd, target);
  const rel = relative(proj.configRoot, abs).replace(/\\/g, '/');
  if (rel.startsWith('..')) process.exit(0); // 프로젝트 밖
  const hit = globs.find(g => matchesAny(rel, [g]));
  if (!hit) process.exit(0);
  verdict = { decision: cfg.mode === 'suggest' ? 'warn' : 'deny', code: 'PROTECTED', reason: `${rel} 은 보호 파일이다(harness.json.protected: ${hit}) — 검증 자산·게이트를 고쳐서 통과시키지 않는다. 정말 바꿔야 하면 protected 에서 글롭을 빼고 그 변경을 diff 에 남길 것` };
} catch (e) {
  verdict = { decision: 'deny', code: 'HOOK_ERROR', reason: `판정 중 오류(fail-closed): ${e.message}` };
}

const tag = `[caseworker] ${event.tool_name ?? 'edit'}: ${verdict.code} — ${verdict.reason}`;
if (verdict.decision === 'deny') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: tag } }));
else process.stdout.write(JSON.stringify({ systemMessage: `⚠ ${tag} (mode=suggest 라 차단하지 않음)` }));
process.exit(0);
