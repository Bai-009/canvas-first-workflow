import { cp, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 仅这一份生成的演示数据仍以经典脚本加载；程序一律由 TypeScript 编译。
const demoData = resolve('prototype/plan-data.js');
const CODE = ['.js', '.cjs', '.mjs', '.mts', '.ts'];

// 拷哪几个目录、拷里面的哪些东西,只写一遍:监听那头照同一份判断盯着,两边不会走岔。
export const ASSET_DIRECTORIES = ['contracts', 'nodes', 'prompts', 'fixtures', 'web', 'prototype'];
export const isAsset = (source: string) =>
  !source.includes('/generated') && (resolve(source) === demoData || !CODE.includes(extname(source)));

// 保留资源相对编译入口的层级，源码与编译产物不互相覆盖。
export async function copyAssets() {
  for (const directory of ASSET_DIRECTORIES) {
    await mkdir(`dist/${directory}`, { recursive: true });
    await cp(directory, `dist/${directory}`, { recursive: true, filter: isAsset });
  }
}

/* 样式、页面、提示词、节点表这些不是 TypeScript,tsc 不管它们。监听时不在这儿盯着,
   改完刷新看到的还是启动那一刻拷过去的那一份——而且不报错,只是「我改的样式没生效」,
   人会先去怀疑浏览器缓存。返回的函数用来收摊,不留下后台的监听。 */
export function watchAssets(onCopy: (error?: unknown) => void = () => {}) {
  let pending: NodeJS.Timeout | undefined;
  let queue = Promise.resolve();
  const schedule = () => {
    clearTimeout(pending);
    // 保存一次常常连着来好几个事件;等它停下来再拷,而且一次只拷一趟。
    pending = setTimeout(() => {
      queue = queue.then(copyAssets).then(() => onCopy(), (error: unknown) => onCopy(error));
    }, 80);
  };
  const watchers = ASSET_DIRECTORIES.map((directory) =>
    watch(directory, { recursive: true }, (_event, file) => {
      if (typeof file === 'string' && !isAsset(join(directory, file))) return;
      schedule();
    }));
  return () => { clearTimeout(pending); for (const watcher of watchers) watcher.close(); };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await copyAssets();
