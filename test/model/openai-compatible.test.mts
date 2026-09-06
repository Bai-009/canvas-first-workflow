import test from 'node:test';
import assert from 'node:assert/strict';
import { openAiCompatibleCaller } from '../../src/model/openai-compatible.mjs';
import type { ModelDelta } from '../../shared/model.mjs';
import { runStep } from '../../src/executor/executor.mjs';
import { runPlanAgent } from '../../src/plan/plan-agent.mjs';
import { planWithSteps, record, list } from '../helpers/fixtures.mjs';

const settings = { baseUrl: 'https://model.invalid/v1/', apiKey: 'test-key', model: 'demo' };

function streamResponse(deltas: unknown[]) {
  return new Response(deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join('') + 'data: [DONE]\n\n');
}

for (const streaming of [false, true]) {
  test(`${streaming ? '流式' : '非流式'}：缺省类型、对象参数与额外字段适配为内部调用`, async t => {
    const call = { id: 'c1', function: { name: 'submit_step', arguments: { kind: 'covered', text: '中文' } } };
    t.mock.method(globalThis, 'fetch', async () => streaming
      ? streamResponse([{ tool_calls: [{ index: 0, id: 'c1', function: { name: 'submit_step', arguments: '' } }] }, { tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] }])
      : Response.json({ choices: [{ message: { role: 'assistant', tool_calls: [call], provider: 'kept' } }] }));
    const reply = await openAiCompatibleCaller(settings)([], streaming ? { onDelta() {} } : {});
    assert.deepEqual(reply.tool_calls, [{ ...call, type: 'function', function: { ...call.function, arguments: JSON.stringify(call.function.arguments) } }]);
    if (!streaming) assert.equal(record(reply).provider, 'kept');
  });

  test(`${streaming ? '流式' : '非流式'}：缺失调用信息和未知工具类型仍拒绝`, async t => {
    const good = { id: 'c1', function: { name: 'submit_step', arguments: '{}' } };
    let incoming: unknown;
    t.mock.method(globalThis, 'fetch', async () => streaming
      ? streamResponse([{ tool_calls: [incoming] }])
      : Response.json({ choices: [{ message: { role: 'assistant', tool_calls: [incoming] } }] }));
    for (const bad of [
      { function: good.function }, { ...good, id: '' }, { ...good, type: 'custom' },
      { ...good, function: { arguments: '{}' } }, { ...good, function: { name: 'submit_step' } },
      { ...good, function: { name: 'submit_step', arguments: 42 } },
    ]) {
      incoming = bad;
      await assert.rejects(openAiCompatibleCaller(settings)([], streaming ? { onDelta() {} } : {}), /模型接口/);
    }
  });
}

test('流式完整对象不能与非空文本片段或另一份对象混合', async t => {
  let fragments: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async () => streamResponse(fragments));
  for (const args of [[{ x: 1 }, '}'], ['{', { x: 1 }], [{ x: 1 }, { y: 2 }]]) {
    fragments = args.map(argumentsValue => ({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'one', arguments: argumentsValue } }] }));
    await assert.rejects(openAiCompatibleCaller(settings)([], { onDelta() {} }), /混用/);
  }
});

test('执行者经传输层收到坏 JSON 后反馈并重试，下一轮对象参数可以提交', async t => {
  const plan = planWithSteps([{ ref: 's1', title: '读取文件', dependsOn: [] }]);
  const step = plan.steps[0];
  assert.ok(step);
  const submission = { kind: 'patch', nodes: [{ name: '读取', type: 'readFile', params: { folder: '/demo' }, blanks: [] }], edges: [] };
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push(record(JSON.parse(String(init?.body))));
    return Response.json({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: `c${requests.length}`, function: {
      name: 'submit_step', arguments: requests.length === 1 ? '{bad json' : submission,
    } }] } }] });
  });
  const out = await runStep({ plan, step, canvas: { nodes: [], edges: [], version: 0 }, openQuestions: [], instructions: [] }, {
    callModel: openAiCompatibleCaller(settings), systemPrompt: 'local fixture', maxRounds: 2,
  });
  assert.equal(out.rounds, 2);
  assert.equal(out.result.kind, 'patch');
  assert.deepEqual(out.events.map(e => e.kind), ['bad-args', 'submitted']);
  const second = requests[1];
  assert.ok(second);
  const feedback = list(second.messages).map(record).find(m => m.role === 'tool');
  assert.ok(feedback);
  assert.equal(feedback.tool_call_id, 'c1');
  assert.match(String(feedback.content), /not valid JSON/);
});

test('Plan Agent 经流式传输层收到坏 JSON 后重交，完整对象方案通过原门禁', async t => {
  const plan = planWithSteps([{ ref: 's1', title: '读取文件', dependsOn: [] }]);
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    count++;
    return streamResponse([{ tool_calls: [{ index: 0, id: `p${count}`, function: { name: 'propose_plan', arguments: count === 1 ? '{bad json' : plan } }] }]);
  });
  const out = await runPlanAgent({ callModel: openAiCompatibleCaller(settings), messages: [{ role: 'user', content: '读取文件' }], systemPrompt: 'local fixture', onDraft() {} });
  assert.equal(count, 2);
  assert.deepEqual(out.plan, plan);
});

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
