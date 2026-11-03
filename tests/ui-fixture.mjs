// Interactive, isolated fixture for browser regression through the normal UI.
// node tests/ui-fixture.mjs; stdin: status | rate N | ssh-drop | web-drop | quit
// Uses temporary app storage and loopback SSH servers; never reads user hosts.
import net from 'node:net';
import readline from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { startApp, sshFixture, configure, until } from './load-support.mjs';

const fixtures = [], sockets = new Set();
let app, proxy, blockedUntil = 0;
try {
  app = await startApp('stage1-ui');
  const targets = [];
  for (const name of ['api.log', 'worker.log', 'access.log', 'jobs.log']) {
    const fixture = await sshFixture(name); fixtures.push(fixture);
    targets.push(await configure(app, fixture));
    fixture.setRate(20);
  }
  const group = await app.admin.request('/groups', {
    name: '第一阶段回归', description: '四台隔离 SSH 模拟主机',
    sourceIds: targets.map(t => t.source.id),
  });
  const destination = new URL(app.base);
  proxy = net.createServer(client => {
    if (Date.now() < blockedUntil) { client.destroy(); return; }
    const upstream = net.connect(Number(destination.port), '127.0.0.1');
    sockets.add(client);
    client.on('error', () => {}); upstream.on('error', () => client.destroy());
    client.on('close', () => { sockets.delete(client); upstream.destroy(); });
    upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + proxy.address().port;
  await writeFile(app.storage + '/fixture.json', JSON.stringify({url, groupId:group.id}));
  console.log('READY ' + url + ' | admin / LoadTestAdmin123 | storage ' + app.storage);
  const input = readline.createInterface({ input: process.stdin });
  for await (const line of input) {
    const [command, value] = line.trim().split(/\s+/);
    if (command === 'quit') { input.close(); break; }
    if (command === 'rate') fixtures.forEach(f => f.setRate(Number(value)));
    if (command === 'ssh-drop') fixtures[0].disconnect();
    if (command === 'web-drop') {
      blockedUntil = Date.now() + 5000;
      for (const socket of sockets) socket.destroy();
    }
    if (command === 'released') await until(async () => {
      const status = await app.admin.request('/streams/status');
      return status.readers === 0 && status.subscriptions === 0;
    }, 'browser resources released');
    console.log(JSON.stringify({command, status:await app.admin.request('/streams/status'), ssh:fixtures.map(f => ({name:f.filename, active:f.active, starts:f.starts}))}));
  }
} finally {
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise(r => proxy.close(r));
  if (app) await app.close();
  for (const fixture of fixtures) await fixture.close();
}
