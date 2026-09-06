// 这里只读取排序信息，完整事件载荷由应用入口处理。
interface Cursor { feedId?: string; sequence?: number }
interface OrderedEvent extends Cursor { type: string }
// 编号只在同一次服务运行内可比。重连快照可以建立新的事件流，增量不能。
export function createEventCursor(initial: Cursor) {
  let feedId = initial.feedId;
  let sequence = initial.sequence ?? -1;
  return {
    accept(event: OrderedEvent) {
      if (event.feedId !== feedId) {
        if (event.type !== "snapshot") return false;
        feedId = event.feedId;
        sequence = -1;
      }
      if (typeof event.sequence === "number" && Number.isInteger(event.sequence)) {
        if (event.sequence < sequence || (event.sequence === sequence && event.type !== "snapshot")) return false;
        sequence = event.sequence;
      }
      return true;
    },
  };
}
