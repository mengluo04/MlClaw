import type { DatabaseSync } from 'node:sqlite';
import { formatSystemTime } from '../time.js';

// 只迁移结构化时间列，不改写消息、工具结果、规则或用户文本中的日期。
const columns: Record<string, string[]> = {
  schema_migrations: ['applied_at'], users: ['created_at'], sessions: ['expires_at'],
  login_attempts: ['created_at'], conversations: ['created_at'], messages: ['created_at'],
  tasks: ['created_at', 'finished_at'], task_events: ['created_at'],
  tool_calls: ['created_at', 'finished_at', 'decided_at'], memories: ['created_at', 'updated_at'],
  assistant_configs: ['updated_at'], conversation_rules: ['updated_at'], model_providers: ['updated_at'],
  channel_accounts: ['created_at', 'pairing_expires_at'], channel_inbox: ['created_at'], channel_outbox: ['created_at'],
  schedules: ['next_run_at', 'created_at', 'updated_at', 'deleted_at'],
  schedule_occurrences: ['scheduled_at', 'created_at', 'started_at', 'finished_at', 'read_at'],
};

export function migrateLocalTime(db: DatabaseSync) {
  // 发生键改用绝对时间戳；保留旧记录的唯一性，手动请求键不变。
  for (const row of db.prepare("SELECT id,trigger_key FROM schedule_occurrences WHERE source='cron'").all()) {
    const key = String(row.trigger_key);
    if (/^cron:\d{4}-.*Z$/.test(key)) {
      db.prepare('UPDATE schedule_occurrences SET trigger_key=? WHERE id=?').run(`cron:${Date.parse(key.slice(5))}`, row.id!);
    }
  }
  for (const [table, fields] of Object.entries(columns)) {
    for (const field of fields) {
      const update = db.prepare(`UPDATE ${table} SET ${field}=? WHERE rowid=?`);
      for (const row of db.prepare(`SELECT rowid AS migration_rowid,${field} AS value FROM ${table} WHERE ${field} IS NOT NULL`).all()) {
        const value = String(row.value);
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
          update.run(formatSystemTime(new Date(value)), row.migration_rowid!);
        }
      }
    }
  }
}
