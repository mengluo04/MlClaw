import { ref } from "vue";
export function useOperation() {
  const busy = ref(false);
  const error = ref("");
  const notice = ref("");
  async function run(operation: () => Promise<void>) {
    if (busy.value) return false;
    busy.value = true;
    error.value = "";
    notice.value = "";
    try {
      await operation();
      return true;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "操作失败，请重试";
      return false;
    } finally {
      busy.value = false;
    }
  }
  return { busy, error, notice, run };
}
