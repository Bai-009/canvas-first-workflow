/* 在 n8n 镜像里跑：节点 description 是导出数据，不在这里重新定义 n8n 契约。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('节点包元数据或实例必须是对象');
  return value;
}
const [directory, outFile] = process.argv.slice(2);
if (!directory || !outFile) {
  console.error('用法：node .build-tools/dump-n8n-nodes.mjs <节点包目录> <输出 JSON>');
  process.exit(1);
}
const pkgDir = resolve(directory);
const pkg = record(JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')));
const n8n = pkg.n8n == null ? {} : record(pkg.n8n);
const files: unknown = n8n.nodes ?? [];
if (!Array.isArray(files) || !files.every((file: unknown) => typeof file === 'string')) throw new Error('n8n.nodes 必须是文件路径数组');
interface Entry { file: string; description: unknown; versions?: Record<string, unknown>; currentVersion?: unknown }
const out: { package: unknown; version: unknown; count: number; failed: { file: string; error: string }[]; nodes: Entry[] } =
  { package: pkg.name, version: pkg.version, count: 0, failed: [], nodes: [] };
const require = createRequire(import.meta.url);
for (const rel of files) {
  try {
    const mod: unknown = require(join(pkgDir, rel));
    const Cls = Object.values(record(mod)).find(value => typeof value === 'function');
    if (!Cls) throw new Error('节点模块没有导出构造函数');
    const inst = record(Reflect.construct(Cls, []));
    const entry: Entry = { file: rel, description: inst.description };
    if (inst.nodeVersions) {
      entry.versions = {};
      for (const [version, implementation] of Object.entries(record(inst.nodeVersions))) {
        entry.versions[version] = record(implementation).description;
      }
      entry.currentVersion = inst.currentVersion;
    }
    out.nodes.push(entry);
    out.count++;
  } catch (error: unknown) {
    out.failed.push({ file: rel, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
  }
}
writeFileSync(outFile, JSON.stringify(out));
console.log(`${pkg.name}@${pkg.version}: ${out.count} 个节点导出, ${out.failed.length} 个失败`);
for (const failure of out.failed.slice(0, 5)) console.log('  失败:', failure.file, '-', failure.error);
