import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRecord } from '../../shared/http.mjs';
import { createWorkflowSession } from '../../src/state-machine/workflow-session.mjs';
import { createSessionStore } from '../../src/storage/session-store.mjs';

test('读取存档保留额外元数据，嵌套损坏原文件保留并返回警告', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-record-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workflow = createWorkflowSession({ callModel: async () => ({ role: 'assistant', content: '' }) }).exportState();
  const record: SessionRecord & { migration: { from: string } } = {
    formatVersion: 1, id: 'valid', updatedAt: new Date().toISOString(), workflow,
    migration: { from: 'original-demo' }, presentation: { chat: [] },
  };
  const store = createSessionStore(dir);
  store.save(record);
  const broken = JSON.stringify({ ...record, id: 'broken', workflow: { ...workflow, canvas: { version: 0, edges: [], nodes: [null] } } });
  writeFileSync(join(dir, 'broken.json'), broken);
  assert.deepEqual(store.load(), [record]);
  assert.equal(store.warnings.length, 1);
  assert.match(store.warnings[0] ?? '', /broken.json.*原文件已保留/);
  assert.equal(readFileSync(join(dir, 'broken.json'), 'utf8'), broken);
  assert.equal(readFileSync(join(dir, 'valid.json'), 'utf8'), JSON.stringify(record));
});
