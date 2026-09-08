#!/usr/bin/env node
// md-lint.mjs — PostToolUse(Write|Edit|MultiEdit) 훅. 방금 쓴 .md 파일의 얕은 정합을 **경고만** 한다(차단 없음 — PostToolUse 는 막을 수 없고, 막을 일도 아니다).
// 검사 3종:
//   F  frontmatter — `---` 로 열었으면 닫혀야 하고, 안의 줄은 `key: value` 꼴
//   W  [[name]] 링크 — 같은 디렉터리(또는 --dir)에 <name>.md 가 있어야 한다 (자동 메모리·wiki 교차참조)
//   R  [text](rel.md) 상대 링크 — 파일이 실재해야 한다(http·앵커·절대 경로는 제외)
//   G  LOG.md — 엔트리 줄은 `[YYYY-MM-DD HH:MM KST …]` 로 시작(wiki-lint L12 와 같은 규칙)
// 사용(훅 밖): node md-lint.mjs --file <path> [--strict]   — --strict 면 경고 1건 이상에 exit 1
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute, basename } from 'node:path';

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

export function lintMarkdown(file, text) {
  const warns = [];
  const dir = dirname(file);
  const lines = text.split(/\r?\n/);
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end < 0) warns.push('F: frontmatter 가 닫히지 않았다(두 번째 --- 없음)');
    else for (let i = 1; i < end; i++) {
      const l = lines[i];
      if (l.trim() === '' || /^\s/.test(l) || /^-\s/.test(l.trim())) continue; // 들여쓴 하위 키·목록은 통과
      if (!/^[A-Za-z0-9_-]+:\s*.*$/.test(l)) warns.push(`F: frontmatter ${i + 1}행이 key: value 꼴이 아니다 — ${l.slice(0, 40)}`);
    }
  }
  for (const m of text.matchAll(/\[\[([^\]\n|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const name = m[1].trim();
    if (!existsSync(join(dir, `${name}.md`))) warns.push(`W: [[${name}]] → ${name}.md 가 같은 디렉터리에 없다`);
  }
  for (const m of text.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
    const rel = m[1];
    if (/^[a-z]+:\/\//i.test(rel) || isAbsolute(rel)) continue;
    if (!existsSync(resolve(dir, rel))) warns.push(`R: 링크 대상 없음 — ${rel}`);
  }
  if (basename(file) === 'LOG.md') {
    lines.forEach((raw, i) => {
      const t = raw.trim();
      if (t === '' || t.startsWith('#') || t.startsWith('>')) return;
      if (!/^\[(\d{4}-\d{2}-\d{2})(?:\s+[\d:]+)?\s+KST\s+.*?\]/.test(t)) warns.push(`G: LOG.md ${i + 1}행 형식 일탈(기대 [YYYY-MM-DD HH:MM KST MODE KEY phase] …) — ${t.slice(0, 40)}`);
    });
  }
  return warns;
}

let file = opt('--file');
let event = null;
if (!file) {
  try { const raw = readFileSync(0, 'utf8'); event = raw ? JSON.parse(raw) : {}; } catch { event = {}; }
  file = event?.tool_input?.file_path ?? null;
}
if (!file || !/\.md$/i.test(file)) process.exit(0);
const abs = isAbsolute(file) ? file : resolve(event?.cwd && isAbsolute(event.cwd) ? event.cwd : process.cwd(), file);
if (!existsSync(abs)) process.exit(0);
let warns = [];
try { warns = lintMarkdown(abs, readFileSync(abs, 'utf8')); } catch { process.exit(0); }
if (!warns.length) process.exit(0);
const msg = `[caseworker] md-lint ${basename(abs)}: 경고 ${warns.length}건 — ${warns.slice(0, 5).join(' · ')}${warns.length > 5 ? ' …' : ''}`;
if (opt('--file')) { for (const w of warns) console.log(w); process.exit(flag('--strict') ? 1 : 0); }
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } }));
process.exit(0);
