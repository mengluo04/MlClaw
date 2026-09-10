export function modelLabel(snapshot: string | null) {
  if (!snapshot) return "未记录模型";
  try {
    const value = JSON.parse(snapshot) as {
      providerName?: unknown;
      model?: unknown;
    };
    return (
      [value.providerName, value.model]
        .filter((item) => typeof item === "string")
        .join(" / ") || "未记录模型"
    );
  } catch {
    return "模型记录不可读";
  }
}
