import { element } from "./dom.mjs";
import type { EditView } from "./node-conversation.mjs";
import { createNodeConversation } from './node-conversation.mjs';
const cases = [['default', '默认'], ['hover', '悬停'], ['focus', '键盘聚焦'], ['active', '按下'], ['disabled', '等待其他操作'], ['loading', '修改中'], ['error', '修改未完成'], ['success', '修改完成']] as const;
for (const [kind, label] of cases) {
    const article = document.createElement('article');
    article.innerHTML = `<p>${label}</p><div class="demo-card"><h2 class="demo-name"><i aria-hidden="true">↳</i>解析合同文本</h2><p class="demo-context">Input · 合同文件<br>Output · Text · 按文件</p></div>`;
    element(document, '#states').append(article);
    const node = { name: '解析合同文本', step: 's2' };
    const c = createNodeConversation({ node, onSend: async () => { await new Promise(r => setTimeout(r, 500)); c.update({ edits: [{ id: 'demo', status: 'unchanged', text: '预览提交', summary: '这是手写演示，没有修改真实工作流。', changes: [], review: [] }] }); } });
    element(article, '.demo-card').append(c.el);
    const edits: EditView[] = kind === 'loading' ? [{ id: 'demo', status: 'processing', text: '保留每份合同的来源，并让入库带上这个字段。' }] : kind === 'error' ? [{ id: 'demo', status: 'failed', text: '保留每份合同的来源，并让入库带上这个字段。', error: '这次未能取得模型回复。你的修改文字还在，可以再次发送。' }] : kind === 'success' ? [{ id: 'demo', status: 'applied', text: '保留每份合同的来源，并让入库带上这个字段。', summary: '解析结果保留了来源，后面的字段抽取和入库也一起带上。', changes: ['解析合同文本', '提取合同字段', '写入合同表'], review: [{ step: 's1', summary: '读取文件的方式保持不变。' }, { step: 's2', summary: '解析结果增加来源信息。' }, { step: 's3', summary: '字段抽取保留来源信息。' }, { step: 's4', summary: '入库映射包含来源字段。' }] }] : [];
    c.update({ edits, busy: kind === 'disabled' || kind === 'loading' });
    if (!['default', 'loading', 'success'].includes(kind)) {
        const input = element<HTMLTextAreaElement>(c.el, 'textarea');
        input.value = '保留每份合同的来源，并让入库带上这个字段。';
        input.dispatchEvent(new Event('input'));
    }
    if (['hover', 'focus', 'active'].includes(kind))
        element(c.el, kind === 'focus' ? 'textarea' : '.nc-send').classList.add('is-' + kind);
}
