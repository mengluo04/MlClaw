<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { SkillDetail, SkillDirectory, SkillSearch } from '@mlclaw/shared';
import { api } from '../api';
import { renderMarkdown } from '../markdown';

/** 页面只反映磁盘上的实际状态，刷新时同步重新扫描。 */
const directory = ref<SkillDirectory | null>(null);
const selected = ref<SkillDetail | null>(null);
const results = ref<SkillSearch | null>(null);
const query = ref('');
const busy = ref(false);
const error = ref('');
/** 重新读取技能目录，同时清除可能过时的详情。 */
const load = async () => {
  busy.value = true;
  error.value = '';
  selected.value = null;
  results.value = null;
  try {
    directory.value = await api<SkillDirectory>('/skills');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '技能目录加载失败';
  } finally {
    busy.value = false;
  }
};
/** 在选择时才读取正文和配套文件清单。 */
const read = async (id: string) => {
  busy.value = true;
  error.value = '';
  selected.value = null;
  try {
    selected.value = await api<SkillDetail>(`/skills/${encodeURIComponent(id)}`);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '技能读取失败';
  } finally {
    busy.value = false;
  }
};
/** 搜索入口文档，候选结果不代表模型执行结果。 */
const search = async () => {
  busy.value = true;
  error.value = '';
  results.value = null;
  try {
    results.value = await api<SkillSearch>(`/skills/search?q=${encodeURIComponent(query.value)}`);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '技能搜索失败';
  } finally {
    busy.value = false;
  }
};
onMounted(load);
</script>

<template>
  <div class="page-content feature-panel">
    <section class="settings-panel" aria-label="技能管理">
      <h2>技能目录</h2>
      <p>
        将技能文件夹放入工作区的 <code>skills/</code>，每个文件夹包含
        <code>SKILL.md</code>。下一次提问自动发现，无需重启或在网页登记。
      </p>
      <pre class="skill-example">
skills/my-skill/
  SKILL.md
  scripts/
  references/
  assets/</pre>
      <p>
        SKILL.md 以 YAML 元信息开头，填写 name 和
        description，正文写操作步骤。配套资料与脚本保持原有相对路径。
      </p>
      <el-space wrap>
        <el-button :loading="busy" :disabled="busy" @click="load">重新加载技能</el-button>
        <RouterLink to="/files">打开工作区文件</RouterLink>
      </el-space>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <p v-if="busy" role="status">正在读取技能目录…</p>
      <template v-if="directory">
        <p>
          工作区相对目录：<code>{{ directory.directory }}/</code> · 发现
          {{ directory.skills.length }} 个技能
        </p>
        <el-alert
          v-for="issue in directory.issues"
          :key="issue.path"
          :title="`${issue.path}：${issue.message}`"
          type="warning"
          :closable="false"
          show-icon
        />
        <p v-if="!directory.skills.length">
          尚未发现技能，请放入包含 SKILL.md 的技能文件夹后重新加载。
        </p>
        <article
          v-for="skill in directory.skills"
          :key="skill.id"
          :aria-label="`技能：${skill.name}`"
        >
          <strong>{{ skill.name }}</strong>
          <p>{{ skill.description }}</p>
          <p>
            <code>{{ skill.location }}</code> · {{ skill.enabled ? '可自动选择' : '已停用' }} ·
            {{ skill.version.slice(0, 12) }}
          </p>
          <el-button :disabled="busy" @click="read(skill.id)">查看说明</el-button>
        </article>
        <form @submit.prevent="search">
          <el-form-item label="技能试查关键词">
            <el-input
              v-model="query"
              aria-label="技能试查关键词"
              maxlength="200"
              :disabled="busy"
              placeholder="搜索名称、描述和 SKILL.md 正文"
            />
          </el-form-item>
          <el-button native-type="submit" :disabled="busy || !query.trim()">搜索技能候选</el-button>
        </form>
        <template v-if="results">
          <p v-if="!results.items.length">没有匹配的技能。</p>
          <article v-for="item in results.items" :key="item.id" aria-label="技能候选">
            <strong>{{ item.name }}</strong>
            <p>{{ item.excerpt }}</p>
            <el-button :disabled="busy" @click="read(item.id)">查看说明</el-button>
          </article>
          <p v-if="results.truncated">仅显示前 5 个候选，请缩小查询范围。</p>
        </template>
      </template>
      <section v-if="selected" aria-label="技能详情">
        <h3>{{ selected.name }}</h3>
        <p>
          <code>{{ selected.location }}</code> · 更新于 {{ selected.updatedAt }}
        </p>
        <div class="markdown" v-html="renderMarkdown(selected.content)"></div>
        <h4>配套文件</h4>
        <p v-if="!selected.resources.length">此技能没有配套文件。</p>
        <ul v-else>
          <li v-for="path in selected.resources" :key="path">
            <code>{{ path }}</code>
          </li>
        </ul>
        <p v-if="selected.resourcesTruncated">文件清单已截断，可在工作区文件页面继续查看。</p>
      </section>
    </section>
  </div>
</template>

<style scoped>
article,
form,
section[aria-label='技能详情'] {
  margin-top: 20px;
}
code,
p,
li {
  overflow-wrap: anywhere;
}
.skill-example {
  white-space: pre-wrap;
}
</style>
