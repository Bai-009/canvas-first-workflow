import type { SessionRecord } from '../../shared/http.mjs';
import { isSessionRecord } from './session-record.mjs';
import { errorMessage, errorDetails } from '../../shared/errors.mjs';
import { mkdirSync, readdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// 单机 demo：每条会话一个文件。写完整并同步到磁盘后再替换，读者不会看到半份 JSON。
export function createSessionStore(directory: string | null) {
  const warnings: string[] = [];
  if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const validId = (id: string) => /^[a-zA-Z0-9-]{1,80}$/.test(id);
  return {
    warnings,
    load() {
      if (!directory) return [];
      const records: SessionRecord[] = [];
      for (const name of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
        try {
          const record: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
          if (!isSessionRecord(record) || name !== `${record.id}.json`) {
            throw new Error("格式或版本不受支持");
          }
          records.push(record);
        } catch (error) {
          warnings.push(`会话文件 ${name} 未能读取，原文件已保留：${errorMessage(error)}`);
        }
      }
      return records;
    },
    save(record: SessionRecord) {
      if (!directory) return;
      if (!validId(record.id)) throw new Error("无效的会话编号");
      const temporary = join(directory, `${record.id}.${randomUUID()}.tmp`);
      let fd: number | undefined;
      try {
        fd = openSync(temporary, "wx", 0o600);
        writeFileSync(fd, JSON.stringify(record));
        fsyncSync(fd);
        closeSync(fd); fd = undefined;
        renameSync(temporary, join(directory, `${record.id}.json`));
      } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temporary); } catch (error) { if (errorDetails(error).code !== "ENOENT") throw error; }
      }
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
