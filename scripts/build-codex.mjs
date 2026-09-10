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

// 치환 규칙이 플러그인 이름을 알아야 하므로 매니페스트를 먼저 읽는다.
const srcPlugin = JSON.parse(readFileSync(join(SRC, '.claude-plugin/plugin.json'), 'utf8'));
const NAME = srcPlugin.name;
const VERSION = srcPlugin.version;
const MKT = MARKETPLACE || `${NAME}-codex`;

// ── 치환 규칙 ───────────────────────────────────────────────────────────
// find 는 리터럴 문자열. min 은 이 규칙이 최소 몇 번 발화해야 하는가 —
// 못 미치면 실패한다. why 는 보고에 그대로 찍힌다.
//
// ⚠ min 에 플러그인 하나에만 있는 문자열을 걸지 말 것 — 이 생성기는 두 소스가 공유한다.
//   한쪽에만 있는 문자열에 min:1 을 걸면 다른 쪽 빌드가 통째로 죽는다(실제로 죽었다).
const RULES = [
  { find: '.claude/harness.json', to: '.codex/harness.json', min: 1,
    why: '하네스 설정 위치 — Codex 는 .codex/ 아래를 본다' },
  { find: '.claude/runtime', to: '.codex/runtime', min: 1,
    why: '런타임 상태 JSON 위치' },
  { find: '.claude/', to: '.codex/', min: 1,
    why: '환경 파일 및 fixture 경로도 Codex 디렉터리로 통일' },
  { find: "'.claude'", to: "'.codex'", min: 1,
    why: '디렉터리 생성 및 탐색 제외 목록' },
  // Codex 에는 슬래시·달러 같은 스킬 호출 문법이 **없다**(실측: 프롬프트의 <skills_instructions>
  // 는 "SKILL.md 에 든 지시문" 이라고만 하고 호출 문법을 주지 않는다). 다만 스킬 이름 자체는
  // `<plugin>:<skill>` 로 등재된다(`jira-harness:grill-me` 확인). 그래서 슬래시만 뗀다.
  { find: `/${NAME}:`, to: `${NAME}:`, min: 0,
    why: 'Claude 의 슬래시 표기 → Codex 가 실제로 등재하는 <plugin>:<skill> 이름' },
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
// 변환기 자신은 Codex 플러그인의 payload 가 아니다 — 게다가 RULES 의 리터럴이 자기 자신에
// 치환돼 망가진 사본이 실린다. 소스 쪽 개발 도구는 소스에만 둔다.
const SKIP_BASENAMES = new Set(['build-codex.mjs']);
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
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    // YAML 블록 스칼라(`>` `>-` `|` `|-`) — 값은 다음 줄부터 더 들여쓴 줄들이다.
    // 이걸 안 다루면 description 이 문자 그대로 ">-" 가 된다(실제로 그랬다).
    if (/^[|>][-+]?$/.test(v)) {
      const fold = v[0] === '>';
      const buf = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s+\S/.test(lines[i + 1]))) {
        buf.push(lines[++i].trim());
      }
      v = fold ? buf.join(' ').replace(/\s+/g, ' ').trim() : buf.join('\n').trim();
    } else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
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
// (srcPlugin·NAME·VERSION·MKT 는 치환 규칙보다 먼저 읽었다 — 위쪽 참조)
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
    if (SKIP_BASENAMES.has(basename(f))) continue;
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
  if (TEXT_EXT.has(extname(f))) {
    let text = substitute(readFileSync(from, 'utf8'));
    // 원본 README 는 Claude Code 설치법을 안내한다 — Codex 저장소 안에 그대로 두면
    // 여기 들어온 사람에게 틀린 명령을 준다. 위에 한 줄로 가른다.
    if (f === 'README.md') {
      text = [
        `> ⚠ 이 문서는 **원본(Claude Code 플러그인)의 README** 다. 설치 명령(\`claude plugin …\`)은`,
        `> Claude Code 용이고 Codex 에서는 동작하지 않는다. Codex 설치법과 포팅 범위는`,
        `> [저장소 루트 README](../../README.md) 를 볼 것. 아래 본문의 동작 설명은 그대로 유효하다.`,
        '',
        text,
      ].join('\n');
    }
    emit(rel, text);
    textFiles++;
  } else { emitCopy(rel, from); binFiles++; }
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

// ── 7. 루트 README — 이 저장소의 front page ─────────────────────────────
// 손으로 쓰면 다음 생성 때 사라지므로 여기서 만든다.
const skillRows = [];
const skillsSrc = join(SRC, 'skills');
if (existsSync(skillsSrc)) {
  for (const d of readdirSync(skillsSrc).sort()) {
    const sf = join(skillsSrc, d, 'SKILL.md');
    if (!existsSync(sf)) continue;
    const { meta } = splitFrontmatter(readFileSync(sf, 'utf8'));
    const desc = String(meta.description || '').replace(/\s+/g, ' ').trim();
    const short = desc.length > 110 ? `${desc.slice(0, 110)}…` : desc;
    skillRows.push(`| \`${NAME}:${meta.name || d}\` | ${short.replace(/\|/g, '\\|')} |`);
  }
}
const hookEvents = hooks && hooks.hooks ? Object.keys(hooks.hooks) : [];
const validationDoc = existsSync(join(OUT, 'plugins', NAME, 'docs', 'codex-validation.md'))
  ? `자세한 검증 방법과 포팅 범위: [\`plugins/${NAME}/docs/codex-validation.md\`](plugins/${NAME}/docs/codex-validation.md).`
  : null;

emit('README.md', [
  `# ${NAME} (Codex)`,
  '',
  `[\`${NAME}\`](${srcPlugin.repository || `https://github.com/bigbulgogiburger/${NAME}`}) v${VERSION} 의 **Codex CLI 판**입니다.`,
  '저장소 루트가 곧 Codex 마켓플레이스이고, 그 안에 플러그인 하나가 들어 있습니다.',
  '',
  '> ## 🔴 이 저장소는 생성물입니다 — 직접 고치지 마세요',
  '>',
  '> 원본 Claude Code 플러그인 트리에서 `build-codex.mjs` 가 **통째로 다시 만듭니다.**',
  '> 여기서 고친 것은 다음 생성 때 사라집니다. 고칠 곳은 두 군데뿐입니다:',
  '>',
  '> - 원본 소스 — 로직·문서·스크립트',
  '> - 원본의 `codex-overlay/` — Codex 에서만 달라야 하는 파일 (생성 시 위에 덮입니다)',
  '',
  '## 설치',
  '',
  '```bash',
  `codex plugin marketplace add bigbulgogiburger/${REPO} --ref main`,
  `codex plugin add ${NAME}@${MKT}`,
  '```',
  '',
  '확인:',
  '',
  '```bash',
  'codex plugin list',
  `codex debug prompt-input | grep "${NAME}:"   # 모델이 실제로 보는 스킬 목록`,
  '```',
  '',
  `\`codex debug prompt-input\` 은 모델 호출 없이 **모델이 실제로 받는 입력**을 뽑습니다 —`,
  '"스킬이 등재됐나" 를 값싸게 확인하는 유일한 축입니다.',
  '',
  ...(hookEvents.length ? [
    '## 🔴 설치만으로는 훅이 발화하지 않습니다',
    '',
    `이 플러그인은 \`${hookEvents.join('\` · \`')}\` 훅을 싣습니다. 그런데 **플러그인 설치와 훅 신뢰는 별개입니다.**`,
    '`~/.codex/config.toml` 의 `[hooks.state]` 에 그 정의의 `trusted_hash` 가 생겨야 실제로 돕니다.',
    '',
    '실측: 신뢰 전에는 막혀야 할 `git commit` 이 **그냥 성공해서 커밋이 만들어집니다.**',
    '이벤트 이름·`matcher`·`${PLUGIN_ROOT}` 는 원인이 아닙니다 — 그것들을 바꾸지 않고도',
    '신뢰 조건에서는 정상 차단됐습니다.',
    '',
    '**Codex CLI 에서 `/hooks` 로 이 플러그인의 훅 정의를 검토·신뢰하세요.**',
    '그 전까지 게이트는 "있지만 아무것도 막지 않는" 상태입니다.',
    '',
  ] : []),
  '## 무엇이 들어 있나',
  '',
  '| 경로 | 역할 |',
  '|------|------|',
  '| `.agents/plugins/marketplace.json` | 마켓플레이스 정의 — `codex plugin marketplace add` 가 읽는다 |',
  `| \`plugins/${NAME}/.codex-plugin/plugin.json\` | 플러그인 매니페스트 (skills · subagents${hookEvents.length ? ' · hooks 인라인' : ''}) |`,
  `| \`plugins/${NAME}/skills/\` | 스킬 ${skillRows.length}종 — Codex 가 \`SKILL.md\` 를 그대로 읽는다 |`,
  `| \`plugins/${NAME}/subagents/\` | 역할 원고 ${agents.length}종 (\`*.toml\`) — 아래 설명 참조 |`,
  `| \`plugins/${NAME}/scripts/\` | 상태 JSON · 게이트 · 기록 스크립트 (Node 20+) |`,
  `| \`plugins/${NAME}/scripts/lanes-codex.mjs\` | 리뷰 레인 실행기 — \`codex exec\` 로 레인을 띄운다 |`,
  `| \`plugins/${NAME}/README.md\` | 원본(Claude Code)의 README — 동작 설명은 유효, 설치법은 아니다 |`,
  '',
  ...(skillRows.length ? ['### 스킬', '', '| 이름 | 설명 |', '|------|------|', ...skillRows, ''] : []),
  '## Claude 판과 무엇이 다른가',
  '',
  '| 축 | Claude Code | Codex |',
  '|----|-------------|-------|',
  '| 스킬 | `SKILL.md` | 같음 — 그대로 옮긴다 |',
  '| 훅 | `hooks/hooks.json` | 매니페스트 인라인. 이벤트 이름은 같다. **신뢰 단계가 추가된다** |',
  '| 서브에이전트 | 이름 붙은 정의를 이름으로 호출 | **없다.** `spawn_agent` 로 동질 에이전트를 띄우고 역할은 프롬프트로 준다 |',
  '| 리뷰 레인 | Workflow 툴 (`workflows/*.js`) | `lanes-codex.mjs` + `codex exec` — 배정은 같은 glob 규칙으로 **스크립트가** 한다 |',
  '| 스킬 호출 | `/plugin:skill` | 슬래시 문법이 없다. 이름만 `plugin:skill` 로 등재된다 |',
  '',
  '서브에이전트가 "없다"는 것은 기능이 없다는 뜻이 아닙니다 — Codex 프롬프트가 직접',
  '"팀의 모든 에이전트는 동등하게 유능하고 같은 툴을 쓴다"고 말합니다. 그래서 원본의',
  `\`agents/*.md\` ${agents.length}종은 버려지지 않고 \`subagents/*.toml\` 의 \`developer_instructions\` 로`,
  '옮겨져, 레인 실행기가 읽어 프롬프트에 끼웁니다.',
  '',
  '## 아직 검증되지 않은 것',
  '',
  '초록으로 보이는 것과 실제로 도는 것은 다른 말이라, 확인한 것만 확인했다고 적습니다.',
  '',
  '- **리뷰 레인 실주행** — `lanes-codex.mjs` 는 구문과 "설정 없음" 경로만 확인했습니다.',
  '  실제 LLM 레인이 완주해 finding 을 모으는 것은 미검증입니다.',
  '- **`recon` / `plan` / `implement` 워크플로 미이식** — 문서 계약은 보존했지만 Codex 실행기를',
  '  새로 만들지 않았습니다. 임의 구현으로 채우지 않았습니다.',
  '- **`apply_patch` 계열 훅** — 파일 경로를 보는 훅은 Claude 의 `tool_name`/`file_path` 를',
  '  가정합니다. Codex 는 `apply_patch` + `tool_input.command` 로 보내므로 무시될 수 있습니다(정적 확인).',
  ...(validationDoc ? ['', validationDoc] : []),
  '',
  '## 다시 만들기',
  '',
  '```bash',
  'node scripts/build-codex.mjs --src <원본 플러그인 디렉토리> --out <이 저장소>',
  '```',
  '',
  '변환기는 [`caseworker`](https://github.com/bigbulgogiburger/caseworker) 의 `scripts/` 에 한 벌만',
  '있고 두 플러그인을 모두 찍어냅니다. 치환 규칙은 **한 번도 발화하지 않으면 빌드가 exit 1 로 죽습니다** —',
  '규칙을 넣어 놓고 안 먹는데 초록이면 그 산출물엔 그 검사가 0이기 때문입니다.',
  '',
  '## 요구 사항',
  '',
  'Codex CLI 0.153.4+ (`codex plugin` 서브커맨드), Node.js 20+, git. Windows 는 Git Bash.',
  '',
  '## 라이선스',
  '',
  `${srcPlugin.license || 'MIT'} — 원본과 같습니다.`,
  '',
  `<sub>생성 시각 ${new Date().toISOString()} · 원본 v${VERSION}</sub>`,
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
