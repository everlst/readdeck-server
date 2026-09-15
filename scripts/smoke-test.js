const { prepareSettings, fixtureSource } = require('./settings-fixture');
const path = require('path');
const assert = require('assert');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const sharp = require('sharp');

const fixtureCandidates = [
  process.env.READER_PLUS_SAMPLE_DIR,
  path.resolve(__dirname, '..', '资源示例'),
  path.resolve(__dirname, '..', '..', '资源示例'),
].filter(Boolean).map(candidate => path.resolve(candidate));
const fixtureSearchParent = path.resolve(__dirname, '..', '..');
const requiredFixturePaths = [
  path.join('[FX战士久留美][でむにゃん][Vol.01-Vol.06+Chap.31-Chap.36][汉化组]', 'FX戰士久留美 - Chap.31-Chap.36.rar'),
  'Vol.01.cbz',
  '杀手青春 Vol.01.zip',
  '想結束這場「我愛你」的遊戲 Vol.01.pdf',
];
const smokeRunRoot = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'reader-plus-smoke-'));
const smokeRoot = path.join(smokeRunRoot, 'library');
const smokeOtherRoot = path.join(smokeRunRoot, 'others');
const smokeCustomRoot = path.join(smokeRunRoot, 'photos');
const smokeDataRoot = path.join(smokeRunRoot, 'data');
const run = promisify(execFile);

async function resolveFixtureRoot() {
  const siblingCandidates = (await fs.readdir(fixtureSearchParent, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(fixtureSearchParent, entry.name, '资源示例'));
  const candidates = Array.from(new Set([...fixtureCandidates, ...siblingCandidates]));
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const required = await Promise.all(requiredFixturePaths.map(relativePath =>
      fs.stat(path.join(candidate, relativePath)).catch(() => null)
    ));
    if (required.every(item => item?.isFile())) return candidate;
  }
  throw new Error(
    `未找到 smoke 样例目录，请设置 READER_PLUS_SAMPLE_DIR。已检查: ${candidates.join(', ')}`
  );
}

process.env.DATA_DIR = smokeDataRoot;
function prepareSmokeSettings() {
  prepareSettings({
    dataRoot: smokeDataRoot,
    sources: [
      fixtureSource(smokeRoot, { id: 'smoke-comic', name: '漫画源1' }),
      fixtureSource(path.join(smokeOtherRoot, '1'), { id: 'smoke-other-1', name: '其他源1', mode: 'fixed', categoryId: 'other' }),
      fixtureSource(path.join(smokeOtherRoot, '2'), { id: 'smoke-other-2', name: '其他源2', mode: 'fixed', categoryId: 'other' }),
      fixtureSource(path.join(smokeCustomRoot, '1'), { id: 'smoke-photos', name: '图册源1', mode: 'fixed', categoryId: 'photos' }),
      fixtureSource(path.join(smokeCustomRoot, '2'), { id: 'smoke-mmt', name: 'MMT源1', mode: 'fixed', categoryId: 'mmt' }),
    ],
    categories: [{ id: 'photos', label: '图册', visible: true, order: 3 }, { id: 'mmt', label: 'MMT', visible: true, order: 4 }],
  });
}
prepareSmokeSettings();

const { parseName } = require('../lib/nameParser');
const {
  buildDeepSeekSearchQueryPayload,
  buildDeepSeekSubjectMatchPayload,
  buildDeepSeekVolumeMatchPayload,
  localizeMetadataNames,
  normalizeSummaryText,
  parseDeepSeekSubjectMatchResponse,
  parseDeepSeekSearchKeywordsResponse,
  parseDeepSeekVolumeMatchResponse,
  scoreSubject,
  seriesSearchKeywords,
} = require('../lib/archiveSource');
const { scanLibrary } = require('../lib/scanner');
const {
  readIndex,
  rebuildIndexes,
  updateBangumi,
  writeSeriesBundle,
} = require('../lib/metadataStore');
const { getLibraryVersion, onLibraryChanged } = require('../lib/libraryEvents');
const { sourceAliasForRelativePath } = require('../lib/sourceAliases');
const { getPageFile, getPages } = require('../lib/readerProvider');
const { getEpubManifest } = require('../lib/epubProvider');
const {
  maxImageDimension,
  persistentCoverFromFile,
  readImageMetadata,
  streamableImage,
} = require('../lib/imageProcessor');
const { parseVolumeNumberFromText } = require('../lib/utils');

function testSeries(seriesId, title) {
  return {
    schemaVersion: 1,
    seriesId,
    title,
    titleNormalized: title.toLowerCase(),
    alternateTitles: [],
    authors: [],
    publishers: [],
    language: '',
    contentMode: 'volume',
    status: '',
    tags: [],
    cover: '',
    bangumiSubjectId: null,
    hasVolumes: true,
    hasChapters: false,
    hasMixedResources: false,
    source: 'resource',
    latestAddedAt: '2026-01-01T00:00:00.000Z',
    lastScannedAt: '2026-01-01T00:00:00.000Z',
    lastMatchedAt: '',
    lastUpdatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function testResource(resourceId, seriesId, title) {
  return {
    schemaVersion: 1,
    resourceId,
    seriesId,
    type: 'directory',
    contentType: 'volume',
    sourcePath: '',
    relativePath: `${seriesId}/${title}`,
    fileHash: `${resourceId}-hash`,
    modifiedTime: '2026-01-01T00:00:00.000Z',
    detectedNumber: 1,
    detectedNumberEnd: 1,
    detectedNumberType: 'volume',
    title,
    volumeNumber: 1,
    chapterNumber: null,
    pageCount: 1,
    coverCandidate: '',
    parseHints: {},
    readable: true,
    readError: '',
    lastIndexedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function assertLibraryChangeEventsRefreshSubjectIndex() {
  const beforeVersion = getLibraryVersion();
  const events = [];
  const unsubscribe = onLibraryChanged(event => events.push(event));

  const seriesA = testSeries('manual-aggregate-a', '手动聚合资源 A');
  const seriesB = testSeries('manual-aggregate-b', '手动聚合资源 B');
  const resourceA = testResource('manual-aggregate-resource-a', seriesA.seriesId, '资源 A');
  const resourceB = testResource('manual-aggregate-resource-b', seriesB.seriesId, '资源 B');

  await writeSeriesBundle(seriesA, [resourceA]);
  await writeSeriesBundle(seriesB, [resourceB]);

  const existingSeries = await readIndex('series-index.json', []);
  const existingResourceIndex = await readIndex('resource-index.json', {});
  await rebuildIndexes(
    [
      ...(existingSeries || []).map(item => ({ ...item, lastUpdatedAt: item.updatedAt })),
      seriesA,
      seriesB,
    ],
    [...Object.values(existingResourceIndex || {}), resourceA, resourceB]
  );

  await updateBangumi(seriesA.seriesId, {
    bangumi: { subjectId: 424242, name_cn: '手动聚合回归测试', name: 'Manual Aggregate Regression' },
    brief: '手动聚合回归测试简介',
    relations: [],
    persons: [],
    characters: [],
  });
  await updateBangumi(seriesB.seriesId, {
    bangumi: { subjectId: 424242, name_cn: '手动聚合回归测试', name: 'Manual Aggregate Regression' },
    brief: '手动聚合回归测试简介',
    relations: [],
    persons: [],
    characters: [],
  });

  const subjectRows = (await readIndex('subject-index.json', []))
    .filter(item => Number(item.subjectId) === 424242);
  assert.strictEqual(subjectRows.length, 2, 'manual subject id updates should immediately refresh subject index');
  assert(events.some(event => event.reason === 'derived_indexes_written'),
    'index writes should emit library change events for list-cache invalidation');
  assert(getLibraryVersion() > beforeVersion, 'library version should advance after metadata writes');

  unsubscribe();
}

function assertSourceAliasScoping() {
  assert.strictEqual(
    sourceAliasForRelativePath('1/漫画源 A', { sourceId: 'smoke-comic' }),
    '漫画源1',
    'comic numbered mount alias should use the comic-scoped alias'
  );
  assert.strictEqual(
    sourceAliasForRelativePath('1/设定集 A', { sourceId: 'smoke-other-1' }),
    '其他源1',
    'other numbered mount alias should use the other-scoped alias even when the segment is also 1'
  );
  assert.strictEqual(
    sourceAliasForRelativePath('2/特典 B', { sourceId: 'smoke-other-2' }),
    '其他源2',
    'other numbered mount alias should support additional numeric roots'
  );
  assert.strictEqual(
    sourceAliasForRelativePath('图册 A', {
      category: 'photos',
      sourcePath: path.join(smokeCustomRoot, '1', '图册 A'),
    }),
    '图册源1',
    'custom category root aliases should match by absolute source path'
  );
}

function assertBangumiTitleAndMediumScoring() {
  const sakuraSeries = {
    title: '樱花庄的宠物女孩',
    alternateTitles: [],
    authors: ['鴨志田一'],
    category: 'novel',
    contentMode: 'volume',
    hasVolumes: true,
    hasChapters: false,
  };
  const novelSubject = {
    id: 14406,
    type: 1,
    name: 'さくら荘のペットな彼女',
    name_cn: '樱花庄的宠物女孩',
    infobox: [
      { key: '文库', value: '電撃文庫' },
      { key: '作者', value: '鴨志田一' },
      { key: '插图', value: '溝口ケージ' },
    ],
  };
  const mangaSubject = {
    id: 43362,
    type: 1,
    name: 'さくら荘のペットな彼女',
    name_cn: '樱花庄的宠物女孩 漫画版',
    infobox: [
      { key: '作画', value: '草野ほうき' },
      { key: '原作', value: '鴨志田一' },
      { key: '连载杂志', value: "電撃G'sコミック" },
    ],
  };
  const volumeSubject = {
    id: 67038,
    type: 1,
    name: 'さくら荘のペットな彼女 9',
    name_cn: '樱花庄的宠物女孩 9',
    infobox: [
      { key: '文库', value: '電撃文庫' },
      { key: '作者', value: '鴨志田一' },
      { key: '页数', value: '360' },
      { key: 'ISBN', value: '9784048869866' },
    ],
  };

  assert(scoreSubject(sakuraSeries, novelSubject) >= 90,
    'novel subject should score as a strong match');
  assert.strictEqual(scoreSubject(sakuraSeries, mangaSubject), 0,
    'novel scrape should reject manga adaptation even when original author matches');

  const payload = buildDeepSeekSubjectMatchPayload(sakuraSeries, [novelSubject, mangaSubject, volumeSubject], {
    resources: [{ type: 'epub', contentType: 'volume', title: 'Vol.01', detectedNumber: 1, detectedNumberEnd: 10 }],
  });
  assert.strictEqual(payload.local.resourceMedium, 'text', 'epub resources should be sent as text medium');
  assert.strictEqual(payload.local.targetScope, 'infer_from_local_context', 'AI should determine series versus standalone scope');
  assert(payload.candidates.some(item => item.subjectId === 43362 &&
    item.authorsAndStaff.some(row => row.key === '原作' && row.value.includes('鴨志田一'))),
    'DeepSeek payload should preserve original-author role for manga adaptations');
  assert(payload.candidates.some(item => item.subjectId === 67038 && item.name === volumeSubject.name),
    'AI should receive original candidate titles and determine single-volume semantics itself');
  const selected = parseDeepSeekSubjectMatchResponse(
    '```json\n{"subjectId":14406,"confidence":96,"reason":"小说资源匹配小说条目"}\n```',
    [novelSubject, mangaSubject, volumeSubject]
  );
  assert.strictEqual(selected.subjectId, 14406, 'DeepSeek JSON response should select a candidate subject id');
  assert.strictEqual(parseDeepSeekSubjectMatchResponse('{"subjectId":999,"confidence":99}', [novelSubject]), null,
    'DeepSeek response must be constrained to provided candidates');
}

function assertRuriDragonTitleCompatibility() {
  const ruriSeries = {
    title: '瑠璃龍龍',
    alternateTitles: ['[瑠璃龍龍][眞藤雅興][Vol.01-Vol.03][東立][未完]'],
    authors: ['眞藤雅興'],
    category: 'comic',
    contentMode: 'volume',
    hasVolumes: true,
    hasChapters: false,
  };
  const ruriSubject = {
    id: 384745,
    type: 1,
    name: 'ルリドラゴン',
    name_cn: '琉璃龙龙',
    infobox: [
      { key: '作者', value: '眞藤雅興' },
      { key: '出版社', value: '集英社' },
    ],
  };

  assert(seriesSearchKeywords(ruriSeries).includes('瑠璃龍龍'),
    'local titles should remain available as deterministic Bangumi search keywords');
  assert.deepStrictEqual(
    parseDeepSeekSearchKeywordsResponse('{"keywords":["ルリドラゴン","琉璃龙龙"]}'),
    ['ルリドラゴン', '琉璃龙龙'],
    'cross-script title expansion should come from DeepSeek instead of a partial character dictionary'
  );
  assert.strictEqual(
    buildDeepSeekSubjectMatchPayload(ruriSeries, [ruriSubject]).candidates[0].subjectId,
    384745,
    'the candidate judge should receive the complete Bangumi subject after AI-assisted retrieval'
  );
}

function assertBangumiArtbookMatching() {
  const apothecaryParsed = parseName('[藥師少女的獨語畫集][しのとうこ]');
  const apothecarySeries = {
    ...apothecaryParsed,
    category: 'comic',
    contentMode: apothecaryParsed.contentType,
    hasVolumes: false,
    hasChapters: true,
  };
  const apothecaryArtbook = {
    id: 473643,
    type: 1,
    name: '薬屋のひとりごと画集',
    name_cn: '',
    platform: '画集',
    tags: [{ name: '画集' }, { name: '藥師少女的獨語' }, { name: '药屋少女的呢喃' }],
    infobox: [
      { key: '作者', value: 'しのとうこ' },
      { key: '原作', value: '日向夏' },
      { key: '页数', value: '160' },
    ],
  };
  const apothecaryNovel = {
    id: 156126,
    type: 1,
    name: '薬屋のひとりごと',
    name_cn: '药屋少女的呢喃',
    platform: '小说',
    tags: [{ name: '轻小说' }],
    infobox: [
      { key: '别名', value: [{ v: '药师少女的独语' }] },
      { key: '作者', value: '日向夏' },
      { key: '插图', value: 'しのとうこ' },
    ],
  };

  assert(scoreSubject(apothecarySeries, apothecaryArtbook) >= 90,
    'artbook title, platform, tags and author should strongly match Bangumi subject 473643');
  assert.strictEqual(scoreSubject(apothecarySeries, apothecaryNovel), 0,
    'an image-backed artbook must not be matched to the similarly named novel subject 156126');

  const payload = buildDeepSeekSubjectMatchPayload(
    apothecarySeries,
    [apothecaryArtbook, apothecaryNovel],
    { resources: [{ type: 'zip', contentType: 'chapter', title: apothecaryParsed.title }] }
  );
  assert.strictEqual(payload.local.resourceCarrier, 'image', 'archive files should be described as image carriers');
  assert.strictEqual(payload.local.workFormat, 'artbook', 'artbook title markers should override the comic path category');
  assert.strictEqual(payload.local.targetScope, 'infer_from_local_context', 'AI should infer whether the target is a series or standalone book');
  assert.strictEqual(payload.candidates.find(item => item.subjectId === 473643).platform, '画集',
    'AI should receive the original Bangumi platform');

  const searchPayload = buildDeepSeekSearchQueryPayload(apothecarySeries, {
    resources: [{ type: 'zip', title: apothecaryParsed.title }],
  });
  assert.strictEqual(searchPayload.local.workFormat, 'artbook');
  assert.deepStrictEqual(
    parseDeepSeekSearchKeywordsResponse('{"keywords":["薬屋のひとりごと画集","藥師少女的獨語畫集"]}'),
    ['薬屋のひとりごと画集', '藥師少女的獨語畫集'],
    'DeepSeek-generated canonical Japanese titles should be accepted as Bangumi search keywords'
  );
  const haruhiParsed = parseName('[涼宮ハルヒの憂鬱 版権原画集][京都アニメーション][Vol.01-Vol.02]');
  const haruhiSeries = {
    ...haruhiParsed,
    category: 'comic',
    contentMode: haruhiParsed.contentType,
    hasVolumes: true,
    hasChapters: false,
  };
  const haruhiArtbook = {
    id: 407098,
    type: 1,
    name: '涼宮ハルヒの憂鬱 版権原画集',
    name_cn: '凉宫春日的忧郁 版权原画集',
    platform: '画集',
    tags: [{ name: '原画集' }],
    infobox: [{ key: '出版社', value: '京都アニメーション' }],
  };
  const haruhiNovel = {
    id: 46,
    type: 1,
    name: '涼宮ハルヒの憂鬱',
    name_cn: '凉宫春日的忧郁',
    platform: '小说',
    tags: [{ name: '轻小说' }],
    infobox: [{ key: '作者', value: '谷川流' }],
  };
  assert(scoreSubject(haruhiSeries, haruhiArtbook) >= 90,
    'the Haruhi copyright key-animation collection should match artbook subject 407098');
  assert.strictEqual(scoreSubject(haruhiSeries, haruhiNovel), 0,
    'the Haruhi artbook collection must not fall back to the novel subject');
}

function assertDeepSeekVolumeMatchingParsesLocalExtras() {
  const series = {
    title: '樱花庄的宠物女孩',
    alternateTitles: [],
    authors: ['鴨志田一'],
    category: 'novel',
    contentMode: 'volume',
    bangumiSubjectId: 14406,
  };
  const resources = [
    {
      resourceId: 'sakura-01',
      title: 'Vol.01',
      originalTitle: '[鸭志田一].樱花庄的宠物女孩  01',
      relativePath: '[樱花庄的宠物女孩][鴨志田一]/[鸭志田一].樱花庄的宠物女孩  01.epub',
      type: 'epub',
      contentType: 'volume',
      detectedNumber: 1,
    },
    {
      resourceId: 'sakura-55',
      title: 'Vol.05.5',
      originalTitle: '[鸭志田一].樱花庄的宠物女孩  5.5',
      relativePath: '[樱花庄的宠物女孩][鴨志田一]/[鸭志田一].樱花庄的宠物女孩  5.5.epub',
      type: 'epub',
      contentType: 'volume',
      detectedNumber: 5.5,
    },
    {
      resourceId: 'sakura-bd-onsen',
      title: '樱花庄的宠物女孩 BD 温泉短篇',
      originalTitle: '[鸭志田一].樱花庄的宠物女孩 BD 温泉短篇（网翻）',
      relativePath: '[樱花庄的宠物女孩][鴨志田一]/[鸭志田一].樱花庄的宠物女孩 BD 温泉短篇（网翻）.epub',
      type: 'epub',
      contentType: 'volume',
      detectedNumber: null,
    },
  ];
  const candidates = [
    { subjectId: 12475, relationType: '单行本', order: 1, name: 'さくら荘のペットな彼女 〈1〉', name_cn: '' },
    { subjectId: 26693, relationType: '单行本', order: 6, name: 'さくら荘のペットな彼女 〈5.5〉', name_cn: '' },
  ];
  const bundle = { series, resources, bangumi: { subjectId: 14406 } };
  const payload = buildDeepSeekVolumeMatchPayload(bundle, candidates);
  assert.strictEqual(payload.resources.length, 3, 'DeepSeek volume payload should include local volumes');
  assert.strictEqual(payload.candidates.find(item => item.subjectId === 26693).volumeNumberHint, 5.5,
    'Bangumi offprint titles like 〈5.5〉 should expose decimal volume hints');
  assert.strictEqual(parseVolumeNumberFromText('さくら荘のペットな彼女 <5.5>'), 5.5,
    'ASCII angle bracket decimal volume titles should parse');
  assert.strictEqual(parseVolumeNumberFromText('さくら荘のペットな彼女 （5.5）'), 5.5,
    'parenthesized decimal volume titles should parse');
  assert.strictEqual(
    payload.resources.find(item => item.resourceId === 'sakura-bd-onsen').displayTitleHint,
    '（BD）温泉短篇',
    'BD short extra should get a clean local title hint'
  );

  const matches = parseDeepSeekVolumeMatchResponse(JSON.stringify({
    results: [
      { resourceKey: 'sakura-01', subjectId: 12475, confidence: 100, displayTitle: '樱花庄的宠物女孩 1', reason: '正篇第一卷' },
      { resourceKey: 'sakura-55', subjectId: 26693, confidence: 100, displayTitle: 'Vol.05.5', reason: '正式5.5卷' },
      { resourceKey: 'sakura-bd-onsen', subjectId: null, confidence: 0, displayTitle: '（BD）温泉短篇', reason: 'BD特典无候选' },
    ],
  }), resources, payload.candidates, series);
  const byResourceId = new Map(matches.map(match => [match.resourceId, match]));
  assert.strictEqual(byResourceId.get('sakura-01').subjectId, 12475,
    'regular local volume should keep the selected candidate subject');
  assert.strictEqual(byResourceId.get('sakura-01').displayTitle, '樱花庄的宠物女孩 1',
    'the AI display title must not be shortened by program rules');
  assert.strictEqual(byResourceId.get('sakura-55').subjectId, 26693,
    'official half volume should keep the selected candidate subject');
  assert.strictEqual(byResourceId.get('sakura-55').displayTitle, 'Vol.05.5',
    'the AI owns the display format, including decimal volume labels');
  assert.strictEqual(byResourceId.get('sakura-bd-onsen').matched, false,
    'BD extra should be persisted as a local-only volume match');
  assert.strictEqual(byResourceId.get('sakura-bd-onsen').displayTitle, '（BD）温泉短篇',
    'BD extra should keep the AI-shortened display title');

  const aobutaSeries = {
    title: '青春猪头少年系列',
    alternateTitles: [],
    authors: ['鸭志田一'],
    category: 'novel',
  };
  const aobutaResource = {
    resourceId: 'aobuta-01',
    title: 'Vol.01',
    originalTitle: '[鸭志田一].[青春猪头少年系列01].青春猪头少年不会梦到兔女郎学姐',
    relativePath: '青春猪头少年系列/青春猪头少年系列01.epub',
    type: 'epub',
    contentType: 'volume',
    detectedNumber: 1,
  };
  const aobutaCandidate = {
    subjectId: 50001,
    relationType: '单行本',
    order: 1,
    name: '青春ブタ野郎はバニーガール先輩の夢を見ない',
    nameCn: '青春猪头少年不会梦到兔女郎学姐',
  };
  const [aobutaMatch] = parseDeepSeekVolumeMatchResponse(JSON.stringify({
    results: [{
      resourceKey: 'aobuta-01',
      subjectId: 50001,
      confidence: 100,
      displayTitle: '青春猪头少年不会梦到兔女郎学姐',
      reason: '每卷独立标题',
    }],
  }), [aobutaResource], [aobutaCandidate], aobutaSeries);
  assert.strictEqual(aobutaMatch.displayTitle, '青春猪头少年不会梦到兔女郎学姐',
    'distinct per-volume titles must not receive a program-generated prefix');
  assert.strictEqual(aobutaMatch.bangumiOrder, 1,
    'matched volumes should retain Bangumi ordering metadata');
}

async function assertDeepSeekNameLocalization() {
  const config = require('../lib/config');
  const previousApiKey = Object.getOwnPropertyDescriptor(config, 'AI_API_KEY');
  const previousFetch = global.fetch;
  Object.defineProperty(config, 'AI_API_KEY', { configurable: true, value: 'smoke-test-key' });
  const previousModel = Object.getOwnPropertyDescriptor(config, 'AI_MODEL');
  Object.defineProperty(config, 'AI_MODEL', { configurable: true, value: 'test-model' });
  global.fetch = require('./localization-fixture').researchFetch([
    { sourceName: '桜島麻衣', nameCn: '樱岛麻衣' },
    { sourceName: '梓川咲太', nameCn: '梓川咲太' },
    { sourceName: '鴨志田一', nameCn: '鸭志田一' },
  ]);
  try {
    const localized = await localizeMetadataNames(
      [{ personId: 201, name: '鴨志田一' }],
      [
        { characterId: 101, name: '桜島麻衣', actors: [] },
        { characterId: 102, name: '梓川咲太', actors: [] },
      ]
    );
    assert.deepStrictEqual(localized.characters.map(item => item.nameCn), ['樱岛麻衣', '梓川咲太']);
    assert.strictEqual(localized.persons[0].nameCn, '鸭志田一');
    assert(localized.characters.every(item => item.nameTranslationProvider === 'ai_translation'));
  } finally {
    Object.defineProperty(config, 'AI_API_KEY', previousApiKey);
    Object.defineProperty(config, 'AI_MODEL', previousModel);
    global.fetch = previousFetch;
  }
}

async function assertDeepSeekSummaryNormalization() {
  const config = require('../lib/config');
  const previousModel = Object.getOwnPropertyDescriptor(config, 'AI_MODEL');
  Object.defineProperty(config, 'AI_MODEL', { configurable: true, value: 'test-model' });
  const previousApiKey = Object.getOwnPropertyDescriptor(config, 'AI_API_KEY');
  const previousFetch = global.fetch;
  Object.defineProperty(config, 'AI_API_KEY', { configurable: true, value: 'smoke-test-key' });
  global.fetch = async (url, options = {}) => {
    const body = String(options.body || '');
    const content = body.includes('繁體中文簡介') ? '繁体中文简介' : '这是中文译文';
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  };
  try {
    const japanese = await normalizeSummaryText('local_epub_summary', 'これは紹介です');
    assert.strictEqual(japanese.sourceText, 'これは紹介です');
    assert.strictEqual(japanese.translatedText, '这是中文译文');
    assert.strictEqual(japanese.displayText, '这是中文译文');

    const traditional = await normalizeSummaryText('local_epub_summary', '繁體中文簡介');
    assert.strictEqual(traditional.sourceText, '繁體中文簡介');
    assert.strictEqual(traditional.translatedText, '繁体中文简介');
    assert.strictEqual(traditional.displayText, '繁体中文简介');
  } finally {
    Object.defineProperty(config, 'AI_API_KEY', previousApiKey);
    Object.defineProperty(config, 'AI_MODEL', previousModel);
    global.fetch = previousFetch;
  }
}

async function assertScrapeRetriesAfterSimplifiedFallback() {
  const archivePath = require.resolve('../lib/archiveSource');
  const taskQueuePath = require.resolve('../lib/taskQueue');
  const originalArchiveExports = require(archivePath);
  const originalTaskQueue = require.cache[taskQueuePath];
  let scrapeCalls = 0;
  let fallbackCalls = 0;

  delete require.cache[taskQueuePath];
  require.cache[archivePath].exports = {
    ...originalArchiveExports,
    scrapeSeries: async (seriesId, options = {}) => {
      scrapeCalls += 1;
      assert.strictEqual(seriesId, 'traditional-title-retry');
      throw new Error('未找到 Bangumi 匹配: 繁體標題');
    },
    fallbackBangumiToLocalMode: async (seriesId, options = {}) => {
      fallbackCalls += 1;
      assert.strictEqual(seriesId, 'traditional-title-retry');
      assert.strictEqual(options.persistAsScrapeResult, true,
        'failed scrape should first persist simplified local fallback');
      return { success: true, seriesId, reason: options.reason || '', bangumi: { subjectId: null } };
    },
  };

  try {
    const { enqueueTask, snapshot } = require(taskQueuePath);
    await enqueueTask('scrapeSeries', { seriesId: 'traditional-title-retry' });
    let task = null;
    for (let i = 0; i < 80; i += 1) {
      task = snapshot().find(item => item.payload?.seriesId === 'traditional-title-retry');
      if (task && (task.status === 'success' || task.status === 'failed')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert(task, 'retry scrape task should be visible in task snapshot');
    assert.strictEqual(task.status, 'success', 'a successfully localized fallback may complete the task');
    assert.strictEqual(scrapeCalls, 1, 'localized fallback is the final step, without another external scrape');
    assert.strictEqual(fallbackCalls, 1, 'AI localization fallback should run exactly once');
  } finally {
    require.cache[archivePath].exports = originalArchiveExports;
    delete require.cache[taskQueuePath];
    if (originalTaskQueue) require.cache[taskQueuePath] = originalTaskQueue;
  }
}

async function prepareFixture() {
  const fixtureRoot = await resolveFixtureRoot();
  await fs.rm(smokeRoot, { recursive: true, force: true });
  await fs.rm(smokeOtherRoot, { recursive: true, force: true });
  await fs.rm(smokeCustomRoot, { recursive: true, force: true });
  await fs.rm(smokeDataRoot, { recursive: true, force: true });
  await fs.mkdir(smokeRoot, { recursive: true });
  await fs.mkdir(smokeOtherRoot, { recursive: true });
  await fs.mkdir(smokeCustomRoot, { recursive: true });

  await fs.mkdir(path.join(smokeRoot, '杀手青春 Vol.01'), { recursive: true });
  await fs.writeFile(path.join(smokeRoot, '杀手青春 Vol.01', '001.jpg'), '');
  await fs.copyFile(
    path.join(fixtureRoot, '[FX战士久留美][でむにゃん][Vol.01-Vol.06+Chap.31-Chap.36][汉化组]', 'FX戰士久留美 - Chap.31-Chap.36.rar'),
    path.join(smokeRoot, 'FX戰士久留美 - Chap.31-Chap.36.rar')
  );

  const nested = path.join(smokeRoot, '[嵌套示例][作者][Vol.01-Vol.03]');
  await fs.mkdir(nested, { recursive: true });
  await fs.copyFile(path.join(fixtureRoot, 'Vol.01.cbz'), path.join(nested, 'Vol.01.cbz'));
  await fs.copyFile(path.join(fixtureRoot, '杀手青春 Vol.01.zip'), path.join(nested, 'Vol.02.zip'));
  await fs.copyFile(path.join(fixtureRoot, '想結束這場「我愛你」的遊戲 Vol.01.pdf'), path.join(nested, 'Vol.03.pdf'));

  const implicitVolume = path.join(smokeRoot, '瑠璃龍龍');
  await fs.mkdir(implicitVolume, { recursive: true });
  await fs.copyFile(path.join(fixtureRoot, 'Vol.01.cbz'), path.join(implicitVolume, '瑠璃龍龍 (1).cbz'));

  const webpTarget = path.join(smokeRoot, 'BACK COVER.webp');
  await sharp({
    create: {
      width: maxImageDimension() + 1,
      height: 8,
      channels: 3,
      background: { r: 28, g: 28, b: 30 },
    },
  }).webp({ quality: 80 }).toFile(webpTarget);

  const attachedVolumeBuild = path.join(smokeRunRoot, 'reader-plus-smoke-attached-volumes');
  await fs.rm(attachedVolumeBuild, { recursive: true, force: true });
  await fs.mkdir(attachedVolumeBuild, { recursive: true });
  const attachedVolumeImage = path.join(attachedVolumeBuild, '001.png');
  await fs.writeFile(attachedVolumeImage, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw9qYQAAAABJRU5ErkJggg==',
    'base64'
  ));
  for (let volume = 1; volume <= 7; volume += 1) {
    const separator = volume % 2 === 0 ? ' ' : '';
    const target = path.join(smokeRoot, `從後面來的神威先生${separator}(${String(volume).padStart(2, '0')}).zip`);
    await fs.rm(target, { force: true });
    await run('zip', ['-Xj', target, attachedVolumeImage]);
  }

  const legacy = path.join(smokeRoot, '兼容旧格式');
  await fs.mkdir(path.join(legacy, '默認', '1 第01话'), { recursive: true });
  await fs.mkdir(path.join(legacy, '其他系列', '1 番外01'), { recursive: true });
  await fs.writeFile(path.join(legacy, '默認', '1 第01话', '001.jpg'), '');
  await fs.writeFile(path.join(legacy, '其他系列', '1 番外01', '001.jpg'), '');
  await fs.writeFile(path.join(legacy, '元数据.json'), JSON.stringify({
    comic: {
      name: '兼容旧格式',
      alias: '',
      author: [],
      theme: [],
      status: { display: '连载中' },
      groups: {
        default: [
          {
            chapterUuid: 'legacy-default-1',
            chapterTitle: '第01话',
            groupName: '默認',
            order: 1.0,
          },
        ],
        other_group: [
          {
            chapterUuid: 'legacy-other-1',
            chapterTitle: '番外01',
            groupName: '其他系列',
            order: 1.0,
          },
        ],
      },
    },
  }, null, 2));

  const grouped = path.join(smokeRoot, '通用分组示例');
  await fs.mkdir(path.join(grouped, '其他系列', '1 番外01'), { recursive: true });
  await fs.writeFile(path.join(grouped, '其他系列', '1 番外01', '001.jpg'), '');

  const epubBuild = path.join(smokeRunRoot, 'reader-plus-smoke-epub');
  const epubTarget = path.join(smokeRoot, '[百炼霸王与圣约女武神][鹰山诚一][Vol.01].epub');
  await fs.rm(epubBuild, { recursive: true, force: true });
  await fs.mkdir(path.join(epubBuild, 'META-INF'), { recursive: true });
  await fs.mkdir(path.join(epubBuild, 'OEBPS', 'text'), { recursive: true });
  await fs.mkdir(path.join(epubBuild, 'OEBPS', 'images'), { recursive: true });
  await fs.writeFile(path.join(epubBuild, 'mimetype'), 'application/epub+zip');
  await fs.writeFile(path.join(epubBuild, 'META-INF', 'container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  await fs.writeFile(path.join(epubBuild, 'OEBPS', 'content.opf'), `<?xml version="1.0" encoding="utf-8"?>
<package version="3.0" unique-identifier="bookid" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>百炼霸王与圣约女武神</dc:title></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="chap1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chap2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="chap1"/><itemref idref="chap2"/></spine>
</package>`);
  await fs.writeFile(path.join(epubBuild, 'OEBPS', 'nav.xhtml'), `<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"><body>
<nav epub:type="toc"><ol><li><a href="text/chapter1.xhtml">序章</a></li><li><a href="text/chapter2.xhtml">第一章</a></li></ol></nav>
</body></html>`);
  await fs.writeFile(path.join(epubBuild, 'OEBPS', 'text', 'chapter1.xhtml'), '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>序章</h1><p>测试正文</p></body></html>');
  await fs.writeFile(path.join(epubBuild, 'OEBPS', 'text', 'chapter2.xhtml'), '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><p>更多测试正文</p></body></html>');
  await fs.writeFile(path.join(epubBuild, 'OEBPS', 'images', 'cover.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw9qYQAAAABJRU5ErkJggg==',
    'base64'
  ));
  await fs.rm(epubTarget, { force: true });
  await run('zip', ['-X0', epubTarget, 'mimetype'], { cwd: epubBuild });
  await run('zip', ['-Xr', epubTarget, 'META-INF', 'OEBPS'], { cwd: epubBuild });

  const aobutaStyleDir = path.join(smokeRoot, '[青春猪头少年系列][鴨志田一][Vol.01]');
  await fs.mkdir(aobutaStyleDir, { recursive: true });
  await fs.copyFile(
    epubTarget,
    path.join(aobutaStyleDir, '[鸭志田一].[青春猪头少年系列01].青春猪头少年不会梦到兔女郎学姊.epub')
  );
  await fs.copyFile(
    epubTarget,
    path.join(aobutaStyleDir, '[鸭志田一].[青春猪头少年系列短篇].青春猪头少年不会梦到初恋少女.epub')
  );

  await fs.mkdir(path.join(smokeOtherRoot, '1', '设定集 A'), { recursive: true });
  await fs.writeFile(path.join(smokeOtherRoot, '1', '设定集 A', '001.jpg'), '');
  await fs.mkdir(path.join(smokeOtherRoot, '2', '特典 B'), { recursive: true });
  await fs.writeFile(path.join(smokeOtherRoot, '2', '特典 B', '001.jpg'), '');

  await fs.mkdir(path.join(smokeCustomRoot, '1', '图册 A'), { recursive: true });
  await fs.writeFile(path.join(smokeCustomRoot, '1', '图册 A', '001.jpg'), '');
  await fs.mkdir(path.join(smokeCustomRoot, '2', 'MMT A'), { recursive: true });
  await fs.writeFile(path.join(smokeCustomRoot, '2', 'MMT A', '001.jpg'), '');
}

async function main() {
  await prepareFixture();
  prepareSmokeSettings();

  const fx = parseName('[FX战士久留美][でむにゃん][Vol.01-Vol.06+Chap.31-Chap.36][汉化组]');
  assert.strictEqual(fx.title, 'FX战士久留美');
  assert.strictEqual(fx.authors[0], 'でむにゃん');
  assert.strictEqual(fx.contentType, 'mixed_bundle');
  assert.strictEqual(fx.volumeRange.start, 1);
  assert.strictEqual(fx.volumeRange.end, 6);
  assert.strictEqual(fx.chapterRange.start, 31);

  const collectedVolume = parseName('Vol.031 最新Chap.489-530.zip');
  assert.strictEqual(collectedVolume.contentType, 'volume');
  assert.strictEqual(collectedVolume.detectedNumberType, 'volume');
  assert.strictEqual(collectedVolume.detectedNumber, 31);
  assert.strictEqual(collectedVolume.chapterRange.start, 489);
  assert.strictEqual(collectedVolume.chapterRange.end, 530);

  const relife = parseName('[ReLIFE 重返17岁] [夜宵草] [[Vol.01-Vol.15]');
  assert.strictEqual(relife.title, 'ReLIFE 重返17岁');
  assert.strictEqual(relife.detectedNumberType, 'volume');

  const makeine = parseName('[败犬女主太多了！][雨森たきび×いたち][Vol.01-Vol.12]');
  assert.strictEqual(makeine.title, '败犬女主太多了！');
  assert.deepStrictEqual(makeine.authors, ['雨森たきび', 'いたち']);
  assert.strictEqual(makeine.detectedNumberType, 'volume');

  const attachedParenthesizedVolume = parseName('從後面來的神威先生(07).zip');
  assert.strictEqual(attachedParenthesizedVolume.title, '從後面來的神威先生');
  assert.strictEqual(attachedParenthesizedVolume.contentType, 'volume');
  assert.strictEqual(attachedParenthesizedVolume.detectedNumberType, 'volume');
  assert.strictEqual(attachedParenthesizedVolume.detectedNumber, 7);
  const spacedParenthesizedVolume = parseName('從後面來的神威先生 (07).zip');
  assert.strictEqual(spacedParenthesizedVolume.title, '從後面來的神威先生');
  assert.strictEqual(spacedParenthesizedVolume.contentType, 'volume');
  assert.strictEqual(spacedParenthesizedVolume.detectedNumberType, 'volume');
  assert.strictEqual(spacedParenthesizedVolume.detectedNumber, 7);
  const decimalBareVolume = parseName('さくら荘のペットな彼女 5.5.epub');
  assert.strictEqual(decimalBareVolume.contentType, 'volume');
  assert.strictEqual(decimalBareVolume.detectedNumber, 5.5);
  const decimalBracketVolume = parseName('さくら荘のペットな彼女 〈5.5〉.epub');
  assert.strictEqual(decimalBracketVolume.contentType, 'volume');
  assert.strictEqual(decimalBracketVolume.detectedNumber, 5.5);

  assertBangumiTitleAndMediumScoring();
  assertRuriDragonTitleCompatibility();
  assertBangumiArtbookMatching();
  assertDeepSeekVolumeMatchingParsesLocalExtras();
  assertSourceAliasScoping();
  await assertDeepSeekNameLocalization();
  await assertDeepSeekSummaryNormalization();
  await assertScrapeRetriesAfterSimplifiedFallback();

  await scanLibrary({ fast: true, concurrency: 1 });
  const scan = await scanLibrary({ concurrency: 1 });
  assert(scan.seriesList.length >= 3, 'sample scan should discover resources');
  const resourceIndex = await readIndex('resource-index.json', {});
  const resources = Object.values(resourceIndex);
  assert(resources.some(r => r.type === 'zip'), 'zip resource should be indexed');
  assert(resources.some(r => r.type === 'cbz'), 'cbz resource should be indexed');
  assert(resources.some(r => r.type === 'rar'), 'rar resource should be indexed');
  assert(resources.some(r => r.type === 'pdf'), 'pdf resource should be indexed');
  assert(resources.some(r => ['zip', 'cbz', 'rar'].includes(r.type) && Number(r.pageCount || 0) > 0),
    'full scan after fast scan should refresh archive page counts');
  const webpResource = resources.find(r => r.type === 'image' && r.relativePath === 'BACK COVER.webp');
  assert(webpResource, 'top-level webp image should be indexed as a single image resource');
  assert.strictEqual(webpResource.pageCount, 1, 'single webp image should have one page');
  const attachedVolumes = resources
    .filter(r => /^從後面來的神威先生\s*[（(]/.test(r.relativePath))
    .sort((a, b) => a.detectedNumber - b.detectedNumber);
  assert.strictEqual(attachedVolumes.length, 7,
    'attached parenthesized volume filenames should all be indexed');
  assert(attachedVolumes.every(r => r.contentType === 'volume'),
    'attached parenthesized zip files should be treated as volumes, not chapters');
  assert.deepStrictEqual(attachedVolumes.map(r => r.detectedNumber), [1, 2, 3, 4, 5, 6, 7],
    'attached parenthesized zip files should preserve volume numbers');
  assert.strictEqual(new Set(attachedVolumes.map(r => r.seriesId)).size, 1,
    'attached parenthesized zip files should belong to one series');
  const attachedSeries = scan.seriesList.find(s => s.seriesId === attachedVolumes[0].seriesId);
  assert(attachedSeries, 'attached parenthesized volume series should be indexed');
  assert.strictEqual(attachedSeries.title, '從後面來的神威先生');
  assert.strictEqual(attachedSeries.contentMode, 'volume');
  const nestedResources = resources.filter(r => r.relativePath.includes('[嵌套示例]'));
  assert(nestedResources.length >= 3, 'nested series directory resources should be indexed');
  const implicitCbzVolume = resources.find(r => r.relativePath.includes('瑠璃龍龍/瑠璃龍龍 (1).cbz'));
  assert(implicitCbzVolume, 'implicit numbered cbz volume should be indexed');
  assert.strictEqual(implicitCbzVolume.contentType, 'volume');
  assert.strictEqual(implicitCbzVolume.detectedNumberType, 'volume');
  assert.strictEqual(implicitCbzVolume.detectedNumber, 1);
  const legacyResources = resources.filter(r => r.relativePath.includes('兼容旧格式'));
  assert(legacyResources.some(r => r.legacy?.groupName === '其他系列' && r.title === '番外01'),
    'legacy metadata groups should preserve other series and chapter titles');
  const groupedResource = resources.find(r => r.relativePath.includes('通用分组示例/其他系列/1 番外01'));
  assert(groupedResource, 'generic nested group resource should be indexed');
  assert.strictEqual(groupedResource.groupName, '其他系列');
  assert.strictEqual(groupedResource.title, '番外01');
  const epubResource = resources.find(r => r.type === 'epub');
  assert(epubResource, 'epub resource should be indexed');
  assert.strictEqual(epubResource.category, 'novel');
  assert.strictEqual(epubResource.title, 'Vol.01');
  const epubSeries = scan.seriesList.find(s => s.seriesId === epubResource.seriesId);
  assert(epubSeries, 'epub series should be indexed');
  assert.strictEqual(epubSeries.category, 'novel');
  assert.strictEqual(epubSeries.title, '百炼霸王与圣约女武神');
  const epubManifest = await getEpubManifest(epubResource);
  assert.strictEqual(epubManifest.chapters.length, 2, 'epub spine chapters should be parsed');
  assert.strictEqual(epubManifest.chapters[0].title, '序章');
  assert(epubManifest.coverEntry, 'epub cover image should be discovered');
  const aobutaStyleResource = resources.find(r => r.relativePath.includes('[青春猪头少年系列01]'));
  assert(aobutaStyleResource, 'series-number epub filename should be indexed');
  assert.strictEqual(aobutaStyleResource.category, 'novel');
  assert.strictEqual(aobutaStyleResource.detectedNumber, 1);
  assert.strictEqual(aobutaStyleResource.title, 'Vol.01');
  const aobutaShortResource = resources.find(r => r.relativePath.includes('[青春猪头少年系列短篇]'));
  assert(aobutaShortResource, 'series short-story epub filename should be indexed');
  assert.strictEqual(aobutaShortResource.category, 'novel');
  assert.strictEqual(aobutaShortResource.contentType, 'volume',
    'novel epub resources without a volume number should still be treated as volumes');
  assert.strictEqual(aobutaShortResource.detectedNumber, null);
  const otherResources = resources.filter(r => r.category === 'other');
  assert(otherResources.some(r => r.relativePath === '设定集 A'),
    'numbered other-library mount should expand and index resources inside /others/1');
  assert(otherResources.some(r => r.relativePath === '特典 B'),
    'numbered other-library mount should expand and index resources inside /others/2');
  assert(scan.seriesList.some(s => s.category === 'other' && s.title === '设定集 A'),
    'other-library mount segment should not become the series title');
  assert(!scan.seriesList.some(s => s.category === 'other' && /^\d+$/.test(s.title)),
    'numeric other-library mount directories should not be indexed as series titles');
  const customResources = resources.filter(r => r.category === 'photos');
  assert(customResources.some(r => r.relativePath === '图册 A'),
    'custom category root should index resources under its bound path');
  assert(scan.seriesList.some(s => s.category === 'photos' && s.title === '图册 A'),
    'custom category resources should remain in their configured category');
  const suffixCustomResources = resources.filter(r => r.category === 'mmt');
  assert(suffixCustomResources.some(r => r.relativePath === 'MMT A'),
    'suffix custom category env vars should not overwrite aggregate custom categories');
  assert(scan.seriesList.some(s => s.category === 'mmt' && s.title === 'MMT A'),
    'suffix custom category resources should remain in their configured category');

  const archiveResource = resources.find(r => r.type === 'zip' || r.type === 'cbz');
  const pages = await getPages(archiveResource.resourceId);
  assert(pages.pageCount > 0, 'archive pages should be listed');
  const archivePagePath = await getPageFile(archiveResource.resourceId, 1);
  const refreshedArchivePagePaths = await Promise.all(
    Array.from({ length: 3 }, () => getPageFile(archiveResource.resourceId, 1, { forceRefresh: true }))
  );
  assert(refreshedArchivePagePaths.every(item => item === archivePagePath),
    'concurrent archive page refreshes should keep a stable cache path');
  const refreshedArchivePageStat = await fs.stat(archivePagePath);
  assert(refreshedArchivePageStat.size > 0,
    'force refreshing an archive page should leave a readable cache file');
  const webpPages = await getPages(webpResource.resourceId);
  assert.strictEqual(webpPages.pageCount, 1, 'single webp image pages should be listed');
  assert.strictEqual(await getPageFile(webpResource.resourceId, 1), await fs.realpath(webpResource.sourcePath),
    'single webp image page should resolve to the original file');
  const streamImage = await streamableImage(webpResource.sourcePath);
  assert(streamImage.resized, 'oversized webp should be resized before streaming');
  assert.strictEqual(streamImage.contentType, 'image/webp', 'resized stream image should be webp');
  const streamMeta = await readImageMetadata(streamImage.filePath);
  assert(Math.max(streamMeta.width, streamMeta.height) <= maxImageDimension(),
    'streamed oversized image should be capped to the configured max dimension');
  const coverImage = await persistentCoverFromFile(webpResource.sourcePath);
  assert(coverImage.resized, 'oversized extracted cover should be resized before persistence');
  assert.strictEqual(coverImage.ext, '.webp', 'resized extracted cover should be persisted as webp');

  await assertLibraryChangeEventsRefreshSubjectIndex();

  console.log(`smoke ok: ${scan.seriesList.length} series, ${resources.length} resources`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => fs.rm(smokeRunRoot, { recursive: true, force: true }));
