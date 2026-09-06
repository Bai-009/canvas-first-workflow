import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Schema 路径必须指向对象');
  return value as Record<string, unknown>;
}
function at(root: unknown, path: string[]): Record<string, unknown> {
  return object(path.reduce<unknown>((value, key) => object(value)[key], root));
}

await mkdir('shared/generated', { recursive: true });
for (const [file, name] of Object.entries({ 'plan-proposal': 'PlanProposal', 'node-definition': 'NodeDefinition', 'step-submission': 'StepSubmission', 'workflow-revision': 'WorkflowRevision' })) {
  const schema = object(JSON.parse(await readFile(`contracts/${file}.schema.json`, 'utf8')));
  // JSON Schema 的纯描述字段不约束值；生成器默认将它误推为对象。
  // pattern 的 slot 前缀也需要保留，才能与共用流类型一致。
  if (file === 'node-definition') {
    const defaultValue = at(schema, ['$defs', 'slot', 'properties', 'default']);
    const variants = at(schema, ['properties', 'output', 'properties', 'adds']).anyOf;
    const slotReference = object(Array.isArray(variants) ? variants[1] : null);
    if (Object.keys(defaultValue).some((key) => key !== 'description') || slotReference.pattern !== '^slot:[a-z][a-zA-Z0-9]*$') {
      throw new Error('节点契约已改变，请同步检查生成类型的默认值与 slot 引用规则');
    }
    defaultValue.tsType = 'unknown';
    slotReference.tsType = '`slot:${string}`';
  }
  const source = await compile({ ...schema, title: name }, name, {
    unknownAny: true, unreachableDefinitions: true,
    bannerComment: '/* Generated from contracts/*.schema.json. Do not edit; run npm run contracts. */',
  });
  await writeFile(`shared/generated/${file}.d.mts`, source);
}
