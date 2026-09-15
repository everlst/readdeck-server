const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { prepareSettings, fixtureSource } = require('./settings-fixture');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-web-detail-'));
  process.env.DATA_DIR = path.join(root, 'data');
  const library = path.join(root, 'library');
  await fs.mkdir(library);
  prepareSettings({ dataRoot: process.env.DATA_DIR, sources: [fixtureSource(library)] });
  const metadata = require('../lib/metadataStore');
  const workStore = require('../lib/workStore');
  const progressStore = require('../lib/progressStore');
  const { resolveLocalRelations } = require('../lib/relatedLibrary');
  const access = require('../lib/access');
  let child;
  const source = { id: 'publisher', url: 'https://publisher.example/work-a', title: '出版资料', excerpt: '已保存的作品资料' };
  const keyA = 'web:novel:a', keyB = 'web:novel:b';
  const volumeKey1 = 'web:volume:a-1', volumeKey2 = 'web:volume:a-2';
  const detailFor = (key, name) => ({ detailKey: key, metadataKey: key, subjectId: null,
    nameJa: `${name} Original`, nameCn: name, summary: `${name}的已保存简介`,
    cover: `https://publisher.example/${encodeURIComponent(name)}.jpg`,
    sourceUrl: `https://publisher.example/${key}`, sources: [source], externalLinks: [{ url: source.url, title: source.title }] });

  async function writeWork({ id, key, subjectId = null, category = 'novel', matches = [], details = {}, relations = [], web = true, resources: resourceIds = [] }) {
    const resources = resourceIds.map((resourceId, index) => ({ resourceId, seriesId: id,
      sourceId: 'fixture-source', type: 'pdf', contentType: 'volume', category, title: '本地原名',
      originalTitle: '相同本地文件名', relativePath: `${id}/${resourceId}.pdf`, sourcePath: path.join(library, `${resourceId}.pdf`),
      detectedNumber: index + 1, pageCount: 12, readable: true }));
    for (const resource of resources) await fs.writeFile(resource.sourcePath, '%PDF-1.4\n');
    const sourceUrl = key === keyA ? source.url : `https://publisher.example/${id}`;
    const series = { seriesId: id, category, title: `${id}中文作品`, metadataKey: key || '', sourceUrl,
      authors: ['中文作者'], bangumiSubjectId: subjectId, hasVolumes: true, contentMode: 'volume',
      cover: 'https://publisher.example/cover.jpg' };
    const bangumi = { subjectId, name_cn: series.title, name: `${id} Original`, summary: '联网刮削最终简介',
      metadataKey: key || '', sourceUrl, sources: [source], externalLinks: [{ url: sourceUrl, title: '出版社' }],
      volumeMatches: matches, relatedSubjects: relations, ...(web ? { webScrape: { status: 'success', completedAt: new Date().toISOString() } } : {}) };
    const persons = [{ personId: null, metadataKey: 'person:author', sourceUrl: 'https://author.example/about', name: 'Author', nameCn: '作者', role: '作者' }];
    const characters = [{ characterId: null, metadataKey: 'character:a', sourceUrl: 'https://publisher.example/character', name: 'Character', nameCn: '角色',
      actors: [{ personId: null, metadataKey: 'person:actor', sourceUrl: 'https://actor.example/about', nameCn: '声优' }] }];
    const written = await metadata.writeSeriesBundle(series, resources, { bangumi, relations, persons, characters, volumeDetails: details });
    await metadata.upsertSeriesIndexes(written, resources);
    return { series: written, bangumi, resources, volumeDetails: details };
  }

  try {
    const a = await writeWork({ id: 'web-a', key: keyA,
      resources: ['a1', 'a2', 'a-unmapped', 'a-missing-detail', 'a-fallback'],
      matches: [
        { resourceId: 'a1', subjectId: null, detailKey: volumeKey1, matched: true, displayTitle: '第一卷 完整副标题', source: 'ai_web_scrape' },
        { resourceId: 'a2', subjectId: null, detailKey: volumeKey2, matched: true, displayTitle: '第二卷 完整副标题', source: 'ai_web_scrape' },
        { resourceId: 'a-missing-detail', subjectId: 81001, detailKey: 'web:missing', matched: true, displayTitle: '缺字段卷册', source: 'ai_web_scrape' },
        { resourceId: 'a-fallback', subjectId: null, detailKey: 'local:a-fallback', matched: false, displayTitle: '本地回退译名', source: 'local_metadata_fallback', matchKind: 'local' },
      ], details: { [volumeKey1]: detailFor(volumeKey1, '第一卷'), [volumeKey2]: detailFor(volumeKey2, '第二卷'),
        'local:a-fallback': { detailKey: 'local:a-fallback', metadataKey: 'local:a-fallback', nameCn: '本地回退译名', summary: '本地资料已中文化', fallback: true, sourceUrl: '', sources: [] } },
      relations: [{ subjectId: null, metadataKey: keyB, name_cn: '关联外传', relationType: '外传', sourceUrl: 'https://publisher.example/web-b' },
        { subjectId: null, metadataKey: 'web:remote', name_cn: '外部关联', relationType: '', sourceUrl: 'https://publisher.example/remote' },
        { subjectId: 90210, name_cn: '有ID的补充来源', relationType: '画集', sourceUrl: 'https://publisher.example/artbook' }],
    });
    await writeWork({ id: 'web-a-copy', key: keyA, resources: ['a1-copy'],
      matches: [{ resourceId: 'a1-copy', subjectId: null, detailKey: volumeKey1, matched: true, displayTitle: '第一卷 完整副标题', source: 'ai_web_scrape' }],
      details: { [volumeKey1]: detailFor(volumeKey1, '第一卷') } });
    await writeWork({ id: 'web-a-comic', key: keyA, category: 'comic', resources: ['adaptation'] });
    await writeWork({ id: 'web-b', key: keyB, resources: ['b1'] });
    await writeWork({ id: 'web-numeric', key: 'web:numeric', subjectId: 81000, resources: ['numeric-volume'],
      matches: [{ resourceId: 'numeric-volume', subjectId: 81001, detailKey: 'web:numeric-volume', matched: true, displayTitle: '已确认卷册', source: 'ai_web_scrape' }],
      relations: [{ subjectId: 90211, name_cn: '未知关联分类', relationType: '' }] });
    await writeWork({ id: 'legacy', web: false, subjectId: 9999, resources: ['legacy-volume'],
      matches: [{ resourceId: 'legacy-volume', subjectId: 10001, matched: true, displayTitle: '第1册' }],
      details: { '10001': { nameJa: 'Legacy', nameCn: '旧卷册', summary: '旧简介', cover: '', date: '' } } });
    const aiTitle = '(1) AI　完整标题＋附录.epub';
    await writeWork({ id: 'ai-title', web: false, subjectId: 300270, resources: ['ai-volume'],
      matches: [{ resourceId: 'ai-volume', subjectId: 311129, matched: true, matchKind: 'offprint', relationType: '单行本',
        displayTitle: aiTitle, displayTitleSource: 'ai', source: 'deepseek_volume_match' }],
      details: { '311129': { subjectId: 311129, nameJa: 'Original volume', nameCn: '详情中的完整书名', summary: '卷册简介', cover: '', date: '' } } });

    assert.equal(workStore.workIdForBundle(a), `metadata:novel:${keyA}`);
    assert.equal(workStore.workIdFor({ category: 'novel', subjectId: 9999, metadataKey: keyA }), 'subject:novel:9999');
    assert.equal(workStore.workIdFor({ category: 'novel', seriesId: 'local' }), 'series:novel:local');
    await workStore.assignSeriesToWork('old-local-group', ['web-a']);
    assert.equal(await workStore.resolveWorkIdForBundle(a), `metadata:novel:${keyA}`, 'generic identity must supersede stale local grouping');

    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('Relation resolution must not request external data'); };
    try {
      const forward = await resolveLocalRelations(a.bangumi.relatedSubjects, { seriesIds: ['web-a'], metadataKeys: [keyA], allowRemote: false });
      assert.equal(forward.find(row => row.metadataKey === keyB).localSeriesId, 'web-b');
      assert.equal(forward.find(row => row.subjectId === 90210).url, 'https://publisher.example/artbook');
      const byUrl = await resolveLocalRelations([{ name_cn: '外传', sourceUrl: 'https://publisher.example/web-b/' }], { metadataKeys: [keyA], allowRemote: false });
      assert.equal(byUrl[0].localSeriesId, 'web-b', 'source URL identifies stored generic relations');
      const reverse = await resolveLocalRelations([], { seriesIds: ['web-b'], metadataKeys: [keyB], allowRemote: false });
      assert(reverse.some(row => row.metadataKey === keyA && row.localSeriesId), 'generic one-way relations must be navigable in reverse');
      const restricted = await access.context.run({ role: 'reader', sourceIds: [] }, () =>
        resolveLocalRelations(a.bangumi.relatedSubjects, { metadataKeys: [keyA], allowRemote: false }));
      assert(restricted.every(row => row.localSeriesId === null), 'generic identifiers must not expose hidden library entries');
    } finally { global.fetch = originalFetch; }

    await progressStore.save('admin', 'web-a-copy', { chapterUuid: 'a1-copy', resourceId: 'a1-copy', resourceType: 'pdf',
      page: 4, cfi: 'preserved-cfi', scrollPercent: 42, deviceId: 'test-device', sequence: 7 });
    const progressBefore = await progressStore.read('admin');
    const guardLog = path.join(root, 'old-flow-calls.jsonl');
    await fs.writeFile(guardLog, '');
    const preload = path.join(root, 'guard.cjs');
    await fs.writeFile(preload, `const fs = require('node:fs');
const archive = require(${JSON.stringify(path.resolve(__dirname, '../lib/archiveSource.js'))});
for (const key of ['getApiJson', 'maybeTranslate', 'maybeSimplifyChinese']) archive[key] = async () => {
  fs.appendFileSync(${JSON.stringify(guardLog)}, key + '\\n'); throw new Error('Unexpected legacy enrichment: ' + key);
};
const originalFetch = global.fetch;
global.fetch = (url, options) => {
  if (!String(url).startsWith('http://127.0.0.1:')) {
    fs.appendFileSync(${JSON.stringify(guardLog)}, 'fetch:' + String(url) + '\\n');
    throw new Error('Unexpected external request');
  }
  return originalFetch(url, options);
};
`);
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    child = spawn(process.execPath, ['--require', preload, 'server.js'], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    for (let i = 0; i < 150 && !logs.includes('ReadDeck running'); i++) {
      if (child.exitCode !== null) throw new Error(logs);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(logs.includes('ReadDeck running'), logs);
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'test-password' }) }).then(res => res.json());
    assert(login.token);
    async function get(url) {
      const res = await fetch(base + url, { headers: { Authorization: `Bearer ${login.token}` } });
      const text = await res.text();
      assert.equal(res.status, 200, text);
      return JSON.parse(text);
    }

    const comic = await get('/api/comics/web-a');
    assert.equal(comic.comic.metadataKey, keyA);
    assert.equal(comic.comic.sourceUrl, source.url);
    assert.equal(comic.comic.bangumiSubjectId, null);
    assert.equal(comic.comic.brief, '联网刮削最终简介');
    assert.deepEqual(comic.resourceVersions.map(row => row.seriesId).sort(), ['web-a', 'web-a-copy']);
    const volumeCard = comic.localVolumes.find(row => row.detailKey === volumeKey1);
    assert.equal(volumeCard.versionCount, 2);
    assert.equal(volumeCard.title, '第一卷 完整副标题', 'AI final titles must not enter legacy normalization');
    assert.equal(volumeCard.sourceUrl, detailFor(volumeKey1, '第一卷').sourceUrl);
    assert.equal(volumeCard.resourceId, 'a1-copy', 'the recently read original resource remains the preferred version');
    assert(comic.bookSections.flatMap(section => section.items).some(row => row.detailKey === volumeKey2));
    assert.equal(comic.persons[0].url, 'https://author.example/about');
    assert.equal(comic.characters[0].actors[0].url, 'https://actor.example/about');
    assert.equal(comic.workProgress.lastResourceId, 'a1-copy');
    assert.equal(comic.workProgress.lastPage, 4);
    assert.equal(comic.workProgress.lastCfi, 'preserved-cfi');

    for (const [resourceId, key, title] of [['a1', volumeKey1, '第一卷'], ['a2', volumeKey2, '第二卷']]) {
      const volume = await get(`/api/comics/web-a/volumes/${resourceId}`);
      assert.equal(volume.resourceId, resourceId);
      assert.equal(volume.detailKey, key);
      assert.equal(volume.metadataKey, key);
      assert.equal(volume.bangumiSubjectId, null);
      assert.equal(volume.bangumiUrl, '');
      assert.equal(volume.nameCn, title);
      assert.equal(volume.summary, `${title}的已保存简介`);
      assert.deepEqual(volume.sources, [source]);
      assert.equal(volume.externalLinks[0].url, source.url);
      assert.equal(volume.sourceUrl, detailFor(key, title).sourceUrl);
    }
    const unmapped = await get('/api/comics/web-a/volumes/a-unmapped');
    assert.equal(unmapped.detailKey, '', 'matching titles must not borrow another resource’s result');
    assert.equal(unmapped.summary, '');
    const fallback = await get('/api/comics/web-a/volumes/a-fallback');
    assert.equal(fallback.nameCn, '本地回退译名');
    assert.equal(fallback.summary, '本地资料已中文化');
    assert.equal(fallback.detailKey, 'local:a-fallback');
    assert.equal(fallback.matchKind, 'local');
    assert.equal(fallback.sourceUrl, '');
    const missing = await get('/api/comics/web-a/volumes/a-missing-detail');
    assert.equal(missing.bangumiSubjectId, 81001);
    assert.equal(missing.summary, '', 'missing fields on a final web result remain empty');
    assert.equal(missing.bangumiUrl, 'https://bangumi.tv/subject/81001');
    await get('/api/comics/web-numeric');
    await get('/api/comics/web-numeric/volumes/numeric-volume');
    const legacy = await get('/api/comics/legacy/volumes/legacy-volume');
    assert.equal(legacy.nameCn, '旧卷册');
    assert.equal(legacy.summary, '旧简介');
    assert.equal(legacy.bangumiSubjectId, 10001);
    assert.equal(legacy.bangumiUrl, 'https://bangumi.tv/subject/10001');
    const aiComic = await get('/api/comics/ai-title');
    assert.equal(aiComic.localVolumes[0].title, aiTitle, 'card names must bypass legacy normalization for AI matches');
    assert.equal(aiComic.bookSections.flatMap(section => section.items)[0].title, aiTitle);
    const aiVolume = await get('/api/comics/ai-title/volumes/ai-volume');
    assert.equal(aiVolume.title, aiTitle, 'volume navigation retains the same AI display name');
    assert.equal(aiVolume.nameCn, '详情中的完整书名', 'full detail names remain available independently');
    const list = await get('/api/comics');
    const rows = Array.isArray(list) ? list : (list.comics || list.list || []);
    assert(rows.some(row => row.metadataKey === keyA && row.category === 'novel' && row.seriesIds?.length === 2));
    assert.equal(await fs.readFile(guardLog, 'utf8'), '', 'detail presentation must never call legacy API or translation enrichment');
    assert.deepEqual(await progressStore.read('admin'), progressBefore, 'detail requests must preserve all reading positions and resource IDs');
    console.log('Web detail: generic IDs, separate volumes, aggregation, sources, permissions, progress, numeric compatibility and zero enrichment passed.');
    if (process.argv.includes('--serve')) {
      console.log(JSON.stringify({ base, username: 'admin', password: 'test-password' }));
      process.once('SIGTERM', () => child.kill('SIGTERM'));
      process.once('SIGINT', () => child.kill('SIGTERM'));
      await new Promise(resolve => child.once('exit', resolve));
    }
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
