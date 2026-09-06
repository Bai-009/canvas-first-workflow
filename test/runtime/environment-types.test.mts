import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { join } from 'node:path';
import { projectRoot } from '../../src/runtime-paths.mjs';

function inspect(config: string, directory: string, source: string) {
  const path = join(projectRoot, config);
  const read = ts.readConfigFile(path, ts.sys.readFile);
  assert.equal(read.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, projectRoot);
  assert.deepEqual(parsed.errors, []);
  const fixture = join(projectRoot, directory, '__environment_probe__.mts');
  const host = ts.createCompilerHost(parsed.options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, language, onError, create) => file === fixture
    ? ts.createSourceFile(file, source, language, true)
    : original(file, language, onError, create);
  const program = ts.createProgram([...parsed.fileNames, fixture], parsed.options, host);
  const errors = ts.getPreEmitDiagnostics(program).filter(d => d.category === ts.DiagnosticCategory.Error);
  return { errors, fixture, files: program.getSourceFiles().map(f => f.fileName) };
}

test('浏览器工程没有 Node 全局，process、Buffer、require 均被检查器拒绝', () => {
  const result = inspect('tsconfig.browser.json', 'web', 'process.env.KEY;\nBuffer.from("x");\nrequire("fs");\ndocument.title = "allowed";');
  assert.equal(result.errors.length, 3, ts.formatDiagnosticsWithColorAndContext(result.errors, {
    getCanonicalFileName: f => f, getCurrentDirectory: () => projectRoot, getNewLine: () => '\n',
  }));
  assert.ok(result.errors.every(d => d.file?.fileName === result.fixture));
  assert.ok(!result.files.some(f => f.includes('/@types/node/')));
});

test('浏览器显式导入 Node 内置模块也不能绕过检查', () => {
  const result = inspect('tsconfig.browser.json', 'web', 'import { readFileSync } from "node:fs";\nimport { env } from "process";\nvoid import("node:path");\nvoid [readFileSync, env];');
  assert.equal(result.errors.length, 3);
  assert.ok(result.errors.every(d => d.file?.fileName === result.fixture));
});

test('后端工程允许文件与环境变量，但没有 DOM 全局', () => {
  const result = inspect('tsconfig.server.json', 'src', 'import { readFileSync } from "node:fs";\nvoid [readFileSync, process.env.KEY];\ndocument.title = "forbidden";\nwindow.alert("forbidden");');
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every(d => d.file?.fileName === result.fixture));
  assert.ok(!result.files.some(f => /lib\.dom(?:\.iterable)?\.d\.ts$/.test(f)));
});
