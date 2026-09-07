import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createNodeConversation, editResultHtml, editPresentation } from "../../web/node-conversation.mjs";

/* A small event surface, not a layout simulation. Browser QA covers focus/geometry;
   these checks exercise async acceptance, failure and composition boundaries. */
interface FakeEvent {
  target: Element;
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}
class Element {
  children = new Map<string, Element>();
  listeners = new Map<string, ((event: FakeEvent) => void)[]>();
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  value = "";
  disabled = false;
  textContent = "";
  /* 真元素的 classList 能加能减能问,替身也得能——只会 add 不会 remove 的替身,
     会让「加了类又去掉」这种代码在测试里炸,而在浏览器里是好的。 */
  classes = new Set<string>();
  classList = {
    add: (...names: string[]) => { for (const name of names) this.classes.add(name); },
    remove: (...names: string[]) => { for (const name of names) this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name); else this.classes.delete(name);
      return on;
    },
  };
  querySelector(key: string): Element {
    let child = this.children.get(key);
    if (!child) { child = new Element(); this.children.set(key, child); }
    return child;
  }
  addEventListener(key: string, fn: (event: FakeEvent) => void) {
    const listeners = this.listeners.get(key) ?? [];
    listeners.push(fn); this.listeners.set(key, listeners);
  }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  fire(key: string, event: Partial<FakeEvent> = {}) {
    for (const fn of this.listeners.get(key) ?? []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
  }
}
// 只替换本文件用到的事件表面，不将这个替身声称为完整 DOM；几何与焦点另做浏览器验收。
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
after(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
/* 发出去之后字要先淡出才清空(--send-fade,浏览器外用兜底的 130 毫秒),等过那一段再看框里。 */
const afterFade = () => new Promise<void>((resolve) => setTimeout(resolve, 220));
function mount(onSend: () => void | Promise<unknown>) {
  const element = new Element();
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => element } });
  const component = createNodeConversation({ node: { name: "解析", step: "s2" }, onSend });
  const input = element.querySelector(".nc-input");
  const send = element.querySelector(".nc-send");
  const type = (value: string) => { input.value = value; input.fire("input"); };
  const submit = () => element.querySelector("form").fire("submit");
  return { component, element, input, send, type, submit };
}

test("网络失败后保留草稿并恢复发送，运行中仍可写下一条", async () => {
  let reject: (error: Error) => void = () => { throw new Error("发送尚未发起"); };
  const ui = mount(() => new Promise((_, fail) => { reject = fail; }));
  ui.type("保留来源"); ui.submit();
  assert.equal(ui.send.disabled, true);
  ui.type("保留来源，并传到入库");
  reject(new Error("网络中断，请重试")); await tick();
  assert.equal(ui.component.draft, "保留来源，并传到入库");
  assert.equal(ui.send.disabled, false);
  assert.equal(ui.element.querySelector(".nc-help").textContent, "网络中断，请重试");
});

test("快照更新保持同一个输入元素；失败和停止不清掉请求文字", async () => {
  const ui = mount(async () => {});
  ui.type("保留来源"); ui.submit(); await tick();
  for (const status of ["processing", "checking", "failed", "stopped"] as const) {
    ui.component.update({ busy: ["processing", "checking"].includes(status), edits: [{ id: "e1", text: "保留来源", status }] });
    assert.equal(ui.element.querySelector(".nc-input"), ui.input);
    assert.equal(ui.component.draft, "保留来源");
  }
  assert.equal(ui.send.disabled, false);
});

/* 清空的时机在「按下发送」这一头,不在「结果回来」那一头:
   后台要几十秒才回话,等它回来再清,那几十秒里人看着自己发的字还在框里,像根本没发出去。
   字先淡出再清空,所以按下的那一瞬框里还是原话;淡出那一下人要是改了字,那就是他的新话,不许清。 */
test("按下发送就清空，不等结果；淡出那一下人改了字就不清", async () => {
  for (const changed of [false, true]) {
    const ui = mount(async () => {});
    ui.type("第一条"); ui.submit(); await tick();
    assert.equal(ui.component.draft, "第一条", "刚按下时字还在淡出,没到清空那一步");
    if (changed) ui.type("正在写第二条");
    await afterFade();
    assert.equal(ui.component.draft, changed ? "正在写第二条" : "");
    // 结果这时候才回来:框里已经是清好的样子,它不该再动一次。
    ui.component.update({ edits: [{ id: "e1", text: "第一条", status: "applied" }], busy: false });
    assert.equal(ui.component.draft, changed ? "正在写第二条" : "");
  }
});

test("中文输入法确认和 Shift+Enter 不发送，普通 Enter 发送", async () => {
  let calls = 0;
  const ui = mount(async () => { calls++; }); ui.type("修改来源");
  ui.element.fire("keydown", { target: ui.input, key: "Enter", isComposing: true });
  ui.element.fire("keydown", { target: ui.input, key: "Enter", shiftKey: true });
  assert.equal(calls, 0);
  ui.element.fire("keydown", { target: ui.input, key: "Enter" }); await tick();
  assert.equal(calls, 1);
});

test("再次发送相同文字时，历史成功记录不能提前清空新草稿", async () => {
  let ui: ReturnType<typeof mount>;
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
