<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { UploadFile, UploadUserFile } from 'element-plus';
import { ElMessage } from 'element-plus';
import 'element-plus/es/components/message/style/css';
import type { FileEntry } from '@mlclaw/shared';
import { api } from '../api';
import { useOperation } from '../composables/operation';
import { useChat } from '../stores/chat';
/** 统一操作状态：忙碌、错误提示及执行入口，并提供成功反馈。 */
const { busy, error, notice, run } = useOperation();
/** 共享的会话与任务状态。 */
const chat = useChat();
/** 当前目录。 */
const directory = ref('.');
/** 目录导航输入框中的相对路径。 */
const pathInput = ref('.');
/** 当前文件列表。 */
const files = ref<FileEntry[]>([]);
/** 返回内容是否因上限被截断。 */
const truncated = ref(false);
/** 是否已完成首次数据加载。 */
const loaded = ref(false);
/** 上传对话框是否打开。 */
const uploadOpen = ref(false);
/** 上传控件维护的文件列表。 */
const fileList = ref<UploadUserFile[]>([]);
/** 待上传的原始文件对象。 */
const uploadFile = ref<File>();
/** 上传文件在工作区中的名称。 */
const uploadName = ref('');
/** 当前路径编辑模式：新建目录、移动或关闭。 */
const operation = ref<'mkdir' | 'move' | null>(null);
/** 移动或重命名操作的源相对路径。 */
const source = ref('');
/** 文件操作的目标路径。 */
const destination = ref('');
/** 初始化新建目录或移动路径的表单。 */
const editPath = (mode: 'mkdir' | 'move', name = '') => {
  operation.value = mode;
  source.value = name ? pathFor(name) : '';
  destination.value = name ? pathFor(name) : directory.value === '.' ? '' : directory.value + '/';
};
/** 提交目录创建或移动请求并刷新文件列表。 */
const savePath = async () => {
  await run(async () => {
    if (operation.value === 'mkdir')
      await api('/files/directory', 'POST', { path: destination.value });
    else await api('/files/move', 'POST', { source: source.value, destination: destination.value });
    operation.value = null;
    await list();
    notice.value = '工作区已更新';
  });
};
/** 永久删除工作区条目并刷新目录。 */
const removeFile = async (name: string, type: string) => {
  await run(async () => {
    await api('/files', 'DELETE', { path: pathFor(name), recursive: type === 'directory' });
    await list();
    notice.value = '已永久删除，无法自动恢复';
  });
};
/** 当前目录拆分出的面包屑路径。 */
const crumbs = computed(() =>
  directory.value === '.' ? [] : directory.value.split('/').filter(Boolean),
);
/** 根据当前目录拼接文件相对路径。 */
const pathFor = (name: string) => (directory.value === '.' ? name : `${directory.value}/${name}`);
/** 读取并更新当前列表。 */
const list = async (path = directory.value) => {
  /** 接口 /files?path=${encodeURIComponent(path)} 返回的业务数据。 */
  const result = await api<{ entries: FileEntry[]; truncated: boolean }>(
    `/files?path=${encodeURIComponent(path)}`,
  );
  files.value = result.entries;
  truncated.value = result.truncated;
  directory.value = path;
  pathInput.value = path;
  loaded.value = true;
};
/** 保存用户选择的上传文件及默认名称。 */
const pick = (file: UploadFile) => {
  uploadFile.value = file.raw;
  uploadName.value = file.name;
};
/** 校验文件大小后上传并刷新目录。 */
const upload = async () => {
  await run(async () => {
    if (!uploadFile.value) throw new Error('请先选择文件');
    if (uploadFile.value.size > 65536) throw new Error('文件不能超过 64 KiB');
    /** 当前内容的字节数据。 */
    const bytes = new Uint8Array(await uploadFile.value.arrayBuffer());
    /** 当前操作使用的路径。 */
    const path = pathFor(uploadName.value);
    await api('/files/upload', 'POST', {
      path,
      contentBase64: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')),
    });
    await list();
    uploadOpen.value = false;
    fileList.value = [];
    uploadFile.value = undefined;
    notice.value = `已保存到工作目录：${path}`;
  });
};
/** 将相对路径复制到剪贴板并反馈结果。 */
const copy = async (path: string) => {
  try {
    await navigator.clipboard.writeText(path);
    ElMessage.success('已复制相对路径，可在对话中引用');
  } catch {
    error.value = '复制失败，请手动复制路径';
  }
};
onMounted(() => void run(() => list()));
</script>
<template>
  <div class="page-content feature-panel">
    <section>
      <div class="page-toolbar">
        <div>
          <h2>工作目录文件</h2>
          <p>助手可自主读写此工作区。覆盖和删除不保留旧版本，无法自动恢复。</p>
        </div>
        <el-button :disabled="busy || !!chat.runtime" @click="editPath('mkdir')"
          >新建目录</el-button
        >
        <el-button type="primary" :disabled="busy || !!chat.runtime" @click="uploadOpen = true"
          >上传文件</el-button
        >
      </div>
      <el-alert v-if="error" :title="error" type="error" :closable="false"
        ><el-button text @click="run(() => list())">重新加载</el-button></el-alert
      ><el-alert v-if="notice" :title="notice" type="success" :closable="false" />
      <el-alert
        v-if="chat.runtime"
        title="任务正在执行，暂时不能修改工作区"
        type="info"
        :closable="false"
      />
      <el-breadcrumb separator="/"
        ><el-breadcrumb-item
          ><el-button text @click="run(() => list('.'))">工作目录</el-button></el-breadcrumb-item
        ><el-breadcrumb-item v-for="(part, index) in crumbs" :key="index"
          ><el-button text @click="run(() => list(crumbs.slice(0, index + 1).join('/')))">{{
            part
          }}</el-button></el-breadcrumb-item
        ></el-breadcrumb
      >
      <el-form class="inline-search" @submit.prevent="run(() => list(pathInput))"
        ><el-input v-model="pathInput" aria-label="相对目录" placeholder="输入相对目录" /><el-button
          native-type="submit"
          :loading="busy"
          >查看目录</el-button
        ></el-form
      >
      <el-skeleton v-if="busy && !loaded" animated :rows="4" /><el-table
        v-else
        :data="files"
        empty-text="目录为空"
        ><el-table-column prop="name" label="名称" min-width="160" /><el-table-column
          label="类型"
          width="80"
          ><template #default="{ row }">{{
            row.type === 'directory' ? '文件夹' : row.type === 'file' ? '文件' : '不可操作'
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
              v-else-if="row.type === 'file'"
              :href="`/api/files/download?path=${encodeURIComponent(pathFor(String(row.name)))}`"
              download
              >下载</a
            ><el-button text @click="copy(pathFor(String(row.name)))">复制路径</el-button>
            <el-button
              v-if="['file', 'directory'].includes(row.type)"
              text
              :disabled="busy || !!chat.runtime"
              @click="editPath('move', row.name)"
              >移动/重命名</el-button
            >
            <el-button
              v-if="['file', 'directory'].includes(row.type)"
              text
              type="danger"
              :disabled="busy || !!chat.runtime"
              @click="removeFile(String(row.name), String(row.type))"
              >永久删除</el-button
            >
          </template></el-table-column
        ></el-table
      >
      <p v-if="truncated">仅显示前 200 项，请进入具体子目录。</p>
      <el-dialog
        :model-value="operation !== null"
        :title="operation === 'mkdir' ? '新建目录' : '移动或重命名'"
        width="min(480px, 94vw)"
        :before-close="
          (done: () => void) => {
            if (!busy) {
              operation = null;
              done();
            }
          }
        "
      >
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <p v-if="source">原路径：{{ source }}</p>
        <el-form label-position="top" @submit.prevent="savePath">
          <el-form-item label="目标相对路径"
            ><el-input aria-label="目标相对路径" v-model="destination" :disabled="busy"
          /></el-form-item>
          <p>路径相对于工作区，父目录须已存在；目标不能覆盖已有文件或目录。</p>
          <el-button
            type="primary"
            native-type="submit"
            :loading="busy"
            :disabled="!destination.trim() || !!chat.runtime"
            >保存路径</el-button
          >
        </el-form>
      </el-dialog>
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
            个文件。同名文件直接覆盖，不保留旧版本。上传文件保存在当前目录，不会自动解析为聊天附件。
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
  </div>
</template>
