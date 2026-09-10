import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 将安装包自带的许可与声明一起放入镜像，覆盖被打包的前端依赖。
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const sections = ['MlClaw 构建依赖与运行依赖的第三方许可\n精确依赖版本见 package-lock.json；以下为当前构建平台实际安装包的上游声明。'];
for (const [directory, entry] of Object.entries(lock.packages)) {
  if (!directory.includes('node_modules/') || entry.link || !existsSync(join(directory, 'package.json'))) continue;
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const files = readdirSync(directory).filter(file => /^(?:licen[sc]e|copying|copyright|notice)(?:[-.]|$)/i.test(file));
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  sections.push(`\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\n声明许可：${pkg.license ?? entry.license ?? '见上游说明'}\n作者：${author ?? '见下方许可或上游仓库'}\n仓库：${repository ?? pkg.homepage ?? '见 npm 包页面'}\n`);
  for (const file of files) sections.push(`${file}\n${readFileSync(join(directory, file), 'utf8')}`);
  if (!files.length) {
    sections.push('该发布包未附独立许可文件，以上保留其 package.json 许可及作者声明。');
    const readme = readdirSync(directory).find(file => /^readme(?:\.|$)/i.test(file));
    if (readme) sections.push(readFileSync(join(directory, readme), 'utf8'));
  }
}
mkdirSync('dist', { recursive: true });
writeFileSync('dist/THIRD_PARTY_LICENSES.txt', sections.join('\n'));
console.log('已生成 dist/THIRD_PARTY_LICENSES.txt');
