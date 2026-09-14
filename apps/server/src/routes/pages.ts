import type { FastifyInstance } from 'fastify';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { TaskError } from '../tasks/manager.js';

// 独立分页接口保留原有数组接口兼容性，返回 50 条和不透明的下一页游标。
export const registerPages = (app: FastifyInstance, db: DatabaseSync) => {
  /** 接口请求体各字段的 JSON Schema 定义。 */
  const properties = {
    before: { type: 'string', pattern: '^[1-9][0-9]{0,14}$' },
    q: { type: 'string', maxLength: 200 },
    conversationId: { type: 'string', minLength: 1, maxLength: 100 },
    status: {
      type: 'string',
      enum: [
        'queued',
        'running',
        'waiting_approval',
        'succeeded',
        'failed',
        'cancelled',
        'interrupted',
      ],
    },
  };
  for (/* 逐项处理当前业务类型。 */ const kind of ['conversations', 'tasks'] as const) {
    app.get<{
      Querystring: {
        before?: string;
        q?: string;
        conversationId?: string;
        status?: string;
      };
    }>(
      `/api/${kind}/page`,
      {
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties:
              kind === 'conversations'
                ? { before: properties.before, q: properties.q }
                : properties,
          },
        },
      },
      async (request) => {
        /** before：操作前的状态或分页起点；q：当前搜索关键词；conversationId：当前会话标识；status：当前业务状态。 */
        const { before, q, conversationId, status } = request.query;
        /** 拼接查询语句使用的筛选条件。 */
        const conditions = ['user_id=?', 'rowid<?'];
        /** 当前请求参数。 */
        const params: SQLInputValue[] = [
          request.userId,
          before ? Number(before) : Number.MAX_SAFE_INTEGER,
        ];
        if (q?.trim()) {
          conditions.push(
            `instr(lower(${kind === 'conversations' ? 'title' : 'input'}),lower(?))>0`,
          );
          params.push(q.trim());
        }
        if (kind === 'tasks' && conversationId) {
          if (
            !db
              .prepare('SELECT id FROM conversations WHERE id=? AND user_id=?')
              .get(conversationId, request.userId)
          )
            throw new TaskError('会话不存在', 404);
          conditions.push('conversation_id=?');
          params.push(conversationId);
        }
        if (kind === 'tasks' && status) {
          conditions.push('status=?');
          params.push(status);
        }
        /** 需要处理的数据库或对象字段集合。 */
        const fields =
          kind === 'conversations'
            ? 'id,title,created_at'
            : 'id,conversation_id,status,kind,input,error,usage,created_at,finished_at,model_snapshot';
        /** 查询返回的记录列表。 */
        const rows = db
          .prepare(
            `SELECT rowid AS cursor,${fields} FROM ${kind} WHERE ${conditions.join(' AND ')} ORDER BY rowid DESC LIMIT 51`,
          )
          .all(...params);
        return {
          items: rows.slice(0, 50).map(({ cursor: _cursor, ...row }) => row),
          nextCursor: rows.length > 50 ? String(rows[49]!.cursor) : null,
        };
      },
    );
  }
};
