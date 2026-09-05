import test from 'node:test';
import assert from 'node:assert/strict';
import { checkResult, isStepResult } from '../../src/state-machine/workflow-session.mjs';

test('类型收窄保留既有构建规则：缺省连线、透传旁白与坏机器字段', () => {
  const step = { ref: 's1', dependsOn: [] };
  const canvas = { nodes: [], edges: [], version: 0 };
  const node = { name: '读文件', type: 'readFile', step: 's1', params: {}, blanks: ['folder'], note: { original: 'opaque' } };
  assert.equal(isStepResult({ kind: 'patch', nodes: [node] }, step, canvas), true);
  assert.deepEqual(checkResult({ kind: 'patch', nodes: [node], edges: [] }, step, canvas), []);
  for (const bad of [null, { kind: 'patch' }, { kind: 'patch', nodes: [{ ...node, params: null }] },
    { kind: 'patch', nodes: [node], edges: [{ from: '不存在', to: node.name }] }]) {
    assert.equal(isStepResult(bad, step, canvas), false);
    assert.ok(checkResult(bad, step, canvas).length > 0);
  }
});
