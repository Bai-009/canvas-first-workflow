import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../../src/runtime-paths.mjs';

/* 演出版是录下来的那一场。主体往前改,它不该跟着变——两边摆在一起才照得出差别。
   所以它不跟主体共用一行代码,也不靠模块加载:一个文件夹整个拿走,双击就能演。
   这两条被"顺手合并一下"破坏,原型就又成了主体的一部分,而且失败起来不报错:
   页面照样出来,只是一动不动。 */

const 原型目录 = join(projectRoot, 'prototype');
const 读 = (name: string) => readFileSync(join(原型目录, name), 'utf8');
const 程序 = readdirSync(原型目录).filter((name) => name.endsWith('.ts'));
const 页面 = readdirSync(原型目录).filter((name) => name.endsWith('.html'));

test('原型的程序不引用主体的任何东西', () => {
  assert.ok(程序.length >= 2, '原型下面应当有它自己的程序');
  for (const name of 程序) {
    const code = 读(name);
    assert.doesNotMatch(code, /^\s*import\s/m, `${name} 一旦 import,演出版就跟主体连上了`);
    assert.doesNotMatch(code, /^\s*export\s/m, `${name} 一旦 export 就成了模块,页面得靠服务才打得开`);
    assert.doesNotMatch(code, /\brequire\s*\(/, `${name} 不能 require`);
  }
});

test('原型页用普通脚本装程序,双击就能开', () => {
  assert.ok(页面.length >= 2);
  for (const name of 页面) {
    const html = 读(name);
    assert.doesNotMatch(html, /type="module"/, `${name} 用了模块脚本,双击打开会被浏览器拦下`);
    assert.match(html, /<script src=/, `${name} 应当用普通脚本装程序`);
  }
});

test('编出来的仍然是普通脚本', () => {
  const 产物 = join(projectRoot, 'dist/prototype');
  const built = readdirSync(产物).filter((name) => name.endsWith('.js'));
  assert.ok(built.length >= 2, '构建应当产出原型自己的脚本');
  for (const name of built) {
    const code = readFileSync(join(产物, name), 'utf8');
    assert.doesNotMatch(code, /^\s*import\s/m, `${name} 编出来带了 import,页面就打不开了`);
  }
});
