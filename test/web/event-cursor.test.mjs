import test from "node:test";
import assert from "node:assert/strict";
import { createEventCursor } from "../../dist/web/event-cursor.mjs";

test("服务重启后接受从零开始的快照与后续事件，旧流增量不能覆盖新画布", () => {
  const cursor = createEventCursor({ feedId: "before-restart", sequence: 42 });
  assert.equal(cursor.accept({ feedId: "after-restart", sequence: 0, type: "snapshot" }), true);
  assert.equal(cursor.accept({ feedId: "after-restart", sequence: 1, type: "edit" }), true);
  assert.equal(cursor.accept({ feedId: "before-restart", sequence: 43, type: "edit" }), false);
});

test("同一服务的初始缓冲与重连不能回滚或重复应用增量", () => {
  const cursor = createEventCursor({ feedId: "current", sequence: 10 });
  const event = (sequence, type) => ({ feedId: "current", sequence, type });
  assert.equal(cursor.accept(event(9, "snapshot")), false);
  assert.equal(cursor.accept(event(10, "edit")), false);
  assert.equal(cursor.accept(event(10, "snapshot")), true);
  assert.equal(cursor.accept(event(11, "edit")), true);
  assert.equal(cursor.accept(event(11, "edit")), false);
  assert.equal(cursor.accept({ feedId: "other", sequence: 12, type: "edit" }), false);
});
