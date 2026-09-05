import { mkdirSync, readdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// 单机 demo：每条会话一个文件。写完整并同步到磁盘后再替换，读者不会看到半份 JSON。
export function createSessionStore(directory) {
  const warnings = [];
  if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const validId = (id) => /^[a-zA-Z0-9-]{1,80}$/.test(id);
  return {
    warnings,
    load() {
      if (!directory) return [];
      const records = [];
      for (const name of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
        try {
          const record = JSON.parse(readFileSync(join(directory, name), "utf8"));
          const state = record.workflow;
          if (record.formatVersion !== 1 || !validId(record.id) || name !== `${record.id}.json`
            || !state || state.formatVersion !== 1 || !Array.isArray(state.plan?.transcript)
            || !Array.isArray(state.plan?.versions) || !Array.isArray(state.canvas?.nodes)
            || !Array.isArray(state.canvas?.edges) || !Number.isInteger(state.canvas?.version)
            || !Array.isArray(state.runs) || !Array.isArray(state.edits) || !Array.isArray(state.annotations)) {
            throw new Error("格式或版本不受支持");
          }
          records.push(record);
        } catch (error) {
          warnings.push(`会话文件 ${name} 未能读取，原文件已保留：${error.message}`);
        }
      }
      return records;
    },
    save(record) {
      if (!directory) return;
      if (!validId(record.id)) throw new Error("无效的会话编号");
      const temporary = join(directory, `${record.id}.${randomUUID()}.tmp`);
      let fd;
      try {
        fd = openSync(temporary, "wx", 0o600);
        writeFileSync(fd, JSON.stringify(record));
        fsyncSync(fd);
        closeSync(fd); fd = undefined;
        renameSync(temporary, join(directory, `${record.id}.json`));
      } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    },
  };
}
