import { createCanvasView } from "./canvas.mjs";
import { createPlanCard } from "./plan-card.mjs";

const $ = (id) => document.getElementById(id);
const table = await fetch("/api/node-table").then((r) => r.json());

const view = createCanvasView({
  table, world: $("world"), wires: $("wires"), viewport: $("viewport"),
  stage: $("stage"), picker: $("picker"),
  /* 右上角的需求框占掉一条,卡片不能钻到它下面。 */
  insets: () => ({
    right: card.isMini ? 360 : 0,
    bottom: innerHeight - document.querySelector(".bar").getBoundingClientRect().top + 24,
  }),
});
const card = createPlanCard({ card: $("plan"), stage: $("stage") });

const post = (path, data) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data ?? {}) })
    .then((r) => r.json());

let plan = null;
let busy = null;
/* 停在哪一步、为什么。停着的时候输入框接的是那一步的执行者,不是 Plan Agent——
   Plan Agent 看不见画布,跟它说「这里少了一条线」它无从改起。 */
let broke = null;
const done = new Set();

const titleOf = (ref) => plan?.steps.find((s) => s.ref === ref)?.title ?? ref;
/* 闸门说的是编号,画布上写的是名字。同一件事两个叫法,读的人得在心里换算一遍。 */
const named = (text) => String(text ?? "").replace(/\bs\d+\b/g, (ref) => titleOf(ref));

/* 这一趟停在哪儿。跑完了、或者最后那一步是做完/已经有了,就是没停。 */
function stopAt(run) {
  if (!run || run.endedBy === "finished") return null;
  const last = run.steps.at(-1);
  if (!last || last.outcome === "done" || last.outcome === "covered") return null;
  /* 闸门退几条就是几条,一条一行。只给第一条的话,人按它改了、重走,撞第二条。 */
  const whys = last.reasons ?? (last.error ? [last.error] : last.outcome === "stopped" ? ["按了停"] : []);
  return { ref: last.ref, why: whys.map(named).join("\n") };
}

/* 手上有东西的时候才给「新建」:空画布上没什么可以重开的。 */
let started = false;
const canReset = () => ($("fresh").hidden = !started);

/* 停了:那一格上摆一张卡,写清哪一步、为什么、能做什么。输入框跟着改口。 */
function showBreak() {
  placeholder();
  if (!broke) return;
  view.waiting({ title: titleOf(broke.ref), note: broke.why, remaining: 0, broken: true });
}

/* 输入框对谁说,看中央开着什么:方案卡摊在中央就对方案说;方案卡收在角上、画布上有断口,
   才对停住的那一步说。同一个框,收信人由位置定,不由一个看不见的状态定。 */
const toStep = () => Boolean(broke) && card.isMini;

/* 输入框的提示按阶段换:没方案时说要什么,有待确认时先答它,答完了就是改。 */
function placeholder() {
  const el = $("input");
  if (toStep()) el.placeholder = `告诉「${titleOf(broke.ref)}」该怎么改，发出去就从这一步重走`;
  else if (!plan) el.placeholder = "描述你要做的数据处理";
  else if (plan.openQuestions.length) el.placeholder = "回答上面待确认的问题";
  else el.placeholder = "还想改点什么";
}

/* 轨道上那一行字:当下这一步的名字;后面还剩几步决定线有多长。 */
const waitingOn = (refs) => ({
  title: refs.map((ref) => plan?.steps.find((s) => s.ref === ref)?.title ?? ref).join("、"),
  remaining: plan ? plan.steps.filter((s) => !done.has(s.ref)).length : refs.length,
});

const canSend = () => $("input").value.trim() !== "" && !busy;
const refreshSend = () => ($("send").disabled = !canSend());

/* 输入框跟着字长高:把同一段字抄给那个隐形的替身,高度归 CSS 算。
   这里不量任何东西——量出来的数会过期,替身不会。 */
const grow = () => { $("grow").dataset.value = $("input").value; };

async function send() {
  if (!canSend()) return;
  const text = $("input").value.trim();
  $("input").value = "";
  grow();
  refreshSend();
  /* 对着断口说的话不给 Plan Agent:挂到停住的那一步上,再从那一步重走。
     已经做完的几步会说「已经有了」,只有这一步重做。 */
  if (toStep()) {
    const at = broke.ref;
    const r = await post("/api/note", { step: at, text });
    if (r.error) return card.status(r.error);
    return rerun();
  }
  if (card.isMini) await card.toCenter();
  started = true;
  canReset();
  card.ask(text);
  const r = await post("/api/say", { text });
  if (r.error) card.status(r.error);
}

/* 从停住的地方接着走。断口先撤掉,不然它会一直挂在画布上。 */
async function rerun() {
  broke = null;
  showBreak();
  view.waiting(null);
  done.clear();
  const r = await post("/api/start");
  if (r.error) return card.status(r.error);
  card.status("正在生成");
}

/* 发送:按钮和回车都行。Shift+回车换行,中文输入法确认候选词的那一下回车不算发送。 */
$("input").addEventListener("input", () => { grow(); refreshSend(); });
$("input").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  send();
});
$("form").addEventListener("submit", (e) => { e.preventDefault(); send(); });

/* 卡片飞走或飞回来,右边空出来的那一条变了,镜头跟着重新放一次。 */
card.onGo(async () => {
  done.clear();
  broke = null;
  showBreak();
  const r = await post("/api/start");
  if (r.error) return card.status(r.error);
  await card.toMini("正在生成");
  view.fit();
});
card.onClose(async () => { await card.back(); view.fit(); placeholder(); });
/* 新建:这一条清掉,画布空出来,重新说一句。 */
$("fresh").addEventListener("click", () => post("/api/reset"));
/* 断口那张卡上的三个选择:改这一步(光标落到输入框,它已经写着「告诉『这一步』该怎么改」)、
   改方案(交给设计者)、重走。 */
view.onBreak({
  rerun,
  talk: () => $("input").focus(),
  plan: async () => { const r = await post("/api/escalate"); if (r.error) card.status(r.error); },
});
$("plan").addEventListener("click", async () => {
  if (!card.isMini) return;
  await card.toCenter();
  view.fit();
  placeholder();
});
/* 同一条规矩:方案卡摊在中央的时候,点它外面就收回右上角。
   两处不算「外面」——收得回去才收(「收起」亮着才有右上角那个位置可回,
   不然人就被丢在一张空画布上),以及输入框:那儿写着「回答上面待确认的问题」,
   一点输入框就把「上面」收走,说不通。 */
addEventListener("click", async (e) => {
  if (card.isMini || e.target.closest(".plan") || e.target.closest(".picker")) return;
  if (e.target.closest(".bar") || $("plan").querySelector(".plan-close").hidden) return;
  await card.back();
  view.fit();
  placeholder();
});

/* ?still 只看现在这一眼,不挂长连接——截图工具等不到一个不断线的页面。 */
const still = new URLSearchParams(location.search).has("still");
const feed = still ? {} : new EventSource("/api/events");
feed.onmessage = async (e) => {
  const event = JSON.parse(e.data);
  if (event.type === "reset") return location.reload();
  /* 画布替人说的那句(断口交给设计者):跟人自己打的一句走一样的路——先上墙,再等回话。 */
  if (event.type === "said") {
    if (card.isMini) await card.toCenter();
    started = true;
    canReset();
    placeholder();
    return card.ask(event.text);
  }
  if (event.type === "draft") return card.draft(event);
  if (event.type === "thinking") { busy = event.who; refreshSend(); }
  /* 这一波要做哪几步,写到画布上——等着的人得知道当下在做什么。 */
  if (event.type === "wave") view.waiting(waitingOn(event.refs));
  if (event.type === "plan") {
    busy = null;
    plan = event.plan;
    refreshSend();
    placeholder();
    card.show(event);
  }
  if (event.type === "step") {
    done.add(event.step.ref);
    view.draw(event.canvas);
    card.status(`正在生成 · ${done.size} / ${plan?.steps.length ?? done.size}`);
  }
  if (event.type === "run") {
    busy = null;
    refreshSend();
    view.draw(event.canvas);
    view.waiting(null);
    broke = stopAt(event.run);
    /* 收场的话等卡全落地了再说:还在落的时候报「已生成 9 个」,画布上只有 4 张。
       断了就把断口和理由留在画布上,不弹东西。 */
    view.onIdle(() => {
      card.status(broke ? `停在 ${titleOf(broke.ref)}` : `已生成 ${event.canvas.nodes.length} 个节点`);
      showBreak();
    });
  }
  if (event.type === "error") { busy = null; refreshSend(); view.waiting(null); card.status(event.message); }
};

const state = await fetch("/api/state").then((r) => r.json());
plan = state.plan;
started = Boolean(state.task || state.plan || state.canvas.nodes.length);
canReset();
placeholder();
/* 生成到一半刷新页面,状态不能丢:还在跑就把那一格重新摆回画布上。 */
if (state.turn === "executor" && state.wave) {
  card.restore(state, "正在生成");
  for (const s of state.canvas.nodes) done.add(s.step);
  view.waiting(waitingOn(state.wave));
  view.draw(state.canvas, { instant: true });
  view.fit();
} else if (state.canvas.nodes.length || stopAt(state.run)) {
  /* 刷新回来也得知道停在哪儿、为什么:这几样原来只走 SSE,刷一下就没了。 */
  broke = stopAt(state.run);
  card.restore(state, broke ? `停在 ${titleOf(broke.ref)}` : `已生成 ${state.canvas.nodes.length} 个节点`);
  /* 断口先挂上再画:先画再挂的话镜头要摆两次,第二次是有过渡的,
     刷新回来会看见画面自己晃一下。 */
  showBreak();
  view.draw(state.canvas, { instant: true });
} else if (state.task) {
  card.ask(state.task);
  await card.show(state);
}
if (!state.hasExecutor) card.status("执行者未接入:启动时设置 EXECUTOR_MODULE。");
addEventListener("resize", () => { view.fit(); card.reflow(); });
