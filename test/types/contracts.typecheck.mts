import type { PlanProposal, Canvas, RevisionResult, StepResult } from '../../shared/contracts.mjs';
import { assembleTable } from '../../src/state-machine/step-context.mjs';
import { validatePlanProposal, isPlanProposal } from '../../src/plan/validate-plan-proposal.mjs';

declare const plan: PlanProposal;
declare const canvas: Canvas;
declare const incoming: unknown;
validatePlanProposal(incoming);
if (isPlanProposal(incoming)) assembleTable(incoming, 's1', { canvas });
assembleTable(plan, 's1', { canvas });
const unchanged: RevisionResult = { kind: 'unchanged', summary: '保持', review: [] };
void unchanged;
// @ts-expect-error patch 不能只带说明而缺少差量。
const missingDiff: RevisionResult = { kind: 'patch', summary: '修改', review: [] };
// @ts-expect-error 无需修改的结果不能偷偷携带画布变化。
const extraDiff: RevisionResult = { kind: 'unchanged', summary: '保持', review: [], removeNodes: ['s1'] };
// @ts-expect-error 构建 patch 必须包含节点和连线。
const missingNodes: StepResult = { kind: 'patch' };
// @ts-expect-error 未校验的外部数据不能直接成为已确认计划。
assembleTable(incoming, 's1', { canvas });
// @ts-expect-error readiness 仅接受 Schema 中定义的值。
const unsupported: PlanProposal['readiness'] = 'running';
void [missingDiff, extraDiff, missingNodes, unsupported];
