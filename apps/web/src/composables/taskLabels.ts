/** 从任务快照提取可展示的模型名称。 */
export const modelLabel = (snapshot: string | null) => {
  if (!snapshot) return '未记录模型';
  try {
    /** 从 JSON 文本解析的结构化数据，后续仍需按业务规则校验。 */
    const value = JSON.parse(snapshot) as {
      providerName?: unknown;
      model?: unknown;
    };
    return (
      [value.providerName, value.model].filter((item) => typeof item === 'string').join(' / ') ||
      '未记录模型'
    );
  } catch {
    return '模型记录不可读';
  }
};
