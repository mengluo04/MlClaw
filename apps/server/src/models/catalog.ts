import type { ProviderPreset } from '@mlclaw/shared';

// 地址为基础 URL，不包含调用路径；模型标识始终从远程获取或由用户填写。
export const providerPresets: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://developers.openai.com/api/reference/resources/models/methods/list',
    note: '使用 Chat Completions；模型列表可能包含非对话模型。',
  },
  {
    id: 'gemini',
    name: 'Google / Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    note: '使用 Google 提供的 OpenAI 兼容接口；工具调用能力需按模型验证。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    docsUrl: 'https://api-docs.deepseek.com/',
    note: '填写 DeepSeek API 密钥。',
  },
  {
    id: 'qwen',
    name: '阿里云百炼 / 通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    note: '预设为北京公共地址；可替换为业务空间专属域名，密钥必须与地域一致。',
  },
  {
    id: 'moonshot',
    name: '月之暗面 / Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    docsUrl: 'https://platform.kimi.com/docs/api/list-models',
    note: '预设为国内 API 地址，请使用对应平台密钥。',
  },
  {
    id: 'volcengine',
    name: '火山方舟 / 豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    docsUrl: 'https://www.volcengine.com/docs/82379/1795150',
    note: '按控制台填写模型 ID 或推理接入点 ID；列表不可用时手动添加。Coding Plan 使用不同地址和密钥。',
  },
  {
    id: 'zhipu',
    name: '智谱 / GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    docsUrl: 'https://docs.bigmodel.cn/cn/api/introduction',
    note: '普通 API 地址；Coding Plan 使用独立地址。若无模型列表接口，请手动填写控制台模型 ID。',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    docsUrl: 'https://platform.minimaxi.com/docs/guides/text-generation',
    note: '国内 OpenAI 兼容接口；列表不可用时手动添加。',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 / SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    docsUrl: 'https://docs.siliconflow.cn/docs/userguide/quickstart',
    note: '列表可能包含图片、语音和向量模型，请选择支持对话的模型。',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    docsUrl: 'https://console.groq.com/docs/openai',
    note: '使用 OpenAI 兼容接口。',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    docsUrl: 'https://docs.mistral.ai/api/endpoint/models',
    note: '使用 Chat Completions；具体模型能力需连接测试。',
  },
  {
    id: 'custom',
    name: '自定义提供商',
    baseUrl: '',
    docsUrl: '',
    note: '填写 OpenAI 兼容服务的基础地址；不要填写完整的 /chat/completions 或 /messages 路径。',
  },
];
