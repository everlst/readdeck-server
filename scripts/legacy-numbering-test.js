// Offline regression and disposable browser fixture for legacy chapter sort keys.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { prepareSettings, fixtureSource } = require('./settings-fixture');

const credentials = { username: 'admin', password: 'test-password' };
const cases = [
  { order: 0.1, title: '第1卷', number: 1, group: '单行本' },
  { order: 0.2, title: '第2卷', number: 2, group: '单行本' },
  { order: 0.3, title: '第0.1卷', number: 0.1, group: '单行本' },
  { order: 0.4, title: '第0卷', number: 0, group: '单行本' },
  { order: 0.5, title: '附录', number: 0.5, group: '单行本' },
  { order: 0.2, title: '第2话', number: 2, group: '单话' },
];
const customTitle = '特别篇：第0.3册的回忆';
const volumeSummary = '已保存的第二卷简介，编号修正后继续保留。';

function assertNumbers(resources, baseline) {
  for (const item of cases) {
    const resource = resources.find(row => row.legacy?.chapterTitle === item.title);
    assert.ok(resource, `Missing legacy resource ${item.title}`);
    for (const field of ['detectedNumber', 'detectedNumberEnd', item.group === '单行本' ? 'volumeNumber' : 'chapterNumber']) {
      assert.equal(resource[field], item.number, `${item.title}: ${field}`);
    }
    assert.equal(resource.legacy.order, item.order, 'legacy sort key must stay unchanged');
    assert.equal(resource.relativePath, `旧版编号测试/${item.group}/${item.order} ${item.title}`);
    if (baseline) {
      const previous = baseline.find(row => row.legacy?.chapterTitle === item.title);
      for (const field of ['resourceId', 'seriesId', 'sourcePath', 'relativePath', 'firstIndexedAt']) {
        assert.equal(resource[field], previous[field], `${item.title}: stable ${field}`);
      }
    }
  }
}

async function startFixture({ port = 15949 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-legacy-numbering-'));
  const dataRoot = path.join(root, 'data');
  const libraryRoot = path.join(root, 'library');
  const ordinaryRoot = path.join(root, 'ordinary');
  process.env.DATA_DIR = dataRoot;
  let child;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await fs.rm(root, { recursive: true, force: true });
  };
  const nativeFetch = global.fetch;
  let externalRequests = 0;
  try {
    await Promise.all([libraryRoot, ordinaryRoot].map(dir => fs.mkdir(dir, { recursive: true })));
    prepareSettings({ dataRoot, ...credentials, sources: [
      fixtureSource(libraryRoot, { id: 'legacy-fixture', name: '旧版来源' }),
      fixtureSource(ordinaryRoot, { id: 'ordinary-fixture', name: '普通来源', order: 1 }),
    ] });
    const groups = {};
    for (const [index, item] of cases.entries()) {
      const groupKey = item.group === '单行本' ? 'tankobon' : 'default';
      (groups[groupKey] ||= []).push({ order: item.order, chapterTitle: item.title,
        groupName: item.group, chapterUuid: `legacy-chapter-${index}` });
      const directory = path.join(libraryRoot, '旧版编号测试', item.group, `${item.order} ${item.title}`);
      await fs.mkdir(directory, { recursive: true });
      await sharp({ create: { width: 480, height: 680, channels: 3, background: '#d9c6a3' } })
        .png().toFile(path.join(directory, '1.png'));
    }
    await fs.writeFile(path.join(libraryRoot, '旧版编号测试', '元数据.json'), JSON.stringify({
      comic: { name: '旧版编号测试', author: [], brief: '卷号与旧版排序值不同的离线回归资源。', groups },
    }, null, 2));

    global.fetch = async () => { externalRequests++; throw new Error('Legacy numbering test must not call AI or the network'); };
    const scanner = require('../lib/scanner');
    const storage = require('../lib/metadataStore');
    const scans = [];
    for (const options of [{ fast: true }, { fast: false }, { fast: true,
      changedPaths: [path.join(libraryRoot, '旧版编号测试', '单行本', '0.2 第2卷', '1.png')] }]) {
      scans.push((await scanner.scanLibrary(options)).resourceList);
    }
    const baseline = scans[0];
    const seriesId = baseline[0].seriesId;
    const second = baseline.find(row => row.legacy.chapterTitle === '第2卷');
    const decimal = baseline.find(row => row.legacy.chapterTitle === '第0.1卷');
    const bundle = await storage.readSeriesBundle(seriesId);
    const oldResources = baseline.map(resource => ({ ...resource,
      title: resource.resourceId === second.resourceId ? '第0.2册' : resource.title,
      detectedNumber: resource.legacy.order, detectedNumberEnd: resource.legacy.order,
      volumeNumber: resource.contentType === 'volume' ? resource.legacy.order : null,
      chapterNumber: resource.contentType === 'chapter' ? resource.legacy.order : null,
    }));
    const matches = [
      { resourceId: second.resourceId, subjectId: 930002, matched: true, matchKind: 'offprint',
        relationType: '单行本', detailKey: 'legacy-volume-two', source: 'ai_web_scrape',
        displayTitleSource: 'ai', displayTitle: '第0.2册', bangumiOrder: 2 },
      { resourceId: decimal.resourceId, matched: false, matchKind: 'local',
        source: 'ai_web_scrape', displayTitleSource: 'ai', displayTitle: customTitle },
    ];
    const volumeDetails = { 'legacy-volume-two': { detailKey: 'legacy-volume-two',
      nameCn: '第0.2册', nameJa: '第二巻（保存済み）', summary: volumeSummary,
      translatedSummary: '保留译文。', date: '2026-01-02', cover: second.coverCandidate } };
    const written = await storage.writeSeriesBundle({ ...bundle.series, bangumiSubjectId: 930000,
      lastMatchedAt: '2026-01-02T00:00:00.000Z' }, oldResources, {
      bangumi: { subjectId: 930000, source: 'ai_web_scrape', name_cn: '旧版编号测试',
        matchedAt: '2026-01-02T00:00:00.000Z', detailsSchemaVersion: 2,
        webScrape: { status: 'success', completedAt: '2026-01-02T00:00:00.000Z' }, volumeMatches: matches },
      volumeDetails,
    });
    await storage.upsertSeriesIndexes(written, oldResources);
    const seriesDirectory = storage.seriesStorageDir(seriesId);
    const resourcesFile = path.join(seriesDirectory, 'resources.json');
    const indexFile = path.join(dataRoot, 'metadata', 'indexes', 'resource-index.json');
    async function writeOldResources() {
      // Write the historical bytes directly: production writers may already normalize them.
      await fs.writeFile(resourcesFile, JSON.stringify(oldResources, null, 2));
      const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
      for (const resource of oldResources) index[resource.resourceId] = resource;
      await fs.writeFile(indexFile, JSON.stringify(index, null, 2));
    }
    await writeOldResources();
    const originals = Object.fromEntries(await Promise.all(['bangumi.json', 'volume_details.json'].map(async name =>
      [name, await fs.readFile(path.join(seriesDirectory, name), 'utf8')])));
    const oldResourceBytes = await fs.readFile(resourcesFile, 'utf8');
    const oldIndexBytes = await fs.readFile(indexFile, 'utf8');
    const loaded = {
      bundle: await storage.readSeriesBundle(seriesId),
      resource: await storage.getResource(second.resourceId),
      indexes: await storage.readLibraryIndexes(),
      directIndex: await storage.readIndex('resource-index.json', {}),
    };
    assert.equal(await fs.readFile(resourcesFile, 'utf8'), oldResourceBytes, 'reading must not rewrite stored resources');
    assert.equal(await fs.readFile(indexFile, 'utf8'), oldIndexBytes, 'reading must not rewrite stored indexes');
    const preservedScan = (await scanner.scanLibrary({ fast: true })).resourceList;
    const afterScan = await storage.readSeriesBundle(seriesId);
    await writeOldResources();

    // Same book from a normal source becomes the representative because it is newer.
    const ordinaryId = 'ordinary-second-volume';
    const ordinaryDirectory = path.join(ordinaryRoot, '普通第2卷');
    await fs.mkdir(ordinaryDirectory, { recursive: true });
    await fs.copyFile(path.join(second.sourcePath, '1.png'), path.join(ordinaryDirectory, '1.png'));
    const ordinary = { ...second, resourceId: ordinaryId, seriesId: 'ordinary-numbering-series',
      sourceId: 'ordinary-fixture', sourcePath: ordinaryDirectory, relativePath: '普通第2卷',
      seriesRelativePath: '普通第2卷', title: '第2卷', originalTitle: '第2卷',
      detectedNumber: 2, detectedNumberEnd: 2, volumeNumber: 2,
      firstIndexedAt: '2099-01-01T00:00:00.000Z', coverCandidate: `/api/resources/${ordinaryId}/cover` };
    delete ordinary.legacy;
    const ordinarySeries = await storage.writeSeriesBundle({ ...written,
      seriesId: ordinary.seriesId, source: '普通来源', legacy: undefined }, [ordinary], {
      bangumi: { ...loaded.bundle.bangumi, volumeMatches: [{ ...matches[0], resourceId: ordinaryId }] },
      volumeDetails,
    });
    await storage.upsertSeriesIndexes(ordinarySeries, [ordinary]);
    global.fetch = nativeFetch;

    // Prevent HTTP fixture endpoints from silently falling back to online metadata.
    const guard = path.join(root, 'offline.cjs');
    await fs.writeFile(guard, "global.fetch = async () => { throw new Error('Offline fixture blocked an external request'); };\n");
    child = spawn(process.execPath, ['--require', guard, 'server.js'], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dataRoot, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`Fixture startup timed out: ${logs}`)), 15000);
      const onData = () => { if (logs.includes('ReadDeck running')) finish(); };
      const onExit = code => finish(new Error(`Fixture server exited (${code}): ${logs}`));
      const onError = error => finish(error);
      function finish(error) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        child.off('exit', onExit);
        child.off('error', onError);
        error ? reject(error) : resolve();
      }
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', onExit);
      child.once('error', onError);
    });
    return { root, dataRoot, child, base: `http://127.0.0.1:${port}`, credentials,
      seriesId, second, decimal, ordinary, baseline, scans, loaded, preservedScan, afterScan,
      originals, seriesDirectory, externalRequests, logs: () => logs, close };
  } catch (error) {
    global.fetch = nativeFetch;
    await close();
    throw error;
  }
}

async function main() {
  const fixture = await startFixture({ port: Number(process.env.READDECK_LEGACY_PORT ||
    (process.argv.includes('--serve') ? 15949 : 16000 + Math.floor(Math.random() * 10000))) });
  if (process.argv.includes('--serve')) {
    console.log(`Legacy numbering fixture: ${fixture.base} (${credentials.username}/${credentials.password})`);
    console.log(`Series: ${fixture.seriesId}; second volume: ${fixture.second.resourceId}`);
    const stop = () => fixture.close().then(() => process.exit());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  try {
    for (const resources of fixture.scans) assertNumbers(resources, fixture.baseline);
    assertNumbers(fixture.loaded.bundle.resources, fixture.baseline);
    assertNumbers(Object.values(fixture.loaded.indexes.resourceIndex), fixture.baseline);
    assertNumbers(Object.values(fixture.loaded.directIndex), fixture.baseline);
    assert.equal(fixture.loaded.resource.detectedNumber, 2);
    assertNumbers(fixture.preservedScan, fixture.baseline);
    assertNumbers(fixture.afterScan.resources, fixture.baseline);
    assert.equal(fixture.afterScan.bangumi.volumeMatches[0].displayTitle, '第0.2册');
    assert.equal(fixture.externalRequests, 0);
    let token;
    const request = async (endpoint, options = {}) => {
      const response = await fetch(`${fixture.base}${endpoint}`, { ...options,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      const data = await response.json();
      assert.ok(response.ok, `${endpoint}: ${JSON.stringify(data)}`);
      return data;
    };
    token = (await request('/api/login', { method: 'POST', body: JSON.stringify(credentials) })).token;
    const detailPath = `/api/comics/${fixture.seriesId}`;
    async function checkPresentation(expectedRepresentative) {
      const detail = await request(detailPath);
      const books = detail.bookSections.flatMap(section => section.items);
      const second = books.find(book => Number(book.subjectId || book.bangumiSubjectId) === 930002);
      assert.ok(second, 'second-volume book must be present');
      assert.equal(second.title, '第2册');
      assert.equal(second.versionCount, 2);
      assert.equal(second.representativeResourceId, expectedRepresentative);
      assert.ok(books.some(book => book.title === customTitle), 'custom AI title must remain untouched');
      for (const resource of [fixture.second, fixture.ordinary]) {
        const volume = await request(`${detailPath}/volumes/${resource.resourceId}`);
        assert.equal(volume.title, '第2册');
        assert.equal(volume.order, 2);
        assert.equal(volume.summary, volumeSummary);
        assert.equal(volume.translatedSummary, '保留译文。');
        assert.equal(volume.nameJa, '第二巻（保存済み）');
        assert.equal(volume.versions.length, 2);
        assert.equal(volume.currentVersion.resourceId, resource.resourceId);
      }
    }
    await checkPresentation(fixture.ordinary.resourceId);
    await request(`/api/progress/${fixture.seriesId}`, { method: 'PUT', body: JSON.stringify({
      resourceId: fixture.second.resourceId, chapterUuid: fixture.second.legacy.chapterUuid,
      page: 1, chapterTitle: '第2卷', groupName: '单行本', resourceType: 'directory',
    }) });
    await checkPresentation(fixture.second.resourceId);
    for (const [name, original] of Object.entries(fixture.originals)) {
      assert.equal(await fs.readFile(path.join(fixture.seriesDirectory, name), 'utf8'), original,
        `scan/read/presentation must preserve original ${name}`);
    }
    assert.doesNotMatch(fixture.logs(), /Offline fixture blocked/);
    console.log('Legacy numbering: fast/full/incremental scans, persisted indexes, zero/fractional numbers, saved AI details and multi-source presentation passed offline.');
  } finally {
    await fixture.close();
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { startFixture };
