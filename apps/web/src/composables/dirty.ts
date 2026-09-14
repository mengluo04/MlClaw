import { onUnmounted, type Ref } from 'vue';
import { confirmAction } from './confirm';
/** 按组件标识保存未提交修改的检查函数，供全局路由离开保护查询。 */
const drafts = new Map<symbol, () => boolean>();
/** 注册未保存内容的离开保护并在卸载时清理。 */
export const useDirtyGuard = (dirty: Ref<boolean>) => {
  /** 当前组件的唯一登记键，卸载时只移除自己的检查函数。 */
  const key = Symbol();
  drafts.set(key, () => dirty.value);
  onUnmounted(() => drafts.delete(key));
  /** 存在未保存内容时触发浏览器离开提示。 */
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (dirty.value) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload));
};
/** 询问是否放弃尚未保存的修改。 */
export const mayLeave = async () => {
  return (
    ![...drafts.values()].some((check) => check()) ||
    (await confirmAction('离开将丢弃尚未保存的修改，是否继续？', '未保存的修改'))
  );
};
