const { prepareSettings, fixtureSource } = require('./settings-fixture');
const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

async function main() {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-plus-volume-scrape-'));
  const libraryRoot = path.join(runRoot, 'library');
  const dataRoot = path.join(runRoot, 'data');
  await fs.mkdir(libraryRoot, { recursive: true });
  const excludedRoot = path.join(runRoot, 'excluded');
  await fs.mkdir(excludedRoot);

  process.env.DATA_DIR = dataRoot;
  prepareSettings({ dataRoot, sources: [fixtureSource(libraryRoot, { autoScrape: true }),
    fixtureSource(excludedRoot, { id: 'excluded', autoScrape: false })], username: 'admin', password: 'admin' });
  const { LOCALIZATION_VERSION } = require('../lib/metadataLocalization');

  const { scanLibrary } = require('../lib/scanner');
  const {
    readSeriesBundle,
    updateBangumi,
    updateSeriesOverrides,
  } = require('../lib/metadataStore');
  const {
    enqueueTask,
    onTasksChanged,
    waitForTask,
  } = require('../lib/taskQueue');

  const volumePath = number => path.join(
    libraryRoot,
    `[定向卷册测试][测试作者][Vol.${String(number).padStart(2, '0')}].epub`
  );

  try {
    await fs.writeFile(volumePath(1), 'volume-1');
    const firstScan = await scanLibrary({ fast: true, concurrency: 1 });
    assert.strictEqual(firstScan.seriesList.length, 1);
    const seriesId = firstScan.seriesList[0].seriesId;
    const firstBundle = await readSeriesBundle(seriesId);
    const firstResource = firstBundle.resources[0];
    const firstMatch = {
      resourceId: firstResource.resourceId,
      resourceKey: firstResource.resourceId,
      originalTitle: firstResource.originalTitle || firstResource.title,
      localTitle: firstResource.title,
      detectedNumber: 1,
      subjectId: 2001,
      matched: true,
      confidence: 60,
      displayTitle: 'Vol.01',
      reason: 'existing match',
      source: 'test',
      candidateName: '定向卷册测试 1',
      candidateNameCn: '定向卷册测试 第1卷',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const relations = [
      { subjectId: 2001, name: '定向卷册测试 1', name_cn: '定向卷册测试 第1卷', relationType: '单行本' },
      { subjectId: 2002, name: '定向卷册测试 2', name_cn: '定向卷册测试 第2卷', relationType: '单行本' },
    ];
    const oldVolumeDetail = {
      localizationVersion: LOCALIZATION_VERSION,
      subjectId: 2001,
      nameJa: '定向卷册测试 1',
      nameCn: '定向卷册测试 第1卷',
      summary: 'old summary',
      translatedSummary: '旧简介',
      cover: 'https://example.test/old-cover.jpg',
      resourceIds: [firstResource.resourceId],
      volumeNumbers: [1],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await updateBangumi(seriesId, {
      bangumi: {
        subjectId: 1000,
        detailsSchemaVersion: 2,
        localizationVersion: LOCALIZATION_VERSION,
        name: '定向卷册测试',
        name_cn: '定向卷册测试',
        authors: ['测试作者'],
        tags: [],
        metaTags: [],
        relatedSubjects: relations,
        volumeMatches: [firstMatch],
      },
      relations,
      persons: [],
      characters: [],
      volumeDetails: { 2001: oldVolumeDetail },
    });
    await updateSeriesOverrides(seriesId, {
      bangumiScrapeCompletedAt: '2026-01-01T00:00:00.000Z',
      bangumiScrapeSubjectId: 1000,
      bangumiScrapeStrategyVersion: 1,
    });

    await fs.writeFile(volumePath(2), 'volume-2');
    await fs.writeFile(path.join(excludedRoot, path.basename(volumePath(3))), 'excluded-volume-3');

    const fetchCalls = [];
    const originalFetch = global.fetch;
    global.fetch = async url => {
      const value = String(url);
      fetchCalls.push(value);
      if (!value.endsWith('/v0/subjects/2002')) {
        throw new Error(`unexpected fetch: ${value}`);
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 2002,
          name: '定向卷册测试 2',
          name_cn: '定向卷册测试 第2卷',
          summary: 'new volume summary',
          date: '2026-02-02',
          images: { large: 'https://example.test/new-cover.jpg' },
        }),
      };
    };

    const taskEvents = [];
    const unsubscribe = onTasksChanged(event => taskEvents.push(event));
    try {
      const task = await enqueueTask('scanAndScrape', {
        reason: 'new_volume_test',
        fastScan: true,
      });
      await waitForTask(task, { timeoutMs: 15000 });
    } finally {
      unsubscribe();
      global.fetch = originalFetch;
    }

    const finalBundle = await readSeriesBundle(seriesId);
    const secondResource = finalBundle.resources.find(resource => Number(resource.detectedNumber) === 2);
    const excludedResource = finalBundle.resources.find(resource => resource.sourceId === 'excluded');
    assert(excludedResource, 'excluded sources are still indexed as part of the shared work');
    assert(!finalBundle.bangumi.volumeMatches.some(match => match.resourceId === excludedResource.resourceId), 'batch scraping must not touch an excluded volume in a shared work');
    assert((await require('../lib/archiveSource').scrapeSeriesVolumes(seriesId, [excludedResource.resourceId], { respectAutoScrape: true })).skipped,
      'the volume scrape boundary also enforces source exclusions');
    assert(secondResource, 'the second volume should be indexed');
    assert.strictEqual(finalBundle.bangumi.subjectId, 1000,
      'targeted volume scraping must preserve the existing series subject');
    assert.deepStrictEqual(
      finalBundle.bangumi.volumeMatches.find(match => match.resourceId === firstResource.resourceId),
      firstMatch,
      'targeted volume scraping must preserve the old volume match unchanged'
    );
    const secondMatch = finalBundle.bangumi.volumeMatches.find(match => match.resourceId === secondResource.resourceId);
    assert.strictEqual(secondMatch.subjectId, 2002,
      'the new volume should match its own Bangumi offprint subject');
    assert.deepStrictEqual(finalBundle.volumeDetails['2001'], oldVolumeDetail,
      'the old volume detail must not be fetched or rewritten');
    assert.strictEqual(finalBundle.volumeDetails['2002'].summary, 'new volume summary');
    assert.deepStrictEqual(fetchCalls, ['https://api.bgm.tv/v0/subjects/2002'],
      'only the new volume subject should be fetched');
    assert(taskEvents.some(event => event.tasks.some(task => task.status === 'running')),
      'task events should push running progress');
    assert(taskEvents.some(event => event.tasks.some(task => task.status === 'success')),
      'task events should push completion');

    // The traditional path translates an independent Japanese volume title directly.
    await updateBangumi(seriesId, {
      bangumi: { ...finalBundle.bangumi, pendingResourceIds: [secondResource.resourceId] }, relations,
      volumeDetails: { 2001: oldVolumeDetail },
    });
    const config = require('../lib/config');
    const originalKey = Object.getOwnPropertyDescriptor(config, 'AI_API_KEY');
    const originalModel = Object.getOwnPropertyDescriptor(config, 'AI_MODEL');
    Object.defineProperty(config, 'AI_API_KEY', { configurable: true, value: 'volume-translation-test-key' });
    Object.defineProperty(config, 'AI_MODEL', { configurable: true, value: 'test-model' });
    const translationCalls = [];
    assert.strictEqual(config.AI_WEB_SEARCH_ENABLED, false);
    global.fetch = async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      translationCalls.push(pathname);
      if (pathname === '/v0/subjects/2002') return { ok: true, json: async () => ({
        id: 2002, type: 1, name: '新しい巻の物語', name_cn: '', summary: '',
      }) };
      assert.strictEqual(pathname, '/v1/chat/completions', 'independent volume titles must never invoke web search');
      const request = JSON.parse(options.body);
      assert.strictEqual(request.tools, undefined);
      const payload = JSON.parse(request.messages.at(-1).content);
      assert.strictEqual(payload.entries[0].sourceName, '新しい巻の物語');
      assert.strictEqual(payload.context.chineseTitle, '定向卷册测试');
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        results: [{ key: payload.entries[0].key, nameCn: '新卷的故事' }],
      }) } }] }) };
    };
    try {
      await require('../lib/archiveSource').scrapeSeriesVolumes(seriesId, [secondResource.resourceId]);
      const translatedBundle = await readSeriesBundle(seriesId);
      assert.strictEqual(translatedBundle.volumeDetails['2002'].nameCn, '新卷的故事');
      assert.deepStrictEqual(translatedBundle.volumeDetails['2001'], oldVolumeDetail);
      assert.deepStrictEqual(translationCalls, ['/v0/subjects/2002', '/v1/chat/completions']);
    } finally {
      global.fetch = originalFetch;
      Object.defineProperty(config, 'AI_API_KEY', originalKey);
      Object.defineProperty(config, 'AI_MODEL', originalModel);
    }

    console.log('new volume scrape ok');
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
