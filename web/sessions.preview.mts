import { element } from "./dom.mjs";
const states = ['default', 'hover', 'focus', 'active', 'disabled', 'loading', 'error', 'success'];
for (const state of states) {
    const block = document.createElement('section');
    block.className = 'sample';
    block.innerHTML = `<h2>${state}</h2><aside class="sessions" data-state="${state}" ${state === 'loading' ? 'aria-busy="true"' : ''}><div class="session-heading"><p class="session-label">工作流</p><button class="session-new" aria-label="新工作流" ${state === 'disabled' ? 'disabled' : ''}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10 4.5v11M4.5 10h11"/></svg></button></div><div class="session-row ${['hover', 'focus', 'active'].includes(state) ? 'is-' + state : ''}" ${state === 'success' ? 'data-current="true"' : ''}><a class="session-link" href="#"><span>合同金额工作流</span>${state === 'loading' ? '<i class="session-working" aria-label="正在处理"></i>' : ''}</a></div>${state === 'error' ? '<p class="session-error">保存失败，请重试</p>' : ''}${state === 'success' ? '<span class="session-save">已保存到本机</span>' : ''}</aside>`;
    element(document, '#samples').append(block);
}
