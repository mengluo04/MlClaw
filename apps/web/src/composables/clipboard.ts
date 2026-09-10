import { ElMessage } from "element-plus";
import "element-plus/es/components/message/style/css";
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success("已复制");
  } catch {
    ElMessage.error("复制失败，请手动选择内容复制");
  }
}
export function copyCode(event: MouseEvent) {
  if (
    !(event.target instanceof HTMLElement) ||
    !event.target.closest(".copy-code")
  )
    return;
  const code = event.target.closest(".code-block")?.querySelector("code");
  if (code) void copyText(code.textContent ?? "");
}
