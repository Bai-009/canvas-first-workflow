import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// 两个编译目标一起监听；任一退出时结束其余子进程，不留下后台编译器。
const compiler = resolve('node_modules/typescript/bin/tsc');
const children = ['tsconfig.json', 'tsconfig.classic.json'].map(project =>
  spawn(process.execPath, [compiler, '--project', project, '--watch'], { stdio: 'inherit' }));
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code ?? 1));
}
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));
