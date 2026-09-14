<script setup lang="ts">
import { useSession } from '../stores/session';
const session = useSession();
withDefaults(defineProps<{ size?: number }>(), { size: 28 });
</script>
<template>
  <img
    class="assistant-avatar"
    :src="session.assistantAvatarUrl"
    alt="AI 助手头像"
    :width="size"
    :height="size"
  />
</template>
<style scoped>
.assistant-avatar {
  flex-shrink: 0;
  object-fit: contain;
  border-radius: 30%;
  vertical-align: middle;
}
</style>
