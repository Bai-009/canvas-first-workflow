import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createWebServer } from "../../dist/src/web/server.mjs";

const plan = JSON.parse(readFileSync(new URL("../../fixtures/observed/run8-原因版提示词/turn-2.plan.json", import.meta.url)));
plan.steps.push({ ref: "s5", title: "核对结果", intent: "保留可检查的记录", input: "写入结果", output: "核对记录", dependsOn: ["s4"] });
const reply = () => ({ role: "assistant", tool_calls: [{ id: "plan-test", type: "function",
  function: { name: "propose_plan", arguments: JSON.stringify(plan) } }] });
const executor = async ({ step, canvas }) => canvas.nodes.some((node) => node.step === step.ref)
  ? { kind: "covered" }
  : { kind: "patch", nodes: [{ name: step.ref, step: step.ref, type: "code", params: { code: "return items;", outputKind: "JSON" }, blanks: [] }],
    edges: step.dependsOn.map((from) => ({ from, to: step.ref })) };
const patch = (context) => ({ kind: "patch", summary: "S3 与 S5 一起更新。",
  review: context.plan.steps.map(({ ref }) => ({ step: ref, summary: ref === "s3" || ref === "s5" ? "同步字段名称。" : "保留现有处理。" })),
  upsertNodes: context.canvas.nodes.filter(({ name }) => ["s3", "s5"].includes(name)).map((node) => ({ ...node, note: "同步字段名称。", params: { ...node.params, code: "return items.map(item => ({...item, total: item.amount}));" } })),
  removeNodes: [], addEdges: [], removeEdges: [] });

async function setup(t, overrides = {}) {
  const server = await createWebServer({ callModel: async () => reply(), executor, reviser: async (context) => patch(context), ...overrides });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const abort = new AbortController();
  const stream = await fetch(`${base}/api/events`, { signal: abort.signal });
  const events = [];
  const listeners = new Set();
  const reader = stream.body.getReader();
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const packet = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!packet.startsWith("data: ")) continue;
        const event = JSON.parse(packet.slice(6));
        events.push(event);
        for (const listener of listeners) listener(event);
      }
    }
  })().catch((error) => { if (!abort.signal.aborted) throw error; });
  t.after(async () => {
    abort.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await reading;
  });
  const waitFor = (predicate) => {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error("未收到预期 SSE 事件")); }, 5000);
      const listener = (event) => { if (predicate(event)) { clearTimeout(timer); listeners.delete(listener); resolve(event); } };
      listeners.add(listener);
    });
  };
  const post = async (path, body = {}) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const state = () => fetch(`${base}/api/state`).then((response) => response.json());
  const build = async () => {
    const before = await state();
    assert.equal((await post("/api/say", { text: "手写 HTTP 测试场景" })).status, 200);
    assert.equal((await post("/api/start")).status, 200);
    await waitFor((event) => event.type === "run" && event.sequence > before.sequence);
    return state();
  };
  return { server, base, post, state, events, waitFor, build };
}

test("浏览器可加载同一份 TypeScript 编译结果，默认 Agent 与契约资源路径仍有效", async (t) => {
  const api = await setup(t, { executor: undefined, reviser: undefined });
  const state = await api.state();
  assert.equal(state.hasExecutor, true);
  assert.equal(state.hasReviser, true);
  const wrapper = await fetch(`${api.base}/flow.mjs`);
  assert.equal(wrapper.status, 200);
  assert.match(await wrapper.text(), /\.\.\/shared\/flow\.mjs/);
  const generated = await fetch(`${api.base}/shared/flow.mjs`);
  assert.equal(generated.status, 200);
  assert.match(generated.headers.get("content-type"), /javascript/);
  assert.equal(await generated.text(), readFileSync(new URL("../../dist/shared/flow.mjs", import.meta.url), "utf8"));
  assert.equal((await fetch(`${api.base}/api/node-table`)).status, 200);
});

test("HTTP 节点请求携完整上下文，SSE 与刷新同见一次原子修订", async (t) => {
  let received;
  const api = await setup(t, { reviser: async (context) => { received = context; return patch(context); } });
  const before = await api.build();
  assert.equal(before.canvasPlanRevision, before.revision);
  const accepted = await api.post("/api/revise", { node: "s3", step: "s3", canvasVersion: before.canvas.version, text: "S3 改字段名，并保持整条流程成立" });
  assert.equal(accepted.status, 202);
  const finished = await api.waitFor((event) => event.type === "edit" && !["processing", "checking"].includes(event.edit.status));
  assert.equal(finished.edit.status, "applied", JSON.stringify(finished.edit));
  assert.equal(received.plan.steps.length, 5);
  assert.equal(received.canvas.nodes.length, 5);
  assert.equal(received.history.runs.length, 1);
  assert.equal(finished.turn, "user");
  assert.equal(finished.canvas.version, before.canvas.version + 1);
  assert.deepEqual(finished.edit.changes, ["s3", "s5"]);
  const after = await api.state();
  const snapshot = await api.waitFor((event) => event.type === "snapshot");
  assert.ok(after.feedId);
  assert.equal(snapshot.feedId, after.feedId);
  assert.equal(snapshot.state.feedId, after.feedId);
  assert.equal(finished.feedId, after.feedId);
  assert.deepEqual(after.canvas, finished.canvas);
  assert.deepEqual(after.edits, finished.edits);
  assert.deepEqual(after.plan, before.plan);
  assert.deepEqual(after.chat, before.chat);
  assert.equal(after.revision, before.revision);
  assert.ok(api.events.filter((event) => event.type === "edit" && ["processing", "checking"].includes(event.edit.status))
    .every((event) => event.canvas.version === before.canvas.version));
  // 模拟遗漏终态后的重新订阅，第一条消息就包含恢复所需的完整快照。
  const connection = await fetch(`${api.base}/api/events`);
  const reconnectReader = connection.body.getReader();
  const { value } = await reconnectReader.read();
  const packet = new TextDecoder().decode(value).split("\n\n").find((line) => line.startsWith("data: "));
  await reconnectReader.cancel();
  const restored = JSON.parse(packet.slice(6));
  assert.equal(restored.type, "snapshot");
  assert.equal(restored.sequence, after.sequence);
  assert.deepEqual(restored.state.edits, after.edits);
  assert.deepEqual(restored.state.canvas, after.canvas);
  assert.equal(restored.state.turn, "user");
});

test("读取中的旧请求不能在 reset 后落到同版本的新工作流", async (t) => {
  const api = await setup(t);
  const before = await api.build();
  const requests = [
    ["/api/revise", { node: "s3", step: "s3", canvasVersion: before.canvas.version, text: "只属于旧流程" }],
    ["/api/say", { text: "只属于旧目标" }],
    ["/api/note", { step: "s3", text: "只属于旧批注" }],
  ];
  const waiting = [];
  for (const [path, body] of requests) {
    const raw = JSON.stringify(body);
    let request;
    const response = new Promise((resolve, reject) => {
      request = httpRequest(`${api.base}${path}`, { method: "POST", headers: { "content-type": "application/json" } }, (incoming) => {
        incoming.resume(); incoming.on("end", () => resolve(incoming.statusCode));
      });
      request.on("error", reject);
    });
    const arrived = once(api.server, "request");
    request.write(raw.slice(0, 1));
    await arrived;
    waiting.push({ request, rest: raw.slice(1), response });
  }
  await api.post("/api/reset");
  const newWorkflow = await api.build();
  assert.equal(newWorkflow.canvas.version, before.canvas.version);
  for (const pending of waiting) pending.request.end(pending.rest);
  assert.deepEqual(await Promise.all(waiting.map((pending) => pending.response)), [409, 409, 409]);
  const after = await api.state();
  assert.deepEqual(after.canvas, newWorkflow.canvas);
  assert.deepEqual(after.chat, newWorkflow.chat);
  assert.deepEqual(after.edits, []);
  assert.deepEqual(after.annotations, []);
});

test("HTTP 拒绝过期画布与并发全局操作；停止后的晚结果不写画布", async (t) => {
  let finish;
  const api = await setup(t, { reviser: (context) => new Promise((resolve) => { finish = () => resolve(patch(context)); }) });
  const before = await api.build();
  const request = { node: "s3", step: "s3", canvasVersion: before.canvas.version, text: "改字段" };
  assert.equal((await api.post("/api/revise", { ...request, canvasVersion: 0 })).status, 400);
  assert.equal((await api.state()).edits.length, 0);
  assert.equal((await api.post("/api/revise", request)).status, 202);
  await api.waitFor((event) => event.type === "edit" && event.edit.status === "processing");
  assert.equal((await api.post("/api/say", { text: "换一个目标" })).status, 409);
  assert.equal((await api.post("/api/start")).status, 409);
  assert.equal((await api.post("/api/revise", request)).status, 400);
  await api.post("/api/stop");
  finish();
  await api.waitFor((event) => event.type === "edit" && event.edit.status === "stopped");
  const after = await api.state();
  assert.deepEqual(after.canvas, before.canvas);
  assert.deepEqual(after.chat, before.chat);
  assert.equal(after.turn, "user");
});

test("新建会话隔离尚未返回的修订；后续不能覆盖新画布", async (t) => {
  let finish;
  let finished;
  const settled = new Promise((resolve) => { finished = resolve; });
  const api = await setup(t, { reviser: (context) => new Promise((resolve) => { finish = () => { resolve(patch(context)); finished(); }; }) });
  const before = await api.build();
  await api.post("/api/revise", { node: "s3", step: "s3", canvasVersion: before.canvas.version, text: "修改" });
  await api.waitFor((event) => event.type === "edit" && event.edit.status === "processing");
  await api.post("/api/reset");
  await api.waitFor((event) => event.type === "reset");
  finish();
  await settled;
  const after = await api.state();
  assert.equal(after.plan, null);
  assert.deepEqual(after.canvas, { nodes: [], edges: [], version: 0 });
  assert.deepEqual(after.edits, []);
  assert.equal(after.turn, "user");
  assert.equal(api.events.filter((event) => event.type === "edit" && ["applied", "stopped"].includes(event.edit.status)).length, 0);
});

test("模型规划失败返回 JSON 与恢复事件，纯说话保留现有方案", async (t) => {
  let calls = 0;
  const api = await setup(t, { callModel: async () => {
    calls += 1;
    if (calls === 1) return reply();
    if (calls === 2) return { role: "assistant", content: "已有方案可以继续使用。" };
    throw new Error("测试模型不可用");
  } });
  const before = await api.build();
  assert.equal((await api.post("/api/say", { text: "解释一下" })).status, 200);
  assert.deepEqual(api.events.filter((event) => event.type === "plan").at(-1).plan, before.plan);
  const failed = await api.post("/api/say", { text: "再说一句" });
  assert.equal(failed.status, 400);
  assert.match(failed.data.error, /测试模型不可用/);
  const event = await api.waitFor((event) => event.type === "error");
  assert.equal(event.turn, "user");
  assert.equal((await api.state()).turn, "user");
});
