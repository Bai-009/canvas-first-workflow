import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { watchAssets } from './build-assets.mjs';

// 编译目标与前后端边界一起监听；任一退出时结束其余子进程，不留下后台编译器。
const compiler = resolve('node_modules/typescript/bin/tsc');
const children = ['tsconfig.json', 'tsconfig.classic.json', 'tsconfig.browser.json', 'tsconfig.server.json'].map(project =>
  spawn(process.execPath, [compiler, '--project', project, '--watch'], { stdio: 'inherit' }));
/* 样式、页面、提示词、节点表不归 tsc 管;不在这儿一起盯着,
   改完刷新看到的还是启动那一刻的那份,而且不报错。 */
const stopAssets = watchAssets((error) => {
  if (error) console.error(error instanceof Error ? error.message : String(error));
  else console.log('已更新 dist 里的样式、页面与节点表');
});
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  stopAssets();
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code ?? 1));
}
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));
