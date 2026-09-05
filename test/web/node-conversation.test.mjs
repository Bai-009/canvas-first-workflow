import { test } from "node:test";
import assert from "node:assert/strict";
import { createNodeConversation, editResultHtml, editPresentation } from "../../web/node-conversation.mjs";

/* A small event surface, not a layout simulation. Browser QA covers focus/geometry;
   these checks exercise async acceptance, failure and composition boundaries. */
class Element {
  constructor() {
    this.children = new Map(); this.listeners = new Map(); this.dataset = {};
    this.value = ""; this.disabled = false; this.attrs = {};
    this.classList = { toggle() {}, add() {} };
  }
  querySelector(key) { if (!this.children.has(key)) this.children.set(key, new Element()); return this.children.get(key); }
  addEventListener(key, fn) { (this.listeners.get(key) ?? this.listeners.set(key, []).get(key)).push(fn); }
  setAttribute(key, value) { this.attrs[key] = value; }
  fire(key, event = {}) { for (const fn of this.listeners.get(key) ?? []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...event }); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function mount(onSend) {
  globalThis.document = { createElement: () => new Element() };
  const component = createNodeConversation({ node: { name: "解析", step: "s2" }, onSend });
  const input = component.el.querySelector(".nc-input");
  const send = component.el.querySelector(".nc-send");
  const type = (value) => { input.value = value; input.fire("input"); };
  const submit = () => component.el.querySelector("form").fire("submit");
  return { component, input, send, type, submit };
}

test("网络失败后保留草稿并恢复发送，运行中仍可写下一条", async () => {
  let reject;
  const ui = mount(() => new Promise((_, fail) => { reject = fail; }));
  ui.type("保留来源"); ui.submit();
  assert.equal(ui.send.disabled, true);
  ui.type("保留来源，并传到入库");
  reject(new Error("网络中断，请重试")); await tick();
  assert.equal(ui.component.draft, "保留来源，并传到入库");
  assert.equal(ui.send.disabled, false);
  assert.equal(ui.component.el.querySelector(".nc-help").textContent, "网络中断，请重试");
});

test("快照更新保持同一个输入元素；失败和停止不清掉请求文字", async () => {
  const ui = mount(async () => {});
  ui.type("保留来源"); ui.submit(); await tick();
  for (const status of ["processing", "checking", "failed", "stopped"]) {
    ui.component.update({ busy: ["processing", "checking"].includes(status), edits: [{ id: "e1", target: { node: "解析", step: "s2" }, text: "保留来源", status }] });
    assert.equal(ui.component.el.querySelector(".nc-input"), ui.input);
    assert.equal(ui.component.draft, "保留来源");
  }
  assert.equal(ui.send.disabled, false);
});

test("成功只清理原封未动的已发草稿，不清理请求期间的新文字", async () => {
  for (const changed of [false, true]) {
    const ui = mount(async () => {});
    ui.type("第一条"); ui.submit(); await tick();
    if (changed) ui.type("正在写第二条");
    ui.component.update({ edits: [{ id: "e1", text: "第一条", status: "applied" }], busy: false });
    assert.equal(ui.component.draft, changed ? "正在写第二条" : "");
  }
});

test("中文输入法确认和 Shift+Enter 不发送，普通 Enter 发送", async () => {
  let calls = 0;
  const ui = mount(async () => { calls++; }); ui.type("修改来源");
  ui.component.el.fire("keydown", { target: ui.input, key: "Enter", isComposing: true });
  ui.component.el.fire("keydown", { target: ui.input, key: "Enter", shiftKey: true });
  assert.equal(calls, 0);
  ui.component.el.fire("keydown", { target: ui.input, key: "Enter" }); await tick();
  assert.equal(calls, 1);
});

test("再次发送相同文字时，历史成功记录不能提前清空新草稿", async () => {
  let ui;
  ui = mount(async () => { ui.component.update({ busy: true }); throw new Error("未被接受"); });
  ui.component.update({ edits: [{ id: "old", text: "保留来源", status: "applied" }] });
  ui.type("保留来源"); ui.submit(); await tick();
  assert.equal(ui.component.draft, "保留来源");
});

test("反馈区转义模型和节点内容，变化名单与 Agent 影响说明分开", () => {
  const html = editResultHtml({ status: "applied", text: "<img src=x>", summary: "<script>bad()</script>", changes: ["实际变化节点", "实际变化节点"], review: [{ step: "s2", summary: "没有改动" }] });
  assert.doesNotMatch(html, /<script>|<img/);
  assert.equal((html.match(/实际变化节点/g) ?? []).length, 1);
  assert.match(html, /Agent 说明/);
  assert.doesNotMatch(html, /验证通过|证明/);
  assert.equal(editPresentation({ status: "needs_plan" }).badge, "需完善方案");
  assert.equal(editPresentation({ status: "checking" }).working, true);
});
