const assert = require('assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const sharp = require('sharp');
const { prepareSettings, fixtureSource } = require('./settings-fixture');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-integration-'));
  const dataRoot = path.join(root, 'data');
  const sourceA = path.join(root, 'library-a'), sourceB = path.join(root, 'library-b');
  process.env.DATA_DIR = dataRoot;
  for (const source of [sourceA, sourceB]) {
    await fs.mkdir(path.join(source, 'Work', 'Chapter'), { recursive: true });
    for (let i = 1; i <= 3; i++) await sharp({ create: { width: 600, height: 900, channels: 3, background: source === sourceA ? '#c27034' : '#476177' } }).png().toFile(path.join(source, 'Work', 'Chapter', `${i}.png`));
  }
  prepareSettings({ dataRoot, sources: [fixtureSource(sourceA, { id: 'source-a', name: '公开漫画' }), fixtureSource(sourceB, { id: 'source-b', name: '私有书库' })] });
  const metadata = require('../lib/metadataStore');
  const series = ['a', 'b'].map(suffix => ({ schemaVersion: 1, seriesId: `series-${suffix}`, title: suffix === 'a' ? 'ReadDeck 测试漫画' : '私有版本', authors: ['ReadDeck'], tags: [suffix === 'a' ? '公开' : '私有'], category: 'comic', bangumiSubjectId: 42, updatedAt: new Date().toISOString() }));
  const resources = ['a', 'b'].map((suffix, index) => ({ schemaVersion: 1, resourceId: `resource-${suffix}`, seriesId: series[index].seriesId,
    sourceId: `source-${suffix}`, sourcePath: path.join(index === 0 ? sourceA : sourceB, 'Work', 'Chapter'),
    relativePath: 'Work/Chapter', seriesRelativePath: 'Work', title: '第一章', type: 'directory', contentType: 'chapter', pageCount: 3,
    category: 'comic', groupName: '章节', readable: true }));
  for (let i = 0; i < series.length; i++) await metadata.writeSeriesBundle(series[i], [resources[i]]);
  // A tiny standards-compliant EPUB exercises offline packaging without external services.
  const epubRoot = path.join(root, 'epub'); await fs.mkdir(path.join(epubRoot, 'META-INF'), { recursive: true });
  await fs.writeFile(path.join(epubRoot, 'mimetype'), 'application/epub+zip');
  await fs.writeFile(path.join(epubRoot, 'META-INF/container.xml'), '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  await fs.writeFile(path.join(epubRoot, 'book.opf'), '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">readdeck-test</dc:identifier><dc:title>阅读的时光</dc:title><dc:creator>ReadDeck</dc:creator><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-09-07T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>');
  await fs.writeFile(path.join(epubRoot, 'chapter.xhtml'), '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>阅读的时光</title></head><body><h1>第一章 阅读的时光</h1>' + '<p>翻开一本书，让世界慢下来。ReadDeck 将书库带到你的身边，无论在线还是离线，都能继续阅读。</p>'.repeat(70) + '</body></html>');
  await fs.writeFile(path.join(epubRoot, 'nav.xhtml'), '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章 阅读的时光</a></li></ol></nav></body></html>');
  // A separate illustrated page exercises native hit testing, zoom and rotation in the real EPUB renderer.
  await fs.writeFile(path.join(epubRoot, 'illustration.xhtml'), '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>插画预览</title></head><body style="margin:0;padding:0"><img src="illustration.png" alt="插画预览" style="width:100%;height:auto"/></body></html>');
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#efe3c8"/><path d="M0 0H300V450H0Z" fill="#476177"/><path d="M300 450H600V900H300Z" fill="#c27034"/><circle cx="300" cy="450" r="130" fill="#ffffff"/><text x="300" y="475" font-size="80" text-anchor="middle">UP</text></svg>')).png().toFile(path.join(epubRoot, 'illustration.png'));
  const opfFile = path.join(epubRoot, 'book.opf');
  await fs.writeFile(opfFile, (await fs.readFile(opfFile, 'utf8')).replace('</manifest>', '<item id="art" href="illustration.xhtml" media-type="application/xhtml+xml"/><item id="picture" href="illustration.png" media-type="image/png"/></manifest>').replace('</spine>', '<itemref idref="art"/></spine>'));
  const initialNav = path.join(epubRoot, 'nav.xhtml');
  await fs.writeFile(initialNav, (await fs.readFile(initialNav, 'utf8')).replace('</ol>', '<li><a href="illustration.xhtml">插画预览</a></li></ol>'));
  const epubFile = path.join(sourceA, 'Reading.epub'); execFileSync('bsdtar', ['--format', 'zip', '-cf', epubFile, '-C', epubRoot, '.']);
  const novel = { schemaVersion: 1, seriesId: 'novel', title: '阅读的时光', authors: ['ReadDeck'], category: 'novel', tags: ['小说'] };
  const epub = { schemaVersion: 1, resourceId: 'epub', seriesId: 'novel', sourceId: 'source-a', sourcePath: epubFile, relativePath: 'Reading.epub', seriesRelativePath: '', title: '阅读的时光', type: 'epub', contentType: 'volume', category: 'novel', pageCount: 1, readable: true };
  await metadata.writeSeriesBundle(novel, [epub]);
  await metadata.rebuildIndexes([...series, novel], [...resources, epub]);
  const port = Number(process.env.READDECK_TEST_PORT || 15931);
  const server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), DATA_DIR: dataRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; server.stdout.on('data', d => { logs += d }); server.stderr.on('data', d => { logs += d });
  const base = `http://127.0.0.1:${port}`;
  let keep = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) { if (logs.includes('ReadDeck running')) break; if (server.exitCode !== null) throw new Error(logs); await sleep(100); }
    assert.match(logs, /ReadDeck running/);
    async function request(url, token, method = 'GET', body) {
      const response = await fetch(base + url, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = text }
      return { status: response.status, data, response };
    }
    const login = async (username, password) => { const result = await request('/api/login', '', 'POST', { username, password }); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.token; };
    const admin = await login('admin', 'test-password');
    const info = await request('/api/server'); assert.equal(info.data.apiVersion, 1); assert.ok(info.data.instanceId);
    // Warm the administrator cache before querying as a restricted reader.
    assert.equal((await request('/api/library', admin)).status, 200);
    const create = await request('/api/users', admin, 'POST', { username: 'alice', password: 'alice-password', sourceIds: ['source-a'] }); assert.equal(create.status, 200, JSON.stringify(create.data));
    let alice = await login('alice', 'alice-password');
    assert.equal((await request('/api/library', alice)).status, 403);
    const change = await request('/api/account', alice, 'PUT', { username: 'alice', currentPassword: 'alice-password', password: 'alice-new-password' }); assert.equal(change.status, 200); alice = change.data.token;
    const createdB = await request('/api/users', admin, 'POST', { username: 'bob', password: 'bob-password', sourceIds: ['source-b'] }); assert.equal(createdB.status, 200);
    let bob = await login('bob', 'bob-password'); bob = (await request('/api/account', bob, 'PUT', { username: 'bob', currentPassword: 'bob-password', password: 'bob-new-password' })).data.token;
    const library = await request('/api/library', alice); assert.equal(library.status, 200); assert.equal(library.data.length, 2); assert.ok(!JSON.stringify(library.data).includes('series-b'));
    assert.equal((await request('/api/library/search?q=私有', alice)).data.length, 0);
    assert.ok(!JSON.stringify((await request('/api/tags', alice)).data).includes('私有'));
    const detail = await request('/api/comics/series-a', alice); assert.equal(detail.status, 200); assert.ok(!JSON.stringify(detail.data).includes('resource-b')); assert.ok(!JSON.stringify(detail.data).includes(sourceB));
    assert.equal((await request('/api/resources/epub/epub/manifest', alice)).status, 200);
    assert.equal((await request('/api/resources/epub/epub/file', alice)).status, 200);
    for (const url of ['/api/resources/resource-b/page/1', '/api/resources/resource-b/cover', '/api/comics/series-b', '/api/resources/epub/epub/file']) {
      const token = url.includes('/epub/') ? bob : alice; assert.notEqual((await request(url, token)).status, 200, url);
    }
    for (const url of ['/api/settings', '/api/users', '/api/tasks']) assert.equal((await request(url, alice)).status, 403);
    assert.equal((await request('/api/resources/resource-a', alice, 'DELETE')).status, 403);
    const at = new Date(Date.now() - 6000).toISOString(), newer = new Date(Date.now() - 1000).toISOString();
    const update = { chapterUuid: 'resource-a', resourceId: 'resource-a', page: 2, deviceId: 'device-a', sequence: 1, readAt: newer };
    assert.equal((await request('/api/progress/series-a', alice, 'PUT', update)).data.applied, true);
    assert.equal((await request('/api/progress/series-a', alice, 'PUT', { ...update, page: 0, readAt: at })).data.applied, false);
    assert.equal((await request('/api/progress/series-a', alice, 'PUT', update)).data.applied, false);
    for (const patch of [{ chapterUuid: '__proto__' }, { sequence: 1.5 }, { cfi: 'x'.repeat(8193) }, { scrollPercent: -1 }]) {
      assert.equal((await request('/api/progress/series-a', alice, 'PUT', { ...update, ...patch })).status, 400);
    }
    assert.equal((await request('/api/progress/series-a', alice)).data.lastPage, 2);
    assert.deepEqual((await request('/api/progress', bob)).data, {});
    assert.deepEqual((await request('/api/progress', admin)).data, {});
    let job = (await request('/api/downloads', alice, 'POST', { resourceId: 'resource-a' })).data;
    for (let i = 0; i < 100 && ['queued','building'].includes(job.state); i++) { await sleep(100); job = (await request('/api/downloads/' + job.id, alice)).data; }
    assert.equal(job.state, 'ready', JSON.stringify(job));
    const file = await fetch(base + job.fileURL, { headers: { Authorization: 'Bearer ' + alice } }); const data = Buffer.from(await file.arrayBuffer());
    assert.equal(file.status, 200); assert.equal(crypto.createHash('sha256').update(data).digest('hex'), job.sha256);
    const range = await fetch(base + job.fileURL, { headers: { Authorization: 'Bearer ' + alice, Range: 'bytes=0-99' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 100);
    assert.equal((await request('/api/downloads/' + job.id, bob)).status, 404);
    assert.equal((await request('/api/downloads/' + job.id + '/file', bob)).status, 404);
    assert.equal((await request('/api/downloads', alice, 'POST', { resourceId: 'resource-b' })).status, 404);
    if (!process.argv.includes('--serve')) {
      // Cache invalidation must not wait for a scanner metadata update.
      const before = await request('/api/resources/epub/epub/manifest', alice);
      assert.equal(before.status, 200);
      const navFile = path.join(epubRoot, 'nav.xhtml');
      await fs.writeFile(navFile, (await fs.readFile(navFile, 'utf8')).replace('第一章 阅读的时光', '更新后的章节'));
      execFileSync('bsdtar', ['--format', 'zip', '-cf', epubFile, '-C', epubRoot, '.']);
      const after = await request('/api/resources/epub/epub/manifest', alice);
      assert.equal(after.status, 200); assert.match(JSON.stringify(after.data), /更新后的章节/);
    }
    // Updating a source creates a new immutable package; cancelling it does not affect the previous version.
    await sharp({ create: { width: 600, height: 900, channels: 3, background: '#654321' } }).png().toFile(path.join(sourceA, 'Work', 'Chapter', '1.png'));
    let updatedJob = (await request('/api/downloads', alice, 'POST', { resourceId: 'resource-a' })).data;
    assert.notEqual(updatedJob.id, job.id);
    for (let i = 0; i < 100 && ['queued', 'building'].includes(updatedJob.state); i++) { await sleep(100); updatedJob = (await request('/api/downloads/' + updatedJob.id, alice)).data; }
    assert.equal(updatedJob.state, 'ready'); assert.notEqual(updatedJob.sha256, job.sha256);
    assert.equal((await request('/api/downloads/' + updatedJob.id, alice, 'DELETE')).status, 200);
    assert.equal((await request('/api/downloads/' + updatedJob.id + '/file', alice)).status, 409);
    // A reader receives only a generic library notification and an empty task list.
    const events = await fetch(base + '/api/events', { headers: { Authorization: 'Bearer ' + alice }, signal: AbortSignal.timeout(10000) });
    const stream = events.body.getReader(); let eventText = '';
    while (!eventText.includes('event: ready')) { const next = await stream.read(); eventText += Buffer.from(next.value || []).toString(); }
    assert.ok(!eventText.includes('resource-b')); assert.match(eventText, /"tasks":\[\]/);
    assert.equal((await request('/api/users/admin', admin, 'PUT', { enabled: false })).status, 409);
    const revoke = await request('/api/users/' + create.data.id, admin, 'PUT', { sourceIds: [] }); assert.equal(revoke.status, 200);
    assert.equal((await stream.read()).done, true, '授权变更应立即关闭旧事件流');
    assert.equal((await request('/api/library', alice)).status, 401);
    alice = await login('alice', 'alice-new-password');
    assert.deepEqual((await request('/api/library', alice)).data, []);
    assert.equal((await request(job.fileURL, alice)).status, 404);
    if (process.argv.includes('--serve')) {
      await request('/api/users/' + create.data.id, admin, 'PUT', { sourceIds: ['source-a'] });
      const uiSeries = [...series, novel], uiResources = [...resources, epub];
      const entryQA = { ...series[0], seriesId: 'comic-entry-qa', title: '单话与单行本验证', bangumiSubjectId: null };
      const entryChapter = { ...resources[0], resourceId: 'entry-chapter', seriesId: entryQA.seriesId, title: '第13话', detectedNumber: 13,
        groupKey: 'other_group', groupName: '其他系列' };
      const entryVolume = { ...resources[0], resourceId: 'entry-volume', seriesId: entryQA.seriesId, title: '第1卷', contentType: 'volume', detectedNumber: 1, volumeNumber: 1, firstIndexedAt: '2026-09-01T00:00:00Z' };
      const entryOther = { ...entryVolume, resourceId: 'entry-volume-other', pageCount: 0, firstIndexedAt: '2026-08-01T00:00:00Z' };
      await metadata.writeSeriesBundle(entryQA, [entryChapter, entryVolume, entryOther]);
      await require('../lib/workStore').updateWorkState('series:comic:comic-entry-qa', { modelGroups: {
        'entry-volume': { groupKey: 'volume-one' }, 'entry-volume-other': { groupKey: 'volume-one' },
      } });
      uiSeries.push(entryQA); uiResources.push(entryChapter, entryVolume, entryOther);
      if (process.env.READDECK_COVER_QA === '1') {
        const sizes = [[30, 20], [80, 80], [360, 540], [150, 600]];
        for (let i = 0; i < 20; i++) {
          const [width, height] = sizes[i % sizes.length];
          const folder = path.join(sourceA, `CoverQA-${i}`); await fs.mkdir(folder);
          const color = ['#ca8754', '#66817c', '#45677d', '#a58082'][i % 4];
          await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 120 180"><rect width="120" height="180" fill="${color}"/><circle cx="60" cy="60" r="32" fill="#f4e7d1"/><path d="M0 180L60 90L120 180" fill="#203b50"/></svg>`)).png().toFile(path.join(folder, '1.png'));
          const qa = { ...series[0], seriesId: `cover-qa-${i}`, category: i >= 18 ? 'other' : 'comic', cover: `/api/resources/cover-pages-${i}/cover`, title: ['小尺寸横版封面', '正方形封面', '书名较长时的卡片间距与作者显示', '窄幅封面'][i % 4] + ` ${i + 1}`, authors: [i % 2 ? '作者甲、作者乙、作者丙' : 'ReadDeck'], bangumiSubjectId: null };
          const resource = { ...resources[0], resourceId: `cover-pages-${i}`, seriesId: qa.seriesId, category: qa.category, sourcePath: folder, relativePath: `CoverQA-${i}`, seriesRelativePath: `CoverQA-${i}`, pageCount: 1 };
          await metadata.writeSeriesBundle(qa, [resource]); uiSeries.push(qa); uiResources.push(resource);
        }
      }
      if (process.env.READDECK_PAGER_QA === '1') {
        const folder = path.join(sourceA, 'PagerQA'); await fs.mkdir(folder);
        for (let i = 1; i <= 61; i++) {
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="2700"><defs><pattern id="grid" width="180" height="180" patternUnits="userSpaceOnUse"><rect width="180" height="180" fill="${i % 2 ? '#f2dcc0' : '#d2e3f4'}"/><path d="M0 0H180V180" fill="none" stroke="#486070" stroke-width="8"/></pattern></defs><rect width="1800" height="2700" fill="url(#grid)"/><rect x="0" y="1100" width="1800" height="500" fill="white"/><text x="900" y="1470" font-size="340" text-anchor="middle">${i}</text></svg>`;
          await sharp(Buffer.from(svg)).png().toFile(path.join(folder, `${String(i).padStart(3, '0')}.png`));
        }
        const qa = { ...series[0], seriesId: 'pager-qa', title: '翻页与旋转验证', bangumiSubjectId: null };
        const resource = { ...resources[0], resourceId: 'pager-qa-pages', seriesId: 'pager-qa', sourcePath: folder, relativePath: 'PagerQA', seriesRelativePath: 'PagerQA', pageCount: 61 };
        await metadata.writeSeriesBundle(qa, [resource]);
        uiSeries.push(qa); uiResources.push(resource);
      }
      if (process.env.READDECK_STRIP_QA === '1') {
        const folder = path.join(sourceA, 'StripQA'); await fs.mkdir(folder);
        for (let i = 1; i <= 36; i++) {
          const height = [900, 2100, 600, 1500][i % 4];
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${height}"><defs><pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="${i % 2 ? '#f2dcc0' : '#d2e3f4'}"/><path d="M0 0H100V100" fill="none" stroke="#486070" stroke-width="3"/></pattern></defs><rect width="600" height="${height}" fill="url(#grid)"/><text x="300" y="200" font-size="120" text-anchor="middle">${i}</text></svg>`;
          await sharp(Buffer.from(svg)).png().toFile(path.join(folder, `${String(i).padStart(3, '0')}.png`));
        }
        const qa = { ...series[0], seriesId: 'strip-qa', title: '条漫连续阅读验证', bangumiSubjectId: null };
        const chapters = [1, 2].map(index => ({ ...resources[0], resourceId: `strip-qa-${index}`, seriesId: qa.seriesId,
          title: `第${index}话`, detectedNumber: index, sourcePath: folder, relativePath: 'StripQA', seriesRelativePath: 'StripQA', pageCount: 36 }));
        await metadata.writeSeriesBundle(qa, chapters); uiSeries.push(qa); uiResources.push(...chapters);
      }
      await metadata.rebuildIndexes(uiSeries, uiResources);
      if (process.env.READDECK_PAGER_QA === '1') {
        const progress = await request('/api/progress/pager-qa', admin, 'PUT', { chapterUuid: 'pager-qa-pages', resourceId: 'pager-qa-pages', page: 24, deviceId: 'pager-qa', sequence: 1, readAt: new Date().toISOString() });
        assert.equal(progress.data.applied, true);
      }
      keep = true;
      console.log(JSON.stringify({ base, root, dataRoot, epubFile, sourceA, username: 'admin', password: 'test-password' }));
      console.log('ReadDeck integration passed; UI fixture is running.');
      process.once('SIGTERM', () => server.kill('SIGTERM')); process.once('SIGINT', () => server.kill('SIGTERM'));
      await new Promise(resolve => server.once('exit', resolve));
    } else {
      assert.equal((await request('/api/users/' + createdB.data.id, admin, 'PUT', { enabled: false })).status, 200);
      assert.equal((await request('/api/library', bob)).status, 401);
      const backupAdmin = await request('/api/users', admin, 'POST', { username: 'backup-admin', password: 'backup-password', role: 'admin' });
      assert.equal(backupAdmin.status, 200);
      assert.equal((await request('/api/users/admin', admin, 'PUT', { enabled: false })).status, 200);
      assert.equal((await request('/api/library', admin)).status, 401);
      execFileSync(process.execPath, ['scripts/reset-admin.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATA_DIR: dataRoot } });
      const recovered = await login('admin', 'admin');
      assert.equal((await request('/api/verify', recovered)).data.enabled, true);
      assert.equal((await request('/api/library', recovered)).status, 403);
      assert.equal((await request('/api/library', admin)).status, 401);
      console.log('ReadDeck users, source ACL, progress ordering, package revision/checksum, Range, cancellation, SSE revocation and admin recovery passed.');
    }
  } finally {
    if (server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
