#!/usr/bin/env node
// loop.mjs — 완성도 루프의 장부. 점수를 매기지 않는다(그건 probe·레인이 한다) — 라운드 기록·종료 판정·상한·서킷브레이커만 결정론적으로 계산한다.
//
//   node loop.mjs check                                    .loop/loop.json 검증(가중치 Σ=1 · caps ≥1 · auto_merge=false)
//   node loop.mjs init --name <slug> --goal "<한 줄>" --max-rounds N [--max-cost-usd X] [--max-minutes M]
//                 [--target 90] [--consecutive 2] [--full-audit-every 3] [--dimensions <json 파일>] [--force]
//                                                          .loop/{loop.json, checkpoint.json, scorecard.json} 골격 — caps 없으면 거부
//   node loop.mjs record --mode full|per-round --active <0~100> [--domains <json 파일|inline>] [--deficit <id>]
//                 [--changed-files N] [--error "<시그니처>"] [--cost-usd X] [--blocked a,b] [--note "<한 줄>"]
//                                                          라운드 1건 기록 → verdict(STOP|ESCALATE|CONTINUE) + 사유 + next(full 여부)
//   node loop.mjs verdict                                  디스크 상태로 마지막 판정 재계산(변경 없음)
//   node loop.mjs status                                   현황 요약
//   node loop.mjs session start --session-id <id> --prompt "<라운드 프롬프트>"   Stop 훅 루프 활성(session.local.json)
//   node loop.mjs session stop                             비활성
//   공통: [--cwd <dir>] [--json]
// 종료 코드: 0 · 1(verdict 가 STOP/ESCALATE — 실패가 아니라 "멈춰라") · 2 사용법/설정 오류
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { locateProject } from './lib/config.mjs';
import { validate, loadSchema } from './lib/schema.mjs';

const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json' || a === '--force') flags[a.slice(2)] = true;
  else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
  else pos.push(a);
}
const [cmd, sub] = pos;
const asJson = !!flags.json;
function fail(code, msg) { console.error(`[loop] ${msg}`); process.exit(code); }
function out(obj, code = 0, human = []) { if (asJson) console.log(JSON.stringify(obj, null, 2)); else for (const l of human) console.log(l); process.exit(code); }
function nowIso() { return new Date().toISOString(); }
function readJson(p) { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; }
function writeJson(p, v) { mkdirSync(join(p, '..'), { recursive: true }); const tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', 'utf8'); renameSync(tmp, p); }

if (!cmd) fail(2, '사용법: loop.mjs check|init|record|verdict|status|session … [--cwd <dir>] [--json]');
const proj = locateProject(resolve(flags.cwd ?? process.cwd()));
const root = proj ? (proj.configRoot ?? proj.toplevel) : resolve(flags.cwd ?? process.cwd());
const LOOP = join(root, '.loop');
const F = { cfg: join(LOOP, 'loop.json'), ck: join(LOOP, 'checkpoint.json'), sc: join(LOOP, 'scorecard.json'), session: join(LOOP, 'session.local.json') };

const DEFAULT_BREAKER = { no_change_rounds: 2, same_error_rounds: 3 };

function checkConfig(cfg) {
  const errors = validate(cfg, loadSchema('loop'));
  const sum = (cfg.dimensions ?? []).reduce((a, d) => a + (Number(d.weight) || 0), 0);
  if (cfg.dimensions?.length && Math.abs(sum - 1) > 0.001) errors.push(`dimensions.weight 합이 ${sum.toFixed(3)} — 1.000 이어야 한다`);
  const caps = cfg.caps ?? {};
  if (!(caps.max_rounds > 0) && !(caps.max_cost_usd > 0) && !(caps.max_minutes > 0)) errors.push('caps 에 max_rounds · max_cost_usd · max_minutes 중 하나 이상이 필요하다 — 상한 없는 루프는 시작할 수 없다');
  if (cfg.safety && cfg.safety.auto_merge !== false) errors.push('safety.auto_merge 는 false 여야 한다');
  const ids = new Set(); for (const d of cfg.dimensions ?? []) { if (ids.has(d.id)) errors.push(`dimension id 중복: ${d.id}`); ids.add(d.id); }
  return errors;
}
function loadCfg() {
  const cfg = readJson(F.cfg);
  if (!cfg) fail(2, `.loop/loop.json 이 없다 — loop init 으로 만들 것 (${F.cfg})`);
  const errors = checkConfig(cfg);
  if (errors.length) fail(2, `.loop/loop.json 무효:\n  - ${errors.join('\n  - ')}`);
  cfg.breaker = { ...DEFAULT_BREAKER, ...(cfg.breaker ?? {}) };
  return cfg;
}
function loadCk() { return readJson(F.ck) ?? { version: 1, started_at: null, rounds: [], consecutive_at_target: 0, no_progress: 0, no_change_streak: 0, same_error_streak: 0, last_error: null, last_deficit: null, spent_cost_usd: 0, last_verdict: null, last_reason: null, next: null }; }

/** 상한·브레이커·STOP·ESCALATE 판정 — 순수 함수 */
export function judge(cfg, ck, r) {
  const stop = cfg.stop; const caps = cfg.caps ?? {}; const br = { ...DEFAULT_BREAKER, ...(cfg.breaker ?? {}) };
  const prev = ck.rounds.length ? ck.rounds[ck.rounds.length - 1] : null;
  const next = { ...ck };
  const reasons = [];
  // 1) 진전 카운터
  if (r.mode === 'full') {
    next.consecutive_at_target = r.active >= stop.target ? (ck.consecutive_at_target ?? 0) + 1 : 0;
  }
  const improved = prev ? r.active > prev.active : true;
  const sameDeficit = r.deficit != null && ck.last_deficit != null && r.deficit === ck.last_deficit;
  next.no_progress = (!improved && (sameDeficit || r.deficit == null)) ? (ck.no_progress ?? 0) + 1 : 0;
  next.last_deficit = r.deficit ?? null;
  next.no_change_streak = r.changed_files === 0 ? (ck.no_change_streak ?? 0) + 1 : 0;
  next.same_error_streak = (r.error && r.error === ck.last_error) ? (ck.same_error_streak ?? 0) + 1 : (r.error ? 1 : 0);
  next.last_error = r.error ?? null;
  next.spent_cost_usd = Number(((ck.spent_cost_usd ?? 0) + (r.cost_usd ?? 0)).toFixed(4));
  const roundIndex = ck.rounds.length + 1;
  const minutes = ck.started_at ? (Date.parse(r.at) - Date.parse(ck.started_at)) / 60000 : 0;

  // 2) 판정 — 우선순위: 상한(cap) > STOP > 브레이커/ESCALATE > CONTINUE
  let verdict = 'CONTINUE';
  if (caps.max_rounds && roundIndex >= caps.max_rounds) { verdict = 'STOP'; reasons.push(`cap: max_rounds ${caps.max_rounds} 도달`); }
  if (caps.max_cost_usd && next.spent_cost_usd >= caps.max_cost_usd) { verdict = 'STOP'; reasons.push(`cap: 비용 ${next.spent_cost_usd} ≥ ${caps.max_cost_usd} USD`); }
  if (caps.max_minutes && minutes >= caps.max_minutes) { verdict = 'STOP'; reasons.push(`cap: ${Math.round(minutes)}분 ≥ ${caps.max_minutes}분`); }
  const capHit = verdict === 'STOP';
  if (r.mode === 'full' && next.consecutive_at_target >= stop.consecutive) { verdict = 'STOP'; reasons.push(`target ${stop.target} 을 full audit 연속 ${next.consecutive_at_target}회 달성`); }
  if (verdict !== 'STOP') {
    if (next.no_change_streak >= br.no_change_rounds) { verdict = 'ESCALATE'; reasons.push(`breaker OPEN: 연속 ${next.no_change_streak}라운드 파일 변경 0`); }
    if (next.same_error_streak >= br.same_error_rounds) { verdict = 'ESCALATE'; reasons.push(`breaker OPEN: 같은 에러 ${next.same_error_streak}회 반복 (${String(r.error).slice(0, 60)})`); }
    if (next.no_progress >= stop.consecutive) { verdict = 'ESCALATE'; reasons.push(`no-progress ${next.no_progress}라운드${r.deficit ? ` (deficit ${r.deficit} 미해결)` : ''}`); }
  }
  if (verdict === 'CONTINUE') reasons.push(r.mode === 'full' ? `full ${r.active} (target ${stop.target}, 연속 ${next.consecutive_at_target}/${stop.consecutive})` : `per-round ${r.active}`);
  // 3) 다음 라운드 힌트 — full 이 필요한가
  const nextIndex = roundIndex + 1;
  const nextFull = (nextIndex % stop.full_audit_every === 0) || (r.mode === 'per-round' && r.active >= stop.target);
  next.next = verdict === 'CONTINUE' ? { round: nextIndex, mode: nextFull ? 'full' : 'per-round', why: nextFull ? (r.active >= stop.target && r.mode === 'per-round' ? 'per-round 가 target 을 넘겼다 — full 로 확정' : `full_audit_every ${stop.full_audit_every}`) : 'per-round' } : null;
  next.last_verdict = verdict; next.last_reason = reasons.join(' · '); next.cap_hit = capHit;
  return { verdict, reasons, next, roundIndex, minutes: Math.round(minutes) };
}

switch (cmd) {
  case 'check': {
    const cfg = readJson(F.cfg);
    if (!cfg) fail(2, `.loop/loop.json 이 없다 (${F.cfg})`);
    const errors = checkConfig(cfg);
    out({ ok: errors.length === 0, errors, dimensions: cfg.dimensions?.length ?? 0, caps: cfg.caps ?? {} }, errors.length ? 2 : 0, errors.length ? errors.map(e => `✗ ${e}`) : [`[loop] loop.json OK · dimensions ${cfg.dimensions?.length ?? 0} · caps ${JSON.stringify(cfg.caps)}`]);
  }
  case 'init': {
    if (existsSync(F.cfg) && !flags.force) fail(2, `.loop/loop.json 이 이미 있다 — 덮어쓰려면 --force`);
    if (!flags.name) fail(2, 'init: --name <slug> 가 필요하다');
    const caps = {};
    if (flags['max-rounds']) caps.max_rounds = Number(flags['max-rounds']);
    if (flags['max-cost-usd']) caps.max_cost_usd = Number(flags['max-cost-usd']);
    if (flags['max-minutes']) caps.max_minutes = Number(flags['max-minutes']);
    let dimensions = [{ id: 'core', label: '핵심 시나리오', weight: 1, evidence: [], probe: { kind: 'shell', cmd: 'echo TODO', expect: 'TODO — 실환경 신호로 바꿀 것' } }];
    if (flags.dimensions) { try { dimensions = JSON.parse(existsSync(resolve(flags.dimensions)) ? readFileSync(resolve(flags.dimensions), 'utf8') : flags.dimensions); } catch (e) { fail(2, `--dimensions 를 읽을 수 없다: ${e.message}`); } }
    const cfg = {
      version: 1, name: flags.name, goal: flags.goal ?? 'TODO — 끝나면 무엇이 참인가 한 줄',
      dimensions,
      env: { start: null, db: null, test: null, auth: null },
      stop: { target: Number(flags.target ?? 90), consecutive: Number(flags.consecutive ?? 2), full_audit_every: Number(flags['full-audit-every'] ?? 3) },
      caps, breaker: { ...DEFAULT_BREAKER },
      triage_order: 'auto',
      safety: { scope: 'local-only', forbid: ['git push', 'rm -rf', '--force'], auto_merge: false },
    };
    const errors = checkConfig(cfg);
    if (errors.length) fail(2, `init 거부:\n  - ${errors.join('\n  - ')}`);
    mkdirSync(LOOP, { recursive: true });
    writeJson(F.cfg, cfg);
    if (!existsSync(F.ck) || flags.force) writeJson(F.ck, { ...loadCk(), started_at: nowIso() });
    if (!existsSync(F.sc) || flags.force) writeJson(F.sc, { version: 1, round: 0, mode: null, active_total: null, domains: {}, blocked: [], at: null });
    out({ ok: true, files: [F.cfg, F.ck, F.sc].map(p => p.replace(/\\/g, '/')), caps }, 0, [`[loop] init · ${flags.name} · caps ${JSON.stringify(caps)} · target ${cfg.stop.target}×${cfg.stop.consecutive}`]);
  }
  case 'record': {
    const cfg = loadCfg();
    const ck = loadCk();
    if (!ck.started_at) ck.started_at = nowIso();
    const mode = flags.mode;
    if (!['full', 'per-round'].includes(mode)) fail(2, 'record: --mode full|per-round 가 필요하다');
    const active = Number(flags.active);
    if (!Number.isFinite(active) || active < 0 || active > 100) fail(2, 'record: --active <0~100> 이 필요하다');
    let domains = {};
    if (flags.domains) { try { domains = JSON.parse(existsSync(resolve(flags.domains)) ? readFileSync(resolve(flags.domains), 'utf8') : flags.domains); } catch (e) { fail(2, `--domains 를 읽을 수 없다: ${e.message}`); } }
    const r = { at: nowIso(), mode, active, domains, deficit: flags.deficit ?? null, changed_files: flags['changed-files'] != null ? Number(flags['changed-files']) : null, error: flags.error ?? null, cost_usd: flags['cost-usd'] != null ? Number(flags['cost-usd']) : 0, blocked: flags.blocked ? flags.blocked.split(',').map(s => s.trim()).filter(Boolean) : [], note: flags.note ?? null };
    const j = judge(cfg, ck, r);
    const round = { index: j.roundIndex, ...r, verdict: j.verdict, reason: j.reasons.join(' · ') };
    const nextCk = { ...j.next, rounds: [...ck.rounds, round], started_at: ck.started_at };
    writeJson(F.ck, nextCk);
    writeJson(F.sc, { version: 1, round: j.roundIndex, mode, active_total: active, domains, blocked: r.blocked, at: r.at });
    const human = [`[loop] R${j.roundIndex} ${mode} active=${active} → ${j.verdict} — ${j.reasons.join(' · ')}`];
    if (r.blocked.length) human.push(`  blocked: ${r.blocked.join(', ')} (분모 제외 · surface)`);
    if (nextCk.next) human.push(`  next: R${nextCk.next.round} ${nextCk.next.mode} (${nextCk.next.why})`);
    else human.push(`  루프 정지 — ${j.verdict === 'STOP' ? '브랜치 핸드오프(auto-merge 금지)' : '사람 호출'}`);
    out({ ok: true, round: j.roundIndex, verdict: j.verdict, reasons: j.reasons, cap_hit: j.next.cap_hit, next: nextCk.next, minutes: j.minutes, spent_cost_usd: nextCk.spent_cost_usd, consecutive_at_target: nextCk.consecutive_at_target, no_progress: nextCk.no_progress }, j.verdict === 'CONTINUE' ? 0 : 1, human);
  }
  case 'verdict': {
    loadCfg();
    const ck = loadCk();
    const last = ck.rounds[ck.rounds.length - 1] ?? null;
    out({ ok: true, verdict: ck.last_verdict, reason: ck.last_reason, round: last?.index ?? 0, next: ck.next }, ck.last_verdict && ck.last_verdict !== 'CONTINUE' ? 1 : 0, [`[loop] ${ck.last_verdict ?? '(기록 없음)'} — ${ck.last_reason ?? ''}`]);
  }
  case 'status': {
    const cfg = loadCfg();
    const ck = loadCk(); const sc = readJson(F.sc); const session = readJson(F.session);
    const human = [
      `[loop] ${cfg.name} · goal: ${cfg.goal}`,
      `  round ${sc?.round ?? 0} · active ${sc?.active_total ?? '-'} / target ${cfg.stop.target}×${cfg.stop.consecutive} · 연속 ${ck.consecutive_at_target} · no-progress ${ck.no_progress}`,
      `  caps ${JSON.stringify(cfg.caps)} · 소요 ${ck.started_at ? Math.round((Date.now() - Date.parse(ck.started_at)) / 60000) : 0}분 · 비용 ${ck.spent_cost_usd ?? 0} USD`,
      `  verdict ${ck.last_verdict ?? '(없음)'}${ck.last_reason ? ` — ${ck.last_reason}` : ''}`,
      `  next ${ck.next ? `R${ck.next.round} ${ck.next.mode}` : '(정지)'} · Stop 훅 루프 ${session?.active ? `활성(session ${session.session_id})` : '비활성'}`,
    ];
    out({ ok: true, name: cfg.name, scorecard: sc, checkpoint: ck, session: session ?? null }, 0, human);
  }
  case 'session': {
    if (sub === 'start') {
      loadCfg();
      if (!flags['session-id'] || !flags.prompt) fail(2, 'session start: --session-id <id> --prompt "<라운드 프롬프트>" 가 필요하다');
      const s = { version: 1, active: true, session_id: flags['session-id'], prompt: flags.prompt, started_at: nowIso(), max_rounds: flags['max-rounds'] ? Number(flags['max-rounds']) : null };
      writeJson(F.session, s);
      out({ ok: true, session: s }, 0, [`[loop] Stop 훅 루프 활성 — session ${s.session_id}. 세션이 끝나려 할 때마다 훅이 다음 라운드 프롬프트를 되먹인다. 멈추려면 loop.mjs session stop`]);
    }
    if (sub === 'stop') { if (existsSync(F.session)) unlinkSync(F.session); out({ ok: true }, 0, ['[loop] Stop 훅 루프 비활성']); }
    fail(2, 'session start|stop');
  }
  default: fail(2, `모르는 명령: ${cmd}`);
}
