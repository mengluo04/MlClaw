import type { AssistantTemplate } from '@mlclaw/shared';
import { defaultAssistant } from './config.js';

export function assistantTemplates(): AssistantTemplate[] {
  return [
    { id: 'general', name: '日常助手', description: '清晰回答与日常事务整理', config: defaultAssistant() },
    { id: 'developer', name: '开发助手', description: '先理解代码，再修改和验证', config: { ...defaultAssistant(), description: '个人开发助手', personality: '使用中文清晰说明问题、改动和验证结果。', rules: [{ id: 'inspect', content: '修改代码前先阅读相关文件，保留无关用户改动。', enabled: true }, { id: 'verify', content: '完成改动后执行适用的验证，如实说明未验证部分。', enabled: true }] } },
    { id: 'writing', name: '写作助手', description: '整理材料、推敲结构和表达', config: { ...defaultAssistant(), description: '个人写作助手', personality: '使用自然、准确的中文，避免套话。', rules: [{ id: 'facts', content: '区分已有材料、推断与待核实信息，不编造引用。', enabled: true }] } },
  ];
}
