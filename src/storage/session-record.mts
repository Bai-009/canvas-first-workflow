import { string, integer, optional, array, isCanvas, isRun, isEdit, isAnnotation, oneOf } from '../../shared/workflow-shape.mjs';
export { isCanvas } from '../../shared/workflow-shape.mjs';
import type { WorkflowState } from '../../shared/workflow.mjs';
import type { SessionRecord, Presentation, ChatLine } from '../../shared/http.mjs';
import { isRecord } from '../../shared/json.mjs';
import { isMessage } from '../model/model-response.mjs';
import { isPlanProposal } from '../plan/validate-plan-proposal.mjs';

export function isWorkflowState(value: unknown): value is WorkflowState {
  return isRecord(value) && value.formatVersion === 1 && isRecord(value.plan)
    && array(value.plan.transcript, isMessage) && array(value.plan.versions, isPlanProposal)
    && isCanvas(value.canvas) && array(value.annotations, isAnnotation) && array(value.runs, isRun) && array(value.edits, isEdit)
    && (value.canvasPlanRevision === null || integer(value.canvasPlanRevision))
    && (value.activeRun === null || isRun(value.activeRun)) && oneOf(value.turn, ['user', 'plan', 'executor', 'revision']);
}
function isChatLine(value: unknown): value is ChatLine {
  return isRecord(value) && (value.who === 'user' || value.who === 'agent') && string(value.text);
}
function isPresentation(value: unknown): value is Presentation {
  return isRecord(value) && optional(value.task, string) && optional(value.speech, string)
    && (value.chat === undefined || array(value.chat, isChatLine));
}

// 只检查存档可被安全读取的形状。部分构建、留空参数和历史元数据原样保留；不要求画布已经完成。
export function isSessionRecord(value: unknown): value is SessionRecord {
  return isRecord(value) && value.formatVersion === 1 && string(value.id) && /^[a-zA-Z0-9-]{1,80}$/.test(value.id)
    && string(value.updatedAt) && optional(value.createdAt, string) && optional(value.title, string)
    && (value.renamed === undefined || typeof value.renamed === 'boolean')
    && (value.deletedAt == null || string(value.deletedAt)) && optional(value.notice, string)
    && (value.presentation === undefined || isPresentation(value.presentation)) && isWorkflowState(value.workflow);
}
