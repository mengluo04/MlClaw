import { execFileSync } from 'node:child_process';

const publicDocs = new Set([
  'LOCAL_USAGE.md', 'DEPLOYMENT.md', 'CHANNELS.md', 'SCHEDULES.md',
  'WEB_SEARCH.md', 'CONTEXT_MEMORY.md', 'SKILLS.md', 'THIRD_PARTY_NOTICES.md',
]);
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const rejected = files.filter(file => {
  if (file.startsWith('docs/') && !publicDocs.has(file.slice(5))) return true;
  if (/(^|\/)(AGENTS\.md|\.arts|\.codex|\.idea|\.vscode|data|workspace|node_modules|dist)(\/|$)/.test(file)) return true;
  if (/(^|\/)\.env(?:\..*)?$/.test(file) && !file.endsWith('/.env.example') && file !== '.env.example') return true;
  return /\.(?:sqlite(?:-wal|-shm)?|db|log|tsbuildinfo)$/.test(file);
});
if (rejected.length) {
  console.error('以下文件不应进入公开仓库：\n' + rejected.join('\n'));
  process.exitCode = 1;
} else console.log(`公开文件检查通过：${files.length} 个跟踪文件。`);
