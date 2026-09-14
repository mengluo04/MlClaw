import { ref } from 'vue';
/** 封装忙碌、错误及成功提示状态。 */
export const useOperation = () => {
  /** 操作进行中标记，用于禁用重复提交。 */
  const busy = ref(false);
  /** 当前错误提示。 */
  const error = ref('');
  /** 当前操作反馈文案。 */
  const notice = ref('');
  /** 执行当前操作并返回执行结果。 */
  const run = async (operation: () => Promise<void>) => {
    if (busy.value) return false;
    busy.value = true;
    error.value = '';
    notice.value = '';
    try {
      await operation();
      return true;
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ cause) {
      error.value = cause instanceof Error ? cause.message : '操作失败，请重试';
      return false;
    } finally {
      busy.value = false;
    }
  };
  return { busy, error, notice, run };
};
