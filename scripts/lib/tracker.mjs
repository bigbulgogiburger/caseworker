// tracker.mjs — 트래커 어댑터 로더. 코어는 트래커 이름을 모른다: harness.json.tracker 가 가리키는
// trackers/<name>/adapter.mjs 를 읽어 같은 계약(trackers/_contract.md)으로 부른다.
//   - direct 어댑터(local 등)는 스크립트가 op 를 그 자리에서 실행한다(apply).
//   - MCP 가 필요한 어댑터(jira 등)는 op 를 "라우터가 수행" 으로 표시해 넘긴다 — 스크립트는 네트워크를 만지지 않는다.
// 어댑터 실패는 throw 가 아니라 {ok:false, reason} — 트래커가 죽어도 코드 진행은 막지 않는다(기록만 남긴다).
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TRACKERS_DIR = join(PLUGIN_ROOT, 'trackers');

export const STATUSES = ['open', 'in_progress', 'review', 'done', 'abandoned'];
export const LINK_TYPES = ['blocks', 'parent-child', 'relates-to', 'duplicates', 'supersedes', 'discovered-from'];

export function trackerName(cfg) { return cfg.tracker ?? 'local'; }
export function trackerConfig(cfg) { return cfg.trackers?.[trackerName(cfg)] ?? {}; }

/** 키 본문(접두사 뒤) 정규식 문자열 — 어댑터 설정 key_body 가 우선 */
export function keyBody(cfg) {
  return trackerConfig(cfg).key_body ?? '\\d+';
}

/** `^<PREFIX>-<body>$` */
export function keyPattern(cfg) {
  return new RegExp(`^${cfg.issue_prefix}-(?:${keyBody(cfg)})$`);
}

/** 캡처된 브랜치 토큰 "ABC-696-940" · "HX-a3f8-b2c1-login" → 키 배열. 본문 정규식에 맞는 조각만 키, 아니면 접두사 교체 또는 suffix */
export function expandKeysWith(captured, prefix, bodyRe) {
  const body = new RegExp(`^(?:${bodyRe})$`);
  const keys = [];
  let current = prefix;
  for (const tok of captured.split('-')) {
    if (body.test(tok)) keys.push(`${current}-${tok}`);
    else if (/^[A-Z][A-Z0-9]+$/.test(tok)) current = tok;
    // 그 외 조각(소문자 suffix 단어)은 무시
  }
  return keys;
}

/** 사용자 입력 키 정규화 — 접두사는 대문자, 본문은 어댑터 규칙(local 은 소문자 hex) */
export function normalizeKey(raw, cfg) {
  const s = String(raw).trim();
  const i = s.indexOf('-');
  if (i < 0) return s.toUpperCase();
  const prefix = s.slice(0, i).toUpperCase();
  let body = s.slice(i + 1);
  if (/[a-f]/i.test(keyBody(cfg))) body = body.toLowerCase();
  return `${prefix}-${body}`;
}

/** "ABC-696","ABC-940" → "ABC-696-940" (branch_template 의 {keys}) */
export function keysToken(keys, cfg) {
  const p = `${cfg.issue_prefix}-`;
  return [keys[0], ...keys.slice(1).map(k => (k.startsWith(p) ? k.slice(p.length) : k))].join('-');
}

let cache = new Map();
export async function loadTracker(cfg) {
  const name = trackerName(cfg);
  if (cache.has(name)) return cache.get(name);
  const file = join(TRACKERS_DIR, name, 'adapter.mjs');
  if (!existsSync(file)) {
    const e = new Error(`트래커 어댑터가 없다: ${name} (${file}) — harness.json.tracker 를 확인할 것`);
    e.code = 'NO_TRACKER';
    throw e;
  }
  const mod = await import(pathToFileURL(file).href);
  const adapter = { name, ...mod };
  cache.set(name, adapter);
  return adapter;
}

/**
 * 단계(start|complete)에 해당하는 op 목록을 만들고, direct 어댑터면 그 자리에서 실행한다.
 * @returns {{name, direct, ops:[{op,key,...,via:'script'|'router', result?}], applied:boolean}}
 */
export async function runPhaseOps(adapter, phase, keys, ctx, extra = {}) {
  const ops = adapter.planOps ? adapter.planOps(phase, keys, ctx, extra) : [];
  const direct = !!adapter.capabilities?.direct;
  const out = [];
  for (const op of ops) {
    if (direct && typeof adapter.apply === 'function') {
      let result;
      try { result = adapter.apply(op, ctx); } catch (e) { result = { ok: false, reason: e.message }; }
      out.push({ ...op, via: 'script', result });
    } else {
      out.push({ ...op, via: 'router' });
    }
  }
  return { name: adapter.name, direct, ops: out, applied: direct };
}
