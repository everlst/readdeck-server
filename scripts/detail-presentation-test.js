const { prepareSettings } = require('./settings-fixture');
const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function assertClientMetadataSources() {
  const { app } = require('../public/app');
  const web = { metadataKey: 'novel:publisher:test', sourceUrl: 'https://publisher.example/books/1', bangumiId: null };
  assert.strictEqual(app.metadataSources(web)[0].url, web.sourceUrl);
  assert.deepStrictEqual(app.metadataSources({ bangumiId: null }), []);
  assert.strictEqual(app.metadataSources({ bangumiSubjectId: 123 })[0].url, 'https://bangumi.tv/subject/123');
  assert.deepStrictEqual(app.metadataSources({ bangumiId: -1, sourceUrl: 'javascript:alert(1)' }), []);
  assert.deepStrictEqual(app.metadataSources({ sourceUrl: 'https://user:pass@example.org' }), []);
  assert.strictEqual(app.metadataSources({}, { sources: [{ id: 's1', url: web.sourceUrl, title: '出版社' }] })[0].title, '出版社');
  assert.strictEqual(app.metadataSources({ externalLinks: [web.sourceUrl, { url: web.sourceUrl }] }).length, 1);
  assert.strictEqual(app.metadataSources({ sourceUrl: web.sourceUrl, bangumiSubjectId: 123 })[0].url, web.sourceUrl);
  assert.strictEqual(app.metadataSources({ sourceUrl: 'https://bgm.tv/person/123', personId: 123 }, {}, 'person').length, 1, 'Bangumi mirrors share one destination');
  const savedDocument = global.document, savedWindow = global.window;
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', style: {}, classList: { contains: () => false, add() {}, remove() {}, toggle() {} } });
    return nodes.get(id);
  };
  try {
    global.document = { getElementById: node, querySelectorAll: () => [], documentElement: node('html'), body: node('body'),
      createElement: () => ({ textContent: '', get innerHTML() { return this.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }) };
    global.window = { scrollY: 0, scrollTo() {}, location: { origin: 'http://localhost' } };
    app.state.currentComic = {
      comic: { ...web, id: 'local-work', name: '测试作品', category: 'novel', tags: [] },
      persons: [{ nameCn: '作者', sourceUrl: 'https://author.example/' }],
      characters: [{ nameCn: '无来源角色', bangumiId: null }],
      relations: [{ nameCn: '关联作品', sourceUrl: 'https://publisher.example/related' }],
      bookSections: [{ title: '卷册', items: [{ detailKey: 'volume:web:1', representativeResourceId: 'unchanged-resource', title: '第一卷' }] }],
    };
    app.state.progressCache = { 'local-work': { lastResourceId: 'unchanged-resource', currentPage: 7 } };
    const progress = JSON.stringify(app.state.progressCache);
    app.renderMetadataSections();
    const html = node('metadata-sections').innerHTML;
    assert(html.includes(web.sourceUrl));
    const entities = node('entity-sections').innerHTML;
    assert(entities.includes("app.showEntityDetail('person', 0)"));
    assert(entities.includes('https://publisher.example/related'));
    assert(entities.indexOf('data-section-key="characters"') < entities.indexOf('data-section-key="persons"'));
    app.showEntityDetail('person', 0);
    assert(node('entity-detail-content').innerHTML.includes('https://author.example/'));
    app.closeEntityDetail();
    assert(html.includes('unchanged-resource'), 'volume navigation retains the physical resource ID');
    assert(!html.includes('bangumi.tv/subject/null'));
    assert(!entities.includes('href="#"'), 'entities without sources have no fake link');
    assert.strictEqual(JSON.stringify(app.state.progressCache), progress);
    app.state.currentComic.comic.cover = '/new-cover.jpg';
    app.state.comics = [{ ...web, id: 'other-local-work', cover: '' }, { id: 'unrelated', cover: '' }];
    app.applyOptimisticListCoverFromCurrentComic('local-work');
    assert.strictEqual(app.state.comics[0].cover, '/new-cover.jpg');
    assert.strictEqual(app.state.comics[0].id, 'other-local-work');
    assert.strictEqual(app.state.comics[1].cover, '');
    app.authFetch = async () => ({ json: async () => ({ ...web, detailKey: 'volume:web:1', title: '第一卷', type: 'epub', versions: [] }) });
    app.renderVolumeVersions = () => {};
    app.renderBookInformation = () => {};
    await app.showVolumeDetail('local-work', 'unchanged-resource');
    assert.strictEqual(node('volume-bgm-link').href, web.sourceUrl);
    assert.strictEqual(node('volume-bgm-link').textContent, 'publisher.example');
    assert.strictEqual(app.state.currentVolume.resourceId, 'unchanged-resource');
    assert.strictEqual(JSON.stringify(app.state.progressCache), progress);
  } finally { global.document = savedDocument; global.window = savedWindow; }
}

function waitForOutput(child, pattern, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${pattern}: ${output}`));
    }, timeoutMs);
    const onData = chunk => {
      output += chunk.toString();
      if (!pattern.test(output)) return;
      cleanup();
      resolve(output);
    };
    const onExit = code => {
      cleanup();
      reject(new Error(`server exited early with code ${code}: ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

async function assertPresentationHelpers() {
  const { parseName } = require('../lib/nameParser');
  const config = require('../lib/config');
  const {
    inheritLocalizedMetadataNames,
    localizeBangumiTitle,
    localizeMetadataNames,
    normalizeVolumeDisplayTitle,
    parseDeepSeekVolumeMatchResponse,
  } = require('../lib/archiveSource');

  assert.strictEqual(
    parseName('[鸭志田一].樱花庄的宠物女孩 10 .5.epub').detectedNumber,
    10.5,
    'spaced decimal volume numbers should remain decimals'
  );

  const series = {
    title: '青春猪头少年系列',
    alternateTitles: [],
    authors: ['鸭志田一'],
    category: 'novel',
  };
  const resources = [
    {
      resourceId: 'regular-01',
      title: 'Vol.01',
      originalTitle: '青春猪头少年系列 01',
      type: 'epub',
      contentType: 'volume',
      detectedNumber: 1,
    },
    {
      resourceId: 'named-02',
      title: 'Vol.02',
      originalTitle: '青春猪头少年不会梦到小恶魔学妹',
      type: 'epub',
      contentType: 'volume',
      detectedNumber: 2,
    },
    {
      resourceId: 'extra-bd',
      title: 'Vol.01',
      originalTitle: '青春猪头少年系列 BD vol.1 短篇（网翻）',
      type: 'epub',
      contentType: 'volume',
      detectedNumber: 1,
    },
  ];
  const candidates = [
    { subjectId: 1001, order: 1, nameCn: '青春猪头少年系列 1' },
    { subjectId: 1002, order: 2, nameCn: '青春猪头少年不会梦到小恶魔学妹' },
  ];
  const matches = parseDeepSeekVolumeMatchResponse(JSON.stringify({
    results: [
      { resourceKey: 'regular-01', subjectId: 1001, confidence: 100, displayTitle: '青春猪头少年系列 1' },
      { resourceKey: 'named-02', subjectId: 1002, confidence: 100, displayTitle: '青春猪头少年不会梦到兔女郎学姐' },
      { resourceKey: 'extra-bd', subjectId: null, confidence: 0, displayTitle: '（BD 1）短篇' },
    ],
  }), resources, candidates, series);
  const matchById = new Map(matches.map(item => [item.resourceId, item]));
  assert.strictEqual(matchById.get('regular-01').displayTitle, '青春猪头少年系列 1');
  assert.strictEqual(matchById.get('named-02').displayTitle, '青春猪头少年不会梦到兔女郎学姐',
    'AI display names are independent from candidate detail titles');
  assert.strictEqual(matchById.get('named-02').candidateNameCn, '青春猪头少年不会梦到小恶魔学妹');
  assert.strictEqual(matchById.get('named-02').displayTitleSource, 'ai');
  assert.strictEqual(matchById.get('extra-bd').displayTitle, '（BD 1）短篇');
  const exactTitle = '(2) 特别篇　＋附录（网翻）.epub';
  const [exact] = parseDeepSeekVolumeMatchResponse(JSON.stringify({ results: [
    { resourceKey: 'extra-bd', matched: false, displayTitle: '  ' + exactTitle + '  ' },
  ] }), [resources[2]], candidates, series);
  assert.strictEqual(exact.displayTitle, exactTitle, 'only leading/trailing whitespace may be removed from an AI title');
  const [fallback] = parseDeepSeekVolumeMatchResponse(JSON.stringify({ results: [
    { resourceKey: 'regular-01', subjectId: 1001, displayTitle: '   ' },
  ] }), [resources[0]], candidates, series);
  assert.strictEqual(fallback.displayTitle, '第1册', 'missing AI names retain the existing fallback');
  assert.strictEqual(fallback.displayTitleSource, undefined);
  assert.strictEqual(
    normalizeVolumeDisplayTitle('番外 青春猪头少年不会梦到白沙滩女王＋', {}, series),
    '（番外）青春猪头少年不会梦到白沙滩女王+'
  );
  const inheritedNames = inheritLocalizedMetadataNames(
    [{ personId: 2, name: '鴨志田一' }],
    [{
      characterId: 1,
      name: '桜島麻衣',
      actors: [{ personId: 3, name: '瀬戸麻沙美' }],
    }],
    {
      persons: [{
        personId: 2,
        name: '鴨志田一',
        nameCn: '鸭志田一',
        nameTranslationProvider: 'bangumi',
      }],
      characters: [{
        characterId: 1,
        name: '桜島麻衣',
        nameCn: '樱岛麻衣',
        nameTranslationProvider: 'bangumi',
        actors: [{
          personId: 3,
          name: '瀬戸麻沙美',
          nameCn: '濑户麻沙美',
          nameTranslationProvider: 'bangumi',
        }],
      }],
    }
  );
  assert.strictEqual(inheritedNames.persons[0].nameCn, '鸭志田一');
  assert.strictEqual(inheritedNames.characters[0].nameCn, '樱岛麻衣');
  assert.strictEqual(inheritedNames.characters[0].actors[0].nameCn, '濑户麻沙美');

  const previousModel = Object.getOwnPropertyDescriptor(config, 'AI_MODEL');
  Object.defineProperty(config, 'AI_MODEL', { configurable: true, value: 'gpt-5.4-mini' });
  const previousApiKey = Object.getOwnPropertyDescriptor(config, 'AI_API_KEY');
  const previousFetch = global.fetch;
  Object.defineProperty(config, 'AI_API_KEY', { configurable: true, value: 'detail-presentation-test-key' });
  global.fetch = require('./localization-fixture').researchFetch([
    { sourceName: '薬屋のひとりごと画集', nameCn: '药屋少女的呢喃画集' },
    { sourceName: '鴨志田一', nameCn: '鸭志田一' },
    { sourceName: '桜島麻衣', nameCn: '樱岛麻衣' },
  ]);
  try {
    const localized = await localizeMetadataNames(
      [{ personId: 2, name: '鴨志田一' }],
      [{ characterId: 1, name: '桜島麻衣', actors: [] }]
    );
    assert.strictEqual(localized.persons[0].nameCn, '鸭志田一');
    assert.strictEqual(localized.characters[0].nameCn, '樱岛麻衣');
    const localizedTitle = await localizeBangumiTitle({
      id: 473643,
      name: '薬屋のひとりごと画集',
      name_cn: '',
      platform: '画集',
      tags: [{ name: '画集' }],
    });
    assert.strictEqual(localizedTitle.title, '药屋少女的呢喃画集');
    assert.strictEqual(localizedTitle.localizedWithDeepSeek, true);
  } finally {
    Object.defineProperty(config, 'AI_API_KEY', previousApiKey);
    Object.defineProperty(config, 'AI_MODEL', previousModel);
    global.fetch = previousFetch;
  }
}

async function assertDetailApiOrdering(runRoot) {
  const libraryRoot = path.join(runRoot, 'library');
  const dataRoot = path.join(runRoot, 'data');
  const port = 15000 + Math.floor(Math.random() * 1000);
  await fs.mkdir(libraryRoot, { recursive: true });

  process.env.DATA_DIR = dataRoot;

  const {
    ensureMetadataLayout,
    upsertSeriesIndexes,
    writeSeriesBundle,
  } = require('../lib/metadataStore');
  await ensureMetadataLayout();

  const seriesId = 'detail-presentation-series';
  const resources = [
    {
      resourceId: 'local-extra',
      title: '本地外传',
      originalTitle: '本地外传',
      relativePath: '本地外传.epub',
      sourcePath: path.join(libraryRoot, '本地外传.epub'),
      type: 'epub',
      contentType: 'volume',
      detectedNumber: 0.5,
      category: 'novel',
      readable: true,
    },
    {
      resourceId: 'volume-02',
      title: 'Vol.02',
      originalTitle: '作品 02',
      relativePath: '作品 02.epub',
      sourcePath: path.join(libraryRoot, '作品 02.epub'),
      type: 'epub',
      contentType: 'volume',
      detectedNumber: 2,
      category: 'novel',
      readable: true,
    },
    {
      resourceId: 'volume-01',
      title: 'Vol.01',
      originalTitle: '作品 01',
      relativePath: '作品 01.epub',
      sourcePath: path.join(libraryRoot, '作品 01.epub'),
      type: 'epub',
      contentType: 'volume',
      detectedNumber: 1,
      category: 'novel',
      readable: true,
    },
  ];
  const relations = [
    { subjectId: 2002, relationType: '单行本', order: 2, name_cn: '作品 第2卷' },
    { subjectId: 2001, relationType: '单行本', order: 1, name_cn: '作品 第1卷' },
  ];
  const matches = [
    {
      resourceId: 'local-extra',
      resourceKey: 'local-extra',
      matched: false,
      subjectId: null,
      displayTitle: '（外传）本地故事',
    },
    {
      resourceId: 'volume-02',
      resourceKey: 'volume-02',
      matched: true,
      subjectId: 2002,
      bangumiOrder: 2,
      displayTitle: '第2册',
    },
    {
      resourceId: 'volume-01',
      resourceKey: 'volume-01',
      matched: true,
      subjectId: 2001,
      bangumiOrder: 1,
      displayTitle: '（1）作品学姐',
    },
  ];
  const writtenSeries = await writeSeriesBundle({
    seriesId,
    title: '详情展示测试',
    titleNormalized: '详情展示测试',
    alternateTitles: [],
    authors: ['テスト作者'],
    tags: [],
    category: 'novel',
    contentMode: 'volume',
    hasVolumes: true,
    hasChapters: false,
    bangumiSubjectId: 9999,
    status: '',
    cover: '',
  }, resources, {
    bangumi: {
      subjectId: 9999,
      name_cn: '详情展示测试',
      image: 'https://lain.bgm.tv/r/200/pic/cover/l/fixture.jpg',
      relatedSubjects: relations,
      volumeMatches: matches,
      detailsSchemaVersion: 2,
      characters: [{ characterId: 1, name: '桜島麻衣', role: '主角' }],
    },
    relations,
    persons: [],
    characters: [{ characterId: 1, name: '桜島麻衣', role: '主角' }],
  });
  await upsertSeriesIndexes(writtenSeries, resources);

  const localizedVersionId = 'detail-presentation-localized-version';
  const localizedResources = [{
    resourceId: 'localized-version-resource',
    title: '章节合集',
    originalTitle: '章节合集',
    relativePath: '本地化版本/章节合集.zip',
    sourcePath: path.join(libraryRoot, '本地化版本', '章节合集.zip'),
    type: 'zip',
    contentType: 'mixed_bundle',
    category: 'novel',
    pageCount: 12,
    readable: true,
  }];
  const localizedSeries = await writeSeriesBundle({
    seriesId: localizedVersionId,
    title: '详情展示测试',
    titleNormalized: '详情展示测试',
    alternateTitles: [],
    authors: ['测试作者'],
    tags: [],
    category: 'novel',
    contentMode: 'chapter',
    hasVolumes: false,
    hasChapters: true,
    bangumiSubjectId: 9999,
    status: '',
    cover: '',
  }, localizedResources, {
    bangumi: {
      subjectId: 9999,
      name_cn: '详情展示测试',
      detailsSchemaVersion: 2,
      authors: ['测试作者'],
      namesLocalizedAt: new Date().toISOString(),
      namesLocalizationProvider: 'deepseek',
      relatedSubjects: relations,
      characters: [{
        characterId: 1,
        name: '桜島麻衣',
        nameCn: '樱岛麻衣',
        nameTranslationProvider: 'bangumi',
        role: '主角',
      }],
    },
    relations,
    persons: [],
    characters: [{
      characterId: 1,
      name: '桜島麻衣',
      nameCn: '樱岛麻衣',
      nameTranslationProvider: 'bangumi',
      role: '主角',
    }],
  });
  await upsertSeriesIndexes(localizedSeries, localizedResources);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForOutput(child, /ReadDeck running/);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'detail-test', password: 'detail-test' }),
    });
    assert.strictEqual(login.ok, true);
    const { token } = await login.json();
    const response = await fetch(`http://127.0.0.1:${port}/api/comics/${seriesId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const responseText = await response.text();
    assert.strictEqual(response.ok, true, responseText);
    const detail = JSON.parse(responseText);
    assert.equal(detail.comic.cover, 'https://lain.bgm.tv/pic/cover/l/fixture.jpg', 'existing BGM metadata supplies the default work cover');
    const libraryResponse = await fetch(`http://127.0.0.1:${port}/api/library`, { headers: { Authorization: `Bearer ${token}` } });
    const libraryItems = await libraryResponse.json();
    assert(libraryItems.some(item => item.cover === detail.comic.cover), 'library and detail use the same BGM cover');
    const image = await require('sharp')({ create: { width: 4, height: 8, channels: 3, background: '#df453f' } }).png().toBuffer();
    const upload = new FormData(); upload.append('cover', new Blob([image], { type: 'image/png' }), 'cover.png');
    const uploaded = await fetch(`http://127.0.0.1:${port}/api/comics/${seriesId}/cover`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: upload,
    });
    assert.equal(uploaded.status, 200);
    const customCover = (await uploaded.json()).path;
    const customDetail = await fetch(`http://127.0.0.1:${port}/api/comics/${seriesId}`, { headers: { Authorization: `Bearer ${token}` } }).then(res => res.json());
    assert.equal(customDetail.comic.cover, customCover, 'manual covers override BGM');
    const removed = await fetch(`http://127.0.0.1:${port}/api/comics/${seriesId}/cover`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(removed.status, 200);
    const defaultDetail = await fetch(`http://127.0.0.1:${port}/api/comics/${seriesId}`, { headers: { Authorization: `Bearer ${token}` } }).then(res => res.json());
    assert.equal(defaultDetail.comic.cover, detail.comic.cover, 'removing a manual cover restores BGM');
    assert.deepStrictEqual(
      detail.localVolumes.map(item => item.resourceId),
      ['volume-01', 'volume-02', 'local-extra'],
      'Bangumi volumes should lead in Bangumi order and unmatched local resources should follow'
    );
    assert.deepStrictEqual(
      detail.groups.volumes.map(item => item.resourceId),
      ['volume-01', 'volume-02', 'local-extra'],
      'the reading group should use the same order as the volume cards'
    );
    assert.strictEqual(
      detail.localVolumes[0].title,
      '（1）作品学姐',
      'cached DeepSeek volume titles should be displayed as provided in simplified Chinese'
    );
    assert.deepStrictEqual(
      detail.resourceVersions.map(item => item.seriesId).sort(),
      [seriesId, localizedVersionId].sort(),
      'local versions sharing one Bangumi subject should be grouped together'
    );
    assert.strictEqual(detail.characters[0].nameCn, '樱岛麻衣');
    assert.strictEqual(detail.comic.author[0].name, '测试作者');

    const metadataResponse = await fetch(
      `http://127.0.0.1:${port}/api/comics/${seriesId}/metadata`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: '手动编辑后的标题',
          alias: '手动别名一，手动别名二',
          author: '作者甲，作者乙',
          status: { display: '完结' },
          brief: '手动简介',
        }),
      }
    );
    const metadataResponseText = await metadataResponse.text();
    assert.strictEqual(metadataResponse.ok, true, metadataResponseText);
    const metadataPayload = JSON.parse(metadataResponseText);
    assert.deepStrictEqual(metadataPayload.series.authors, ['作者甲', '作者乙']);
    const updatedDetailResponse = await fetch(
      `http://127.0.0.1:${port}/api/comics/${seriesId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const updatedDetailText = await updatedDetailResponse.text();
    assert.strictEqual(updatedDetailResponse.ok, true, updatedDetailText);
    const updatedDetail = JSON.parse(updatedDetailText);
    assert.strictEqual(updatedDetail.comic.name, '手动编辑后的标题');
    assert.strictEqual(updatedDetail.comic.alias, '手动别名一, 手动别名二');
    assert.strictEqual(updatedDetail.comic.status.display, '完结');
    assert.strictEqual(updatedDetail.comic.brief, '手动简介');

    const localizedResponse = await fetch(
      `http://127.0.0.1:${port}/api/comics/${localizedVersionId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const localizedResponseText = await localizedResponse.text();
    assert.strictEqual(localizedResponse.ok, true, localizedResponseText);
    const localizedDetail = JSON.parse(localizedResponseText);
    assert.strictEqual(localizedDetail.characters[0].nameCn, '樱岛麻衣');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
}

async function main() {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-plus-detail-presentation-'));
  process.env.DATA_DIR = path.join(runRoot, 'data');
  prepareSettings({ dataRoot: process.env.DATA_DIR, libraryRoot: path.join(runRoot, 'library'), username: 'detail-test', password: 'detail-test' });
  try {
    await assertClientMetadataSources();
    const css = await fs.readFile(path.resolve(__dirname, '../public/styles.css'), 'utf8');
    assert.match(css, /\.volume-cover-item span\s*\{[^}]*display:\s*-webkit-box;[^}]*-webkit-line-clamp:\s*2;[^}]*max-height:\s*2\.7em;/s);
    assert.doesNotMatch(css, /margin-left:\s*-\.75rem;/, 'collapsed metadata cards should stay inside the section padding');
    assert.match(
      css,
      /\.metadata-section\.is-expanded \.relation-list,[^{]+\{[^}]*justify-content:\s*center;/s,
      'expanded metadata card grids should center their tracks'
    );
    assert.match(css, /\.resource-version-menu\s*\{[^}]*position:\s*fixed;/s,
      'version menus must float without participating in document flow');
    assert.match(css, /\.book-information\s*\{[^}]*border:\s*0;/s,
      'book information must remain an unboxed final section');
    const html = await fs.readFile(path.resolve(__dirname, '../public/index.html'), 'utf8');
    const summaryIndex = html.indexOf('id="volume-detail-summary-section"');
    const versionsIndex = html.indexOf('id="volume-detail-versions-section"');
    const chaptersIndex = html.indexOf('id="volume-detail-chapters-section"');
    const bookInfoIndex = html.indexOf('id="volume-detail-book-info"');
    assert(summaryIndex > 0 && summaryIndex < versionsIndex && versionsIndex < chaptersIndex && chaptersIndex < bookInfoIndex,
      'book detail sections must be ordered as summary, versions, chapters, and book information');
    assert.doesNotMatch(html, />\s*删除此作品\s*</, 'logical work pages must not expose whole-work deletion');
    const appSource = await fs.readFile(path.resolve(__dirname, '../public/app.js'), 'utf8');
    assert.match(appSource, /const bookSections = Array\.isArray\(data\.bookSections\)/,
      'the main detail renderer must consume logical book sections');
    const serviceWorker = await fs.readFile(path.resolve(__dirname, '../public/sw.js'), 'utf8');
    assert.match(serviceWorker, /readdeck-v2-detail/);
    const archiveSource = await fs.readFile(path.resolve(__dirname, '../lib/archiveSource.js'), 'utf8');
    assert.match(archiveSource, /所有 displayTitle 最终必须使用中国大陆规范的自然简体中文/);
    assert.match(archiveSource, /输出 JSON 前逐项自检/);
    await assertPresentationHelpers();
    await assertDetailApiOrdering(runRoot);
    console.log('detail presentation ok');
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
