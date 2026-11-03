import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Runs with integration.mjs on SQLite and PostgreSQL against loopback fixtures.
export async function workspaceChecks({ admin, viewer, group, files, fixtures }) {
  const initial = await admin.request('/workspace');
  const other = await viewer.request('/workspace');
  assert.equal(initial.document, null);
  assert.equal(other.document, null);
  assert.notEqual(initial.ownerId, other.ownerId);
  const empty = { version: 1, groupId: null, items: [], reading: [], active: '', pinned: '', vertical: false, split: 50, watchOpen: true };
  const items = files.map(file => ({
    key: randomUUID(), groupId: group.id, sourceId: file.sourceId,
    hostId: file.hostId, path: file.path, encoding: file.encoding,
    settings: { include: 'error|超时', exclude: 'heartbeat', mode: 'regex', caseSensitive: true, format: 'json', jsonField: 'log.level', levelPattern: '', levels: 'all', context: 2 },
    wrap: true, watchRule: { pattern: '*timeout*', mode: 'glob', caseSensitive: false },
  }));
  const document = { ...empty, groupId: group.id, items, reading: items.map(i => i.key), active: items[1].key, pinned: items[0].key, vertical: true, split: 65, watchOpen: false };
  const authentications = fixtures.map(f => f.authenticationCount);
  const saved = await admin.request('/workspace', { ownerId: initial.ownerId, revision: null, document }, 'PUT');
  let loaded = await admin.request('/workspace');
  assert.deepEqual(loaded.document, document, 'all layout and filtering preferences round-trip');
  assert.equal(loaded.revision, saved.revision);
  assert.ok(loaded.resolved.every(r => r.file && !r.issue));
  assert.deepEqual(loaded.resolved.map(r => r.file.id), files.map(f => f.id));
  assert.equal((await viewer.request('/workspace')).document, null, 'another account starts empty');
  await viewer.request('/workspace', { ownerId: initial.ownerId, revision: null, document }, 'PUT', 401);
  await viewer.request('/workspace/resolve', { ownerId: initial.ownerId, items }, 'POST', 401);
  await viewer.request('/workspace', { ownerId: other.ownerId, revision: null, document }, 'PUT');
  const scoped = await viewer.request('/workspace');
  assert.ok(scoped.resolved[0].file);
  assert.equal(scoped.resolved[1].file, null, 'saved references cannot bypass host grants');
  assert.ok(scoped.resolved[1].issue);

  // Two pages submit the same base revision concurrently; exactly one wins.
  const competing = await Promise.all([51, 52].map(split => fetch(admin.base + '/api/workspace', {
    method: 'PUT', headers: { Cookie: admin.cookie(), 'X-CSRF-Token': admin.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId: initial.ownerId, revision: saved.revision, document: { ...document, split } }),
  }).then(async response => ({ status: response.status, body: await response.json() }))));
  assert.deepEqual(competing.map(r => r.status).sort(), [200, 409]);
  loaded = await admin.request('/workspace');
  assert.equal(loaded.revision, competing.find(r => r.status === 200).body.revision);
  await admin.request('/workspace', { ownerId: initial.ownerId, revision: saved.revision, document }, 'PUT', 409);
  await admin.request('/workspace', { ownerId: initial.ownerId, revision: null, document }, 'PUT', 409);

  for (const invalid of [
    { ...document, version: 2 }, { ...document, split: 80 },
    { ...document, active: randomUUID() }, { ...document, reading: [items[0].key, items[0].key] },
    { ...document, items: Array.from({ length: 5 }, () => ({ ...items[0], key: randomUUID() })) },
    { ...document, items: [{ ...items[0], path: '/var/log/../secret' }] },
    { ...document, items: [{ ...items[0], settings: { ...items[0].settings, include: 'x'.repeat(513) } }] },
  ]) await admin.request('/workspace', { ownerId: initial.ownerId, revision: loaded.revision, document: invalid }, 'PUT', 400);
  assert.equal((await admin.request('/workspace')).revision, loaded.revision, 'invalid saves do not modify stored state');

  const invalidReferences = [
    { ...items[0], key: randomUUID(), encoding: 'utf-16' },
    { ...items[0], key: randomUUID(), path: '/var/log/team/missing.log' },
    { ...items[0], key: randomUUID(), path: '/etc/private.log' },
    { ...items[0], key: randomUUID(), sourceId: randomUUID() },
  ];
  const resolved = await admin.request('/workspace/resolve', { ownerId: initial.ownerId, items: invalidReferences });
  assert.ok(resolved.resolved.every(r => !r.file && r.issue), 'changed/missing references are reported independently');
  assert.deepEqual(fixtures.map(f => f.authenticationCount), authentications, 'saving/loading/resolving does not start SSH');
  assert.ok(fixtures.every(f => f.active === 0));
  // Leave admin empty for UI tests; retain viewer references for revocation.
  await admin.request('/workspace', { ownerId: initial.ownerId, revision: loaded.revision, document: empty }, 'PUT');
  console.log('PASS workspace: preferences, account isolation, concurrent revision conflict, validation, current authorization and zero implicit SSH');
}

export async function workspaceBrowserChecks({ page: p, admin, fixtures, until }) {
  const pane = () => p.locator('.log-pane').first();
  const filter = () => pane().getByRole('textbox', { name: /当前缓存/ });
  const active = () => fixtures.reduce((sum, fixture) => sum + fixture.active, 0);
  await filter().fill('request|服务');
  await pane().getByRole('combobox', { name: /匹配方式/ }).selectOption('regex');
  await p.getByRole('button', { name: '切换为上下分窗' }).click();
  await until(async () => {
    const w = await admin.request('/workspace');
    return w.document?.items.length === 2 && w.document.vertical && w.document.items.some(i => i.settings.include === 'request|服务' && i.settings.mode === 'regex');
  });
  await p.reload();
  await p.locator('.log-pane').nth(1).waitFor();
  await until(() => active() === 0);
  assert.equal(await filter().inputValue(), 'request|服务');
  assert.equal(await pane().getByRole('combobox', { name: /匹配方式/ }).inputValue(), 'regex');
  assert.equal(await p.getByRole('button', { name: '切换为左右分窗' }).isVisible(), true);
  assert.equal(await pane().locator('.log-line').count(), 0, 'reload restores preferences without log bodies');
  await p.locator('.workspace-toolbar').getByRole('button', { name: '恢复接收', exact: true }).click();
  await until(() => active() === 2);
  const remote = await admin.request('/workspace');
  await admin.request('/workspace', { ownerId: remote.ownerId, revision: remote.revision, document: { ...remote.document, vertical: false } }, 'PUT');
  await filter().fill('local draft');
  await p.getByRole('button', { name: '加载已保存版本', exact: true }).waitFor();
  await p.reload();
  await p.getByRole('button', { name: '加载已保存版本', exact: true }).waitFor();
  assert.equal(await filter().inputValue(), 'local draft', 'unsynced draft survives reload');
  assert.equal((await admin.request('/workspace')).document.vertical, false, 'reload must not overwrite a competing version');
  await p.getByRole('button', { name: '加载已保存版本', exact: true }).click();
  await p.getByRole('button', { name: '切换为上下分窗' }).waitFor();
  await p.locator('.account-button').click();
  await p.getByRole('button', { name: '退出登录', exact: true }).click();
  await p.getByLabel('登录名', { exact: true }).fill('admin');
  await p.getByLabel('密码', { exact: true }).fill('IntegrationAdmin123');
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await p.locator('.log-pane').nth(1).waitFor();
  await until(() => active() === 0);
  assert.equal(await filter().inputValue(), 'request|服务');
  // Logout rotates the account security stamp, including the API test session.
  admin.cookies.clear();
  await admin.login('admin', 'IntegrationAdmin123');
  console.log('PASS workspace browser: autosave, refresh, manual resume, conflicting draft persists, load saved version and re-login');
}
