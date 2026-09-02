/* 在 n8n 镜像里跑:把两个节点包里每个节点的 description 原样导出成 JSON。
   分版本的节点(VersionedNodeType)把每个版本的 description 都带上。 */
const fs = require("fs");
const path = require("path");
const [pkgDir, outFile] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const files = pkg.n8n && pkg.n8n.nodes ? pkg.n8n.nodes : [];
const out = { package: pkg.name, version: pkg.version, count: 0, failed: [], nodes: [] };
for (const rel of files) {
  const file = path.join(pkgDir, rel);
  try {
    const mod = require(file);
    const Cls = Object.values(mod).find((v) => typeof v === "function");
    const inst = new Cls();
    const entry = { file: rel, description: inst.description };
    if (inst.nodeVersions) {
      entry.versions = {};
      for (const [v, impl] of Object.entries(inst.nodeVersions)) entry.versions[v] = impl.description;
      entry.currentVersion = inst.currentVersion;
    }
    out.nodes.push(entry);
    out.count++;
  } catch (e) {
    out.failed.push({ file: rel, error: String(e && e.message || e).slice(0, 200) });
  }
}
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`${pkg.name}@${pkg.version}: ${out.count} 个节点导出, ${out.failed.length} 个失败`);
for (const f of out.failed.slice(0, 5)) console.log("  失败:", f.file, "-", f.error);
