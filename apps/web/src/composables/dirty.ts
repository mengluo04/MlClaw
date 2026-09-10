import { onUnmounted, type Ref } from "vue";
import { confirmAction } from "./confirm";
const drafts = new Map<symbol, () => boolean>();
export function useDirtyGuard(dirty: Ref<boolean>) {
  const key = Symbol();
  drafts.set(key, () => dirty.value);
  onUnmounted(() => drafts.delete(key));
  function beforeUnload(event: BeforeUnloadEvent) {
    if (dirty.value) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
  window.addEventListener("beforeunload", beforeUnload);
  onUnmounted(() => window.removeEventListener("beforeunload", beforeUnload));
}
export async function mayLeave() {
  return (
    ![...drafts.values()].some((check) => check()) ||
    (await confirmAction(
      "离开将丢弃尚未保存的修改，是否继续？",
      "未保存的修改",
    ))
  );
}
