<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { UploadFile, UploadUserFile } from "element-plus";
import { ElMessage } from "element-plus";
import "element-plus/es/components/message/style/css";
import type { FileEntry } from "@mlclaw/shared";
import { api } from "../api";
import { useOperation } from "../composables/operation";
import { useChat } from "../stores/chat";
const { busy, error, notice, run } = useOperation();
const chat = useChat();
const directory = ref(".");
const pathInput = ref(".");
const files = ref<FileEntry[]>([]);
const truncated = ref(false);
const loaded = ref(false);
const uploadOpen = ref(false);
const fileList = ref<UploadUserFile[]>([]);
const uploadFile = ref<File>();
const uploadName = ref("");
const crumbs = computed(() =>
  directory.value === "." ? [] : directory.value.split("/").filter(Boolean),
);
const pathFor = (name: string) =>
  directory.value === "." ? name : `${directory.value}/${name}`;
async function list(path = directory.value) {
  const result = await api<{ entries: FileEntry[]; truncated: boolean }>(
    `/files?path=${encodeURIComponent(path)}`,
  );
  files.value = result.entries;
  truncated.value = result.truncated;
  directory.value = path;
  pathInput.value = path;
  loaded.value = true;
}
function pick(file: UploadFile) {
  uploadFile.value = file.raw;
  uploadName.value = file.name;
}
async function upload() {
  await run(async () => {
    if (!uploadFile.value) throw new Error("请先选择文件");
    if (uploadFile.value.size > 65536) throw new Error("文件不能超过 64 KiB");
    const bytes = new Uint8Array(await uploadFile.value.arrayBuffer());
    const path = pathFor(uploadName.value);
    await api("/files/upload", "POST", {
      path,
      contentBase64: btoa(
        Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
      ),
    });
    await list();
    uploadOpen.value = false;
    fileList.value = [];
    uploadFile.value = undefined;
    notice.value = `已保存到工作目录：${path}`;
  });
}
async function copy(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    ElMessage.success("已复制相对路径，可在对话中引用");
  } catch {
    error.value = "复制失败，请手动复制路径";
  }
}
onMounted(() => void run(() => list()));
</script>
<template>
  <section>
    <div class="page-toolbar">
      <div>
        <h2>工作目录文件</h2>
        <p>浏览和管理助手可访问的文件。</p>
      </div>
      <el-button
        type="primary"
        :disabled="!!chat.runtime"
        @click="uploadOpen = true"
        >上传文件</el-button
      >
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false"
      ><el-button text @click="run(() => list())">重新加载</el-button></el-alert
    ><el-alert v-if="notice" :title="notice" type="success" :closable="false" />
    <el-alert
      v-if="chat.runtime"
      title="任务正在执行，暂时不能上传文件"
      type="info"
      :closable="false"
    />
    <el-breadcrumb separator="/"
      ><el-breadcrumb-item
        ><el-button text @click="run(() => list('.'))"
          >工作目录</el-button
        ></el-breadcrumb-item
      ><el-breadcrumb-item v-for="(part, index) in crumbs" :key="index"
        ><el-button
          text
          @click="run(() => list(crumbs.slice(0, index + 1).join('/')))"
          >{{ part }}</el-button
        ></el-breadcrumb-item
      ></el-breadcrumb
    >
    <el-form class="inline-search" @submit.prevent="run(() => list(pathInput))"
      ><el-input
        v-model="pathInput"
        aria-label="相对目录"
        placeholder="输入相对目录"
      /><el-button native-type="submit" :loading="busy"
        >查看目录</el-button
      ></el-form
    >
    <el-skeleton v-if="busy && !loaded" animated :rows="4" /><el-table
      v-else
      :data="files"
      empty-text="目录为空"
      ><el-table-column
        prop="name"
        label="名称"
        min-width="160"
      /><el-table-column label="类型" width="80"
        ><template #default="{ row }">{{
          row.type === "directory" ? "文件夹" : "文件"
        }}</template></el-table-column
      ><el-table-column label="操作" min-width="150"
        ><template #default="{ row }"
          ><el-button
            v-if="row.type === 'directory'"
            text
            :disabled="busy"
            @click="run(() => list(pathFor(String(row.name))))"
            >进入</el-button
          ><a
            v-else
            :href="`/api/files/download?path=${encodeURIComponent(pathFor(String(row.name)))}`"
            download
            >下载</a
          ><el-button text @click="copy(pathFor(String(row.name)))"
            >复制路径</el-button
          ></template
        ></el-table-column
      ></el-table
    >
    <p v-if="truncated">仅显示前 200 项，请进入具体子目录。</p>
    <el-dialog
      v-model="uploadOpen"
      title="上传到工作目录"
      width="480px"
      :close-on-click-modal="!busy"
      :show-close="!busy"
      :close-on-press-escape="!busy"
      ><div class="feature-panel">
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <p>目标目录：{{ directory }}</p>
        <p>
          单文件最多 64 KiB；总配额 20 MiB、500
          个文件。同名文件不会覆盖。上传文件保存在当前目录，不会自动解析为聊天附件。
        </p>
        <el-upload
          v-model:file-list="fileList"
          :auto-upload="false"
          :limit="1"
          :on-change="pick"
          :on-remove="
            () => {
              uploadFile = undefined;
            }
          "
          :on-exceed="
            () => {
              error = '请先移除已选择文件';
            }
          "
          ><el-button :disabled="busy">选择文件</el-button></el-upload
        ><el-form label-position="top" @submit.prevent="upload"
          ><el-form-item label="保存文件名"
            ><el-input
              v-model="uploadName"
              aria-label="保存文件名"
              maxlength="200"
              required
              :disabled="busy" /></el-form-item
          ><el-button
            type="primary"
            native-type="submit"
            :loading="busy"
            :disabled="!uploadFile || !uploadName.trim() || !!chat.runtime"
            >确认上传</el-button
          ></el-form
        >
      </div></el-dialog
    >
  </section>
</template>
