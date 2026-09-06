import { isRecord } from './json.mjs';

export interface DemoData {
  task: string;
  wfName: string;
  understanding: [string, string][];
  route: string[];
  asks: [string, string][];
  done: string;
  reply: string;
  after: { understanding: [string, string][]; route: string[]; answeredAsks: number[]; done: string };
}
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const pairs = (v: unknown): v is [string, string][] => Array.isArray(v) && v.every(x => strings(x) && x.length === 2);
function isDemoData(v: unknown): v is DemoData {
  return isRecord(v) && typeof v.task === 'string' && typeof v.wfName === 'string'
    && pairs(v.understanding) && strings(v.route) && pairs(v.asks) && typeof v.done === 'string' && typeof v.reply === 'string'
    && isRecord(v.after) && pairs(v.after.understanding) && strings(v.after.route) && typeof v.after.done === 'string'
    && Array.isArray(v.after.answeredAsks) && v.after.answeredAsks.every(x => Number.isInteger(x) && x >= 0);
}
export function readDemoData(value: unknown): DemoData {
  if (!isDemoData(value)) throw new Error('原型演示数据缺失或格式不正确，请先生成 plan-data.js');
  return value;
}
