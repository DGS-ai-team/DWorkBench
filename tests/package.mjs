import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { freePort, until } from './load-support.mjs';

const root = process.cwd(), folder = path.join(root, 'artifacts/windows/DWorkBench');
for (const file of ['DWorkBench.Server.exe', 'Install-Windows.ps1', 'DEPLOYMENT.md', 'LICENSE', 'licenses/npm/re2js/LICENSE'])
  await access(path.join(folder, file));
const hash = createHash('sha256').update(await readFile(folder + '.zip')).digest('hex');
assert.equal((await readFile(folder + '.zip.sha256', 'utf8')).trim(), hash + '  DWorkBench.zip');
await mkdir(path.join(root, '.local'), { recursive: true });
const storage = await mkdtemp(path.join(root, '.local/package-'));
const base = 'http://127.0.0.1:' + await freePort();
const app = spawn(path.join(folder, 'DWorkBench.Server.exe'), [], {
  cwd: folder, windowsHide: true,
  env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Development', ASPNETCORE_URLS: base, Database__Provider: 'Sqlite', Storage__Root: storage, Bootstrap__Token: 'isolated-package-smoke-only' },
});
let output = '';
app.stdout.on('data', value => output += value);
app.stderr.on('data', value => output += value);
const closed = new Promise(resolve => app.once('close', resolve));
try {
  await until(async () => { try { return (await fetch(base + '/api/health')).ok; } catch { return false; } }, 'published application health', 30000);
  const html = await (await fetch(base)).text();
  const entry = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(entry, 'published page includes the built client');
  const response = await fetch(base + entry);
  assert.equal(response.status, 200);
  const js = await response.text();
  const worker = js.match(/assets\/log\.worker-[\w-]+\.js/)?.[0];
  assert.ok(worker, 'client includes a log worker');
  assert.equal((await fetch(base + '/' + worker)).status, 200);
  console.log('PASS Windows package: checksum, executable, health, client, worker and license');
} finally {
  app.kill();
  await closed;
  await writeFile(path.join(storage, 'server.log'), output);
}
