import { ElMessage } from 'element-plus';
import 'element-plus/es/components/message/style/css';
/** 将文本写入剪贴板并显示操作结果。 */
export const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制');
  } catch {
    ElMessage.error('复制失败，请手动选择内容复制');
  }
};
/** 响应代码块复制按钮并提取对应代码。 */
export const copyCode = (event: MouseEvent) => {
  if (!(event.target instanceof HTMLElement) || !event.target.closest('.copy-code')) return;
  /** 当前消息中的协议代码或验证码。 */
  const code = event.target.closest('.code-block')?.querySelector('code');
  if (code) void copyText(code.textContent ?? '');
};
