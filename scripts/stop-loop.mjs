#!/usr/bin/env node
// stop-loop.mjs — Stop 훅. 완성도 루프가 이 세션에서 활성이면(.loop/session.local.json) 세션 종료를 막고 다음 라운드 프롬프트를 되먹인다.
// 판정은 loop.mjs 가 디스크(checkpoint.json)에 남긴 verdict 를 따른다 — 훅은 계산하지 않는다.
//   - session_id 가 다르면 무시(같은 프로젝트의 다른 세션을 막지 않는다 — ralph-loop 의 격리 규칙)
//   - verdict 가 STOP/ESCALATE 이거나 상한(max_rounds·max_minutes)에 닿으면 세션 파일을 비활성화하고 통과
//   - 그 외: {"decision":"block","reason":"<프롬프트> (R<n>)"} — Claude Code 는 종료를 멈추고 reason 을 다음 입력으로 쓴다
// 예외·손상은 fail-open 이 아니라 "루프 정지" 다 — 루프를 계속 도는 쪽이 비용이고, 멈추는 쪽이 안전하다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { locateProject } from './lib/config.mjs';

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
let event = {};
try { event = raw ? JSON.parse(raw) : {}; } catch { event = {}; }

const cwd = event.cwd && isAbsolute(event.cwd) ? event.cwd : process.cwd();
const proj = locateProject(cwd);
const root = proj ? (proj.configRoot ?? proj.toplevel) : resolve(cwd);
const LOOP = join(root, '.loop');
const sessionFile = join(LOOP, 'session.local.json');
if (!existsSync(sessionFile)) process.exit(0);

function deactivate(note) {
  try { const s = JSON.parse(readFileSync(sessionFile, 'utf8')); s.active = false; s.stopped_at = new Date().toISOString(); s.stop_note = note; writeFileSync(sessionFile, JSON.stringify(s, null, 2) + '\n'); } catch { /* ignore */ }
  process.stderr.write(`[caseworker] loop: 정지 — ${note}\n`);
  process.exit(0);
}

let session;
try { session = JSON.parse(readFileSync(sessionFile, 'utf8')); } catch { deactivate('session.local.json 손상'); }
if (!session.active) process.exit(0);
if (session.session_id && event.session_id && session.session_id !== event.session_id) process.exit(0); // 다른 세션

let ck = null;
try { ck = existsSync(join(LOOP, 'checkpoint.json')) ? JSON.parse(readFileSync(join(LOOP, 'checkpoint.json'), 'utf8')) : null; } catch { deactivate('checkpoint.json 손상'); }
let cfg = null;
try { cfg = existsSync(join(LOOP, 'loop.json')) ? JSON.parse(readFileSync(join(LOOP, 'loop.json'), 'utf8')) : null; } catch { deactivate('loop.json 손상'); }
if (!cfg) deactivate('loop.json 없음');

const rounds = ck?.rounds?.length ?? 0;
const verdict = ck?.last_verdict ?? null;
if (verdict === 'STOP' || verdict === 'ESCALATE') deactivate(`verdict ${verdict} — ${ck.last_reason ?? ''}`);
const maxRounds = session.max_rounds ?? cfg.caps?.max_rounds ?? null;
if (maxRounds && rounds >= maxRounds) deactivate(`max_rounds ${maxRounds} 도달`);
const maxMin = cfg.caps?.max_minutes ?? null;
if (maxMin && session.started_at && (Date.now() - Date.parse(session.started_at)) / 60000 >= maxMin) deactivate(`max_minutes ${maxMin} 도달`);

const nextRound = rounds + 1;
const nextMode = ck?.next?.mode ?? 'per-round';
const reason = `${session.prompt}\n\n[caseworker loop] R${nextRound}${maxRounds ? `/${maxRounds}` : ''} · 모드 ${nextMode}. 이 라운드가 끝나면 반드시 \`loop.mjs record --mode ${nextMode} --active <점수> …\` 로 기록할 것 — 기록이 없으면 다음 종료 시점에 같은 라운드가 반복된다.`;
process.stdout.write(JSON.stringify({ decision: 'block', reason }));
process.exit(0);
