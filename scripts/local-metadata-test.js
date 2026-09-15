const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { prepareSettings, fixtureSource } = require('./settings-fixture');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-local-metadata-'));
  const data = path.join(root, 'data'), library = path.join(root, 'library');
  process.env.DATA_DIR = data;
  await fs.mkdir(library, { recursive: true });
  const prepared = prepareSettings({ dataRoot: data, sources: [fixtureSource(library)] });
  prepared.metadata.matchEnabled = true; prepared.metadata.volumeMatchEnabled = true;
  await fs.writeFile(path.join(data, 'config/settings.json'), JSON.stringify(prepared));
  const secretFile = path.join(data, 'config/secrets.json');
  const secrets = JSON.parse(await fs.readFile(secretFile, 'utf8')); secrets.deepseekApiKey = 'synthetic-key';
  await fs.writeFile(secretFile, JSON.stringify(secrets));
  const metadata = require('../lib/metadataStore');
  const cache = require('../lib/metadataCache');
  const archive = require('../lib/archiveSource');
  const { LOCALIZATION_VERSION } = require('../lib/metadataLocalization');
  const { createLocalMetadataService, describe } = require('../lib/localMetadata');
  const { workIdForBundle } = require('../lib/workStore');
  let server;
  const originalFetch = global.fetch;
  try {
    for (const [id, suffix, format] of [['first', '', 'cbz'], ['second', ' [高清]', 'zip'], ['third', ' [电子版]', 'cbz']]) {
      const relativePath = `复用测试${suffix}/Vol.01.${format}`;
      const sourcePath = path.join(library, relativePath);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true }); await fs.writeFile(sourcePath, 'synthetic resource; never uploaded');
      const series = { seriesId: id, title: '复用测试' + suffix, authors: ['测试作者'], category: 'comic' };
      const resource = { resourceId: 'resource-' + id, seriesId: id, sourceId: 'fixture-source', sourcePath, relativePath,
        seriesRelativePath: path.dirname(relativePath), title: 'Vol.01', originalTitle: 'Vol.01', type: format, contentType: 'volume', detectedNumber: 1, pageCount: 1, readable: true, category: 'comic' };
      await metadata.writeSeriesBundle(series, [resource]);
    }
    const bundles = await Promise.all(['first', 'second', 'third'].map(metadata.readSeriesBundle));
    await metadata.rebuildIndexes(bundles.map(b => b.series), bundles.flatMap(b => b.resources));
    await metadata.updateBangumi('first', {
      bangumi: { subjectId: 1000, name: '复用测试', name_cn: '复用测试', bangumiNameCn: '复用测试', localizationVersion: LOCALIZATION_VERSION, detailsSchemaVersion: 2, titleSource: '复用测试', titleLocalizationProvider: 'deepseek',
        authors: ['测试作者'], infobox: { 作者: '测试作者', 中文名: '复用测试' }, summary: '已经刮削的简介', translatedSummary: '已经刮削的简介', tags: [], relatedSubjects: [] },
      persons: [], characters: [], relations: [],
      volumeDetails: { 1001: { subjectId: 1001, localizationVersion: LOCALIZATION_VERSION, nameJa: '复用测试 1', nameCn: '复用测试 第1卷', summary: '卷册简介', translatedSummary: '卷册简介',
        volumeNumbers: [1], resourceIds: ['resource-first'], displayTitle: '(1) AI　卷册名', displayTitleSource: 'ai',
        cover: 'https://example.test/cover.jpg', updatedAt: new Date().toISOString() } },
    });
    let providerCalls = 0;
    global.fetch = async (url, options = {}) => {
      const payload = options.body && JSON.parse(JSON.parse(options.body).messages?.at(-1)?.content || '{}');
      if (payload?.task === 'parse_resource_name') return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: '复用测试', authors: ['测试作者'], alternateTitles: [], publishers: [], status: '', tags: [],
        contentType: 'volume', detectedNumber: 1, detectedNumberEnd: 1, detectedNumberType: 'volume',
      }) } }] }), { headers: { 'Content-Type': 'application/json' } });
      providerCalls++; throw new Error('Cached metadata must not repeat matching or detail fetching');
    };
    const versions = await Promise.all(['second', 'third'].map(id => archive.scrapeSeries(id)));
    assert.equal(providerCalls, 0, '不同版本来源不应重复匹配作品、卷册或拉取详情');
    assert.equal(new Set(versions.map(workIdForBundle)).size, 1);
    for (const version of versions) {
      assert.equal(version.bangumi.subjectId, 1000);
      assert.equal(version.bangumi.volumeMatches[0].subjectId, 1001);
      assert.equal(version.bangumi.volumeMatches[0].resourceId, version.resources[0].resourceId);
      assert.equal(version.bangumi.volumeMatches[0].displayTitle, '(1) AI　卷册名', 'reusing details must not normalize or replace the saved AI name');
      assert.equal(version.bangumi.volumeMatches[0].displayTitleSource, 'ai');
    }
    assert.equal(await cache.find({ title: '复用测试', authors: ['其他作者'], category: 'comic' }), null, '同名异作者不能直接合并');
    assert.equal(await cache.find({ title: '复用测试（另一作者版）', authors: [], category: 'comic' }), null, '作者版本标记不能当作普通画质或来源后缀去掉');
    assert.equal(await cache.find({ title: '复用测试', authors: ['测试作者'], category: 'novel' }), null, '小说和漫画改编应区分');
    const before = await metadata.readLibraryIndexes();
    const jobsDirectory = path.join(data, 'metadata/local-requests');
    let resolutions = 0;
    const service = createLocalMetadataService({ directory: jobsDirectory, resolve: async value => { resolutions++; return archive.resolveMetadataOnly(value); }, runAsUser: (_, operation) => operation() });
    await service.initialize();
    const descriptor = { title: '复用测试', author: '测试作者', originalName: '复用测试 Vol.01.cbz', mediaType: 'comic' };
    const requests = await Promise.all(Array.from({ length: 12 }, () => service.submit('admin', descriptor)));
    assert.equal(new Set(requests.map(job => job.id)).size, 1, '同账号并发请求应复用同一任务');
    let result;
    for (let i = 0; i < 100; i++) { result = service.get('admin', requests[0].id); if (['success', 'failed'].includes(result.status)) break; await delay(20); }
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(resolutions, 1); assert.equal(providerCalls, 0);
    assert.equal(result.metadata.subjectId, 1000); assert.equal(result.metadata.volumeSubjectId, 1001);
    assert.equal(service.get('other-user', result.id), null);
    const variant = await service.submit('admin', { ...descriptor, originalName: '复用测试 Vol.01 [高清].zip' });
    assert.notEqual(variant.id, result.id, 'different raw names must be parsed before deciding whether they are the same volume');
    for (let i = 0; i < 100 && ['queued', 'running'].includes(service.get('admin', variant.id).status); i++) await delay(20);
    assert.equal(service.get('admin', variant.id).metadata.volumeSubjectId, 1001);
    assert.equal(providerCalls, 0);
    assert.deepEqual(await metadata.readLibraryIndexes(), before, '本地描述刮削不得创建服务端书籍或资源');
    const serialized = JSON.stringify(result);
    for (const forbidden of ['sourcePath', 'resourceIds', library, 'synthetic resource']) assert.ok(!serialized.includes(forbidden));
    for (const input of [{ ...descriptor, file: 'base64' }, { ...descriptor, sourcePath: '/private/book.epub' }, { ...descriptor, originalName: '/private/book.epub' }, { ...descriptor, title: 'x'.repeat(257) }]) {
      assert.throws(() => describe(input), error => error.status === 400);
    }
    const restored = createLocalMetadataService({ directory: jobsDirectory, resolve: async () => { throw new Error('Completed jobs must survive restart'); }, runAsUser: (_, operation) => operation() });
    await restored.initialize(); assert.equal(restored.get('admin', result.id).status, 'success');
    assert.equal((await restored.submit('admin', descriptor)).id, result.id);
    const jobFiles = await fs.readdir(jobsDirectory); assert.ok(jobFiles.every(name => name.endsWith('.json')));
    assert.equal((await fs.stat(path.join(jobsDirectory, jobFiles[0]))).mode & 0o777, 0o600);

    global.fetch = originalFetch;
    const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    let logs = '';
    server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', data => { logs += data }); server.stderr.on('data', data => { logs += data });
    for (let i = 0; i < 100 && !logs.includes('ReadDeck running'); i++) { if (server.exitCode !== null) throw new Error(logs); await delay(50); }
    assert.ok(logs.includes('ReadDeck running'), logs);
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password' }) });
    const { token } = await login.json(); assert.ok(token);
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/local-metadata/' + result.id)).status, 401);
    assert.equal((await fetch(base + '/api/local-metadata/' + result.id, { headers })).status, 200);
    assert.equal((await fetch(base + '/api/local-metadata/another-user-job', { headers })).status, 404);
    assert.equal((await fetch(base + '/api/local-metadata', { method: 'POST', headers, body: JSON.stringify({ ...descriptor, file: 'not a resource upload' }) })).status, 400);
    assert.equal((await fetch(base + '/api/local-metadata', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, body: 'resource bytes' })).status, 415);
    const cached = await fetch(base + '/api/local-metadata', { method: 'POST', headers, body: JSON.stringify(descriptor) });
    assert.equal(cached.status, 200); assert.equal((await cached.json()).id, result.id);
    const created = await fetch(base + '/api/users', { method: 'POST', headers, body: JSON.stringify({ username: 'local-reader', password: 'reader-password', sourceIds: [] }) });
    assert.equal(created.status, 200);
    const readerLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'local-reader', password: 'reader-password' }) });
    const readerSession = await readerLogin.json();
    const changed = await fetch(base + '/api/account', { method: 'PUT', headers: { ...headers, Authorization: 'Bearer ' + readerSession.token }, body: JSON.stringify({ username: 'local-reader', currentPassword: 'reader-password', password: 'reader-new-password' }) });
    const readerToken = (await changed.json()).token; assert.ok(readerToken);
    const readerHeaders = { ...headers, Authorization: 'Bearer ' + readerToken };
    assert.equal((await fetch(base + '/api/local-metadata/' + result.id, { headers: readerHeaders })).status, 404);
    const readerJob = await fetch(base + '/api/local-metadata', { method: 'POST', headers: readerHeaders, body: JSON.stringify(descriptor) });
    assert.equal(readerJob.status, 202, '无书库来源权限的读者也可以刮削自己的本地书籍');
    const readerJobID = (await readerJob.json()).id;
    let readerResult;
    for (let i = 0; i < 100; i++) {
      readerResult = await (await fetch(base + '/api/local-metadata/' + readerJobID, { headers: readerHeaders })).json();
      if (['success', 'failed'].includes(readerResult.status)) break;
      await delay(20);
    }
    assert.equal(readerResult.status, 'success', JSON.stringify(readerResult));
    assert.equal(readerResult.metadata.subjectId, 1000);
    assert.deepEqual(await (await fetch(base + '/api/library', { headers: readerHeaders })).json(), []);
    const works = await (await fetch(base + '/api/library', { headers })).json();
    assert.equal(works.length, 1, '多来源版本在实际书库接口中合并为一个作品');
    console.log('Local metadata: no uploads, isolated jobs, restart recovery, concurrent reuse, shared work/volume metadata, and source-version merging passed.');
  } finally {
    global.fetch = originalFetch;
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
