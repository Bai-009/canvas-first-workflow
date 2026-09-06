import type { PlanProposal } from './generated/plan-proposal.mjs';
import type { NodeDefinition } from './generated/node-definition.mjs';
import type { StepSubmission } from './generated/step-submission.mjs';
import type { WorkflowRevision, Node as RevisionNode, Edge } from './generated/workflow-revision.mjs';

export type { PlanProposal, NodeDefinition, StepSubmission, WorkflowRevision, Edge, RevisionNode };
export type PlanStep = PlanProposal['steps'][number];
export type PlanQuestion = PlanProposal['openQuestions'][number];
export type SubmittedNode = NonNullable<StepSubmission['nodes']>[number];
export type CanvasNode = SubmittedNode & { step: string };
export interface Canvas { nodes: CanvasNode[]; edges: Edge[]; version: number }
export interface Annotation { step: string; text: string }
export interface Requirement { target: { node: string; step: string }; text: string }
export interface StepContext {
  plan: PlanProposal;
  step: PlanStep;
  canvas: Canvas;
  openQuestions: PlanQuestion[];
  instructions: string[];
  requirements?: Requirement[];
}
// Schema 的信封约束之外，现有状态机还要求 patch 必须带齐节点与线。
export type StepResult = { kind: 'covered' } | { kind: 'patch'; nodes: CanvasNode[]; edges: Edge[] };
// 从生成类型取字段，补全 oneOf 生成器无法精确表达的必填差量关联。
type RevisionBase = Pick<WorkflowRevision, 'summary' | 'review'>;
export type RevisionResult = RevisionBase & (
  | { kind: 'patch'; upsertNodes: RevisionNode[]; removeNodes: string[]; addEdges: Edge[]; removeEdges: Edge[] }
  | { kind: 'unchanged' | 'needs_plan'; upsertNodes?: never; removeNodes?: never; addEdges?: never; removeEdges?: never }
);
