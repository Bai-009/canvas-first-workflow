import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { projectRoot, resolveRuntimeModule } from '../../src/runtime-paths.mjs';

test('会话根目录在仓库，内置 Agent 的原配置路径指向编译结果', () => {
  assert.equal(resolve(projectRoot), process.cwd());
  assert.equal(resolveRuntimeModule('src/executor/executor.mjs'), resolve('dist/src/executor/executor.mjs'));
  assert.equal(resolveRuntimeModule('fixtures/doubles/fixed-executor.mjs'), resolve('dist/fixtures/doubles/fixed-executor.mjs'));
  assert.equal(resolveRuntimeModule('/tmp/external-custom-agent.mjs'), '/tmp/external-custom-agent.mjs');
});
