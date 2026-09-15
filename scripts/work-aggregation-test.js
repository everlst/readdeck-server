const { prepareSettings } = require('./settings-fixture');
const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function waitForOutput(child, pattern, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for server: ${output}`)), timeoutMs);
    const onData = chunk => {
      output += chunk.toString();
      if (!pattern.test(output)) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      resolve(output);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Server exited with ${code}: ${output}`));
    });
  });
}

async function requestJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  return { response, data: text ? JSON.parse(text) : null, text };
}

function makeResource(seriesId, resourceId, sourcePath, options = {}) {
  return {
    resourceId,
    seriesId,
    title: options.title || resourceId,
    originalTitle: options.originalTitle || options.title || resourceId,
    relativePath: options.relativePath || path.relative(path.dirname(path.dirname(sourcePath)), sourcePath),
    sourcePath,
    type: options.type || 'cbz',
    contentType: options.contentType || 'volume',
    detectedNumber: options.detectedNumber ?? null,
    detectedNumberEnd: options.detectedNumber ?? null,
    detectedNumberType: options.contentType === 'chapter' ? 'chapter' : 'volume',
    groupKey: options.groupKey || '',
    groupName: options.groupName || '',
    category: 'comic',
    pageCount: options.pageCount || 20,
    fileSize: options.fileSize || 1024,
    firstIndexedAt: options.firstIndexedAt || '2026-07-20T10:00:00.000Z',
    modifiedTime: options.firstIndexedAt || '2026-07-20T10:00:00.000Z',
    readable: true,
    coverCandidate: `/api/resources/${resourceId}/cover`,
  };
}

async function main() {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-plus-work-aggregation-'));
  const libraryRoot = path.join(runRoot, 'library');
  const dataRoot = path.join(runRoot, 'data');
  const outsideRoot = path.join(runRoot, 'outside');
  const port = 16000 + Math.floor(Math.random() * 1000);
  await fs.mkdir(path.join(libraryRoot, '角川版'), { recursive: true });
  await fs.mkdir(path.join(libraryRoot, 'BW版'), { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });

  process.env.DATA_DIR = dataRoot;
  prepareSettings({ dataRoot, libraryRoot, username: 'work-test', password: 'work-test' });

  const archiveSource = require('../lib/archiveSource');
  const {
    assignSeriesToWork,
    effectiveGroupForResource,
    readWorkState,
    replaceModelGroups,
    resolveWorkIdForBundle,
    setManualSplit,
    clearManualSplit,
  } = require('../lib/workStore');
  const {
    ensureMetadataLayout,
    upsertSeriesIndexes,
    writeSeriesBundle,
  } = require('../lib/metadataStore');

  const relatedResources = [{ resourceId: 'extra-a', title: 'Another 0卷', originalTitle: 'Another 0卷' }];
  const relatedCandidates = [
    { subjectId: 37727, relationType: '番外篇', nameCn: 'Another 0卷' },
    { subjectId: 88888, relationType: '画集', nameCn: 'Another 画集' },
  ];
  const validRelated = archiveSource.parseDeepSeekVolumeMatchResponse(
    JSON.stringify({ results: [{ resourceId: 'extra-a', subjectId: 37727, confidence: 82, displayTitle: 'Another 0卷' }] }),
    relatedResources,
    relatedCandidates,
    { title: 'Another' },
    { matchKind: 'related', minConfidence: 70 }
  );
  assert.strictEqual(validRelated[0].subjectId, 37727);
  assert.strictEqual(validRelated[0].matchKind, 'related');
  assert.strictEqual(validRelated[0].sectionTitle, '番外篇');
  const rejectedRelated = archiveSource.parseDeepSeekVolumeMatchResponse(
    JSON.stringify({ results: [
      { resourceId: 'extra-a', subjectId: 99999, confidence: 99 },
    ] }),
    relatedResources,
    relatedCandidates,
    { title: 'Another' },
    { matchKind: 'related', minConfidence: 70 }
  );
  assert.strictEqual(rejectedRelated[0].subjectId, null, 'candidate-list external subject IDs must be rejected');
  const lowRelated = archiveSource.parseDeepSeekVolumeMatchResponse(
    JSON.stringify({ results: [{ resourceId: 'extra-a', subjectId: 37727, confidence: 69 }] }),
    relatedResources,
    relatedCandidates,
    { title: 'Another' },
    { matchKind: 'related', minConfidence: 70 }
  );
  assert.strictEqual(lowRelated[0].subjectId, 37727, 'valid AI related matches must not be vetoed by a fixed confidence threshold');
  const relatedPayload = archiveSource.buildDeepSeekRelatedMatchPayload(
    { series: { title: 'Another' } },
    [
      { subjectId: 1, relationType: '单行本' },
      { subjectId: 2, relationType: '动画' },
      { subjectId: 3, relationType: '画集' },
    ],
    relatedResources,
    [1]
  );
  assert.deepStrictEqual(relatedPayload.candidates.map(item => item.subjectId), [2, 3],
    'related matching must keep every remaining relationship type without a whitelist');

  const localGroups = archiveSource.parseDeepSeekLocalResourceGroupResponse(
    JSON.stringify({ groups: [
      { resourceIds: ['local-a', 'local-b'], kind: 'book', confidence: 91, title: '同一本书' },
      { resourceIds: ['local-a', 'invalid'], kind: 'book', confidence: 99 },
      { resourceIds: ['low-a', 'low-b'], kind: 'chapter', confidence: 84 },
    ] }),
    [
      { resourceId: 'local-a', kind: 'book' },
      { resourceId: 'local-b', kind: 'book' },
      { resourceId: 'low-a', kind: 'chapter' },
      { resourceId: 'low-b', kind: 'chapter' },
    ],
    { minConfidence: 85 }
  );
  assert.strictEqual(localGroups['local-a'].groupKey, localGroups['local-b'].groupKey);
  assert.strictEqual(localGroups['low-a'], undefined, 'local grouping below 85 must be ignored');
  const localWorkGroups = archiveSource.parseDeepSeekLocalWorkResponse(
    JSON.stringify({ groups: [
      { seriesIds: ['local-series-a', 'local-series-b'], confidence: 90, title: '同一作品' },
      { seriesIds: ['local-series-a', 'invalid-series'], confidence: 99 },
      { seriesIds: ['low-series-a', 'low-series-b'], confidence: 84 },
    ] }),
    [
      { seriesId: 'local-series-a' },
      { seriesId: 'local-series-b' },
      { seriesId: 'low-series-a' },
      { seriesId: 'low-series-b' },
    ],
    { minConfidence: 85 }
  );
  assert.deepStrictEqual(localWorkGroups.map(group => group.seriesIds), [['local-series-a', 'local-series-b']]);
  await assignSeriesToWork('local:comic:test', ['local-series-a', 'local-series-b'], {
    source: 'deepseek_local_work_group', confidence: 90,
  });
  assert.strictEqual(await resolveWorkIdForBundle({
    series: { seriesId: 'local-series-b', category: 'comic' },
    bangumi: {},
  }), 'local:comic:test');

  await setManualSplit('test-work', 'local-a', 'book');
  await replaceModelGroups('test-work', {
    'local-a': { groupKey: 'model:book:refreshed', kind: 'book', confidence: 95 },
  });
  let workState = await readWorkState('test-work');
  assert.strictEqual(effectiveGroupForResource(workState, 'local-a', 'model:test'), 'split:local-a');
  await clearManualSplit('test-work', 'local-a');
  workState = await readWorkState('test-work');
  assert.strictEqual(effectiveGroupForResource(workState, 'local-a', 'model:test'), 'model:book:refreshed');

  await ensureMetadataLayout();
  const files = {
    volume1: path.join(libraryRoot, '角川版', 'Another 01.cbz'),
    extraA: path.join(libraryRoot, '角川版', 'Another 0.cbz'),
    chapterA: path.join(libraryRoot, '角川版', '第01话.cbz'),
    extraB: path.join(libraryRoot, 'BW版', 'Another 0.cbz'),
    chapterB: path.join(libraryRoot, 'BW版', '第01话.cbz'),
    deletable: path.join(libraryRoot, 'BW版', '本地附录.cbz'),
    unsafe: path.join(outsideRoot, 'unsafe.cbz'),
    localA: path.join(libraryRoot, '角川版', '本地作品.cbz'),
    localB: path.join(libraryRoot, 'BW版', '本地作品.cbz'),
  };
  await Promise.all(Object.values(files).map(file => fs.writeFile(file, file)));

  const seriesA = 'another-series-a';
  const seriesB = 'another-series-b';
  const resourcesA = [
    makeResource(seriesA, 'volume-01', files.volume1, { title: 'Vol.01', detectedNumber: 1, pageCount: 180 }),
    makeResource(seriesA, 'extra-a', files.extraA, { title: 'Another 0卷', detectedNumber: 0.5, pageCount: 61 }),
    makeResource(seriesA, 'chapter-a', files.chapterA, {
      title: '第01话', originalTitle: '第01话', contentType: 'chapter', detectedNumber: 1,
      groupKey: 'default', groupName: '默认', pageCount: 22,
    }),
  ];
  const resourcesB = [
    makeResource(seriesB, 'extra-b', files.extraB, {
      title: 'Another 0卷', detectedNumber: 0.5, pageCount: 61,
      firstIndexedAt: '2026-07-21T10:00:00.000Z',
    }),
    makeResource(seriesB, 'chapter-b', files.chapterB, {
      title: '第01话', originalTitle: '第01话', contentType: 'chapter', detectedNumber: 1,
      groupKey: 'default', groupName: '默认', pageCount: 22,
      firstIndexedAt: '2026-07-21T10:00:00.000Z',
    }),
    makeResource(seriesB, 'delete-me', files.deletable, { title: '本地附录', detectedNumber: null, pageCount: 8 }),
    makeResource(seriesB, 'unsafe-resource', files.unsafe, { title: '不安全资源', detectedNumber: null, pageCount: 3 }),
  ];
  const relations = [
    { subjectId: 17076, relationType: '单行本', order: 1, name_cn: 'Another 第1卷' },
    { subjectId: 37727, relationType: '番外篇', order: 20, name_cn: 'Another 0卷' },
    { subjectId: 99999, relationType: '动画', order: 30, name_cn: 'Another 动画' },
  ];
  const matchesA = [
    { resourceId: 'volume-01', matched: true, subjectId: 17076, matchKind: 'offprint', relationType: '单行本', displayTitle: '第1册', bangumiOrder: 1 },
    { resourceId: 'extra-a', matched: true, subjectId: 37727, matchKind: 'related', relationType: '番外篇', sectionTitle: '番外篇', displayTitle: 'Another 0卷', confidence: 94 },
  ];
  const matchesB = [
    { resourceId: 'extra-b', matched: true, subjectId: 37727, matchKind: 'related', relationType: '番外篇', sectionTitle: '番外篇', displayTitle: 'Another 0卷', confidence: 96 },
    { resourceId: 'delete-me', matched: false, subjectId: null, matchKind: 'local', displayTitle: '本地附录' },
    { resourceId: 'unsafe-resource', matched: false, subjectId: null, matchKind: 'local', displayTitle: '不安全资源' },
  ];
  const volumeDetails = {
    17076: { subjectId: 17076, nameCn: '第1册', summary: '第一卷简介', cover: '/api/resources/volume-01/cover' },
    37727: { subjectId: 37727, nameCn: 'Another 0卷', summary: '番外篇简介', cover: '/api/resources/extra-a/cover' },
  };

  async function writeTestSeries(seriesId, resources, matches, source) {
    const written = await writeSeriesBundle({
      seriesId,
      title: 'Another',
      titleNormalized: 'another',
      alternateTitles: [],
      authors: ['清原纮', '绫辻行人'],
      publishers: ['角川'],
      tags: ['悬疑'],
      category: 'comic',
      contentMode: 'mixed',
      status: '完结',
      cover: '/api/resources/volume-01/cover',
      bangumiSubjectId: 19198,
      hasVolumes: true,
      hasChapters: true,
      source,
      latestAddedAt: '2026-07-21T10:00:00.000Z',
    }, resources, {
      bangumi: {
        subjectId: 19198,
        name_cn: 'Another',
        name: 'Another',
        summary: '主系列简介',
        authors: ['清原纮', '绫辻行人'],
        tags: ['悬疑'],
        relatedSubjects: relations,
        volumeMatches: matches,
        detailsSchemaVersion: 2,
      },
      relations,
      persons: [],
      characters: [],
      translations: [],
      volumeDetails,
    });
    await upsertSeriesIndexes(written, resources);
  }
  await writeTestSeries(seriesA, [...resourcesA, resourcesA[1]], matchesA, '角川版');
  await writeTestSeries(seriesB, resourcesB, matchesB, 'BW版');

  const seriesAResourcesPath = path.join(
    dataRoot,
    'metadata',
    'series',
    encodeURIComponent(seriesA),
    'resources.json'
  );
  const storedSeriesAResources = JSON.parse(await fs.readFile(seriesAResourcesPath, 'utf8'));
  assert.strictEqual(storedSeriesAResources.length, resourcesA.length,
    'new metadata writes must not persist duplicate resource IDs');

  // 模拟部署数据中遗留的重复资源记录：同一物理版本不应在详情页出现两次。
  await fs.writeFile(
    seriesAResourcesPath,
    JSON.stringify([...resourcesA, resourcesA[1]], null, 2)
  );

  async function writeLocalSeries(seriesId, resourceId, sourcePath, source) {
    const resources = [makeResource(seriesId, resourceId, sourcePath, {
      title: '本地作品',
      originalTitle: '本地作品',
      detectedNumber: 1,
      relativePath: `${source}/本地作品.cbz`,
    })];
    const written = await writeSeriesBundle({
      seriesId,
      title: '本地作品',
      titleNormalized: '本地作品',
      alternateTitles: [],
      authors: ['本地作者'],
      publishers: [],
      tags: [],
      category: 'comic',
      contentMode: 'volume',
      status: '',
      cover: '',
      bangumiSubjectId: null,
      hasVolumes: true,
      hasChapters: false,
      source,
      latestAddedAt: '2026-07-21T10:00:00.000Z',
    }, resources, { bangumi: {}, relations: [], persons: [], characters: [], translations: [] });
    await upsertSeriesIndexes(written, resources);
  }
  await writeLocalSeries('local-series-a', 'local-book-a', files.localA, '角川版');
  await writeLocalSeries('local-series-b', 'local-book-b', files.localB, 'BW版');

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
    const login = await requestJson(`http://127.0.0.1:${port}/api/login`, '', {
      method: 'POST',
      body: JSON.stringify({ username: 'work-test', password: 'work-test' }),
    });
    assert.strictEqual(login.response.ok, true, login.text);
    const token = login.data.token;
    const library = await requestJson(`http://127.0.0.1:${port}/api/comics?cache=0`, token);
    assert.strictEqual(library.response.ok, true, library.text);
    const localWorkCards = library.data.filter(item => item.workId === 'local:comic:test');
    assert.strictEqual(localWorkCards.length, 1,
      'high-confidence local work groups must expose one library entry');
    assert.deepStrictEqual(new Set(localWorkCards[0].seriesIds), new Set(['local-series-a', 'local-series-b']));

    const detailUrl = `http://127.0.0.1:${port}/api/comics/${seriesA}`;
    let detail = await requestJson(detailUrl, token);
    assert.strictEqual(detail.response.ok, true, detail.text);
    assert.strictEqual(detail.data.workId, 'subject:comic:19198');
    assert.strictEqual(detail.data.resources.some(resource => Object.hasOwn(resource, 'sourcePath')), false,
      'series details must not expose full resource paths');
    const offprints = detail.data.bookSections.find(section => section.title === '单行本');
    const extras = detail.data.bookSections.find(section => section.title === '番外篇');
    assert.deepStrictEqual(offprints.items.map(item => item.title), ['第1册']);
    assert.strictEqual(extras.items.length, 1);
    assert.strictEqual(extras.items[0].title, 'Another 0卷');
    assert.strictEqual(extras.items[0].versionCount, 2);
    assert.strictEqual(detail.data.relations.some(relation => Number(relation.subjectId) === 37727), false,
      'locally matched related subjects must be removed from remote relations');
    assert.strictEqual(detail.data.relations.some(relation => Number(relation.subjectId) === 99999), true);
    assert.strictEqual(detail.data.chapterGroups.default.length, 1);
    assert.strictEqual(detail.data.chapterGroups.default[0].versionCount, 2);
    assert.strictEqual(detail.data.resourceVersions.length, 2, 'legacy version field must remain compatible');

    const volume = await requestJson(
      `http://127.0.0.1:${port}/api/comics/${seriesA}/volumes/extra-a`,
      token
    );
    assert.strictEqual(volume.response.ok, true, volume.text);
    assert.strictEqual(volume.data.versions.length, 2);
    assert.strictEqual(new Set(volume.data.versions.map(item => item.resourceId)).size, 2,
      'duplicate persisted resource IDs must render as one local version');
    assert.strictEqual(volume.data.currentVersion.sourcePath, files.extraA);
    assert.strictEqual(volume.data.summary, '番外篇简介');

    let override = await requestJson(
      `http://127.0.0.1:${port}/api/comics/${seriesA}/group-overrides/extra-b`,
      token,
      { method: 'PUT', body: JSON.stringify({ kind: 'book' }) }
    );
    assert.strictEqual(override.response.ok, true, override.text);
    detail = await requestJson(detailUrl, token);
    assert.strictEqual(detail.data.bookSections.find(section => section.title === '番外篇').items.length, 2);
    override = await requestJson(
      `http://127.0.0.1:${port}/api/comics/${seriesA}/group-overrides/extra-b`,
      token,
      { method: 'DELETE' }
    );
    assert.strictEqual(override.response.ok, true, override.text);
    detail = await requestJson(detailUrl, token);
    assert.strictEqual(detail.data.bookSections.find(section => section.title === '番外篇').items[0].versionCount, 2);

    override = await requestJson(
      `http://127.0.0.1:${port}/api/comics/${seriesA}/group-overrides/chapter-b`,
      token,
      { method: 'PUT', body: JSON.stringify({ kind: 'chapter' }) }
    );
    assert.strictEqual(override.response.ok, true, override.text);
    detail = await requestJson(detailUrl, token);
    assert.strictEqual(detail.data.chapterGroups.default.length, 2);
    await requestJson(
      `http://127.0.0.1:${port}/api/comics/${seriesA}/group-overrides/chapter-b`,
      token,
      { method: 'DELETE' }
    );

    const progressWrite = await requestJson(`http://127.0.0.1:${port}/api/progress/${seriesA}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        chapterUuid: 'extra-b', page: 2, chapterTitle: 'Another 0卷', groupName: '单行本',
        resourceId: 'extra-b', resourceType: 'cbz',
      }),
    });
    assert.strictEqual(progressWrite.response.ok, true, progressWrite.text);
    const progressFile = JSON.parse(await fs.readFile(path.join(dataRoot, 'users', 'admin', 'progress.json'), 'utf8'));
    assert.strictEqual(progressFile[seriesB].lastResourceId, 'extra-b',
      'progress writes must follow the physical resource series');
    const progressRead = await requestJson(`http://127.0.0.1:${port}/api/progress/${seriesA}`, token);
    assert.strictEqual(progressRead.data.lastResourceId, 'extra-b');

    const unsafeDelete = await requestJson(
      `http://127.0.0.1:${port}/api/resources/unsafe-resource`,
      token,
      { method: 'DELETE' }
    );
    assert.strictEqual(unsafeDelete.response.status, 403);
    await fs.stat(files.unsafe);

    const safeDelete = await requestJson(
      `http://127.0.0.1:${port}/api/resources/delete-me`,
      token,
      { method: 'DELETE' }
    );
    assert.strictEqual(safeDelete.response.ok, true, safeDelete.text);
    await assert.rejects(fs.stat(files.deletable), error => error.code === 'ENOENT');
    await fs.stat(files.extraB);

    console.log('work aggregation ok');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await fs.rm(runRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
