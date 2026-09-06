import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot } from '../../src/runtime-paths.mjs';
import { record, list, text } from '../helpers/fixtures.mjs';

const exporter = join(projectRoot, '.build-tools/dump-n8n-nodes.mjs');
test('节点导出保留普通描述、各版本与失败记录，不需要安装 n8n', t => {
  const directory = mkdtempSync(join(tmpdir(), 'node-export-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0', n8n: { nodes: ['plain.cjs', 'versions.cjs', 'broken.cjs'] } }));
  // 临时模块是用于验证导出协议的输入数据，不是应用执行代码。
  writeFileSync(join(directory, 'plain.cjs'), 'exports.Plain = class { description = { name: "plain", nested: { options: [1, "x"] } }; };');
  writeFileSync(join(directory, 'versions.cjs'), 'exports.Versions = class { description = { name: "versions" }; nodeVersions = { 1: { description: { name: "v1" } }, 2: { description: { name: "v2", unknownField: true } } }; currentVersion = 2; };');
  writeFileSync(join(directory, 'broken.cjs'), 'throw new Error("fixture failure");');
  const output = join(directory, 'out.json');
  const result = spawnSync(process.execPath, [exporter, directory, output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const exported = record(JSON.parse(readFileSync(output, 'utf8')));
  assert.deepEqual(exported, { package: 'fixture', version: '1.0', count: 2,
    failed: [{ file: 'broken.cjs', error: 'fixture failure' }], nodes: [
      { file: 'plain.cjs', description: { name: 'plain', nested: { options: [1, 'x'] } } },
      { file: 'versions.cjs', description: { name: 'versions' }, versions: { 1: { name: 'v1' }, 2: { name: 'v2', unknownField: true } }, currentVersion: 2 },
    ] });
  assert.match(text(record(list(exported.failed)[0]).error), /fixture failure/);
});
test('节点导出缺参数时给出用法并失败退出', () => {
  const result = spawnSync(process.execPath, [exporter], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /用法/);
});
