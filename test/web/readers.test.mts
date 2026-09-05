import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebServer } from '../../src/web/server.mjs';
import { readSnapshot, readListing, readNodeTable, readEvent } from '../../web/readers.mjs';

test('实际 HTTP 快照、会话列表和节点表通过浏览器边界检查', async (t) => {
  const server = await createWebServer({ callModel: async () => ({ role: 'assistant', content: '' }), executor: null, reviser: null });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const get = async (path: string): Promise<unknown> => (await fetch(`http://127.0.0.1:${address.port}${path}`)).json();
  const state = readSnapshot(await get('/api/state'));
  assert.equal(state.turn, 'user');
  assert.equal(readListing(await get('/api/sessions')).sessions[0]?.id, state.sessionId);
  assert.ok(readNodeTable(await get('/api/node-table')).length > 0);
  assert.throws(() => readSnapshot({ ...state, canvas: { version: 0, nodes: [null], edges: [] } }), /格式不正确/);
  assert.throws(() => readSnapshot({ ...state, edits: [{ status: 'applied' }] }), /格式不正确/);
  assert.throws(() => readSnapshot({ ...state, chat: [{ who: 'agent', text: {} }] }), /格式不正确/);
  assert.throws(() => readSnapshot({ ...state, turn: 'made-up-state' }), /格式不正确/);
});

test('事件边界拒绝未知类型与不完整结果，保留有效流式草稿', () => {
  const envelope = { feedId: 'stream', sequence: 1 };
  assert.throws(() => readEvent({ ...envelope, type: 'unknown' }), /格式不正确/);
  assert.throws(() => readEvent({ ...envelope, type: 'step', step: null, canvas: {} }), /格式不正确/);
  assert.throws(() => readEvent({ ...envelope, type: 'configured', canvas: { version: 1, nodes: [], edges: [{ from: 'a' }] } }), /格式不正确/);
  const draft = { ...envelope, type: 'draft', task: '读取', chat: [], speech: '', phase: 'writing', plan: {
    readiness: '', goal: '', understanding: [], steps: [{ ref: 's1', title: '读取' }], openQuestions: [] } };
  assert.deepEqual(readEvent(draft), draft);
});
