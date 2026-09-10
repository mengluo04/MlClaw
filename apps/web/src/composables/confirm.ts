import { ElMessageBox } from "element-plus";
import "element-plus/es/components/message-box/style/css";
export async function confirmAction(message: string, title = "确认操作") {
  try {
    await ElMessageBox.confirm(message, title, {
      confirmButtonText: "确认",
      cancelButtonText: "取消",
      type: "warning",
      distinguishCancelAndClose: true,
    });
    return true;
  } catch (cause) {
    if (cause === "cancel" || cause === "close") return false;
    throw cause;
  }
}
