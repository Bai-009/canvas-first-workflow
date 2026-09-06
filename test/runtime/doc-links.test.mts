import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { projectRoot } from '../../src/runtime-paths.mjs';

/* 文档是他进这个仓库的入口:CLAUDE.md 每次开工先读,架构.md 是流程的准。
   链接指向一个已经改名或搬走的文件,点开是空的,而没有任何东西会报错——
   TypeScript 迁移一次就留下了十二个。这一条把整类问题钉住:改了文件名,
   忘了改文档,测试立刻红。 */

const 文档 = [
  ...readdirSync(join(projectRoot, 'docs')).filter((n) => n.endsWith('.md')).map((n) => join('docs', n)),
  'README.md', 'CLAUDE.md', 'AGENTS.md',
].filter((path) => existsSync(join(projectRoot, path)));

test('文档里指向仓库文件的链接都点得开', () => {
  assert.ok(文档.length > 5, '应当找得到这些文档');
  const 断掉的: string[] = [];
  for (const path of 文档) {
    const text = readFileSync(join(projectRoot, path), 'utf8');
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      // 只看指向仓库里文件的:外链和页内锚点不归这儿管
      if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
      const 去掉锚点 = target.split('#')[0];
      if (!去掉锚点) continue;
      const 文件 = resolve(dirname(join(projectRoot, path)), 去掉锚点);
      if (!existsSync(文件)) 断掉的.push(`${path} → ${target}`);
    }
  }
  assert.deepEqual(断掉的, [], `这些链接点开是空的：\n  ${断掉的.join('\n  ')}`);
});
