import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot } from '../../src/runtime-paths.mjs';

test('完整构建清理旧产物，保留会话、配置和运行记录', t => {
  const directory = mkdtempSync(join(tmpdir(), 'build-clean-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (path: string, value: string) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), value);
  };
  write('dist/web/removed.mjs', 'stale');
  write('.build-tools/removed.mjs', 'stale');
  for (const path of ['.sessions/saved.json', '.env', '.runs/trace.json', 'web/main.mts']) write(path, path);
  mkdirSync(join(directory, 'scripts'));
  copyFileSync(join(projectRoot, 'scripts/clean-build.mts'), join(directory, 'scripts/clean-build.mts'));
  // 从其他工作目录运行仍只清理脚本所属项目，且可以在没有编译器产物时启动。
  const result = spawnSync(process.execPath, ['--experimental-strip-types', join(directory, 'scripts/clean-build.mts')], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const path of ['dist', '.build-tools']) assert.equal(existsSync(join(directory, path)), false);
  for (const path of ['.sessions/saved.json', '.env', '.runs/trace.json', 'web/main.mts']) assert.equal(readFileSync(join(directory, path), 'utf8'), path);
});

test('静态资源只放行生成的演示 JS 数据，不能夹带未编译的程序', t => {
  const directory = mkdtempSync(join(tmpdir(), 'build-assets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['contracts', 'nodes', 'prompts', 'fixtures', 'web', 'prototype', 'dist/web']) mkdirSync(join(directory, name), { recursive: true });
  for (const name of ['old.js', 'old.cjs', 'old.mjs', 'main.mts', 'theme.ts']) writeFileSync(join(directory, 'web', name), 'source');
  writeFileSync(join(directory, 'web/index.html'), '<html></html>');
  writeFileSync(join(directory, 'prototype/plan-data.js'), 'window.DEMO_DATA = {};');
  writeFileSync(join(directory, 'dist/web/theme.js'), 'compiled');
  const result = spawnSync(process.execPath, [join(projectRoot, '.build-tools/build-assets.mjs')], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['old.js', 'old.cjs', 'old.mjs', 'main.mts', 'theme.ts']) assert.equal(existsSync(join(directory, 'dist/web', name)), false);
  assert.equal(readFileSync(join(directory, 'dist/web/theme.js'), 'utf8'), 'compiled');
  assert.equal(readFileSync(join(directory, 'dist/web/index.html'), 'utf8'), '<html></html>');
  assert.equal(readFileSync(join(directory, 'dist/prototype/plan-data.js'), 'utf8'), 'window.DEMO_DATA = {};');
});
