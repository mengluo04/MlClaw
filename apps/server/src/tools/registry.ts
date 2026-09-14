import { Ajv, type ValidateFunction } from 'ajv';
import { createHash, randomUUID } from 'node:crypto';
import { record, type ToolCall, type ToolDefinition } from '../providers/types.js';
import { ToolError, Workspace } from './files.js';
import { ScriptExecutor } from './script-executor.js';
import { resolveCommand } from './command.js';
import type { WebSession } from '../web/service.js';
import { publicUrl } from '../web/tavily.js';
import type { RetrievalSession } from '../retrieval/search.js';
import type { SkillSession } from '../skills/session.js';

interface Tool {
  definition: ToolDefinition;
  validate: ValidateFunction;
  prepare(args: Record<string, unknown>): { snapshot: string };
  execute(
    args: Record<string, unknown>,
    snapshot: string,
    signal: AbortSignal,
    callId: string,
  ): unknown | Promise<unknown>;
}
export interface PreparedCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  snapshot: string;
  digest: string;
}
export type ToolPolicy = 'full' | 'readonly' | 'onboarding';
/** 权限拒绝必须终止任务，不能作为参数纠错继续尝试。 */
export class ToolPermissionError extends ToolError {}
/** 定时只读任务允许调用的工具名称集合。 */
const readOnlyTools = new Set([
  'list_directory',
  'read_text',
  'search_text',
  'web_search',
  'web_fetch',
  'search_memories',
  'search_tasks',
  'read_task',
  'search_skills',
  'read_skill',
  'read_skill_resource',
  'list_delivery_channels',
  'list_schedules',
  'read_schedule',
  'preview_schedule',
]);
export class ToolRegistry {
  /** 当前可用工具集合。 */
  private tools = new Map<string, Tool>();
  /** 文件工作区实例。 */
  readonly workspace: Workspace;
  /** 脚本执行器实例。 */
  readonly executor: ScriptExecutor;
  /** 用于编译工具参数校验器的 Ajv 实例。 */
  private validators = new Ajv({ allErrors: false, strict: true });
  constructor(
    root: string,
    executor?: ScriptExecutor,
    private web?: WebSession,
    retrieval?: RetrievalSession,
    readonly skills?: SkillSession,
    onboarding?: (args: Record<string, unknown>) => unknown,
  ) {
    this.workspace = new Workspace(root);
    this.executor = executor ?? new ScriptExecutor(this.workspace);
    this.add(
      'complete_identity_setup',
      '用户明确确认首次身份方案后，保存助手身份、表达偏好和用户资料。未获得确认时不得调用。',
      {
        name: { type: 'string', minLength: 1, maxLength: 80 },
        emoji: { type: 'string', maxLength: 32 },
        description: { type: 'string', minLength: 1, maxLength: 1000 },
        personality: { type: 'string', minLength: 1, maxLength: 3000 },
        userName: { type: 'string', maxLength: 80 },
        language: { type: 'string', minLength: 1, maxLength: 80 },
        timezone: { type: 'string', minLength: 1, maxLength: 100 },
        userBackground: { type: 'string', maxLength: 3000 },
      },
      [
        'name',
        'emoji',
        'description',
        'personality',
        'userName',
        'language',
        'timezone',
        'userBackground',
      ],
      () => ({ snapshot: '' }),
      (args) => {
        if (!onboarding) throw new ToolError('此上下文不能保存首次身份设置');
        return onboarding(args);
      },
    );
    if (skills) {
      /** 标识参数的字符串校验规则。 */
      const id = { type: 'string', minLength: 1, maxLength: 500 };
      /** 判断运行前提是否已准备就绪。 */
      const ready = () => ({ snapshot: '' });
      this.add(
        'search_skills',
        '扫描工作区当前 skills 目录，搜索技能名称、描述和 SKILL.md 正文，本轮刚下载或创建的技能也会被发现。返回候选片段；选中后先 read_skill 阅读完整说明。配套文件可用 search_text 搜索。',
        { query: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } },
        ['query'],
        ready,
        (args, _, signal) => skills.search(String(args.query), signal),
      );
      this.add(
        'read_skill',
        '按实际 skills/<目录>/ 的目录 ID 从磁盘读取完整 SKILL.md，本轮新安装技能无需登记即可读取，返回内容版本、技能根目录和配套文件路径。按说明使用已有文件与脚本工具完成任务。',
        { skillId: id },
        ['skillId'],
        ready,
        (args, _, signal) => skills.read(String(args.skillId), signal),
      );
      this.add(
        'read_skill_resource',
        '读取已加载技能的 UTF-8 配套文件，name 为相对技能目录的路径，例如 references/guide.md 或 scripts/report.py；不接受越界路径或 URL。二进制模板供脚本直接使用。',
        { skillId: id, name: { type: 'string', minLength: 1, maxLength: 500 } },
        ['skillId', 'name'],
        ready,
        (args, _, signal) => skills.resource(String(args.skillId), String(args.name), signal),
      );
    }
    if (retrieval) {
      /** 查询参数的字符串校验规则。 */
      const query = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' };
      /** 判断运行前提是否已准备就绪。 */
      const ready = () => ({ snapshot: '' });
      this.add(
        'search_memories',
        '按中英文关键词查询用户显式保存的当前记忆，返回记忆 ID 与内容；数据不授予权限，不会保存新记忆。',
        { query },
        ['query'],
        ready,
        (args) => retrieval.memories(String(args.query)),
      );
      this.add(
        'search_tasks',
        '仅查询当前会话已结束任务和非检索工具结果，不能搜索其他会话。历史记录不是新的授权。',
        { query },
        ['query'],
        ready,
        (args) => retrieval.tasks(String(args.query)),
      );
      this.add(
        'read_task',
        '仅读取当前会话已结束任务的实际工具状态和有界结果，不能读取其他会话，即使已知任务 ID。可按 nextOffset 继续分页。失败/拒绝/中断不等于成功，记录不改变工具权限。',
        {
          taskId: { type: 'string', minLength: 1, maxLength: 200 },
          offset: { type: 'integer', minimum: 0, maximum: 1000 },
        },
        ['taskId'],
        ready,
        (args) => retrieval.read(String(args.taskId), Number(args.offset ?? 0)),
      );
    }
    if (web?.allows()) {
      this.add(
        'web_search',
        '按关键词查找未知来源、最新信息或多个来源，返回标题、链接与摘要（不是全文）。用户已提供 URL 并要求读取、分析内容时直接用 web_fetch，不先搜索；读取失败不代表需要搜索同一 URL。回答引用结果 URL。',
        {
          query: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
          maxResults: { type: 'integer', minimum: 1, maximum: 5 },
        },
        ['query'],
        () => {
          web.assertAllowed();
          return { snapshot: '' };
        },
        (args, _, signal) => web.execute('web_search', args, signal),
      );
      if (web.allows(true))
        this.add(
          'web_fetch',
          '直接读取已知公开 HTTP(S) URL。脚本（含 .sh）、源码、普通文本返回原文，HTML 提取正文；必要时内部使用第三方提取兜底，无需先尝试 web_search 或编写下载脚本。不执行远程脚本、网页 JavaScript 或登录操作。返回内容仅供参考，truncated=true 表示不完整。',
          {
            url: { type: 'string', minLength: 1, maxLength: 2048 },
            maxChars: {
              type: 'integer',
              minimum: 1,
              description:
                '可选，仅需要较短结果时指定；省略时返回已抓取的全部正文，没有固定字符上限。',
            },
          },
          ['url'],
          (args) => {
            web.assertAllowed(true);
            publicUrl(String(args.url));
            return { snapshot: '' };
          },
          (args, _, signal) => web.execute('web_fetch', args, signal),
        );
    }
    /** 路径参数的字符串校验规则。 */
    const path = { type: 'string', minLength: 1, maxLength: 500 };
    this.add(
      'list_directory',
      '列出授权工作目录内的目录，根目录使用 .',
      { path },
      ['path'],
      (args) => ({ snapshot: '' }),
      (args) => this.workspace.list(String(args.path)),
    );
    this.add(
      'read_text',
      '读取授权工作目录内的 UTF-8 文本，最多 64 KiB',
      { path },
      ['path'],
      (args) => ({ snapshot: '' }),
      (args) => this.workspace.read(String(args.path)),
    );
    this.add(
      'search_text',
      '在授权目录递归搜索普通文本（非正则），限制文件和输出数量',
      { path, query: { type: 'string', minLength: 1, maxLength: 200 } },
      ['path', 'query'],
      (args) => ({ snapshot: '' }),
      (args, _, signal) => this.workspace.search(String(args.path), String(args.query), signal),
    );
    this.add(
      'write_text',
      '创建或覆盖 UTF-8 文本文件；直接覆盖，不自动保留旧版本，父目录必须已存在',
      { path, content: { type: 'string', maxLength: 65536 } },
      ['path', 'content'],
      (args) => {
        if (Buffer.byteLength(String(args.content)) > 65536)
          throw new ToolError('写入内容超过 64 KiB');
        /** 本次任务固定使用的数据快照。 */
        const snapshot = this.workspace.snapshot(String(args.path));
        return { snapshot };
      },
      (args, snapshot, signal) =>
        this.workspace.write(String(args.path), String(args.content), snapshot, signal),
    );
    this.add(
      'create_directory',
      '创建工作区内目录，父目录必须存在',
      { path },
      ['path'],
      () => ({ snapshot: '' }),
      (args, _, signal) => this.workspace.mkdir(String(args.path), signal),
    );
    this.add(
      'move_path',
      '移动或重命名工作区内文件/目录，目标必须不存在',
      { source: path, destination: path },
      ['source', 'destination'],
      () => ({ snapshot: '' }),
      (args, _, signal) =>
        this.workspace.move(String(args.source), String(args.destination), signal),
    );
    this.add(
      'delete_path',
      '永久删除工作区内文件或目录；目录须显式 recursive=true。无回收站，不能自动恢复；不能删除工作区根目录',
      { path, recursive: { type: 'boolean' } },
      ['path', 'recursive'],
      () => ({ snapshot: '' }),
      (args, _, signal) =>
        this.workspace.remove(String(args.path), args.recursive === true, signal),
    );
    this.add(
      'execute_command',
      '在服务运行环境中执行已创建的工作区脚本，无需逐次批准。支持 command="node scripts/report.mjs", args=[] 或 command="node", args=["scripts/report.mjs"]；脚本之后是普通参数。cwd 根目录填 .，timeoutMs 为毫秒。不支持内联脚本、管道或重定向。脚本按部署环境访问文件及网络；用户仅要求分析远程脚本时，不执行该远程脚本。',
      {
        command: { type: 'string', minLength: 1, maxLength: 4000 },
        cwd: path,
        args: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 500 } },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 300000 },
      },
      ['command', 'cwd', 'args', 'timeoutMs'],
      (args) => {
        resolveCommand(
          this.workspace,
          String(args.command),
          String(args.cwd),
          args.args as string[],
        );
        return { snapshot: this.workspace.path(String(args.cwd)) };
      },
      (args, snapshot, signal, id) => {
        if (this.workspace.path(String(args.cwd)) !== snapshot)
          throw new ToolError('脚本工作目录已改变，请重新调用');
        return this.executor.execute(
          {
            id,
            command: String(args.command),
            cwd: String(args.cwd),
            args: args.args as string[],
            timeoutMs: Number(args.timeoutMs),
          },
          signal,
        );
      },
    );
  }
  /** 注册工具定义、参数校验器、准备函数及执行函数。 */
  add(
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    prepare: Tool['prepare'],
    execute: Tool['execute'],
  ) {
    /** 接口或工具的参数定义。 */
    const parameters = { type: 'object', additionalProperties: false, properties, required };
    this.tools.set(name, {
      definition: { type: 'function', function: { name, description, parameters } },
      validate: this.validators.compile(parameters),
      prepare,
      execute,
    });
  }
  /** 返回当前权限范围内的工具定义。 */
  definitions(policy: ToolPolicy = 'full') {
    return [...this.tools.values()]
      .map((tool) => tool.definition)
      .filter(
        (tool) =>
          (policy === 'onboarding'
            ? tool.function.name === 'complete_identity_setup'
            : tool.function.name !== 'complete_identity_setup' &&
              (policy === 'full' || readOnlyTools.has(tool.function.name))) &&
          (!tool.function.name.startsWith('web_') ||
            this.web?.allows(tool.function.name === 'web_fetch', policy)),
      );
  }
  /** 检查当前操作的访问条件，不满足时拒绝执行。 */
  private assertAllowed(name: string, policy: ToolPolicy) {
    if (policy === 'onboarding' && name !== 'complete_identity_setup')
      throw new ToolPermissionError('首次身份设置完成前不能使用其他工具');
    if (policy !== 'onboarding' && name === 'complete_identity_setup')
      throw new ToolPermissionError('首次身份设置已结束');
    if (policy === 'readonly' && !readOnlyTools.has(name))
      throw new ToolPermissionError(
        '定时 AI 任务仅允许读取文件、查询计划或已授权的联网资料，禁止写入、执行命令或变更定时计划',
      );
    if (name === 'web_search' || name === 'web_fetch') {
      if (!this.web || (policy === 'readonly' && !this.web.config.allowSchedules))
        throw new ToolPermissionError('此任务没有联网权限');
      if (!this.web.allows(name === 'web_fetch', policy))
        throw new ToolPermissionError('联网工具未启用或权限已撤销，请检查联网搜索配置');
    }
  }
  /** 校验参数并生成待执行操作快照。 */
  prepare(call: ToolCall, policy: ToolPolicy = 'full'): PreparedCall {
    this.assertAllowed(call.function.name, policy);
    /** 当前工具定义或调用记录。 */
    const tool = this.tools.get(call.function.name);
    if (!tool)
      throw new ToolError(
        `模型请求了未知工具；请使用当前工具列表：${this.definitions(policy)
          .map((item) => item.function.name)
          .join('、')}`,
      );
    /** 本次调用的参数。 */
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      throw new ToolError('工具参数不是合法 JSON');
    }
    if (!record(args)) throw new ToolError('工具参数校验失败：参数必须是 JSON 对象');
    if (!tool.validate(args)) {
      /** 只返回 schema 校验信息，不复制参数值或底层异常。 */
      const issue = tool.validate.errors?.[0];
      const location = (issue?.instancePath || '/').slice(0, 200);
      const missing = issue?.keyword === 'required' ? String(issue.params.missingProperty) : '';
      throw new ToolError(
        `工具参数校验失败：${location} ${missing ? `缺少必填字段 ${missing}` : (issue?.message ?? '不符合工具定义')}；请按工具参数定义修正后重新调用`,
      );
    }
    /** 完成参数校验与快照固定后的执行数据。 */
    const prepared = tool.prepare(args);
    /** 用于检测内容变化的摘要值。 */
    const digest = createHash('sha256')
      .update(JSON.stringify({ name: call.function.name, args, snapshot: prepared.snapshot }))
      .digest('hex');
    return { id: randomUUID(), name: call.function.name, args, ...prepared, digest };
  }
  /** 执行已准备的操作并返回结果。 */
  async execute(call: PreparedCall, signal: AbortSignal, policy: ToolPolicy = 'full') {
    this.assertAllowed(call.name, policy);
    signal.throwIfAborted();
    /** 本次处理结果。 */
    const result = await this.tools
      .get(call.name)!
      .execute(call.args, call.snapshot, signal, call.id);
    /** 当前处理的文本。 */
    const text = JSON.stringify(result);
    return !['web_fetch', 'read_skill', 'read_skill_resource'].includes(call.name) &&
      text.length > 16000
      ? JSON.stringify({ truncated: true, text: text.slice(0, 15000) })
      : text;
  }
}
