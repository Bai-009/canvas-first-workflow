import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';

await mkdir('shared/generated', { recursive: true });
for (const [file, name] of Object.entries({ 'plan-proposal': 'PlanProposal', 'node-definition': 'NodeDefinition', 'step-submission': 'StepSubmission', 'workflow-revision': 'WorkflowRevision' })) {
  const schema = JSON.parse(await readFile(`contracts/${file}.schema.json`, 'utf8'));
  const source = await compile({ ...schema, title: name }, name, {
    unknownAny: true, unreachableDefinitions: true,
    bannerComment: '/* Generated from contracts/*.schema.json. Do not edit; run npm run contracts. */',
  });
  await writeFile(`shared/generated/${file}.d.mts`, source);
}
