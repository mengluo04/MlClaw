import { randomUUID } from 'node:crypto';
import { ProviderError, type ToolCall, type ToolDefinition } from './types.js';

/** 仅对当前已公开工具匹配大小写和标准命名空间，不猜测其他工具或参数。 */
export const normalizeToolCalls = (calls: ToolCall[], tools: ToolDefinition[]): ToolCall[] => {
  /** 预留上游所有 ID，避免生成的 ID 与后续调用碰撞。 */
  const reserved = new Set(calls.map((call) => call.id.trim()));
  const assigned = new Set<string>();
  const names = tools.map((tool) => tool.function.name);
  return calls.map((call) => {
    const rawName = call.function.name.trim();
    const candidate = rawName.replace(/^(?:functions|tools)[./]/i, '');
    const matches = names.filter((name) => name.toLowerCase() === candidate.toLowerCase());
    const name = names.includes(rawName) ? rawName : matches.length === 1 ? matches[0]! : rawName;
    if (!/^[\w-]{1,100}$/.test(name)) throw new ProviderError('模型工具名称格式无效');
    let id = call.id.trim();
    if (!/^[\w-]{1,200}$/.test(id) || assigned.has(id)) {
      do {
        id = `call_${randomUUID().replaceAll('-', '')}`;
      } while (reserved.has(id) || assigned.has(id));
    }
    assigned.add(id);
    return { ...call, id, function: { ...call.function, name } };
  });
};
