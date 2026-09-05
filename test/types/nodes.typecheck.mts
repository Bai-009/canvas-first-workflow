import type { NodeDefinition } from '../../shared/contracts.mjs';
import { isNodeDefinition } from '../../src/nodes/node-table.mjs';
import { flows } from '../../shared/flow.mjs';

type Slot = NodeDefinition['slots'][number];
// 默认值的契约没有限制 JSON 值的种类，不能误生成为仅允许对象。
const count: Slot = { key: 'size', label: 'Size', kind: 'number', default: 500 };
const model: Slot = { key: 'model', label: 'Model', kind: 'pick', options: ['Demo'], default: 'Demo' };
const flag: Slot = { key: 'flag', label: 'Flag', kind: 'text', default: false };
const empty: Slot = { key: 'empty', label: 'Empty', kind: 'text', default: null };
// @ts-expect-error 不属于固定种类、也没有 slot: 前缀的输出不能进入数据流约定。
const wrong: NodeDefinition['output'] = { adds: 'unsupported', per: '文件' };
declare const external: unknown;
if (isNodeDefinition(external)) flows([external], { nodes: [], edges: [] });
void [count, model, flag, empty, wrong];
