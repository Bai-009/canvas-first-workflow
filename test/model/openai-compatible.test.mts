import test from 'node:test';
import assert from 'node:assert/strict';
import { openAiCompatibleCaller } from '../../src/model/openai-compatible.mjs';
import type { ModelDelta } from '../../shared/model.mjs';

const settings = { baseUrl: 'https://model.invalid/v1/', apiKey: 'test-key', model: 'demo' };

test('非流式响应保留完整消息，未知接口结果必须先经过边界检查', async (t) => {
  const message = { role: 'assistant', content: '可以开始。', tool_calls: null, reasoning_content: 'provider metadata' };
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message }] }));
  const caller = openAiCompatibleCaller(settings);
  const result = await caller([{ role: 'user', content: '设计一个工作流' }]);
  assert.deepEqual(result, message);
  fetchMock.mock.mockImplementation(async () => Response.json({ choices: [] }));
  await assert.rejects(caller([]), /有效的 assistant/);
  fetchMock.mock.mockImplementation(async () => Response.json({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 1 }] } }] }));
  await assert.rejects(caller([]), /有效的 assistant/);
});

test('流式 UTF-8 跨块、推理、文字和多个工具调用组装成同一消息', async (t) => {
  const events = [
    { reasoning_content: '思考中', tool_calls: null },
    { content: '你好' },
    { tool_calls: [{ index: 1, id: 'second', function: { name: 'two', arguments: '{' } }] },
    { tool_calls: [{ index: 0, id: 'first', function: { name: 'one', arguments: '{"x":' } }] },
    { tool_calls: [{ index: 1, function: { arguments: '}' } }, { index: 0, function: { arguments: '1}' } }] },
  ];
  const wire = events.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(wire);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2));
      controller.close();
    },
  })));
  const deltas: ModelDelta[] = [];
  const result = await openAiCompatibleCaller(settings)([], { onDelta: (delta) => deltas.push(delta) });
  assert.deepEqual(result, {
    role: 'assistant', content: '你好', tool_calls: [
      { id: 'first', type: 'function', function: { name: 'one', arguments: '{"x":1}' } },
      { id: 'second', type: 'function', function: { name: 'two', arguments: '{}' } },
    ],
  });
  assert.deepEqual(deltas[0], { kind: 'reason', text: '思考中' });
  assert.ok(deltas.some((delta) => delta.kind === 'args' && delta.index === 1));
});

test('接口失败与异常流式工具参数明确报错', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
  const caller = openAiCompatibleCaller(settings);
  await assert.rejects(caller([]), /503.*unavailable/);
  fetchMock.mock.mockImplementation(async () => new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":-1}]}}]}\n\n'));
  await assert.rejects(caller([], { onDelta() {} }), /无效的流式消息/);
});
