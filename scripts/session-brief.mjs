#!/usr/bin/env node
// session-brief.mjs — SessionStart 훅. 세션이 열릴 때 "지금 어디인가" 를 additionalContext 로 한 번 심는다.
// 내용: 현재 브랜치·이슈 키·stage·next · 게이트/리뷰 신선도 · 사람 확인 DoD · local 트래커 PROGRESS 꼬리 · 루프 현황 · 규율 요약 3줄.
// 상한: BRIEF_MAX 자(≈1,500 토큰) — 넘으면 뒤에서부터 자른다(방법론을 세션마다 다시 읽히지 않기 위한 장치이지 문서 대체가 아니다).
// 하네스가 없는 저장소·git 밖에서는 아무것도 내지 않는다(빈 출력 = 훅 무해). 오류도 조용히 삼킨다 — 세션 시작을 막을 이유는 없다.
//   사용(훅 밖): node session-brief.mjs --print [--cwd <dir>]
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { locateProject, loadConfig, parseBranch, branchSlug, statePath, readState } from './lib/config.mjs';
import { currentBranch } from './lib/git.mjs';
import { trackerName, trackerConfig } from './lib/tracker.mjs';
import { fingerprintTree } from './lib/tree.mjs';
import { treeAccepted } from './lib/gate-core.mjs';
import { gateOverall } from './lib/herdr.mjs';

export const BRIEF_MAX = 3500;
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

let event = {};
if (!flag('--print')) { try { const raw = readFileSync(0, 'utf8'); event = raw ? JSON.parse(raw) : {}; } catch { event = {}; } }
const cwd = resolve(opt('--cwd') ?? (event.cwd && isAbsolute(event.cwd) ? event.cwd : process.cwd()));

function tail(file, n) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim());
  return lines.slice(-n);
}
function readJson(p) { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } }

export function buildBrief(cwd) {
  const proj = locateProject(cwd);
  if (!proj || !proj.configPath) return null;
  const cfg = loadConfig(proj.configPath);
  const root = proj.configRoot;
  const branch = currentBranch(cwd);
  const L = [];
  L.push(`[caseworker] 브랜치 ${branch ?? '(detached)'} · 트래커 ${trackerName(cfg)} · mode ${cfg.mode}`);
  const parsed = branch ? parseBranch(branch, cfg) : null;
  if (!parsed) {
    L.push(branch === cfg.default_branch
      ? `기본 브랜치다 — 이슈를 잡으려면 /caseworker:issue <KEY> (${cfg.branch_template} 브랜치를 새로 만든다)`
      : `이슈 브랜치 패턴 밖 — 채택하려면 /caseworker:issue <KEY> --adopt`);
  } else {
    const sPath = statePath(cfg, root, parsed.slug ?? branchSlug(branch));
    const st = readState(sPath);
    if (!st) L.push(`키 ${parsed.keys.join(', ')} · 상태 JSON 없음 → /caseworker:issue ${parsed.keys[0]} 로 start`);
    else {
      // 신선도는 훅과 같은 축(인덱스 지문 + treeAccepted) — HEAD 트리와 비교하면 항상 "낡음" 으로 보였다
      let fresh = () => false;
      try { const tree = fingerprintTree({ cwd: proj.toplevel, base: 'index', excludes: cfg.fingerprint_exclude }); fresh = rec => treeAccepted(rec, tree, cfg, proj.toplevel).ok; } catch { /* 지문 실패 = 낡음 */ }
      const gate = st.gate ? `${st.gate.level ?? '?'} ${gateOverall(st.gate)}${fresh(st.gate.tree) ? '(신선)' : '(낡음 — 재실행 필요)'}` : '없음';
      const review = st.review ? `r${st.review.round ?? '?'} blocker ${st.review.blockers_open ?? '?'}${fresh(st.review.tree) ? '(신선)' : '(낡음)'}` : '없음';
      L.push(`키 ${st.keys.join(', ')} · stage ${st.stage} · 게이트 ${gate} · 리뷰 ${review}`);
      const humans = (st.dod ?? []).filter(d => d.human && d.last !== 'PASS').map(d => d.id);
      if (humans.length) L.push(`사람 확인 DoD 미완: ${humans.join(', ')}`);
      const dec = (st.decisions ?? []).slice(-3);
      if (dec.length) L.push(`최근 결정: ${dec.map(d => `${d.q ?? '?'} → ${d.a ?? '?'}`.slice(0, 80)).join(' / ')}`);
      L.push(`다음: node "<P>/scripts/issue-start.mjs" --status --json 의 next 를 따른다 — 상태 JSON 은 스크립트만 쓴다`);
      const t = trackerConfig(cfg);
      if (trackerName(cfg) === 'local') {
        for (const key of st.keys.slice(0, 2)) {
          const lines = tail(join(root, t.dir ?? '.caseworker', 'cases', key, 'PROGRESS.md'), 5);
          if (lines.length) L.push(`${key} PROGRESS 꼬리:\n  ${lines.join('\n  ')}`);
        }
      }
    }
  }
  const sc = readJson(join(root, '.loop', 'scorecard.json'));
  const ck = readJson(join(root, '.loop', 'checkpoint.json'));
  if (sc || ck) L.push(`루프: R${sc?.round ?? 0} active ${sc?.active_total ?? '-'} · verdict ${ck?.last_verdict ?? '(없음)'} · next ${ck?.next ? `R${ck.next.round} ${ck.next.mode}` : '(정지)'} — 판정은 loop.mjs record 가 한다`);
  if (Array.isArray(cfg.protected) && cfg.protected.length) L.push(`보호 파일(편집 차단): ${cfg.protected.slice(0, 4).join(', ')}${cfg.protected.length > 4 ? ' …' : ''}`);
  L.push('규율: 게이트 신선도 = git 트리 id · commit/push 는 훅이 판정 · 테스트를 고쳐 초록을 만들지 않는다 · 자동 머지 금지');
  let text = L.join('\n');
  if (text.length > BRIEF_MAX) text = text.slice(0, BRIEF_MAX - 12) + '\n…(잘림)';
  return text;
}

let brief = null;
try { brief = buildBrief(cwd); } catch (e) { if (flag('--print')) console.error(`[session-brief] ${e.message}`); brief = null; }
if (!brief) process.exit(0);
if (flag('--print')) { console.log(brief); process.exit(0); }
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: brief } }));
process.exit(0);
