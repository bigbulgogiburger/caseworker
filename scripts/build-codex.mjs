#!/usr/bin/env node
// build-codex.mjs — Claude Code 플러그인 트리를 Codex 플러그인 저장소로 변환한다.
//
//   node scripts/build-codex.mjs --src <claude-plugin-dir> --out <codex-repo-dir>
//
// 산출물은 "저장소 = 마켓플레이스 1개 + 플러그인 1개" 형태다:
//   <out>/.agents/plugins/marketplace.json      codex plugin marketplace add <owner>/<repo>
//   <out>/plugins/<name>/.codex-plugin/plugin.json
//
// 규율 — 치환 규칙은 **발화하지 않으면 빌드가 실패한다**. 규칙을 넣었는데 0건이면
// 그 산출물엔 그 검사가 0인 것이고, 조용히 통과시키면 무효 설정이 사고를 가린다.

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync,
  existsSync, rmSync, copyFileSync,
} from 'node:fs';
import { join, relative, dirname, basename, extname } from 'node:path';

// ── 인자 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const SRC = arg('--src');
const OUT = arg('--out');
const MARKETPLACE = arg('--marketplace');
const DRY = has('--dry-run');

if (!SRC || !OUT) {
  console.error('usage: build-codex.mjs --src <claude-plugin-dir> --out <codex-repo-dir> [--marketplace <name>] [--dry-run]');
  process.exit(2);
}
if (!existsSync(join(SRC, '.claude-plugin/plugin.json'))) {
  console.error(`[build-codex] --src 가 Claude 플러그인이 아니다 (.claude-plugin/plugin.json 없음): ${SRC}`);
  process.exit(2);
}

// ── 치환 규칙 ───────────────────────────────────────────────────────────
// find 는 리터럴 문자열. min 은 이 규칙이 최소 몇 번 발화해야 하는가 —
// 못 미치면 실패한다. why 는 보고에 그대로 찍힌다.
const RULES = [
  { find: '.claude/harness.json', to: '.codex/harness.json', min: 1,
    why: '하네스 설정 위치 — Codex 는 .codex/ 아래를 본다' },
  { find: '.claude/runtime', to: '.codex/runtime', min: 1,
    why: '런타임 상태 JSON 위치' },
  { find: '.claude/', to: '.codex/', min: 1,
    why: '환경 파일 및 fixture 경로도 Codex 디렉터리로 통일' },
  { find: "'.claude'", to: "'.codex'", min: 1,
    why: '디렉터리 생성 및 탐색 제외 목록' },
  { find: '/caseworker:', to: '$caseworker:', min: 1,
    why: 'Codex 스킬 명시 호출 표기' },
  { find: 'AskUserQuestion', to: 'request_user_input', min: 1,
    why: 'Codex 질문 도구 (모드 제한은 Codex 오버레이 참고)' },
  { find: '${CLAUDE_PLUGIN_ROOT}', to: '${PLUGIN_ROOT}', min: 1,
    why: '플러그인 루트 변수 — Codex 네이티브 형태' },
  { find: 'CLAUDE_PLUGIN_ROOT', to: 'PLUGIN_ROOT', min: 0,
    why: '위 규칙이 못 잡은 환경변수 직접 참조' },
];

const TEXT_EXT = new Set(['.mjs', '.js', '.json', '.md', '.sh', '.toml', '.yml', '.yaml', '.txt']);

// 복사 대상 — agents/ workflows/ hooks/ .claude-plugin/ 은 따로 처리한다.
const COPY_DIRS = ['skills', 'scripts', 'schemas', 'evals', 'trackers', 'docs'];
const COPY_FILES = ['README.md', 'LICENSE', 'package.json', 'herdr-plugin.toml', '.gitattributes'];

// ── 유틸 ────────────────────────────────────────────────────────────────
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const walk = (dir, acc = []) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === '.git' || e === 'node_modules') continue;
    if (statSync(p).isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
};
const ensureDir = (p) => mkdirSync(dirname(p), { recursive: true });

const hits = new Map(RULES.map((r) => [r.find, 0]));

function substitute(text) {
  let out = text;
  for (const r of RULES) {
    if (!out.includes(r.find)) continue;
    const n = out.split(r.find).length - 1;
    hits.set(r.find, hits.get(r.find) + n);
    out = out.split(r.find).join(r.to);
  }
  return out;
}

/** frontmatter(--- ... ---) 를 { meta, body } 로 가른다. */
function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

/** TOML 리터럴 멀티라인 문자열 — 이스케이프 처리를 하지 않아 마크다운에 안전하다. */
const TRIPLE_SQ = "'".repeat(3);
function tomlLiteral(s) {
  if (s.includes(TRIPLE_SQ)) throw new Error('본문에 삼중 작은따옴표가 있어 TOML 리터럴로 담을 수 없다');
  return `${TRIPLE_SQ}\n${s.replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n${TRIPLE_SQ}`;
}
const tomlStr = (s) => JSON.stringify(String(s));

// ── 소스 읽기 ───────────────────────────────────────────────────────────
const srcPlugin = readJson(join(SRC, '.claude-plugin/plugin.json'));
const NAME = srcPlugin.name;
const VERSION = srcPlugin.version;
const MKT = MARKETPLACE || `${NAME}-codex`;
const REPO = basename(OUT);

console.log(`[build-codex] ${NAME} v${VERSION}`);
console.log(`[build-codex]   src = ${SRC}`);
console.log(`[build-codex]   out = ${OUT}   (marketplace ${MKT})`);

// ── 출력 비우기 (.git 은 보존) ──────────────────────────────────────────
if (!DRY && existsSync(OUT)) {
  for (const e of readdirSync(OUT)) {
    if (e === '.git') continue;
    rmSync(join(OUT, e), { recursive: true, force: true });
  }
}

const written = [];
function emit(relPath, content) {
  const p = join(OUT, relPath);
  written.push(relPath.replace(/\\/g, '/'));
  if (DRY) return;
  ensureDir(p);
  writeFileSync(p, content);
}
function emitCopy(relPath, srcPath) {
  const p = join(OUT, relPath);
  written.push(relPath.replace(/\\/g, '/'));
  if (DRY) return;
  ensureDir(p);
  copyFileSync(srcPath, p);
}

// ── 1. payload 복사 + 치환 ──────────────────────────────────────────────
let textFiles = 0, binFiles = 0;
for (const d of COPY_DIRS) {
  const from = join(SRC, d);
  if (!existsSync(from)) continue;
  for (const f of walk(from)) {
    const rel = join('plugins', NAME, relative(SRC, f));
    if (TEXT_EXT.has(extname(f))) {
      emit(rel, substitute(readFileSync(f, 'utf8')));
      textFiles++;
    } else { emitCopy(rel, f); binFiles++; }
  }
}
for (const f of COPY_FILES) {
  const from = join(SRC, f);
  if (!existsSync(from)) continue;
  const rel = join('plugins', NAME, f);
  if (TEXT_EXT.has(extname(f))) { emit(rel, substitute(readFileSync(from, 'utf8'))); textFiles++; }
  else { emitCopy(rel, from); binFiles++; }
}

// ── 2. agents/*.md → subagents/*.toml ───────────────────────────────────
// Codex 의 서브에이전트는 이름으로 등록해 부르는 게 아니라 spawn_agent 로 띄우고
// 역할을 프롬프트로 준다(실측: 프롬프트 목록에 뜨지 않는다). 그래서 이 파일들은
// 레인 실행기가 읽어 spawn_agent / codex exec 에 넘기는 **역할 원고**다.
const agentsDir = join(SRC, 'agents');
const agents = [];
if (existsSync(agentsDir)) {
  for (const f of readdirSync(agentsDir).filter((x) => x.endsWith('.md')).sort()) {
    const { meta, body } = splitFrontmatter(readFileSync(join(agentsDir, f), 'utf8'));
    if (!meta.name) { console.warn(`[build-codex]   ! agents/${f} 에 name 이 없어 건너뛴다`); continue; }
    const toml = [
      `# 원본: agents/${f} (Claude Code 서브에이전트 정의)`,
      '# Codex 는 동질 에이전트를 spawn_agent 로 띄우고 역할을 프롬프트로 준다 —',
      '# tools 제한과 model 지정은 Codex 쪽 대응물이 없어 메타데이터로만 남긴다.',
      `name = ${tomlStr(meta.name)}`,
      `description = ${tomlStr(meta.description || '')}`,
      meta.model ? `# claude_model = ${tomlStr(meta.model)}` : null,
      meta.tools ? `# claude_tools = ${tomlStr(meta.tools)}` : null,
      `developer_instructions = ${tomlLiteral(substitute(body))}`,
      '',
    ].filter(Boolean).join('\n');
    emit(join('plugins', NAME, 'subagents', `${meta.name}.toml`), toml);
    agents.push({ name: meta.name, description: meta.description || '' });
  }
}

// ── 3. hooks — 매니페스트에 인라인 ──────────────────────────────────────
let hooks = null;
const hooksFile = join(SRC, 'hooks/hooks.json');
if (existsSync(hooksFile)) {
  hooks = JSON.parse(substitute(readFileSync(hooksFile, 'utf8')));
  // 참고용 원본도 남긴다 (사람이 읽는 자리)
  emit(join('plugins', NAME, 'hooks', 'hooks.json'), `${JSON.stringify(hooks, null, 2)}\n`);
}

// ── 4. .codex-plugin/plugin.json ────────────────────────────────────────
const manifest = {
  name: NAME,
  version: VERSION,
  description: srcPlugin.description.replaceAll('Claude Code', 'Codex'),
  author: srcPlugin.author,
  homepage: `https://github.com/bigbulgogiburger/${REPO}`,
  repository: `https://github.com/bigbulgogiburger/${REPO}`,
  license: srcPlugin.license,
  keywords: [...(srcPlugin.keywords || []).filter((k) => k !== 'claude-code'), 'codex'],
  skills: './skills/',
  subagents: './subagents/',
  ...(hooks ? { hooks } : {}),
  interface: {
    displayName: NAME,
    shortDescription: (srcPlugin.description || '').replaceAll('Claude Code', 'Codex').split(':')[0].slice(0, 80),
    longDescription: srcPlugin.description.replaceAll('Claude Code', 'Codex'),
    developerName: srcPlugin.author?.name || 'bigbulgogiburger',
    category: 'Developer Tools',
    capabilities: ['Interactive', 'Read', 'Write'],
  },
};
emit(join('plugins', NAME, '.codex-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// ── 5. 마켓플레이스 ─────────────────────────────────────────────────────
const marketplace = {
  name: MKT,
  interface: { displayName: `${NAME} (Codex)` },
  plugins: [{
    name: NAME,
    source: { source: 'local', path: `./plugins/${NAME}` },
    policy: { installation: 'AVAILABLE' },
    category: 'Developer Tools',
  }],
};
emit(join('.agents', 'plugins', 'marketplace.json'), `${JSON.stringify(marketplace, null, 2)}\n`);

// ── 6. 오버레이 — 손으로 쓴 Codex 전용 대체분 ───────────────────────────
// <src>/codex-overlay/** 는 출력 플러그인 디렉토리 위에 그대로 덮인다.
const overlayDir = join(SRC, 'codex-overlay');
const overlaid = [];
if (existsSync(overlayDir)) {
  for (const f of walk(overlayDir)) {
    const rel = relative(overlayDir, f);
    emitCopy(join('plugins', NAME, rel), f);
    overlaid.push(rel.replace(/\\/g, '/'));
  }
}

// ── 7. 생성 표식 ────────────────────────────────────────────────────────
emit('GENERATED.md', [
  '# 이 저장소는 생성물이다 — 직접 고치지 말 것',
  '',
  `\`${NAME}\` v${VERSION} 의 Codex 판. 원본은 Claude Code 플러그인이고,`,
  '이 트리는 그 원본에서 `scripts/build-codex.mjs` 가 통째로 다시 만든다.',
  '',
  '여기서 고친 것은 **다음 생성 때 사라진다.** 고칠 곳은 두 군데뿐이다:',
  '',
  '- 원본 소스 — 로직·문서·스크립트',
  '- 원본의 `codex-overlay/` — Codex 에서만 달라야 하는 파일',
  '',
  '## 다시 만들기',
  '',
  '```',
  'node scripts/build-codex.mjs --src <원본> --out <이 저장소>',
  '```',
  '',
  '## 설치',
  '',
  '```',
  `codex plugin marketplace add bigbulgogiburger/${REPO}`,
  `codex plugin add ${NAME}@${MKT}`,
  '```',
  '',
  '설치 후 Codex CLI의 `/hooks`에서 플러그인 훅 정의를 검토하고 신뢰해야 한다. 설치만으로 훅이 발화하지 않는다.',
  `검증 방법과 포팅 범위: [Codex 안내](plugins/${NAME}/docs/codex-validation.md).`,
  '',
  `생성 시각: ${new Date().toISOString()}`,
  '',
].join('\n'));

// ── 보고 + 규칙 발화 판정 ───────────────────────────────────────────────
console.log(`[build-codex]   텍스트 ${textFiles} · 바이너리 ${binFiles} · subagent ${agents.length} · 오버레이 ${overlaid.length}`);
console.log(`[build-codex]   파일 ${written.length}개`);
if (overlaid.length) console.log(`[build-codex]   오버레이: ${overlaid.join(', ')}`);

let failed = 0;
console.log('[build-codex] 치환 규칙 발화:');
for (const r of RULES) {
  const n = hits.get(r.find);
  const ok = n >= r.min;
  if (!ok) failed++;
  console.log(`  ${ok ? 'OK ' : 'X  '} ${String(n).padStart(3)}회  ${r.find}  ->  ${r.to}${r.min ? `  (최소 ${r.min})` : '  (선택)'}`);
}
if (!hooks) { console.log('  X   hooks/hooks.json 이 없다 — 게이트 훅이 없는 플러그인이 된다'); failed++; }
if (!agents.length) { console.log('  X   agents/ 가 비었다 — 레인 역할 원고가 없다'); failed++; }

if (failed) {
  console.error(`[build-codex] 실패: ${failed}개 규칙이 발화하지 않았다. 규칙이 안 먹으면 그 산출물엔 그 검사가 0이다.`);
  process.exit(1);
}
console.log(`[build-codex] OK${DRY ? ' (dry-run — 아무것도 쓰지 않았다)' : ''}`);
