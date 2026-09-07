import type { Edit } from '../shared/workflow.mjs';
import { errorMessage } from '../shared/errors.mjs';
import { element, motionMs } from './dom.mjs';

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export type EditView = Pick<Edit, 'status'> & Partial<Pick<Edit, 'id' | 'text' | 'summary' | 'error' | 'reasons' | 'changes' | 'review'>>;
interface TargetNode { name: string; step: string }
interface ConversationState<N> { node: N; edits: EditView[]; busy: boolean; blockedReason: string }
interface ConversationOptions<N> {
  node: N;
  onSend?: (request: { node: N; text: string }) => void | Promise<unknown>;
  onStop?: () => void | Promise<unknown>;
  onResize?: () => void;
  initialDraft?: string;
  onDraftChange?: (text: string) => void;
}
/* Hallmark · component: node conversation · existing Canvas theme
 * pre-emit critique: P4 H4 E4 S5 R5 V3
 * The input owns its DOM for its whole lifetime; canvas snapshots only update its surroundings. */
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
export const isEditing = (edit?: EditView | null) => edit?.status === "processing" || edit?.status === "checking";
const STATES: Record<Edit["status"], readonly [string, string]> = {
  processing: ["正在修改", "正在结合整条工作流修改"],
  checking: ["正在检查", "正在检查整条工作流的修改"],
  applied: ["已修改", "修改已应用"],
  unchanged: ["无需修改", "本次没有修改画布"],
  needs_plan: ["需完善方案", "这次需要先完善整体方案"],
  failed: ["修改未完成", "修改未完成，画布保持原样"],
  stopped: ["已停止", "已停止修改，画布保持原样"],
};
export function editPresentation(edit?: EditView | null) {
  const [badge, title] = (edit ? STATES[edit.status] : undefined) ?? ["", ""];
  return { badge, title, working: isEditing(edit), error: edit?.status === "failed" };
}
export function editResultHtml(edit?: EditView | null) {
  if (!edit) return "";
  const { title, working } = editPresentation(edit);
  const changes = [...new Set(edit.changes ?? [])];
  return `<details class="nc-history"><summary><span class="nc-status-mark" aria-hidden="true">${working ? "" : edit.status === "applied" ? "✓" : "·"}</span><span class="nc-result-title">${esc(title)}</span><span class="nc-result-hint">查看</span></summary><div class="nc-detail-body">`
    + (edit.text ? `<p class="nc-request">${esc(edit.text)}</p>` : "")
    + (edit.summary && !working ? `<p class="nc-summary">${esc(edit.summary)}</p>` : "")
    + (edit.error ? `<p class="nc-error-text">${esc(edit.error)}</p>` : "")
    + (edit.reasons?.length ? `<ul class="nc-reasons">${edit.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "")
    + (changes.length ? `<p class="nc-changes"><span>实际变化</span>${changes.map(esc).join("、")}</p>` : "")
    + (edit.review?.length ? `<div class="nc-review"><p>全部步骤的影响 · Agent 说明</p><dl>${edit.review.map((r) => `<div><dt>${esc(r.step)}</dt><dd>${esc(r.summary)}</dd></div>`).join("")}</dl></div>` : "")
    + `</div></details>`;
}
let nextId = 0;
export function createNodeConversation<N extends TargetNode>({ node, onSend, onStop, onResize = () => {}, initialDraft = "", onDraftChange = () => {} }: ConversationOptions<N>) {
  const id = `node-message-${++nextId}`;
  const el = document.createElement("section");
  el.className = "node-conversation";
  el.innerHTML = `<div class="nc-results" aria-live="polite" aria-atomic="false"></div>
    <form class="nc-form"><div class="nc-compose">
    <textarea id="${id}" class="nc-input" rows="1" aria-label="修改这个节点" placeholder="说说这里想怎么改…" aria-describedby="${id}-help"></textarea>
    <div class="nc-foot"><button class="nc-stop" type="button" aria-label="停止修改" title="停止修改" hidden><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor"/></svg></button><button class="nc-send" type="submit" aria-label="发送修改"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m-4 4 4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div></div><p class="nc-help" id="${id}-help" hidden></p></form>`;
  const input = element<HTMLTextAreaElement>(el, ".nc-input"), send = element<HTMLButtonElement>(el, ".nc-send"), stop = element<HTMLButtonElement>(el, ".nc-stop");
  input.value = initialDraft;
  const help = element(el, ".nc-help"), results = element(el, ".nc-results");
  let state: ConversationState<N> = { node, edits: [], busy: false, blockedReason: "" };
  let sending = false, stopping = false, localError = "", resultKey = "";
  let sent: { text: string; after: string | undefined } | null = null;
  const refresh = () => {
    const latest = state.edits.at(-1);
    const working = isEditing(latest);
    const failed = Boolean(localError) || latest?.status === "failed";
    el.dataset.state = working || sending ? "loading" : failed ? "error" : latest?.status === "applied" ? "success" : "default";
    results.dataset.state = el.dataset.state;
    send.disabled = sending || Boolean(state.busy) || Boolean(state.blockedReason) || !input.value.trim();
    send.setAttribute("aria-disabled", String(send.disabled));
    stop.hidden = !working;
    stop.disabled = stopping;
    stop.setAttribute("aria-label", stopping ? "正在停止修改" : "停止修改");
    stop.title = stopping ? "正在停止…" : "停止修改";
    send.hidden = working;
    const reason = localError || state.blockedReason || "";
    help.textContent = reason;
    help.hidden = !reason;
    help.classList.toggle("nc-error-text", Boolean(localError));
    input.setAttribute("aria-invalid", String(Boolean(localError)));
    send.title = state.blockedReason || (state.busy ? "等待当前操作完成后发送" : !input.value.trim() ? "写下修改后发送" : "发送工作流修改");
  };
  const fitInput = () => {
    if (!input.style) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(120, Math.max(44, input.scrollHeight))}px`;
  };
  /* 发出去的那一下不能是「凭空没了」:字先往上抬一点淡掉,走干净了框再收回一行。
     跟画布下方那个输入框是同一个动作,时长也读同一处样式。
     收高度得临时把数写死,只活到这段过渡;发失败要作废这一次收拢,字原样留着。 */
  const compose = element(el, ".nc-compose");
  let clearing = 0;
  const settleInput = () => { compose.classList.remove("sending", "closing"); fitInput(); };
  async function clearInput(draft: string) {
    const mine = ++clearing;
    // 到发送这一刻再读:模块刚加载那会儿样式不一定已经生效。
    const FADE = motionMs("--send-fade", 130), CLOSE = motionMs("--send-close", 260);
    const before = input.offsetHeight;
    compose.classList.add("sending");
    await wait(FADE);
    if (mine !== clearing) return;
    // 字淡出的这一小会儿人又改了内容,那是他的新话,不许清。
    if (input.value !== draft) return settleInput();
    input.value = ""; onDraftChange(""); fitInput();
    compose.classList.remove("sending");
    const after = input.offsetHeight;
    if (after !== before) {
      input.style.height = `${before}px`;
      compose.classList.add("closing");
      /* 起点得先在浏览器那儿落地,不然两个高度同一拍写完,它只看见终点、不过渡。
         读一下高度就逼它把上一行算完——不等下一帧:页面在后台时帧是不来的。 */
      void input.offsetHeight;
      input.style.height = `${after}px`;
      await wait(CLOSE);
    }
    if (mine === clearing) settleInput();
    onResize();
  }
  function restoreInput(draft: string) {
    clearing++;
    compose.classList.remove("sending", "closing");
    if (input.value) return;
    input.value = draft; onDraftChange(draft); fitInput(); onResize();
  }
  const submit = async () => {
    if (send.disabled) return;
    const text = input.value.trim();
    const draft = input.value;
    sending = true; localError = ""; sent = { text, after: state.edits.at(-1)?.id };
    void clearInput(draft);   // 不等它:请求这一刻就出去,收拢是画面上的事
    refresh();
    try { await onSend?.({ node: state.node, text }); }
    catch (error) {
      localError = errorMessage(error) || "发送失败，请重试。"; sent = null;
      restoreInput(draft);
    }
    finally { sending = false; refresh(); onResize(); }
  };
  el.addEventListener("click", (event) => event.stopPropagation());
  results.addEventListener("click", (event) => event.stopPropagation());
  results.addEventListener("pointerdown", (event) => event.stopPropagation());
  results.addEventListener("keydown", (event) => event.stopPropagation());
  el.addEventListener("pointerdown", (event) => event.stopPropagation());
  el.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
  el.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.target === input && event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
  });
  element<HTMLFormElement>(el, "form").addEventListener("submit", (event) => { event.preventDefault(); submit(); });
  input.addEventListener("input", () => {
    // 上一句还在收尾就按住高度,正在打字的框会长不起来——手一碰就把高度还回去。
    compose.classList.remove("sending", "closing");
    localError = ""; onDraftChange(input.value); fitInput(); refresh(); onResize();
  });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(onResize).observe(input);
  stop.addEventListener("click", async () => {
    if (stopping) return;
    stopping = true; localError = ""; refresh();
    try { await onStop?.(); } catch (error) { localError = errorMessage(error) || "未能停止，请重试。"; }
    finally { stopping = false; refresh(); onResize(); }
  });
  refresh();
  return {
    el,
    resultsEl: results,
    update(next: Partial<ConversationState<N>>) {
      state = { ...state, ...next };
      const latest = state.edits.at(-1);
      // 送出去时已经清空了,这里只是把「这一交有回音了」记下来。
      if (sent && latest?.id !== sent.after && latest?.text === sent.text && ["applied", "unchanged"].includes(latest.status)) sent = null;
      const key = JSON.stringify(state.edits);
      if (key !== resultKey) {
        const open = results.querySelector<HTMLDetailsElement>(".nc-history")?.open;
        results.innerHTML = editResultHtml(latest);
        const history = results.querySelector<HTMLDetailsElement>(".nc-history");
        if (open && history) history.open = true;
        results.querySelector("details")?.addEventListener("toggle", onResize);
        results.hidden = !latest;
        resultKey = key;
      }
      fitInput();
      refresh();
    },
    get draft() { return input.value; },
  };
}
