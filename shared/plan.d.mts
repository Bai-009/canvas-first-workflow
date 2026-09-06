type DraftRow<K extends string> = Record<string, unknown> & Record<K, string>;
export interface DraftPlan {
  goal: string;
  readiness: unknown;
  understanding: DraftRow<'ref' | 'quote' | 'reading'>[];
  steps: DraftRow<'ref' | 'title'>[];
  openQuestions: DraftRow<'ref' | 'question'>[];
}
export interface PlanDraft { speech: string; plan: DraftPlan | null; phase: 'writing' | 'thinking' }
export interface SectionDiff { kept: string[]; changed: string[]; added: string[]; removed: string[] }
export type PlanDiff = Record<'understanding' | 'steps' | 'openQuestions', SectionDiff>;
