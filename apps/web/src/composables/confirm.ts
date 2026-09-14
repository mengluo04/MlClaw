import { ElMessageBox } from 'element-plus';
import 'element-plus/es/components/message-box/style/css';
/** 显示确认对话框并将取消转换为布尔结果。 */
export const confirmAction = async (message: string, title = '确认操作') => {
  try {
    await ElMessageBox.confirm(message, title, {
      confirmButtonText: '确认',
      cancelButtonText: '取消',
      type: 'warning',
      distinguishCancelAndClose: true,
    });
    return true;
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ cause) {
    if (cause === 'cancel' || cause === 'close') return false;
    throw cause;
  }
};
