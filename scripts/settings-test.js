const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { once } = require('events');
const { fixtureSource } = require('./settings-fixture');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await delay(80); }
  throw new Error(message);
}

async function main() {
  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-plus-settings-'));
  let child, watcher, mock;
  try {
    process.env.DATA_DIR = path.join(run, 'unit-data');
    process.env.ADMIN_PASS = 'ignored-password';
    process.env.DEEPSEEK_API_KEY = 'ignored-test-key';
    const paths = require('../lib/runtimePaths');
    paths.LIBRARY_DIR = path.join(run, 'mounts');
    const a = path.join(paths.LIBRARY_DIR, 'a');
    const b = path.join(paths.LIBRARY_DIR, 'b');
    await fs.mkdir(path.join(a, 'nested'), { recursive: true });
    await fs.mkdir(b, { recursive: true });
    mock = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'gpt-5.4-mini' }] })); });
    mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
    const unitBaseUrl = 'http://127.0.0.1:' + mock.address().port;
    const store = require('../lib/settingsStore');
    const auth = require('../lib/auth');
    await store.initialize();
    assert.equal(store.snapshot().cache.maxSizeMb, 150, 'new servers default to 150 MB');
    assert.equal(store.snapshot().sources.length, 2, 'discover only first-level directories');
    assert.equal(store.snapshot().libraryConfirmed, false);
    assert.equal(store.secrets().aiApiKey, '', 'legacy secrets are never imported');
    assert.equal((await fs.stat(path.join(paths.CONFIG_DIR, 'secrets.json'))).mode & 0o777, 0o600);
    const first = await auth.login('admin', 'admin');
    assert.equal(first.mustChangePassword, true);
    assert.equal(await auth.login('admin', 'ignored-password'), null);
    assert.equal(await store.checkPassword('wrong', store.secrets().account.password), false);
    await store.updateAccount({ username: 'owner', currentPassword: 'admin', password: 'new-password-1' });
    assert.equal(auth.verifyToken(first.token), null, 'password change revokes all old tokens');
    const token = auth.createToken();
    assert(auth.verifyToken(token));
    assert.equal(auth.verifyToken(token + 'x'), null);
    const save = mutate => { const value = store.snapshot(); mutate?.(value); return store.save(value); };
    await save(s => { s.metadata.aiBaseUrl = unitBaseUrl; s.metadata.aiModel = 'gpt-5.4-mini'; });
    for (const capacity of [63, 4097]) {
      await assert.rejects(() => save(s => { s.cache.maxSizeMb = capacity; }), /缓存容量/);
    }
    await save(s => { s.cache.maxSizeMb = 4096; });
    assert.equal(store.snapshot().cache.maxSizeMb, 4096);
    await save(s => { s.cache.maxSizeMb = 150; });
    let saved = await save(s => { s.scanning.onStart = false; s.sources.forEach(x => { x.watch = false; x.autoScrape = false; }); });
    assert(saved.scanRequired);
    await assert.rejects(() => store.save({ ...saved, revision: 0 }), e => e.status === 409);
    for (const target of ['relative/path', '/', '/app', paths.DATA_DIR, path.join(paths.ROOT_DIR, 'lib')]) {
      await assert.rejects(() => save(s => { s.sources[0].path = target; }), e => e.status === 400);
    }
    await assert.rejects(() => save(s => { s.sources[1].path = s.sources[0].path + '/nested'; }), /嵌套/);
    await assert.rejects(() => save(s => { s.sources[1].path = s.sources[0].path + '/./'; }), /重复/);
    const link = path.join(run, 'alias');
    await fs.symlink(a, link);
    await assert.rejects(() => save(s => { s.sources[1].path = link; }), /重复/);
    await assert.rejects(() => save(s => { s.sources[0].path = path.join(run, 'missing'); }), /不可访问/);
    await assert.rejects(() => save(s => { s.categories.pop(); }), /默认栏目/);
    await assert.rejects(() => save(s => { s.categories.forEach(c => { c.visible = false; }); }), /至少/);
    await save(s => {
      s.sources[0].path += '/./';
      s.categories.push({ id: 'photos', label: '图册', visible: true });
      s.sources[1].mode = 'fixed'; s.sources[1].categoryId = 'photos';
      s.credentials = { aiApiKey: 'fake-only-test-secret', bangumiToken: 'fake-token' };
    });
    assert.equal(store.snapshot().sources[0].path, a);
    assert(!JSON.stringify(await store.publicSettings()).includes('fake-only-test-secret'));
    assert.equal((await store.publicSettings()).credentials.aiApiKeyConfigured, true);
    await save(s => { s.credentials = { aiApiKey: '' }; });
    assert.equal(store.secrets().aiApiKey, 'fake-only-test-secret');
    await save(s => { s.credentials = { clearAiApiKey: true, clearBangumiToken: true }; });
    assert.equal(store.secrets().aiApiKey, '');
    await assert.rejects(() => save(s => { s.categories.pop(); }), /解除/);
    store.setTopologyBusy(() => true);
    await assert.rejects(() => save(s => { s.sources[0].enabled = false; }), e => e.status === 409);
    await save(s => { s.sources[0].name = '显示名称即时更新'; });
    store.setTopologyBusy(() => false);
    assert(!(await fs.readdir(paths.CONFIG_DIR)).some(f => f.endsWith('.tmp')), 'atomic saves clean temporary files');
    const beforeWriteFailure = store.snapshot();
    const secretBeforeWriteFailure = store.secrets();
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (to === path.join(paths.CONFIG_DIR, 'settings.json')) throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
      return rename(from, to);
    };
    try { await assert.rejects(() => save(s => { s.credentials = { aiApiKey: 'must-not-survive' }; }), /disk failure/); }
    finally { fs.rename = rename; }
    assert.deepEqual(store.snapshot(), beforeWriteFailure);
    assert.deepEqual(store.secrets(), secretBeforeWriteFailure, 'failed settings save rolls back credentials');
    assert(!(await fs.readdir(paths.CONFIG_DIR)).some(f => f.endsWith('.tmp')));

    await fs.writeFile(path.join(a, '[稳定作品][作者][Vol.01].epub'), 'fixture');
    await fs.writeFile(path.join(b, '[画集作品][作者][Vol.01].epub'), 'fixture');
    const { scanLibrary } = require('../lib/scanner');
    let scan = await scanLibrary({ fast: true, confirmSettings: true });
    assert.equal(scan.resourceList.length, 2);
    const sourceA = store.snapshot().sources[0];
    const resourceA = scan.resourceList.find(r => r.sourceId === sourceA.id);
    assert.equal(resourceA.category, 'novel');
    assert.equal(scan.resourceList.find(r => r.sourceId !== sourceA.id).category, 'photos');
    const newA = path.join(run, 'moved-source');
    await fs.rename(a, newA);
    await save(s => { s.sources[0].path = newA; s.sources[0].name = '新名字'; });
    const resourcePaths = require('../lib/resourcePaths');
    assert.equal(await resourcePaths.resourcePath(resourceA), await fs.realpath(path.join(newA, resourceA.relativePath)));
    scan = await scanLibrary({ fast: true, confirmSettings: true });
    assert(scan.resourceList.some(r => r.resourceId === resourceA.resourceId), 'rename/repath must preserve resource ID');
    await fs.rename(newA, a);
    saved = await save();
    assert.equal(saved.warnings.length, 1, 'existing offline paths remain configurable');
    scan = await scanLibrary({ fast: true });
    assert(scan.offlineSourceIds.includes(sourceA.id));
    assert(scan.resourceList.some(r => r.resourceId === resourceA.resourceId), 'offline source keeps active index');
    await save(s => { s.sources[0].enabled = false; });
    scan = await scanLibrary({ fast: true });
    assert(!scan.resourceList.some(r => r.sourceId === sourceA.id));
    await save(s => { s.sources[0].enabled = true; s.sources[0].path = a; });
    await scanLibrary({ fast: true, confirmSettings: true });
    const outside = path.join(run, 'outside.png');
    await fs.writeFile(outside, 'not-an-image');
    await fs.symlink(outside, path.join(a, 'escape.png'));
    await assert.rejects(() => resourcePaths.allowedPath(store.snapshot().sources[0], path.join(a, 'escape.png')), /真实路径/);
    await assert.rejects(() => resourcePaths.allowedPath(store.snapshot().sources[0], a), /超出/);
    assert.deepEqual(await require('../lib/utils').walkImages(a), [], 'image traversal skips symlinks');

    const events = [];
    watcher = require('../lib/libraryWatcher').createLibraryWatcher({ enqueueTask: async (type, payload) => events.push({ type, payload }), invalidate() {} });
    await save(s => { s.sources[0].watch = true; });
    await watcher.rebuild();
    assert.deepEqual(watcher.status().paths, [a]);
    await delay(300); // Allow chokidar's initial inventory before generating a real event.
    await fs.writeFile(path.join(a, 'watch.pdf'), 'fixture');
    await until(() => events.length === 1, 'watch event did not enqueue');
    assert.equal(events[0].type, 'scanLibrary');
    assert.deepEqual(events[0].payload.sourceIds, [sourceA.id]);
    assert(events[0].payload.changedPaths.includes(path.join(a, 'watch.pdf')));
    assert(events[0].payload.changedPaths.every(target => store.contains(a, target)));
    assert.equal(events[0].payload.fastScan, true);
    await save(s => { s.sources[0].autoScrape = true; });
    await watcher.rebuild();
    await delay(300);
    await fs.writeFile(path.join(a, 'watch-two.pdf'), 'fixture');
    await until(() => events.length === 2, 'auto scrape event did not enqueue');
    assert.equal(events[1].type, 'scanAndScrape');
    for (let i = 0; i < 40 && events.length === 2; i++) {
      await fs.writeFile(path.join(a, `continuous-${i}.epub`), 'fixture');
      await delay(150);
    }
    assert(events.length > 2, 'continuous additions must flush before the copy stream becomes idle');
    await save(s => { s.sources[0].watch = false; });
    await watcher.rebuild();
    assert.deepEqual(watcher.status().paths, []);
    await watcher.close(); watcher = null;
    await store.resetAccount();
    assert.equal(auth.verifyToken(token), null);
    assert.equal((await auth.login('admin', 'admin')).mustChangePassword, true);

    // Exercise the real HTTP middleware and restart/reset behavior in an isolated process.
    const listener = http.createServer();
    listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const env = { ...process.env, DATA_DIR: path.join(run, 'http-data'), PORT: String(port) };
    let logs = '';
    const start = async () => {
      child = spawn(process.execPath, [path.resolve(__dirname, '../server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
      await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 'server did not start');
    };
    const stop = async () => { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; child = null; };
    let apiToken = '';
    const api = async (url, method = 'GET', body) => {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(apiToken ? { Authorization: 'Bearer ' + apiToken } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    await start();
    assert.equal((await api('/api/settings')).status, 401);
    let response = await api('/api/login', 'POST', { username: 'admin', password: 'admin' });
    apiToken = response.body.token;
    assert(response.body.mustChangePassword);
    assert.equal((await api('/api/settings')).status, 403);
    assert.equal((await api('/api/tasks/scan', 'POST', {})).status, 403);
    assert((await api('/api/verify')).body.mustChangePassword);
    response = await api('/api/account', 'PUT', { currentPassword: 'admin', username: 'owner', password: 'http-password-1' });
    assert.equal(response.status, 200);
    assert.equal((await api('/api/verify')).status, 401);
    apiToken = response.body.token;
    await stop(); await start();
    assert.equal((await api('/api/verify')).status, 200, 'persistent signing key survives restart');
    response = await api('/api/settings');
    assert.equal(response.body.libraryConfirmed, false);
    const input = response.body;
    const httpSource = path.join(run, 'http-library');
    await fs.mkdir(httpSource);
    input.sources = [fixtureSource(httpSource, { id: 'http-source' })];
    input.scanning.onStart = true;
    response = await api('/api/settings', 'PUT', input);
    assert(response.body.scanRequired);
    assert.equal((await api('/api/settings', 'PUT', input)).status, 409);
    const tasksBefore = await api('/api/tasks');
    assert.equal(tasksBefore.body.length, 0, 'saving never starts a scan');
    const scanTask = await api('/api/tasks/scan', 'POST', { scrape: false });
    assert.equal(scanTask.status, 202);
    await until(async () => !(await api('/api/settings')).body.scanRequired, 'manual scan did not clear prompt');
    for (let attempt = 0; attempt < 4; attempt++) {
      assert.equal((await api('/api/comics')).status, 200);
      await delay(100);
    }
    assert.equal((await api('/api/tasks')).body.length, 1, 'reading an empty library must not trigger startup or repeat scans');
    assert.equal((await api('/api/settings/discovered-sources')).status, 200);
    await new Promise(resolve => mock.close(resolve));
    mock = http.createServer((req, res) => { res.writeHead(req.headers.authorization === 'Bearer test-key' ? 200 : 401); res.end('{}'); });
    mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
    const baseUrl = 'http://127.0.0.1:' + mock.address().port;
    response = await api('/api/settings/test/deepseek', 'POST', { baseUrl, apiKey: 'test-key' });
    assert.equal(response.status, 200);
    response = await api('/api/settings/test/deepseek', 'POST', { baseUrl, apiKey: 'wrong-key' });
    assert.equal(response.status, 502);
    assert(!JSON.stringify(response).includes('wrong-key'));
    execFileSync(process.execPath, [path.join(__dirname, 'reset-admin.js')], { env, stdio: 'pipe' });
    assert.equal((await api('/api/verify')).status, 401, 'reset script invalidates sessions in running server');
    response = await api('/api/login', 'POST', { username: 'admin', password: 'admin' });
    assert(response.body.mustChangePassword);
    assert(!logs.includes('ignored-test-key'), 'deprecated warning logs names only');
    await stop();
    console.log('settings, auth, paths, watcher and HTTP integration ok');
  } finally {
    if (child) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
    await watcher?.close();
    if (mock) await new Promise(resolve => mock.close(resolve));
    await fs.rm(run, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
