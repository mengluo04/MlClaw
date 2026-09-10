import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const image = process.env.MLCLAW_TEST_IMAGE;
if (!image) throw new Error('请设置 MLCLAW_TEST_IMAGE 为待验收镜像');
const name = `mlclaw-smoke-${randomBytes(6).toString('hex')}`;
const volumes = [`${name}-data`, `${name}-workspace`];
const password = randomBytes(24).toString('hex');
function docker(args, check = true) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000 });
  if (check && result.status !== 0) throw new Error(`Docker ${args[0]} 失败：${String(result.stderr).replaceAll(password, '[REDACTED]')}`);
  return result.stdout.trim();
}
let base;
const origin = 'http://127.0.0.1:3000';
async function ready() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('容器未能就绪');
}
function start() {
  docker(['run', '-d', '--name', name, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=256', '--memory=1g', '--cpus=2', '--tmpfs', '/tmp:size=64m,mode=1777', '-p', '127.0.0.1::3000', '-v', `${volumes[0]}:/app/data`, '-v', `${volumes[1]}:/app/workspace`, '-e', 'NODE_ENV=development', '-e', `APP_ORIGIN=${origin}`, '-e', `ADMIN_PASSWORD=${password}`, image]);
  base = `http://${docker(['port', name, '3000/tcp'])}`;
}
try {
  start();
  await ready();
  const home = await fetch(base);
  assert.equal(home.status, 200);
  const html = await home.text();
  const asset = html.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
  assert.ok(asset, '首页包含构建后的脚本');
  assert.equal((await fetch(base + asset)).status, 200);
  assert.equal((await fetch(`${base}/api/auth/me`)).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const conversation = await fetch(`${base}/api/conversations`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: '容器重建持久化验收' }) });
  assert.equal(conversation.status, 200);
  const { id } = await conversation.json();
  assert.notEqual(docker(['exec', name, 'id', '-u']), '0');
  docker(['exec', name, 'node', '-e', "require('node:fs').writeFileSync('/app/workspace/probe.txt','persistent')"]);
  docker(['exec', name, 'node', '-e', "const fs=require('node:fs'); for(const p of ['/app/apps/server/.env','/app/.git','/var/run/docker.sock']) if(fs.existsSync(p)) process.exit(1); try { fs.writeFileSync('/app/should-not-write','x'); process.exit(1); } catch(e) { if(e.code!=='EROFS' && e.code!=='EACCES') throw e; }"]);
  docker(['stop', '-t', '30', name]);
  assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', name]), '0');
  docker(['rm', name]);
  start();
  await ready();
  assert.equal((await fetch(`${base}/api/conversations/${id}`, { headers: { cookie } })).status, 200);
  assert.equal(docker(['exec', name, 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/app/workspace/probe.txt','utf8'))"]), 'persistent');
  console.log('容器验收通过：首页、资源、认证、非 root、只读根目录、正常关闭、数据库/会话/工作文件在容器重建后保留。未调用真实模型或命令执行服务。');
} finally {
  docker(['rm', '-f', name], false);
  for (const volume of volumes) docker(['volume', 'rm', volume], false);
}
