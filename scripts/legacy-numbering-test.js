// Real legacy scanner -> scrape pipeline, with an offline AI/provider transport.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { prepareSettings } = require('./settings-fixture');

const credentials = { username: 'admin', password: 'test-password' };
const cases = [
  { order: 0.1, title: '第1卷', group: '单行本', number: 1 },
  { order: 0.2, title: '第2卷', group: '单行本', number: 2 },
  { order: 0.3, title: '特典集合 海边篇', group: '单行本', number: 5.5 },
  { order: 0.4, title: '未定名资料', group: '单行本', number: null },
  { order: 0.5, title: '第0.1卷', group: '单行本', number: 0.1 },
  { order: 0.2, title: '第2话', group: '单话', number: 0.2 },
  { order: 0.7, title: '附录', group: '附录', number: 0.7 },
];
const nextCase = { order: 0.6, title: '雨后的信件', group: '单行本', number: 3 };
const byTitle = (rows, title) => rows.find(resource => resource.legacy?.chapterTitle === title);

async function runRegression({ keep = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-legacy-ai-'));
  const library = path.join(root, 'library');
  const dataRoot = path.join(root, 'data');
  process.env.DATA_DIR = dataRoot;
  const originalFetch = global.fetch;
  let child;
  const close = async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await fs.rm(root, { recursive: true, force: true });
  };
  try {
    await fs.mkdir(library);
    prepareSettings({ dataRoot, libraryRoot: library, ...credentials });
    const config = require('../lib/config');
    for (const [key, value] of Object.entries({ AI_API_KEY: 'synthetic-key', AI_MODEL: 'fixture',
      AI_WEB_SEARCH_ENABLED: false, DEEPSEEK_MATCH_ENABLED: false,
      DEEPSEEK_VOLUME_MATCH_ENABLED: true, DEEPSEEK_LOCAL_GROUP_ENABLED: false })) {
      Object.defineProperty(config, key, { configurable: true, value });
    }
    const scanner = require('../lib/scanner');
    const storage = require('../lib/metadataStore');
    const archive = require('../lib/archiveSource');
    const parseCalls = [];
    const matchCalls = [];
    const stages = [];
    let invalidName = '', failMetadata = false;
    const answerNumbers = new Map([...cases, nextCase].map(item => [item.title, item.number]));
    const displayTitle = (title, number) => title === '特典集合 海边篇' ? `（${number}）海边特典` :
      number === null ? '未定名独立资料' : `第${number}册`;
    const subject = id => ({ id, type: 1, name: '旧版测试作品', name_cn: '旧版测试作品',
      infobox: { 作者: '测试作者' }, summary: '离线元数据简介', images: {} });
    global.fetch = async (url, options = {}) => {
      const target = new URL(url);
      if (target.hostname === 'api.bgm.tv') {
        stages.push('metadata');
        if (target.pathname.includes('/search/')) return Response.json({ data: failMetadata ? [] : [subject(100)] });
        if (failMetadata) throw new Error('Fixture metadata is unavailable');
        if (target.pathname.endsWith('/subjects')) return Response.json([]);
        if (/\/(persons|characters)$/.test(target.pathname)) return Response.json([]);
        return Response.json(subject(Number(target.pathname.split('/').at(-1))));
      }
      const body = JSON.parse(options.body);
      const payload = JSON.parse(body.messages.at(-1).content);
      let result;
      if (payload.task === 'parse_resource_name') {
        parseCalls.push(payload);
        stages.push('parse:' + payload.name);
        const isLegacyVolume = Object.hasOwn(payload.context, 'legacyOrder');
        const title = payload.context.originalTitle;
        const number = isLegacyVolume ? answerNumbers.get(title) : null;
        if (isLegacyVolume) {
          assert.ok(answerNumbers.has(title), `Unexpected legacy AI input ${JSON.stringify(payload)}`);
          assert.equal(payload.context.parentName, '单行本');
          assert.equal(payload.context.contentType, 'volume');
          assert.equal(payload.name, `${payload.context.legacyOrder} ${title}`);
          assert.ok(payload.context.seriesTitle);
        }
        assert.notEqual(payload.name, '0.2 第2话', 'individual chapters never enter AI parsing');
        assert.notEqual(payload.name, '0.7 附录', 'non-volume groups never enter AI parsing');
        result = payload.name === invalidName ? { title: 'invalid' } : {
          title: isLegacyVolume ? `AI解析：${title}` : payload.name,
          alternateTitles: [], authors: [], publishers: [], status: '', tags: [],
          contentType: number === null ? 'unknown' : 'volume', detectedNumber: number,
          detectedNumberEnd: number, detectedNumberType: number === null ? '' : 'volume',
        };
      } else if (payload.task === 'match_local_resources_to_bangumi_offprints') {
        matchCalls.push(payload);
        result = { results: payload.resources.map(resource => {
          assert.equal(resource.contentType, 'volume');
          assert.notEqual(resource.originalTitle, '第2话');
          assert.notEqual(resource.originalTitle, '附录');
          assert.equal(resource.detectedNumber, answerNumbers.get(resource.originalTitle),
            'AI matching must receive the parsed semantic number');
          return { resourceKey: resource.resourceKey, matched: false, subjectId: null,
            displayTitle: displayTitle(resource.originalTitle, resource.detectedNumber),
            confidence: 90, reason: '无候选，采用 AI 卷册命名' };
        }) };
      } else if (payload.task === 'localize_failed_metadata') {
        result = { results: payload.entries.map(row => ({ key: row.key, text: row.text })) };
      } else if (payload.entries) {
        result = { results: payload.entries.map(row => ({ key: row.key, nameCn: row.name || row.sourceName || '测试资料' })) };
      } else throw new Error('Unexpected offline AI task: ' + JSON.stringify(payload));
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
    };
    async function writeLegacy(name, rows) {
      const groups = {};
      for (const item of rows) {
        const group = item.group === '单行本' ? 'tankobon' : item.group;
        (groups[group] ||= []).push({ order: item.order, chapterTitle: item.title,
          groupName: item.group, chapterUuid: `${name}-${item.group}-${item.order}` });
        const directory = path.join(library, name, item.group, `${item.order} ${item.title}`);
        await fs.mkdir(directory, { recursive: true });
        const image = path.join(directory, '1.png');
        try { await fs.access(image); } catch {
          await sharp({ create: { width: 480, height: 680, channels: 3, background: '#d9c6a3' } }).png().toFile(image);
        }
      }
      const metadataPath = path.join(library, name, '元数据.json');
      await fs.writeFile(metadataPath, JSON.stringify({ comic: { name, author: [], groups } }, null, 2));
      return metadataPath;
    }
    async function diskBytes(seriesId) {
      const directory = storage.seriesStorageDir(seriesId);
      return Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async name =>
        [name, await fs.readFile(path.join(directory, name), 'utf8')])));
    }
    function assertParsed(resources, before, rows = cases) {
      for (const item of rows) {
        const resource = byTitle(resources, item.title);
        const old = byTitle(before, item.title);
        assert.ok(resource, `Missing ${item.title}`);
        if (item.group !== '单行本') {
          assert.deepEqual(resource, old, 'chapter and other-group objects stay unchanged');
          continue;
        }
        assert.equal(resource.contentType, 'volume', 'AI unknown must not discard an established volume');
        for (const field of ['detectedNumber', 'detectedNumberEnd', 'volumeNumber']) {
          assert.equal(resource[field], answerNumbers.get(item.title), `${item.title}: ${field}`);
        }
        assert.equal(resource.title, `AI解析：${item.title}`);
        assert.equal(resource.originalTitle, old.originalTitle || item.title);
        assert.deepEqual(resource.legacy, old.legacy);
        for (const field of ['resourceId', 'seriesId', 'sourcePath', 'relativePath', 'fileHash', 'firstIndexedAt']) {
          assert.equal(resource[field], old[field], `AI parsing must preserve ${field}`);
        }
      }
    }
    const legacyCalls = () => parseCalls.filter(call => Object.hasOwn(call.context, 'legacyOrder'));
    function assertDisplayTitles(bundle, rows) {
      for (const item of rows.filter(row => row.group === '单行本')) {
        const resource = byTitle(bundle.resources, item.title);
        const match = bundle.bangumi.volumeMatches.find(row => row.resourceId === resource.resourceId);
        assert.ok(match, `Missing AI display match for ${item.title}`);
        assert.equal(match.displayTitle, displayTitle(item.title, answerNumbers.get(item.title)));
        assert.equal(match.displayTitleSource, 'ai');
      }
    }
    const metadataPath = await writeLegacy('旧版AI测试', cases);
    const scans = [];
    for (const options of [{ fast: true }, { fast: false }, { fast: true, changedPaths: [metadataPath] }]) {
      scans.push(await scanner.scanLibrary(options));
    }
    assert.equal(parseCalls.length, 0, 'scan modes must stay offline and must not call AI');
    const baseline = scans[0].resourceList;
    for (const scan of scans) for (const item of cases) {
      const resource = byTitle(scan.resourceList, item.title);
      assert.equal(resource.detectedNumber, item.order, 'scanning retains historical order behavior');
      assert.equal(resource.resourceId, byTitle(baseline, item.title).resourceId);
    }
    const seriesId = baseline[0].seriesId;
    const before = (await storage.readSeriesBundle(seriesId)).resources;
    let result = await archive.scrapeSeries(seriesId, { subjectId: 100 });
    assert.equal(result.bangumi.subjectId, 100, 'exercise a successful scrape, not a fallback');
    assertParsed(result.resources, before);
    assertDisplayTitles(result, cases);
    assert.equal(matchCalls.length, 1);
    assert.equal(legacyCalls().length, 5, 'first scrape parses every legacy volume once');
    const firstMetadata = stages.indexOf('metadata');
    assert.equal(stages.slice(0, firstMetadata).filter(stage => stage.startsWith('parse:')).length, 5,
      'legacy volumes are parsed before matching/metadata lookup');
    const indexes = await storage.readLibraryIndexes();
    assertParsed(Object.values(indexes.resourceIndex), before);

    const saved = await diskBytes(seriesId), callsBeforeReuse = parseCalls.length;
    await archive.scrapeSeries(seriesId);
    assert.deepEqual(await diskBytes(seriesId), saved, 'non-force existing scrape stays untouched');
    assert.equal(parseCalls.length, callsBeforeReuse);

    const protectedPath = await writeLegacy('已刮削旧资料', [cases[1]]);
    const protectedScan = await scanner.scanLibrary({ fast: true, changedPaths: [protectedPath] });
    const protectedResource = protectedScan.resourceList.find(row => row.relativePath.startsWith('已刮削旧资料/'));
    const protectedBundle = await storage.readSeriesBundle(protectedResource.seriesId);
    await storage.writeSeriesBundle(protectedBundle.series, protectedBundle.resources, {
      bangumi: { subjectId: 888, name_cn: '保留旧资料', volumeMatches: [{
        resourceId: protectedResource.resourceId, displayTitle: '第0.2册', displayTitleSource: 'ai' }] },
    });
    const protectedBytes = await diskBytes(protectedResource.seriesId);
    const protectedCalls = parseCalls.length;
    const protectedResult = await archive.scrapeSeries(protectedResource.seriesId);
    assert.equal(protectedResult.resources[0].detectedNumber, 0.2, 'non-force must not migrate a protected old scrape');
    assert.equal(protectedResult.bangumi.volumeMatches[0].displayTitle, '第0.2册');
    assert.equal(parseCalls.length, protectedCalls);
    assert.deepEqual(await diskBytes(protectedResource.seriesId), protectedBytes);

    // A newly scanned source reuses shared metadata but still persists its own AI parsing.
    const mirrorPath = await writeLegacy('镜像来源', cases.slice(0, 2));
    const mirrorScan = await scanner.scanLibrary({ fast: true, changedPaths: [mirrorPath] });
    const mirrorResource = mirrorScan.resourceList.find(row => row.relativePath.startsWith('镜像来源/'));
    const mirrorBefore = (await storage.readSeriesBundle(mirrorResource.seriesId)).resources;
    const mirror = await archive.scrapeSeries(mirrorResource.seriesId, { subjectId: 100 });
    assert.equal(mirror.bangumi.subjectId, 100);
    assertParsed(mirror.resources, mirrorBefore, cases.slice(0, 2));
    assertDisplayTitles(mirror, cases.slice(0, 2));
    assertParsed(Object.values((await storage.readLibraryIndexes()).resourceIndex)
      .filter(row => row.seriesId === mirrorResource.seriesId), mirrorBefore, cases.slice(0, 2));

    await writeLegacy('旧版AI测试', [...cases, nextCase]);
    await scanner.scanLibrary({ fast: true, changedPaths: [metadataPath] });
    const beforeIncrement = (await storage.readSeriesBundle(seriesId)).resources;
    const incrementalStart = legacyCalls().length;
    result = await archive.scrapeSeries(seriesId);
    assert.equal(legacyCalls().length - incrementalStart, 1, 'incremental scrape parses only the new legacy volume');
    assert.equal(legacyCalls().at(-1).context.originalTitle, nextCase.title);
    assert.equal(byTitle(result.resources, nextCase.title).detectedNumber, 3);
    assertDisplayTitles(result, [nextCase]);
    assert.equal(matchCalls.at(-1).resources.length, 1, 'incremental AI naming includes only the new volume');
    for (const resource of result.resources.filter(row => row.legacy.chapterTitle !== nextCase.title)) {
      assert.deepEqual(resource, beforeIncrement.find(row => row.resourceId === resource.resourceId));
    }
    assert.equal((await storage.getResource(byTitle(result.resources, nextCase.title).resourceId)).detectedNumber, 3);

    // Change a semantic answer: refresh must use AI again, not a fixed name/number rule.
    answerNumbers.set('特典集合 海边篇', 8.25);
    const forceStart = legacyCalls().length;
    result = await archive.scrapeSeries(seriesId, { force: true, subjectId: 100 });
    assertParsed(result.resources, beforeIncrement, [...cases, nextCase]);
    assertDisplayTitles(result, [...cases, nextCase]);
    const forced = legacyCalls().slice(forceStart);
    assert.equal(forced.length, 6, 'force reparses each legacy volume exactly once');
    assert.equal(new Set(forced.map(call => call.name)).size, 6, 'force must not parse the same volume twice');

    const beforeFailedForce = await diskBytes(seriesId);
    invalidName = '0.6 雨后的信件';
    await assert.rejects(archive.scrapeSeries(seriesId, { force: true, subjectId: 100 }), /AI 文件名解析/);
    assert.deepEqual(await diskBytes(seriesId), beforeFailedForce, 'failed AI refresh preserves the full old result');
    invalidName = '';

    const fallbackPath = await writeLegacy('无匹配的独立资料', [cases[2], cases[3], cases[5], cases[6]]);
    const fallbackScan = await scanner.scanLibrary({ fast: true, changedPaths: [fallbackPath] });
    const fallbackResource = fallbackScan.resourceList.find(row => row.relativePath.startsWith('无匹配的独立资料/'));
    const fallbackBefore = (await storage.readSeriesBundle(fallbackResource.seriesId)).resources;
    const fallbackStart = legacyCalls().length;
    failMetadata = true;
    const fallback = await archive.scrapeSeries(fallbackResource.seriesId, { subjectId: 999 });
    assert.equal(fallback.bangumi.source, 'local_metadata');
    assert.ok(fallback.fallbackFromError);
    assert.equal(legacyCalls().length - fallbackStart, 2, 'local fallback reuses successful name parses from its failed main scrape');
    assert.equal(byTitle(fallback.resources, cases[2].title).detectedNumber, 8.25);
    assert.equal(byTitle(fallback.resources, cases[3].title).detectedNumber, null);
    for (const item of [cases[5], cases[6]]) assert.deepEqual(byTitle(fallback.resources, item.title), byTitle(fallbackBefore, item.title));
    assert.equal((await storage.getResource(byTitle(fallback.resources, cases[2].title).resourceId)).detectedNumber, 8.25);
    global.fetch = originalFetch;
    console.log('Legacy AI volumes: real scans, first/cached/incremental/forced scrapes, semantic/unknown numbers, excluded chapters, fallback cache and failure retention passed offline.');
    if (!keep) { await close(); return; }
    return { root, dataRoot, seriesId, credentials, close,
      start: async (port = 15949) => {
        child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'),
          env: { ...process.env, DATA_DIR: dataRoot, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(output || 'Fixture startup timed out')), 15000);
          const data = chunk => { output += chunk; if (output.includes('ReadDeck running')) { clearTimeout(timer); resolve(); } };
          child.stdout.on('data', data); child.stderr.on('data', data);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${output}`)); });
        });
        return `http://127.0.0.1:${port}`;
      } };
  } catch (error) {
    global.fetch = originalFetch;
    await close();
    throw error;
  }
}

async function startFixture({ port = 15949 } = {}) {
  const fixture = await runRegression({ keep: true });
  try { return { ...fixture, base: await fixture.start(port) }; }
  catch (error) { await fixture.close(); throw error; }
}
if (require.main === module) {
  (process.argv.includes('--serve') ? startFixture({ port: Number(process.env.READDECK_LEGACY_PORT || 15949) }) : runRegression())
    .then(fixture => {
      if (!fixture) return;
      console.log(`Legacy AI fixture: ${fixture.base} (${credentials.username}/${credentials.password}); series ${fixture.seriesId}`);
      const stop = () => fixture.close().then(() => process.exit());
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    }).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { startFixture };
