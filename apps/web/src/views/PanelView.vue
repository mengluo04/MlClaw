<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";
import { useSession } from "../stores/session";
import ModelSettings from "../components/ModelSettings.vue";
import AssistantSettings from "../components/AssistantSettings.vue";
import WebSettings from "../components/WebSettings.vue";
import ChannelSettings from "../components/ChannelSettings.vue";
import ScheduleSettings from "../components/ScheduleSettings.vue";
import FilePanel from "../components/FilePanel.vue";
import MemoryPanel from "../components/MemoryPanel.vue";
import HistoryPanel from "../components/HistoryPanel.vue";
import SkillsPanel from "../components/SkillsPanel.vue";
import SystemLogsPanel from "../components/SystemLogsPanel.vue";
const route = useRoute();
const router = useRouter();
const session = useSession();
function open(id: string) {
  void router.push(`/chat/${id}`);
}
</script>
<template>
  <div class="page-content feature-panel">
    <nav
      v-if="route.meta.panel === 'settings'"
      class="section-tabs"
      aria-label="设置分类"
    >
      <RouterLink
        v-for="item in [
          ['models', '模型服务'],
          ['assistant', '助手设置'],
          ['web', '联网搜索'],
          ['channels', '消息渠道'],
        ]"
        :key="item[0]"
        :to="`/settings/${item[0]}`"
        >{{ item[1] }}</RouterLink
      >
    </nav>
    <nav
      v-if="route.meta.panel === 'knowledge'"
      class="section-tabs"
      aria-label="记忆与技能分类"
    >
      <RouterLink to="/knowledge/memories">长期记忆</RouterLink
      ><RouterLink to="/knowledge/skills">技能管理</RouterLink>
    </nav>
    <ModelSettings
      v-if="route.params.tab === 'models'"
      @expired="session.clear"
      @saved="session.modelLabel = $event"
    />
    <AssistantSettings
      v-else-if="route.params.tab === 'assistant'"
      @expired="session.clear"
      @saved="session.assistantLabel = `${$event.emoji} ${$event.name}`.trim()"
    />
    <WebSettings
      v-else-if="route.params.tab === 'web'"
      @expired="session.clear"
    />
    <ChannelSettings
      v-else-if="route.params.tab === 'channels'"
      @expired="session.clear"
      @open="open"
    />
    <ScheduleSettings
      v-else-if="route.meta.panel === 'schedules'"
      @expired="session.clear"
      @open="open"
    />
    <SkillsPanel
      v-else-if="route.params.tab === 'skills'"
      @expired="session.clear"
    />
    <FilePanel v-else-if="route.meta.panel === 'files'" /><MemoryPanel
      v-else-if="route.params.tab === 'memories'"
    /><SystemLogsPanel v-else-if="route.meta.panel === 'logs'" /><HistoryPanel v-else />
  </div>
</template>
