import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { projectRoot } from '../../src/runtime-paths.mjs';

/* 样式、页面、提示词、节点表不归 tsc 管。监听时如果没人重新拷,改完刷新看到的
   还是启动那一刻的那一份——而且一声不吭,人只会觉得「我改的样式没生效」,先去怀疑缓存。

   这一条跑的是真正的监听入口 watch.mjs,不是它用到的那个函数:漏掉的从来不是
   「拷不动」,是「没人叫它拷」。临时目录里放一个不干活的假编译器,监听脚本按
   相对路径找编译器,于是四个编译进程都成了空壳,只剩这件事被验。 */

test('监听时改了样式,编译产物跟着更新', { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'watch-assets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['contracts', 'nodes', 'prompts', 'fixtures', 'web', 'prototype', 'node_modules/typescript/bin'])
    mkdirSync(join(directory, name), { recursive: true });
  // 假编译器:活着但什么都不做,免得监听脚本以为编译挂了就收摊。
  writeFileSync(join(directory, 'node_modules/typescript/bin/tsc'), 'setInterval(() => {}, 1 << 30);\n');
  writeFileSync(join(directory, 'web/theme.css'), '.card{color:旧}');

  const child = spawn(process.execPath, [join(projectRoot, '.build-tools/watch.mjs')], { cwd: directory });
  t.after(() => child.kill('SIGTERM'));
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += String(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { output += String(chunk); });

  const 拷好的样式 = join(directory, 'dist/web/theme.css');
  const 等到 = async (够了: () => boolean, 说明: string) => {
    for (let i = 0; i < 280; i++) {
      if (够了()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`${说明}；监听脚本这段时间说的是：${output || '(什么都没说)'}`);
  };

  // 监听起来之后才改文件,免得改在它开始盯之前
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(existsSync(拷好的样式), false, '监听本身不该先拷一遍,这一遍归 build 管');
  writeFileSync(join(directory, 'web/theme.css'), '.card{color:新}');

  await 等到(() => existsSync(拷好的样式), '改了样式之后,dist 里始终没有出现它');
  assert.equal(readFileSync(拷好的样式, 'utf8'), '.card{color:新}',
    '监听时改了样式,dist 里必须是新的那一份');
});
