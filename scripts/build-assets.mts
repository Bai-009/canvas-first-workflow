import { cp, mkdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

// 仅这一份生成的演示数据仍以经典脚本加载；程序一律由 TypeScript 编译。
const demoData = resolve('prototype/plan-data.js');

// 保留资源相对编译入口的层级，源码与编译产物不互相覆盖。
for (const directory of ['contracts', 'nodes', 'prompts', 'fixtures', 'web', 'prototype']) {
  await mkdir(`dist/${directory}`, { recursive: true });
  await cp(directory, `dist/${directory}`, {
    recursive: true,
    filter: (source) => !source.includes('/generated')
      && (resolve(source) === demoData || !['.js', '.cjs', '.mjs', '.mts', '.ts'].includes(extname(source))),
  });
}
