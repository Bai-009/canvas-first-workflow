import type { Listing } from './readers.mjs';
import { readListing } from './readers.mjs';
import { isRecord } from '../shared/json.mjs';
import { errorMessage } from '../shared/errors.mjs';
import { element } from './dom.mjs';
interface SidebarOptions { id: string; listing: Listing; onResize: () => void; onRetrySave: () => void | Promise<unknown> }
/* Hallmark · component: session navigation · existing Canvas theme
 * pre-emit critique: P4 H4 E4 S4 R5 V3 */
const esc = (text: unknown) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
const LAST = "canvasflow:last-session";
export const draftKey = (id: string) => `canvasflow:drafts:${id}`;
export const readLocal = (key: string, fallback = "") => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
export const writeLocal = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch {} };

export async function sessionRequest(path: string, { method = "GET", data }: { method?: string; data?: unknown } = {}) {
  const response = await fetch(path, { signal: AbortSignal.timeout(15000), method, headers: { "content-type": "application/json" }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result: unknown = await response.json();
  if (!isRecord(result)) throw new Error("会话响应格式不正确，请重试。");
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "会话操作未完成，请重试。");
  return result;
}
const loadSessions = async () => readListing(await sessionRequest("/api/sessions"));
const newSession = async (title?: string) => {
  const result = await sessionRequest("/api/sessions", { method: "POST", ...(title ? { data: { title } } : {}) });
  if (typeof result.id !== "string" || !result.id) throw new Error("会话编号无效，请重试。");
  return { id: result.id };
};
export async function chooseSession() {
  const listing = await loadSessions();
  const requested = new URLSearchParams(location.search).get("session") || readLocal(LAST);
  const current = listing.sessions.find((item) => item.id === requested) || listing.sessions[0]
    || { id: (await newSession()).id };
  const url = new URL(location.href);
  url.searchParams.set("session", current.id);
  history.replaceState(null, "", url);
  writeLocal(LAST, current.id);
  return { id: current.id, listing };
}

export function createSessionSidebar({ id, listing, onResize, onRetrySave }: SidebarOptions) {
  const root = element(document, "#sessions"), list = element(document, "#session-list");
  const retrySave = element(document, "#session-retry-save");
  const error = element(document, "#session-error"), toggle = element(document, "#sidebar-toggle");
  const trashToggle = element(document, "#session-trash");
  const dialog = element<HTMLDialogElement>(document, "#session-rename"), name = element<HTMLInputElement>(document, "#session-name");
  const dialogTitle = element(document, "#session-rename-title"), dialogError = element(document, "#session-name-error");
  const primary = element<HTMLButtonElement>(dialog, '[value="save"]');
  let submitting = false;
  let data = listing, trash = false, operating = false;
  let renaming: string | null = null;
  const collapsed = readLocal("canvasflow:sidebar", matchMedia("(max-width: 760px)").matches ? "closed" : "open") === "closed";
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  const navigate = (target: string) => { const url = new URL(location.href); url.searchParams.set("session", target); writeLocal(LAST, target); location.assign(url); };
  const message = (text: string) => { error.textContent = text; error.hidden = !text; };
  const render = () => {
    list.innerHTML = (trash ? data.trash : data.sessions).map((item) => `<div class="session-row"${item.id === id ? ' data-current="true"' : ''}>
      ${trash ? `<span class="session-link"><span>${esc(item.title)}</span></span><button class="session-restore" data-restore="${esc(item.id)}" aria-label="恢复 ${esc(item.title)}">恢复</button>` : `<a class="session-link" href="?session=${esc(item.id)}"${item.id === id ? ' aria-current="page"' : ''} title="${esc(item.title)}"><span>${esc(item.title)}</span>${item.turn !== "user" ? '<i class="session-working" aria-label="正在处理"></i>' : ''}</a>
      <details class="session-menu"><summary aria-label="管理 ${esc(item.title)}"><svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="10" r="1.1"/><circle cx="10" cy="10" r="1.1"/><circle cx="15" cy="10" r="1.1"/></svg></summary><div class="session-actions"><button data-rename="${esc(item.id)}">重命名</button><button data-delete="${esc(item.id)}">删除</button></div></details>`}
    </div>`).join("") || `<p class="session-empty">${trash ? "没有已删除的会话" : "从一条新工作流开始"}</p>`;
    element(document, "#session-list-title").textContent = trash ? "已删除" : "工作流";
    trashToggle.textContent = trash ? "返回工作流" : "已删除";
    if (data.warnings?.length) message(data.warnings.join("\n"));
    const current = data.sessions.find((item) => item.id === id);
    if (current) document.title = `${current.title} · CanvasFlow`;
  };
  async function act(operation: () => void | Promise<unknown>) {
    if (operating) return;
    operating = true; root.dataset.state = "loading"; root.setAttribute("aria-busy", "true");
    message("");
    try { await operation(); data = await loadSessions(); render(); root.dataset.state = "success"; }
    catch (e) { message(errorMessage(e)); root.dataset.state = "error"; }
    finally { operating = false; root.setAttribute("aria-busy", "false"); }
  }
  retrySave.addEventListener("click", () => act(onRetrySave));
  const openNameDialog = (target: string | null = null) => {
    if (operating || submitting) return;
    const current = target ? data.sessions.find((item) => item.id === target) : undefined;
    if (target && !current) return;
    renaming = target;
    dialogTitle.textContent = target ? "重命名工作流" : "新建工作流";
    primary.textContent = target ? "保存" : "创建";
    name.value = current?.title ?? "新工作流";
    name.setCustomValidity("");
    dialogError.hidden = true; dialogError.textContent = "";
    dialog.showModal(); name.focus(); name.select();
  };
  element(document, "#fresh").addEventListener("click", () => openNameDialog());
  toggle.addEventListener("click", () => {
    const closed = document.body.classList.toggle("sidebar-collapsed");
    toggle.setAttribute("aria-expanded", String(!closed)); writeLocal("canvasflow:sidebar", closed ? "closed" : "open"); onResize();
  });
  trashToggle.addEventListener("click", () => { trash = !trash; render(); });
  list.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest("a");
    if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); const target = new URL(link.href).searchParams.get("session"); if (target) navigate(target); }
    const button = event.target.closest("button");
    if (!button) return;
    const target = button.dataset.rename || button.dataset.delete || button.dataset.restore;
    if (!target) return;
    if (button.dataset.rename) {
      const menu = button.closest("details"); if (menu) menu.open = false;
      openNameDialog(target);
    } else if (button.dataset.delete) act(async () => {
      await sessionRequest(`/api/sessions/${target}`, { method: "DELETE" });
      if (target === id) {
        const next = (await loadSessions()).sessions[0];
        navigate(next?.id || (await newSession()).id);
      }
    });
    else act(async () => { await sessionRequest(`/api/sessions/${target}/restore`, { method: "POST" }); });
  });
  name.addEventListener("input", () => name.setCustomValidity(""));
  dialog.addEventListener("cancel", (event) => { if (submitting) event.preventDefault(); });
  element<HTMLFormElement>(dialog, "form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || operating) return;
    if (event.submitter instanceof HTMLButtonElement && event.submitter.value === "cancel") return dialog.close();
    const title = name.value.trim();
    if (!title) { name.setCustomValidity("请输入工作流名称"); name.reportValidity(); return; }
    submitting = true;
    dialog.setAttribute("aria-busy", "true");
    for (const control of dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")) control.disabled = true;
    dialogError.hidden = true;
    try {
      if (renaming) {
        await sessionRequest(`/api/sessions/${renaming}`, { method: "PATCH", data: { title } });
        dialog.close();
        await act(async () => {});
      } else {
        const created = await newSession(title);
        dialog.close(); navigate(created.id);
      }
    } catch (e) { dialogError.textContent = errorMessage(e); dialogError.hidden = false; }
    finally {
      submitting = false; dialog.setAttribute("aria-busy", "false");
      for (const control of dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")) control.disabled = false;
    }
  });
  document.addEventListener("click", (event) => { if (event.target instanceof Element && !event.target.closest(".session-menu")) for (const menu of list.querySelectorAll<HTMLDetailsElement>("details[open]")) menu.open = false; });
  render();
  return { update(next: Partial<Listing>) { if (next.sessions) { data = { ...data, ...next }; render(); } },
    left: () => document.body.classList.contains("sidebar-collapsed") || innerWidth <= 760 ? 0 : root.offsetWidth,
    saved(text: string, failed = false) { const el = element(document, "#session-save"); el.textContent = text; el.dataset.error = String(failed); retrySave.hidden = !failed; },
  };
}
