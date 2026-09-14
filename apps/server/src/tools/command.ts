import { ToolError, Workspace } from './files.js';
import { lstatSync } from 'node:fs';

/** 拒绝解释器的内联代码与模块入口。 */
const assertScriptMode = (words: string[]) => {
  if (
    /(^|\/)(python[\d.]*|node|sh|bash|dash|zsh|ksh|perl|ruby|php|lua|pwsh|powershell|cmd|env|busybox)(\.exe)?$/i.test(
      words[0]!,
    ) &&
    words.slice(1).some((value) => /^(?:-c|-e|-m|--eval|--command)(?:=|$)/i.test(value))
  )
    throw new ToolError('请调用脚本文件，不支持内联脚本或模块入口');
};

// 只解析一个程序及其参数；组合逻辑放在脚本文件中，不隐式解释 Shell 表达式。
export const commandWords = (command: string): string[] => {
  /** 解析得到的词项列表。 */
  const words: string[] = [];
  /** 当前处理的词项；当前命令解析所处的引号状态；本次执行的开始时间或启动状态。 */
  let word = '',
    quote = '',
    started = false;
  for (/* 逐项处理字符。 */ const char of command) {
    if (/[\x00-\x1f]/.test(char)) throw new ToolError('命令必须为单行');
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
      started = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
    } else {
      if (/[;&|<>`$\\()]/.test(char))
        throw new ToolError('仅支持单条命令；管道、重定向和组合操作请写入脚本文件');
      word += char;
      started = true;
    }
  }
  if (quote) throw new ToolError('命令引号未闭合');
  if (started) words.push(word);
  if (!words[0] || words.length > 33 || words.some((value) => value.length > 500))
    throw new ToolError('命令或参数长度超出限制');
  assertScriptMode(words);
  return words;
};

/** 解析命令入口、参数和工作目录。 */
export const resolveCommand = (
  workspace: Workspace,
  command: string,
  cwd: string,
  args: string[] = [],
) => {
  /** 当前目录。 */
  const directory = workspace.path(cwd);
  if (!lstatSync(directory).isDirectory()) throw new ToolError('工作目录必须是已有目录');
  if (
    args.length > 32 ||
    args.some((value) => typeof value !== 'string' || value.length > 500 || value.includes('\0'))
  )
    throw new ToolError('脚本参数无效');
  /** 合并两种传参方式，仅定位脚本入口，不把 URL 或输出文件参数当作入口。 */
  const words = [...commandWords(command), ...args];
  const scriptIndex = words.findIndex(
    (value, index) =>
      (index === 0 && value.includes('/')) || /\.(py|sh|bash|js|mjs|cjs|ps1)$/i.test(value),
  );
  if (scriptIndex < 0)
    throw new ToolError(
      '请指定工作区内的脚本文件，例如 command="node", args=["scripts/report.mjs"]',
    );
  // 入口前的解释器参数同样校验，不能通过独立 args 绕过内联脚本限制。
  assertScriptMode(words.slice(0, scriptIndex + 1));
  {
    /** 唯一需要校验的脚本入口。 */
    const file = words[scriptIndex]!;
    /** 当前操作使用的路径。 */
    const path = (cwd === '.' ? '' : cwd + '/') + file.replace(/^\.\//, '');
    try {
      if (!lstatSync(workspace.path(path)).isFile())
        throw new ToolError('脚本必须是工作区内的普通文件');
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError('脚本入口不可读取，请先在工作区创建脚本并检查路径');
    }
  }
  return { executable: words[0]!, args: words.slice(1), directory };
};
