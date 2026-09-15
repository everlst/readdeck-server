const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { prepareSettings, fixtureSource } = require('./settings-fixture');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-related-'));
  process.env.DATA_DIR = path.join(root, 'data');
  const novelRoot = path.join(root, 'novels'), artRoot = path.join(root, 'artbooks');
  await fs.mkdir(novelRoot); await fs.mkdir(artRoot);
  prepareSettings({ dataRoot: process.env.DATA_DIR, sources: [fixtureSource(novelRoot, { id: 'novels' }), fixtureSource(artRoot, { id: 'artbooks' })] });
  const metadata = require('../lib/metadataStore');
  const { resolveLocalRelations } = require('../lib/relatedLibrary');
  const access = require('../lib/access');
  const works = [
    { id: 'novel-a', subjectId: 156126, title: '药屋少女的呢喃', name: '薬屋のひとりごと', category: 'novel', sourceId: 'novels', directory: novelRoot, color: '#457967',
      relations: [{ subjectId: 473643, name: '薬屋のひとりごと画集', name_cn: '药屋少女的呢喃画集', relationType: '画集', localSeriesId: 'stale-series' },
        { subjectId: 420628, name_cn: '药屋少女的呢喃 动画', relationType: '动画', url: 'https://bangumi.tv/subject/420628' }] },
    { id: 'artbook-b', subjectId: 473643, title: '药屋少女的呢喃画集', name: '薬屋のひとりごと画集', category: 'comic', sourceId: 'artbooks', directory: artRoot, color: '#aa7549', relations: [] },
  ];
  let server;
  const originalFetch = global.fetch;
  const keep = process.argv.includes('--serve');
  try {
    for (const work of works) {
      const sourcePath = path.join(work.directory, 'cover.png');
      await sharp({ create: { width: 360, height: 480, channels: 3, background: work.color } }).png().toFile(sourcePath);
      work.resource = { resourceId: 'resource-' + work.id, seriesId: work.id, sourceId: work.sourceId, sourcePath,
        relativePath: 'cover.png', seriesRelativePath: '', type: 'image', contentType: 'volume',
        title: work.title, originalTitle: work.title, pageCount: 1, readable: true, category: work.category };
      work.series = { seriesId: work.id, title: work.title, category: work.category, authors: ['日向夏'],
        hasVolumes: true, contentMode: 'volume', brief: '用于验证小说与画集关联跳转的本地测试资料。',
        cover: `/api/resources/${work.resource.resourceId}/cover`, bangumiSubjectId: work.subjectId };
      await metadata.writeSeriesBundle(work.series, [work.resource], { bangumi: { subjectId: work.subjectId,
        name: work.name, name_cn: work.title, image: work.series.cover, relatedSubjects: work.relations }, relations: work.relations });
    }
    await metadata.rebuildIndexes(works.map(work => work.series), works.map(work => work.resource));
    const [a, b] = works;
    global.fetch = async url => {
      assert.equal(String(url), 'https://api.bgm.tv/v0/subjects/473643/subjects');
      return new Response(JSON.stringify([{ id: 156126, relation: '画集', type: 1 }]), { headers: { 'Content-Type': 'application/json' } });
    };
    const options = work => ({ seriesIds: [work.id], subjectIds: [work.subjectId], category: work.category });
    const forward = await resolveLocalRelations(a.relations, options(a));
    assert.equal(forward[0].localSeriesId, b.id, 'local related works must resolve across categories and replace stale IDs');
    assert.equal(forward[0].relationLabel, '画集');
    assert.equal(forward.find(row => row.subjectId === 420628).localSeriesId, null);
    const reverse = await resolveLocalRelations([], options(b));
    assert.equal(reverse[0].localSeriesId, a.id, 'a stored one-way relation must enable navigation in both directions');
    assert.equal(reverse[0].relationType, '画集', 'reverse links must use the current subject’s Bangumi relation type');
    const restricted = await access.context.run({ role: 'reader', sourceIds: ['novels'] }, () => resolveLocalRelations(a.relations, options(a)));
    assert.equal(restricted.find(row => row.subjectId === b.subjectId).localSeriesId, null, 'inaccessible local works remain external Bangumi links');
    await metadata.writeSeriesBundle(b.series, []);
    await metadata.upsertSeriesIndexes(b.series, []);
    assert.equal((await resolveLocalRelations(a.relations, options(a))).find(row => row.subjectId === b.subjectId).localSeriesId, null,
      'deleted local resources must invalidate navigation');
    await metadata.writeSeriesBundle(b.series, [b.resource]);
    await metadata.upsertSeriesIndexes(b.series, [b.resource]);
    global.fetch = originalFetch;
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const preload = path.join(root, 'bangumi-fixture.cjs');
    await fs.writeFile(preload, `const original = global.fetch;
global.fetch = (url, options) => String(url).startsWith('https://api.bgm.tv/')
  ? Promise.resolve(new Response(JSON.stringify([{ id: 156126, relation: '画集', type: 1 }]), { headers: { 'Content-Type': 'application/json' } }))
  : original(url, options);`);
    server = spawn(process.execPath, ['--require', preload, 'server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
    for (let i = 0; i < 100 && !logs.includes('ReadDeck running'); i++) {
      if (server.exitCode !== null) throw new Error(logs);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(logs.includes('ReadDeck running'), logs);
    const auth = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password' }) }).then(res => res.json());
    const detail = async id => {
      const res = await fetch(base + '/api/comics/' + id, { headers: { Authorization: 'Bearer ' + auth.token } });
      assert.equal(res.status, 200); return res.json();
    };
    const aDetail = await detail(a.id), bDetail = await detail(b.id);
    assert.equal(aDetail.relations.find(row => row.subjectId === b.subjectId).localSeriesId, b.id);
    assert.equal(bDetail.relations.find(row => row.subjectId === a.subjectId).localSeriesId, a.id);
    assert.equal(bDetail.relations.find(row => row.subjectId === a.subjectId).relationType, '画集');
    const web = await fetch(base + '/app.js').then(res => res.text());
    assert(web.includes('data-local-series-id'));
    assert(!web.includes('relations.slice(0, 24)'), 'related navigation must not truncate local cards');
    console.log('Cross-category, reciprocal, permission-filtered, stale/deleted relation links and detail API passed.');
    if (keep) {
      console.log(`RELATED_QA_URL=${base}`);
      await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
    }
  } finally {
    global.fetch = originalFetch;
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
