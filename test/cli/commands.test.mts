import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectRoot } from '../../src/runtime-paths.mjs';
import type { PlanProposal } from '../../shared/contracts.mjs';

function command(entry: string, args: string[] = [], input = '', extra: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(projectRoot, 'dist/src/cli', entry), ...args], {
      cwd: projectRoot,
      env: { ...process.env, MODEL_BASE_URL: 'http://model.invalid/v1', MODEL_API_KEY: 'test-only', MODEL_NAME: 'demo',
        EXECUTOR_MODULE: 'fixtures/doubles/fixed-executor.mjs', ...extra },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('命令行帮助、空画布和错误参数可从编译入口运行', async () => {
  const chat = await command('plan-chat.mjs', [], '/help\n/canvas\n');
  assert.equal(chat.code, 0, chat.stderr);
  assert.match(chat.stdout, /画布 v0 · 空的/);
  assert.match(chat.stdout, /fixed-executor.mjs/);
  const missing = await command('executor-step.mjs');
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /用法/);
});

test('单步命令读取计划，经本地固定模型完成门禁并保存实录', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan: PlanProposal = { readiness: 'ready', goal: '读取文件', understanding: [], openQuestions: [],
    steps: [{ ref: 's1', title: '读取', intent: '读取文件', input: '文件夹', output: '文件', dependsOn: [] }] };
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  let calls = 0;
  const submission = { kind: 'patch', nodes: [{ name: '读文件', type: 'readFile', params: { folder: '/demo' }, blanks: [] }], edges: [] };
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'one', type: 'function', function: { name: 'submit_step', arguments: JSON.stringify(submission) } }] } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const outcome = await command('executor-step.mjs', ['--plan', join(dir, 'plan.json'), '--step', 's1', '--save', join(dir, 'trace')], '',
    { MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1` });
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(calls, 1);
  assert.match(outcome.stdout, /1 个回合交了/);
  assert.match(readFileSync(join(dir, 'trace', 'patch.json'), 'utf8'), /"step": "s1"/);
});
