import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNodeDefinition, isNodeDefinition, findNodeDefinition } from '../../src/nodes/node-table.mjs';

test('畸形节点定义返回问题列表，不在读取 options 或 slots 时抛出异常', () => {
  const llm = findNodeDefinition('llm');
  assert.ok(llm);
  assert.equal(isNodeDefinition(llm), true);
  const malformed = [null, [], { ...llm, slots: 1 }, {
    ...llm, slots: [{ key: 'model', kind: 'pick', label: 'Model', options: {}, default: 'Demo' }],
  }];
  for (const definition of malformed) {
    assert.equal(isNodeDefinition(definition), false);
    assert.ok(checkNodeDefinition(definition).length > 0);
  }
});
