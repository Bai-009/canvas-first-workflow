import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本模块运行于 dist/src；可变会话仍归仓库根目录，不归可重建的 dist。
export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

export function resolveRuntimeModule(which: string): string {
  const source = resolve(which);
  const path = relative(projectRoot, source);
  if (path.startsWith(`src${sep}`) || path.startsWith(`fixtures${sep}doubles${sep}`)) {
    const built = resolve(projectRoot, 'dist', path.replace(/\.mts$/, '.mjs'));
    if (existsSync(built)) return built;
  }
  return source;
}
