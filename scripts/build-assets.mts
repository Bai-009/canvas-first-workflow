import { cp, mkdir } from 'node:fs/promises';
import { extname } from 'node:path';

// 保留资源相对编译入口的层级，源码与编译产物不互相覆盖。
for (const directory of ['contracts', 'nodes', 'prompts', 'fixtures', 'web', 'prototype']) {
  await mkdir(`dist/${directory}`, { recursive: true });
  await cp(directory, `dist/${directory}`, {
    recursive: true,
    filter: (source) => !source.includes('/generated') && !['.mjs', '.mts', '.ts'].includes(extname(source)),
  });
}
