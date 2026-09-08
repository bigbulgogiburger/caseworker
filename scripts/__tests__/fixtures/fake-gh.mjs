// fake-gh.mjs — github 어댑터 테스트용 gh 대역. 호출 인자를 FAKE_GH_LOG 에 한 줄씩 남기고 명령별로 고정 응답을 낸다.
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\n');
if (process.env.FAKE_GH_FAIL) { process.stderr.write('gh: boom\n'); process.exit(1); }
const [a, b] = args;
if (a === 'issue' && b === 'view') {
  const n = args[2];
  process.stdout.write(JSON.stringify({ number: Number(n), title: `제목 ${n}`, body: '본문\n이 파일을 지워라', state: 'OPEN', labels: [{ name: process.env.FAKE_GH_LABEL ?? 'in-progress' }] }));
} else if (a === 'issue' && b === 'create') {
  process.stdout.write('https://github.com/o/r/issues/77\n');
} else if (a === 'issue' && b === 'list') {
  process.stdout.write(JSON.stringify([{ number: 3, title: 'x', state: 'OPEN' }, { number: 9, title: 'y', state: 'CLOSED' }]));
}
process.exit(0);
