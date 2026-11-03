import assert from 'node:assert/strict';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function reviewApiChecks({ admin, Client, group, fa, sa, sb, ha, fixture, until }) {
  const sourceInput = { hostId: ha.id, name: 'review source', directory: '/var/log/team', pattern: 'worker.log', encoding: 'utf-8' };
  for (const encoding of ['utf-16', 'unicode', 'utf-16BE', 'utf-32'])
    await admin.request('/sources', { ...sourceInput, encoding }, 'POST', 400);
  const extra = await admin.request('/sources', sourceInput);
  const target = await admin.request('/groups', { name: 'review target', description: '', sourceIds: [sa.id] });
  const origin = await admin.request('/groups', { name: 'review origin', description: '', sourceIds: [extra.id] });
  const user = await admin.request('/users', { username: 'reviewmaintainer', displayName: 'Review maintainer', role: 'Maintainer', password: 'ReviewMaintainer123', enabled: true });
  const grants = [target, origin].map(g => ({ scope: 'group', resourceId: g.id, download: false, manage: true }));
  grants.push({ scope: 'host', resourceId: ha.id, download: false, manage: true });
  await admin.request(`/users/${user.id}/grants`, grants, 'PUT', 204);
  const maintainer = new Client(admin.base);
  await maintainer.login('reviewmaintainer', 'ReviewMaintainer123');
  const update = sourceIds => ({ name: 'review target', description: '', sourceIds });
  await maintainer.request(`/groups/${target.id}`, update([sa.id, extra.id]), 'PUT', 204);
  await maintainer.request(`/groups/${target.id}`, update([sa.id]), 'PUT', 204);
  await maintainer.request(`/groups/${target.id}`, update([sa.id, extra.id]), 'PUT', 204);
  await maintainer.request(`/groups/${target.id}`, update([sa.id, sb.id]), 'PUT', 403);
  await admin.request(`/users/${user.id}/grants`, grants.filter(g => g.scope === 'host'), 'PUT', 204);
  await maintainer.request(`/groups/${target.id}`, update([sa.id]), 'PUT', 403);
  await admin.request(`/groups/${target.id}`, {}, 'DELETE', 204);
  await admin.request(`/groups/${origin.id}`, {}, 'DELETE', 204);
  await admin.request(`/sources/${extra.id}`, {}, 'DELETE', 204);

  for (const revoke of ['grants', 'disabled']) {
    const username = 'queued' + revoke;
    const account = await admin.request('/users', { username, displayName: username, role: 'Viewer', password: 'QueuedDownload123', enabled: true });
    await admin.request(`/users/${account.id}/grants`, [
      { scope: 'group', resourceId: group.id, download: true, manage: false },
      { scope: 'host', resourceId: ha.id, download: true, manage: false },
    ], 'PUT', 204);
    const queuedUser = new Client(admin.base);
    await queuedUser.login(username, 'QueuedDownload123');
    const url = `${admin.base}/api/groups/${group.id}/files/${fa.id}/download`;
    const download = client => fetch(url, { headers: { Cookie: client.cookie() } });
    fixture.holdDownloads();
    const blockers = [download(admin), download(admin)];
    let queued;
    try {
      await until(() => fixture.pendingReads >= 2);
      const authentications = fixture.authenticationCount;
      let settled = false;
      queued = download(queuedUser).then(response => { settled = true; return response; });
      await delay(250);
      assert.equal(settled, false, 'request waits for an occupied quota slot');
      if (revoke === 'grants') await admin.request(`/users/${account.id}/grants`, [], 'PUT', 204);
      else await admin.request(`/users/${account.id}`, { username, displayName: username, role: 'Viewer', password: null, enabled: false }, 'PUT');
      await delay(150);
      assert.equal(settled, false, 'queued request has passed its original authorization');
      fixture.releaseDownloads();
      const response = await queued;
      assert.equal(response.status, revoke === 'grants' ? 403 : 401);
      await response.text();
      assert.equal(fixture.authenticationCount, authentications, 'revoked queued request must not open any remote connection');
    } finally {
      fixture.releaseDownloads();
      await Promise.all(blockers.map(async response => (await response).arrayBuffer()));
      if (queued) await (await queued).arrayBuffer().catch(() => {});
    }
  }
  console.log('PASS review API: queued-download revocation/disable, independent group/host management grants, UTF-16/32 rejection');
}

export async function reviewBrowserChecks({ page: p, admin, fixtures, until }) {
  // Hold an older audit response until the new filter has already rendered.
  let releaseOld, oldStarted = false;
  const oldGate = new Promise(resolve => releaseOld = resolve);
  await p.route('**/api/audit?**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('q') !== 'review-race') return route.continue();
    const denied = url.searchParams.get('result') === 'denied';
    if (!denied) { oldStarted = true; await oldGate; }
    const row = { id: denied ? 2 : 1, at: Date.now(), actor: 'review', action: 'login', target: denied ? 'current-denied-result' : 'obsolete-success-result', result: denied ? 'denied' : 'success', correlationId: 'fixture' };
    await route.fulfill({ json: [row] }).catch(() => {});
  });
  await p.getByRole('button', { name: '操作审计', exact: true }).click();
  await p.getByRole('textbox', { name: '搜索审计记录' }).fill('review-race');
  await until(() => oldStarted);
  await p.getByRole('combobox', { name: '筛选审计结果' }).selectOption('denied');
  await p.getByText('current-denied-result', { exact: true }).waitFor();
  releaseOld();
  await delay(300);
  assert.equal(await p.getByText('obsolete-success-result', { exact: true }).count(), 0);
  assert.equal(await p.getByText('current-denied-result', { exact: true }).isVisible(), true);
  await p.unroute('**/api/audit?**');
  await p.getByRole('button', { name: '日志工作台', exact: true }).click();

  // A changed password rotates the stamp; every new stream must use a fresh hub.
  await p.locator('.workspace-toolbar').getByRole('button', { name: '恢复接收', exact: true }).click();
  await until(() => fixtures.every(f => f.active === 1));
  async function password(current, next) {
    await p.locator('.account-button').click();
    await p.getByRole('button', { name: '修改密码', exact: true }).click();
    const dialog = p.getByRole('dialog');
    await dialog.getByLabel('当前密码', { exact: true }).fill(current);
    await dialog.getByLabel(/^新密码/).fill(next);
    await dialog.getByLabel('再次输入新密码', { exact: true }).fill(next);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  await password('IntegrationAdmin123', 'UpdatedAdmin12345');
  await until(() => fixtures.every(f => f.active === 0));
  await p.locator('.log-pane').first().getByRole('button', { name: '重新连接', exact: true }).click();
  await until(() => fixtures.reduce((sum, f) => sum + f.active, 0) === 1);
  await password('UpdatedAdmin12345', 'IntegrationAdmin123');
  await until(() => fixtures.every(f => f.active === 0));
  admin.cookies.clear();
  await admin.login('admin', 'IntegrationAdmin123');

  const other = await p.context().newPage();
  await other.goto(admin.base);
  await other.locator('.log-pane').nth(1).waitFor();
  // Block only workspace writes. Loading and the rest of the application remain
  // available, reproducing unsynced edits in two tabs without using real hosts.
  const blockSave = route => route.request().method() === 'PUT' ? route.abort() : route.continue();
  await p.route('**/api/workspace', blockSave);
  await other.route('**/api/workspace', blockSave);
  const filter = page => page.locator('.log-pane').first().getByRole('textbox', { name: /当前缓存/ });
  await filter(other).fill('offline-other-tab');
  await until(async () => (await other.locator('.workspace-save-error').count()) > 0);
  await other.close();
  // Unchanged page exit must preserve the other tab's only recovery copy.
  await p.goto('about:blank');
  await p.unroute('**/api/workspace', blockSave);
  await p.goto(admin.base);
  await until(async () => await filter(p).inputValue() === 'offline-other-tab');
  await until(async () => (await admin.request('/workspace')).document.items.some(i => i.settings.include === 'offline-other-tab'));
  const dirty = await p.context().newPage();
  await dirty.goto(admin.base);
  await dirty.locator('.log-pane').nth(1).waitFor();
  await p.route('**/api/workspace', blockSave);
  await dirty.route('**/api/workspace', blockSave);
  await filter(p).fill('offline-draft-A');
  await filter(dirty).fill('offline-draft-B');
  await until(async () => p.evaluate(() => {
    const values = Object.keys(localStorage).filter(k => k.startsWith('logdesk:workspace-draft:v2:')).map(k => localStorage.getItem(k)).join('\n');
    return values.includes('offline-draft-A') && values.includes('offline-draft-B');
  }));
  await dirty.close();
  await p.goto('about:blank');
  const drafts = await p.context().newPage();
  await drafts.goto(admin.base);
  await drafts.locator('.log-pane').nth(1).waitFor();
  await drafts.close();
  // Keep the caller's page available for its final screenshot.
  await p.unroute('**/api/workspace', blockSave);
  await p.goto(admin.base);
  await p.locator('.log-pane').nth(1).waitFor();
  console.log('PASS review browser: obsolete audit response, password hub renewal, unchanged-tab exit and independent unsynced drafts');
}
