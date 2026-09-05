import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readDemoData } from '../../shared/demo-data.mjs';

function fixture() {
  const source = readFileSync(new URL('../../prototype/plan-data.js', import.meta.url), 'utf8');
  const prefix = 'window.PLAN_DATA = ';
  assert.ok(source.includes(prefix));
  const value: unknown = JSON.parse(source.slice(source.indexOf(prefix) + prefix.length).trim().replace(/;$/, ''));
  return readDemoData(value);
}
test('生成的演示数据可被原型读取，保留两轮理解、路线与已回答问题', () => {
  const data = fixture();
  assert.equal(data.route.length, 4);
  assert.equal(data.after.route.length, 4);
  assert.equal(data.understanding.length, 4);
  assert.equal(data.after.understanding.length, 6);
  assert.deepEqual(data.after.answeredAsks, [0, 1]);
});
test('原型拒绝不完整的演示数据，不能带着缺列或错误路线开始播放', () => {
  const data = fixture();
  assert.throws(() => readDemoData(undefined), /数据缺失/);
  assert.throws(() => readDemoData({ ...data, understanding: [['缺少解读']] }), /格式不正确/);
  assert.throws(() => readDemoData({ ...data, after: { ...data.after, route: [42] } }), /格式不正确/);
});
