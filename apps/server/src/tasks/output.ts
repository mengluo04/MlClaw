import type { TaskEvent } from '@mlclaw/shared';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/index.js';
import { formatSystemTime } from '../time.js';

interface LiveOutput {
  seq: number;
  conversationId: string;
  messageId: string;
  text: string;
  createdAt: string;
  dirty: boolean;
  timer: ReturnType<typeof setInterval>;
}

/** 渠道投递读取已保存的完整结果，兼容旧版本逐段保存的历史。调用方先校验任务归属。 */
export const savedTaskText = (db: DatabaseSync, taskId: string, limit = Infinity): string => {
  const snapshot = db
    .prepare(
      "SELECT json_extract(data,'$.text') AS text FROM task_events WHERE task_id=? AND type='message.snapshot' ORDER BY seq DESC LIMIT 1",
    )
    .get(taskId);
  if (snapshot) return String(snapshot.text ?? '').slice(0, limit);
  const parts: string[] = [];
  let length = 0;
  for (const row of db
    .prepare(
      "SELECT json_extract(data,'$.text') AS text FROM task_events WHERE task_id=? AND type='message.delta' ORDER BY seq",
    )
    .iterate(taskId)) {
    const part = String(row.text ?? '').slice(0, limit - length);
    parts.push(part);
    length += part.length;
    if (length >= limit) break;
  }
  return parts.join('');
};

/** 正文增量只在内存中分发；数据库保存低频快照和业务事件。 */
export class TaskOutput {
  private live = new Map<string, LiveOutput>();
  private listeners = new Map<string, Set<(event: TaskEvent) => void>>();

  constructor(private db: DatabaseSync) {}

  private lastId(taskId: string) {
    return (
      this.live.get(taskId)?.seq ??
      Number(
        this.db
          .prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM task_events WHERE task_id=?')
          .get(taskId)!.seq,
      )
    );
  }

  start(taskId: string, conversationId: string, messageId: string, failed: () => void) {
    const timer = setInterval(() => {
      try {
        this.flush(taskId);
      } catch {
        failed();
      }
    }, 5000);
    timer.unref();
    this.live.set(taskId, {
      seq: this.lastId(taskId),
      conversationId,
      messageId,
      text: '',
      createdAt: formatSystemTime(),
      dirty: false,
      timer,
    });
  }

  private publish(event: TaskEvent) {
    for (const listener of this.listeners.get(event.taskId) ?? []) listener(event);
  }

  private insert(event: TaskEvent) {
    this.db
      .prepare('INSERT INTO task_events (task_id,seq,type,data,created_at) VALUES (?,?,?,?,?)')
      .run(event.taskId, event.id, event.type, JSON.stringify(event.data), event.createdAt);
  }

  record(taskId: string, type: string, data: TaskEvent['data']) {
    const event: TaskEvent = {
      id: this.lastId(taskId) + 1,
      taskId,
      type,
      data,
      createdAt: formatSystemTime(),
    };
    this.insert(event);
    const live = this.live.get(taskId);
    if (live) live.seq = event.id;
    this.publish(event);
  }

  append(taskId: string, text: string) {
    const live = this.live.get(taskId);
    if (!live) throw new Error('任务正文缓冲区不存在');
    live.text += text;
    live.dirty = true;
    this.publish({
      id: ++live.seq,
      taskId,
      type: 'message.delta',
      data: { messageId: live.messageId, text },
      createdAt: formatSystemTime(),
    });
  }

  flush(taskId: string) {
    const live = this.live.get(taskId);
    if (!live?.dirty) return;
    const event: TaskEvent = {
      id: live.seq + 1,
      taskId,
      type: 'message.snapshot',
      data: { messageId: live.messageId, text: live.text },
      createdAt: formatSystemTime(),
    };
    transaction(this.db, () => {
      this.db
        .prepare(
          'INSERT INTO messages VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content',
        )
        .run(live.messageId, live.conversationId, 'assistant', live.text, live.createdAt);
      // 只保留最新的完整快照，避免检查点重复保存不断增长的正文。
      this.db
        .prepare("DELETE FROM task_events WHERE task_id=? AND type='message.snapshot'")
        .run(taskId);
      this.insert(event);
    });
    live.seq = event.id;
    live.dirty = false;
    this.publish(event);
  }

  release(taskId: string) {
    const live = this.live.get(taskId);
    if (live) clearInterval(live.timer);
    this.live.delete(taskId);
  }

  subscribe(taskId: string, listener: (event: TaskEvent) => void) {
    const listeners = this.listeners.get(taskId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(taskId);
    };
  }

  /** 重连快照是游标重置控制帧，不是需要追加或按旧游标去重的业务事件。 */
  snapshot(taskId: string): TaskEvent {
    const live = this.live.get(taskId);
    const row = live
      ? undefined
      : this.db
          .prepare(
            "SELECT data FROM task_events WHERE task_id=? AND type IN ('message.snapshot','message.delta') ORDER BY seq DESC LIMIT 1",
          )
          .get(taskId);
    const messageId =
      live?.messageId ??
      (row ? (JSON.parse(String(row.data)) as TaskEvent['data']).messageId : undefined);
    const text =
      live?.text ??
      (messageId
        ? String(
            this.db.prepare('SELECT content FROM messages WHERE id=?').get(messageId)?.content ??
              '',
          )
        : '');
    const status = String(
      this.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)?.status ?? 'interrupted',
    );
    return {
      id: this.lastId(taskId),
      taskId,
      type: 'stream.snapshot',
      data: { messageId, text, status },
      createdAt: formatSystemTime(),
    };
  }
}
