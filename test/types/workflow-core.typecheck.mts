import type { RevisionContext, Executor } from '../../shared/workflow.mjs';
import type { StepResult, StepContext } from '../../shared/contracts.mjs';
import { readRevision } from '../../src/state-machine/workflow-revision.mjs';
import { isStepResult } from '../../src/state-machine/workflow-session.mjs';

declare const incoming: unknown;
declare const context: RevisionContext;
const checked = readRevision(incoming, context);
if (!checked.ok) {
  // @ts-expect-error 检查失败不能获得可提交画布。
  checked.candidate;
} else if (checked.kind === 'patch') {
  checked.candidate.nodes;
  checked.result.upsertNodes;
} else {
  // @ts-expect-error 说明性结果没有候选画布。
  checked.candidate;
}
const withoutEdges: StepResult = { kind: 'patch', nodes: [] };
declare const stepContext: StepContext;
if (isStepResult(incoming, stepContext.step, stepContext.canvas) && incoming.kind === 'patch') {
  incoming.nodes.map((node) => node.name);
}
declare const externalExecutor: Executor;
const result = await externalExecutor(stepContext);
// @ts-expect-error 即使调用接口已有类型，可替换执行者的输出仍需门禁检查。
result.nodes;
void withoutEdges;
