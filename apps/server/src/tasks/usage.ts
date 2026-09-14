import type { DatabaseSync } from 'node:sqlite';
import type { Usage } from '../providers/types.js';

/** 仅累加上游实际报告的消耗；摘要和聊天共享持久化计数，不混入本地估算。 */
export const addTaskUsage = (db: DatabaseSync, taskId: string, value: Usage) => {
  const raw = db.prepare('SELECT usage FROM tasks WHERE id=?').get(taskId)?.usage;
  const total: Usage = raw
    ? JSON.parse(String(raw))
    : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const)
    total[key] += value[key];
  db.prepare('UPDATE tasks SET usage=? WHERE id=?').run(JSON.stringify(total), taskId);
};
