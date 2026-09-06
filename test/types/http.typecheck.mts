import type { WorkflowEvent } from '../../shared/http.mjs';
import { isSessionRecord } from '../../src/storage/session-record.mjs';
import { createSessionStore } from '../../src/storage/session-store.mjs';
declare const external: unknown;
const store = createSessionStore(null);
// @ts-expect-error 未检查的文件内容不能写成有效会话存档。
store.save(external);
if (isSessionRecord(external)) store.save(external);
// @ts-expect-error 前后端事件名必须来自统一约定。
const misspelled: WorkflowEvent = { type: 'configuerd', canvas: {} };
// @ts-expect-error 执行事件必须携带步骤和画布，不能只发一个完成标签。
const missingCanvas: WorkflowEvent = { type: 'step' };
void [misspelled, missingCanvas];
