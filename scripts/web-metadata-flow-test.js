const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareSettings } = require('./settings-fixture');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-work-flow-'));
  const library = path.join(root, 'library'); await fs.mkdir(library);
  process.env.DATA_DIR = path.join(root, 'data');
  const draft = prepareSettings({ dataRoot: process.env.DATA_DIR, libraryRoot: library, aiWebSearchEnabled: true });
  Object.assign(draft.metadata, { aiBaseUrl: 'https://fixture.invalid/v1', aiModel: 'fixture' });
  await fs.writeFile(path.join(process.env.DATA_DIR, 'config/settings.json'), JSON.stringify(draft));
  const secretFile = path.join(process.env.DATA_DIR, 'config/secrets.json');
  const secrets = JSON.parse(await fs.readFile(secretFile)); secrets.aiApiKey = 'synthetic-key';
  await fs.writeFile(secretFile, JSON.stringify(secrets));
  const config = require('../lib/config'), storage = require('../lib/metadataStore'), archive = require('../lib/archiveSource');
  const scanner = require('../lib/scanner'), protection = require('../lib/scrapeProtection');
  const originalFetch = global.fetch;
  let web = [], chat = [], api = [], behavior = 'success', candidateId = 101;
  const subject = id => ({ id, type: 1, name: id >= 1000 ? `测试作品 (${id - 1000})` : '测试作品',
    name_cn: id >= 1000 ? `测试作品 第${id - 1000}卷` : '测试作品', infobox: { 作者: '测试作者', 类型: '漫画' }, summary: '可核对的简介', images: {} });
  global.fetch = async (url, options = {}) => {
    const target = new URL(url);
    if (target.hostname === 'api.bgm.tv') {
      api.push(target.pathname);
      if (behavior === 'transport') throw Error('fixture unavailable');
      if (target.pathname.includes('/search/')) return Response.json({ data: behavior === 'unmatched' ? [] : [subject(candidateId)] });
      if (target.pathname.endsWith('/subjects')) return Response.json([1, 2, 3].map(n => ({ id: 1000 + n, type: 1,
        name: `测试作品 (${n})`, name_cn: `测试作品 第${n}卷`, relation: '单行本' })));
      if (/\/(persons|characters)$/.test(target.pathname)) return Response.json([]);
      return Response.json(subject(Number(target.pathname.split('/').at(-1))));
    }
    const body = JSON.parse(options.body);
    if (target.pathname.endsWith('/responses')) {
      const input = JSON.parse(body.input.at(-1).content); web.push(input);
      assert.equal(input.task, 'identify_main_work');
      for (const text of [root, 'synthetic-key', 'CHAPTER_SENTINEL']) assert(!JSON.stringify(input).includes(text));
      if (behavior === 'transport') throw Error('fixture unavailable');
      const answer = { status: behavior === 'unmatched' ? 'unresolved' : 'matched',
        subjectId: behavior === 'invalid-id' ? 1.5 : candidateId, reason: '确认作品', evidence: [] };
      // No tool evidence: model ID is used directly per the requested behavior.
      return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: behavior === 'invalid-json' ? '{bad' : JSON.stringify(answer) }] }] });
    }
    const payload = JSON.parse(body.messages.at(-1).content); chat.push(payload);
    let result;
    if (payload.task === 'parse_resource_name') {
      const local = require('../lib/nameParser').parseName(payload.name);
      result = { title: local.title || '测试作品', authors: [], alternateTitles: [], publishers: [], status: '', tags: [],
        contentType: local.contentType, detectedNumber: local.detectedNumber, detectedNumberEnd: local.detectedNumberEnd,
        detectedNumberType: local.detectedNumberType || '' };
    } else if (payload.task === 'localize_failed_metadata') result = { results: payload.entries.map(row => ({ key: row.key, text: '本地资料' })) };
    else if (payload.entries) result = { results: payload.entries.map(row => ({ key: row.key, nameCn: '普通翻译' })) };
    else throw Error('unexpected chat: ' + JSON.stringify(payload));
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  };
  const mode = value => Object.defineProperty(config, 'AI_WEB_SEARCH_ENABLED', { configurable: true, value });
  let serial = 0;
  async function seed(bangumi) {
    const id = 'fixture-' + ++serial, name = `${id} 测试作品`;
    const directory = path.join(library, name); await fs.mkdir(directory);
    const sourcePath = path.join(directory, 'Vol.01.cbz'); await fs.writeFile(sourcePath, 'resource');
    const resource = { resourceId: id + '-r1', seriesId: id, sourceId: 'fixture-source', type: 'cbz',
      sourcePath, relativePath: name + '/Vol.01.cbz', seriesRelativePath: name,
      title: 'Vol.01', originalTitle: 'Vol.01', contentType: 'volume', detectedNumberType: 'volume',
      detectedNumber: 1, detectedNumberEnd: 1, fileHash: 'one', firstIndexedAt: '2020-01-01T00:00:00Z' };
    await storage.writeSeriesBundle({ seriesId: id, title: '测试作品', category: 'comic', authors: ['测试作者'], tags: ['old'], brief: '旧简介' }, [resource],
      { bangumi: bangumi || storage.emptyBangumi(), volumeDetails: {}, relations: [], persons: [], characters: [], translations: [] });
    return storage.readSeriesBundle(id);
  }
  async function bytes(id) {
    const dir = storage.seriesStorageDir(id), files = (await fs.readdir(dir)).sort();
    return Object.fromEntries(await Promise.all(files.map(async name => [name, await fs.readFile(path.join(dir, name), 'utf8')])));
  }
  try {
    const fresh = await seed();
    let result = await archive.scrapeSeries(fresh.series.seriesId);
    assert.equal(web.length, 1); assert.equal(result.bangumi.subjectId, 101);
    assert.equal(result.bangumi.matchedBy, 'web_identification'); assert.equal(result.bangumi.isManualOverride, false);
    assert.equal(result.bangumi.webScrape, undefined); assert.equal(result.overrides.scrapeMode, 'web');
    assert(api.includes('/v0/subjects/101/subjects')); assert(result.bangumi.volumeMatches.length);
    const saved = await bytes(fresh.series.seriesId), calls = [web.length, chat.length, api.length];
    for (const enabled of [false, true, false]) {
      mode(enabled); await archive.scrapeSeries(fresh.series.seriesId, { refreshMetadata: true });
      assert.deepEqual(await bytes(fresh.series.seriesId), saved); assert.deepEqual([web.length, chat.length, api.length], calls);
    }
    for (const state of [
      { webScrape: { status: 'partial' }, subjectId: null, name_cn: '部分结果' },
      { webScrape: { status: 'success' }, subjectId: 'web:unknown', name_cn: '旧联网' },
      { source: 'local_metadata', matchedBy: 'local_metadata_fallback', name_cn: '本地回退' },
      { subjectId: 103, detailsSchemaVersion: 0, name_cn: '旧详情' },
    ]) {
      const old = await seed(state), before = await bytes(old.series.seriesId);
      for (const enabled of [true, false]) { mode(enabled); await archive.scrapeSeries(old.series.seriesId); }
      assert.deepEqual(await bytes(old.series.seriesId), before);
    }
    const old = await storage.readSeriesBundle(fresh.series.seriesId), oldMetadata = structuredClone(await storage.readSeriesBundle(fresh.series.seriesId));
    const nextResource = { ...old.resources[0], resourceId: 'new-r2', title: 'Vol.02', originalTitle: 'Vol.02', detectedNumber: 2, detectedNumberEnd: 2, fileHash: 'two' };
    await storage.writeSeriesBundle(old.series, [...old.resources, nextResource], { bangumi: { ...old.bangumi, pendingResourceIds: ['new-r2'] } });
    mode(true); const webCount = web.length;
    result = await archive.scrapeSeries(old.series.seriesId); assert.equal(web.length, webCount);
    for (const key of ['relations', 'persons', 'characters', 'translations']) assert.deepEqual(result[key], oldMetadata[key]);
    for (const key of ['title', 'authors', 'brief', 'tags', 'cover', 'source']) assert.deepEqual(result.series[key], oldMetadata.series[key]);
    for (const [key, value] of Object.entries(oldMetadata.volumeDetails)) assert.deepEqual(result.volumeDetails[key], value);
    for (const [key, value] of Object.entries(oldMetadata.bangumi)) {
      if (!['volumeMatches', 'resourceFingerprints', 'pendingResourceIds'].includes(key)) assert.deepEqual(result.bangumi[key], value);
    }
    assert.equal(result.overrides.scrapeMode, 'web'); assert(result.bangumi.volumeMatches.some(row => row.resourceId === 'new-r2'));
    const settled = await bytes(old.series.seriesId); await archive.scrapeSeriesVolumes(old.series.seriesId, ['new-r2']);
    assert.deepEqual(await bytes(old.series.seriesId), settled);
    for (const invalid of ['invalid-id', 'invalid-json', 'unmatched']) {
      behavior = invalid; const bundle = await seed(), n = web.length;
      const recognized = await require('../lib/workIdentification').identifyWork(bundle, bundle.resources);
      assert.equal(recognized.status, 'unresolved'); assert.equal(web.length, n + 1);
    }
    behavior = 'invalid-id'; const fallbackCandidate = await seed(), n = web.length;
    result = await archive.scrapeSeries(fallbackCandidate.series.seriesId);
    assert.equal(web.length, n + 1); assert.equal(result.bangumi.subjectId, candidateId);
    behavior = 'transport'; const untouched = await bytes(old.series.seriesId);
    await assert.rejects(archive.scrapeSeries(old.series.seriesId, { force: true }));
    assert.deepEqual(await bytes(old.series.seriesId), untouched, 'failed force retains disk bundle');
    const noOld = await seed();
    await storage.writeSeriesBundle({ ...noOld.series, title: '没有候选的独立资料', authors: ['独立作者'] }, noOld.resources);
    result = await archive.scrapeSeries(noOld.series.seriesId);
    assert.equal(result.bangumi.source, 'local_metadata');
    const fallbackBytes = await bytes(noOld.series.seriesId), fallbackCount = web.length;
    mode(false); await archive.scrapeSeries(noOld.series.seriesId); mode(true); await archive.scrapeSeries(noOld.series.seriesId);
    assert.equal(web.length, fallbackCount); assert.deepEqual(await bytes(noOld.series.seriesId), fallbackBytes);
    behavior = 'success'; candidateId = 202;
    result = await archive.scrapeSeries(old.series.seriesId, { force: true, subjectId: 202 });
    assert.equal(result.bangumi.subjectId, 202); assert.equal(result.bangumi.isManualOverride, true);
    assert.equal(result.bangumi.webScrape, undefined); assert.equal(result.overrides.forcedSubjectId, 202);
    const descriptor = { title: '设备测试作品', author: '作者', originalName: '设备测试作品 Vol.01.cbz', mediaType: 'comic' };
    const device = await archive.resolveMetadataOnly(descriptor), count = web.length;
    const nextDescriptor = { ...descriptor, originalName: '设备测试作品 Vol.02.cbz' };
    const nextDevice = await archive.resolveMetadataOnly(nextDescriptor);
    assert.equal(web.length, count, 'new device volumes reuse established work without web requests');
    assert.equal(nextDevice.subjectId, device.subjectId);
    assert.equal(nextDevice.volumeNumber, 2);
    mode(false); assert.deepEqual(await archive.resolveMetadataOnly(descriptor), { ...device, reused: true }); assert.equal(web.length, count);
    behavior = 'transport'; await assert.rejects(archive.resolveMetadataOnly(descriptor, { force: true }));
    assert.equal((await archive.resolveMetadataOnly(descriptor)).subjectId, device.subjectId);
    behavior = 'success';
    mode(false); const scanned = await scanner.scanLibrary({ fast: true });
    const scanSeries = scanned.seriesList[0], scanBundle = await storage.readSeriesBundle(scanSeries.seriesId);
    await storage.writeSeriesBundle(scanBundle.series, scanBundle.resources, { bangumi: { subjectId: 101, name_cn: '测试作品' } });
    const changedPath = scanBundle.resources[0].sourcePath; await fs.appendFile(changedPath, 'changed');
    await scanner.scanLibrary({ fast: true, changedPaths: [changedPath] });
    const delta = await storage.readSeriesBundle(scanSeries.seriesId);
    assert(protection.changedResources(delta).some(row => row.sourcePath === changedPath));
    assert.equal(delta.resources[0].firstIndexedAt, scanBundle.resources[0].firstIndexedAt);
    const tasks = require('../lib/taskQueue');
    const taskFixture = await seed({ subjectId: 777, name_cn: '受保护的任务结果' });
    const unchangedId = taskFixture.series.seriesId, beforeTask = await bytes(unchangedId);
    const beforeCalls = [web.length, chat.length, api.length];
    for (const enabled of [true, false]) {
      mode(enabled);
      const task = await tasks.enqueueTask('scrapeSeries', { seriesId: unchangedId, refreshMetadata: true });
      await tasks.waitForTask(task);
    }
    assert.deepEqual(await bytes(unchangedId), beforeTask);
    assert.deepEqual([web.length, chat.length, api.length], beforeCalls);
    console.log('One-shot direct-ID recognition, traditional details, mode protection, incremental preservation, force and descriptors passed.');
  } finally { global.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
