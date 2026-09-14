/** 用于检测并发修改的版本号。 */
export const scheduleVersion = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
/** 接口请求体各字段的 JSON Schema 定义。 */
export const scheduleProperties = {
  name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
  kind: { type: 'string', enum: ['agent', 'command'] },
  commandOptions: {
    type: 'object',
    additionalProperties: false,
    required: ['timeoutMs'],
    properties: {
      cwd: { type: 'string', enum: ['.'] },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 300000 },
    },
  },
  content: { type: 'string', minLength: 1, maxLength: 8000, pattern: '\\S' },
  cron: { type: 'string', minLength: 1, maxLength: 100 },
  enabled: { type: 'boolean' },
  deliveryChannelId: {
    anyOf: [{ type: 'string', minLength: 1, maxLength: 100 }, { type: 'null' }],
  },
};
