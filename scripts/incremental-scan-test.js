const { prepareSettings } = require('./settings-fixture');
const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

async function main() {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-plus-delta-'));
  const libraryRoot = path.join(runRoot, 'library');
  const dataRoot = path.join(runRoot, 'data');
  await fs.mkdir(libraryRoot, { recursive: true });

  process.env.DATA_DIR = dataRoot;
  prepareSettings({ dataRoot, libraryRoot, username: 'admin', password: 'admin' });

  const { scanLibrary } = require('../lib/scanner');
  const {
    makeSeriesId,
    readIndex,
    readSeriesBundle,
    updateBangumi,
    upsertSeriesIndexes,
    writeSeriesFromScanItem,
    writeIndex,
    writeSeriesBundle,
  } = require('../lib/metadataStore');
  const { onLibraryChanged } = require('../lib/libraryEvents');

  const writeFixture = (name, marker) =>
    fs.writeFile(path.join(libraryRoot, name), `fast-scan fixture: ${marker}`);
  const readSeriesIndex = () => readIndex('series-index.json', []);
  const readResourceIndex = () => readIndex('resource-index.json', {});

  try {
    const staleLegacyDir = path.join(libraryRoot, '旧版元数据缺失分组');
    await fs.mkdir(staleLegacyDir, { recursive: true });
    await fs.writeFile(path.join(staleLegacyDir, '元数据.json'), JSON.stringify({
      comic: {
        name: '旧版元数据缺失分组',
        groups: {
          stale: [{
            groupName: '其它汉化版',
            order: 1,
            chapterTitle: '已删除章节',
          }],
        },
      },
    }));

    await writeFixture('[系列甲][作者甲][Vol.01].epub', 'series-a-volume-1');
    await writeFixture('[系列乙][作者乙][Vol.01].epub', 'series-b-volume-1');
    await scanLibrary({ fast: true, concurrency: 1 });

    const baselineSeries = await readSeriesIndex();
    const baselineResources = await readResourceIndex();
    assert.strictEqual(baselineSeries.length, 2, 'baseline should contain two series');
    assert.strictEqual(Object.keys(baselineResources).length, 2, 'baseline should contain two resources');

    const noChangeEvents = [];
    const stopNoChangeEvents = onLibraryChanged(event => noChangeEvents.push(event));
    let noChangeDiscoveries = 0;
    await scanLibrary({
      fast: true,
      concurrency: 2,
      persistOnDiscover: true,
      onSeriesDiscovered() {
        noChangeDiscoveries += 1;
      },
    });
    stopNoChangeEvents();

    const unchangedSeries = await readSeriesIndex();
    assert.strictEqual(noChangeDiscoveries, 0, 'unchanged series must not be published as discoveries');
    assert.deepStrictEqual(noChangeEvents, [], 'unchanged scan must not emit library changes');
    assert.deepStrictEqual(unchangedSeries, baselineSeries, 'unchanged scan must preserve order and timestamps');

    await writeIndex('subject-index.json', [{ subjectId: 1, seriesId: 'stale', title: 'stale' }]);
    await scanLibrary({ fast: true, concurrency: 1 });
    assert.deepStrictEqual(await readIndex('subject-index.json', []), [],
      'a no-change scan should repair a stale derived index');

    const offlineRoot = `${libraryRoot}-offline`;
    await fs.rename(libraryRoot, offlineRoot);
    const offlineScan = await scanLibrary({ fast: true, concurrency: 1 });
    assert.deepStrictEqual(offlineScan.offlineSourceIds, ['fixture-source'],
      'an unavailable source must be reported without publishing removals');
    assert.deepStrictEqual(await readSeriesIndex(), baselineSeries,
      'an unavailable library root must preserve the current index');
    await fs.rename(offlineRoot, libraryRoot);

    await writeFixture('[新增系列][作者丙][Vol.01].epub', 'new-series-volume-1');
    const oldSeriesById = new Map(baselineSeries.map(series => [series.seriesId, series]));
    const discoverySnapshots = [];
    await scanLibrary({
      fast: true,
      concurrency: 2,
      persistOnDiscover: true,
      async onSeriesDiscovered(discovered) {
        const seriesIndex = await readSeriesIndex();
        const resourceIndex = await readResourceIndex();
        discoverySnapshots.push({ discovered, seriesIndex, resourceIndex });
      },
    });

    assert.strictEqual(discoverySnapshots.length, 1, 'adding one series should publish one discovery');
    assert.strictEqual(discoverySnapshots[0].discovered.series.title, '新增系列');
    assert(discoverySnapshots[0].seriesIndex.some(series =>
      series.seriesId === discoverySnapshots[0].discovered.seriesId
    ), 'a complete new discovery must appear before the full scan finishes');
    for (const oldId of oldSeriesById.keys()) {
      assert(discoverySnapshots[0].seriesIndex.some(series => series.seriesId === oldId),
        `old series ${oldId} must remain visible during discovery`);
    }
    for (const oldResourceId of Object.keys(baselineResources)) {
      assert(discoverySnapshots[0].resourceIndex[oldResourceId],
        `old resource ${oldResourceId} must remain visible during discovery`);
    }

    const afterAddSeries = await readSeriesIndex();
    const afterAddResources = await readResourceIndex();
    assert.strictEqual(afterAddSeries.length, baselineSeries.length + 1, 'final index should add one series');
    assert.strictEqual(Object.keys(afterAddResources).length, Object.keys(baselineResources).length + 1,
      'final index should add exactly one resource');
    for (const baselineResourceId of Object.keys(baselineResources)) {
      assert(afterAddResources[baselineResourceId],
        `final index must retain baseline resource ${baselineResourceId}`);
    }
    const addedResourceIds = Object.keys(afterAddResources)
      .filter(resourceId => !baselineResources[resourceId]);
    assert.strictEqual(addedResourceIds.length, 1);
    assert.strictEqual(
      afterAddResources[addedResourceIds[0]].seriesId,
      discoverySnapshots[0].discovered.seriesId,
      'the only new resource must belong to the discovered series'
    );
    assert.deepStrictEqual(
      afterAddSeries.slice(0, baselineSeries.length).map(series => series.seriesId),
      baselineSeries.map(series => series.seriesId),
      'existing series order must remain stable'
    );
    for (const [seriesId, before] of oldSeriesById) {
      const after = afterAddSeries.find(series => series.seriesId === seriesId);
      assert.strictEqual(after.updatedAt, before.updatedAt, `old series ${seriesId} timestamp must stay stable`);
    }

    const beforeVolumeSeries = await readSeriesIndex();
    const beforeVolumeResources = await readResourceIndex();
    await writeFixture('[系列甲][作者甲][Vol.02].epub', 'series-a-volume-2');
    let existingSeriesDiscoveries = 0;
    const volumeScanResult = await scanLibrary({
      fast: true,
      concurrency: 2,
      persistOnDiscover: true,
      onSeriesDiscovered() {
        existingSeriesDiscoveries += 1;
      },
    });

    const afterVolumeSeries = await readSeriesIndex();
    const afterVolumeResources = await readResourceIndex();
    assert.strictEqual(existingSeriesDiscoveries, 0, 'adding a volume must not republish the existing series');
    assert.deepStrictEqual(
      afterVolumeSeries.map(series => series.seriesId),
      beforeVolumeSeries.map(series => series.seriesId),
      'adding a volume must preserve series order'
    );
    assert.strictEqual(
      Object.keys(afterVolumeResources).length,
      Object.keys(beforeVolumeResources).length + 1,
      'adding a volume should add exactly one resource'
    );
    assert.strictEqual(volumeScanResult.addedVolumeResources.length, 1,
      'scan result should expose the new volume added to an existing series');
    assert.strictEqual(volumeScanResult.addedVolumeResources[0].seriesId,
      beforeVolumeSeries.find(series => series.title === '系列甲').seriesId);
    assert.strictEqual(volumeScanResult.addedVolumeResources[0].detectedNumber, 2);
    for (const resourceId of Object.keys(beforeVolumeResources)) {
      assert(afterVolumeResources[resourceId], `old resource ${resourceId} must remain indexed`);
    }

    const changedResourceBefore = Object.values(afterVolumeResources)
      .find(resource => resource.relativePath === '[系列甲][作者甲][Vol.01].epub');
    assert(changedResourceBefore?.firstIndexedAt, 'scanned resources should persist firstIndexedAt');
    await writeFixture('[系列甲][作者甲][Vol.01].epub', 'series-a-volume-1-updated');
    await scanLibrary({ fast: true, concurrency: 1 });
    const changedResourceAfter = (await readResourceIndex())[changedResourceBefore.resourceId];
    assert.strictEqual(changedResourceAfter.firstIndexedAt, changedResourceBefore.firstIndexedAt,
      'resource content changes must not reset firstIndexedAt');
    assert.notStrictEqual(changedResourceAfter.fileHash, changedResourceBefore.fileHash,
      'the firstIndexedAt assertion must cover a real resource update');

    const beforeDeletionSeries = await readSeriesIndex();
    const beforeDeletionResources = await readResourceIndex();
    const deletedSeries = beforeDeletionSeries.find(series => series.title === '新增系列');
    const deletedResourceIds = Object.values(beforeDeletionResources)
      .filter(resource => resource.seriesId === deletedSeries.seriesId)
      .map(resource => resource.resourceId);
    await fs.unlink(path.join(libraryRoot, '[新增系列][作者丙][Vol.01].epub'));
    let deletionDiscoveries = 0;
    await scanLibrary({
      fast: true,
      concurrency: 2,
      persistOnDiscover: true,
      onSeriesDiscovered() {
        deletionDiscoveries += 1;
      },
    });
    const afterDeletionSeries = await readSeriesIndex();
    const afterDeletionResources = await readResourceIndex();
    assert.strictEqual(deletionDiscoveries, 0, 'a deletion must not be reported as a discovery');
    assert(!afterDeletionSeries.some(series => series.seriesId === deletedSeries.seriesId),
      'the authoritative final scan should remove the deleted series');
    assert.deepStrictEqual(
      afterDeletionSeries.map(series => series.seriesId),
      beforeDeletionSeries.filter(series => series.seriesId !== deletedSeries.seriesId).map(series => series.seriesId),
      'a real deletion should remove exactly one series without reordering the rest'
    );
    for (const deletedResourceId of deletedResourceIds) {
      assert(!afterDeletionResources[deletedResourceId],
        `deleted resource ${deletedResourceId} must be removed`);
    }
    for (const [resourceId, resource] of Object.entries(beforeDeletionResources)) {
      if (resource.seriesId === deletedSeries.seriesId) continue;
      assert(afterDeletionResources[resourceId], `unrelated resource ${resourceId} must remain indexed`);
    }

    const beforeFailedScanSeries = await readSeriesIndex();
    const beforeFailedScanResources = await readResourceIndex();
    const failedSeriesFile = path.join(libraryRoot, '[失败扫描新增][作者丁][Vol.01].epub');
    const brokenDirectory = path.join(libraryRoot, 'zzz-unreadable-directory');
    await fs.writeFile(failedSeriesFile, 'must not be partially committed');
    await fs.mkdir(brokenDirectory);
    const originalReaddir = fs.readdir;
    fs.readdir = async (target, ...args) => {
      if (path.resolve(target) === brokenDirectory) throw Object.assign(new Error('simulated NAS I/O failure'), { code: 'EIO' });
      return originalReaddir(target, ...args);
    };
    let failedScanDiscoveries = 0;
    try { await assert.rejects(
      () => scanLibrary({
        fast: true,
        concurrency: 1,
        persistOnDiscover: true,
        onSeriesDiscovered() {
          failedScanDiscoveries += 1;
        },
      }),
      error => error?.code === 'SCAN_INCOMPLETE' &&
        error.message.includes('EIO') &&
        error.message.includes(brokenDirectory),
      'a real traversal error should fail with its code and full path'
    ); } finally { fs.readdir = originalReaddir; }
    assert.strictEqual(failedScanDiscoveries, 1,
      'the failed scan should still report the discovered series for progress');
    const failedSeriesIndex = await readSeriesIndex(), failedResourceIndex = await readResourceIndex();
    for (const series of beforeFailedScanSeries) assert.deepStrictEqual(failedSeriesIndex.find(s => s.seriesId === series.seriesId), series,
      'a failed scan must preserve existing works');
    for (const [id, resource] of Object.entries(beforeFailedScanResources)) assert.deepStrictEqual(failedResourceIndex[id], resource,
      'a failed scan must preserve existing resources');
    assert(Object.values(failedResourceIndex).some(resource => resource.sourcePath === failedSeriesFile),
      'already completed new discoveries remain visible even if a later folder fails');
    await fs.unlink(failedSeriesFile);
    await fs.rmdir(brokenDirectory);

    const seriesA = afterVolumeSeries.find(series => series.title === '系列甲');
    const concurrentSeriesId = makeSeriesId('novel:并发新增系列');
    const concurrentResource = {
      schemaVersion: 1,
      resourceId: 'concurrent-new-resource',
      seriesId: concurrentSeriesId,
      type: 'epub',
      category: 'novel',
      contentType: 'volume',
      sourcePath: path.join(libraryRoot, 'concurrent-new.epub'),
      relativePath: 'concurrent-new.epub',
      title: 'Vol.01',
      pageCount: 0,
      readable: true,
      lastIndexedAt: new Date().toISOString(),
    };
    const concurrentSeries = await writeSeriesBundle({
      schemaVersion: 1,
      seriesId: concurrentSeriesId,
      title: '并发新增系列',
      titleNormalized: '并发新增系列',
      alternateTitles: [],
      authors: ['并发作者'],
      publishers: [],
      tags: [],
      cover: '',
      category: 'novel',
      contentMode: 'volume',
      hasVolumes: true,
      hasChapters: false,
      hasMixedResources: false,
      latestAddedAt: '',
      source: 'test',
    }, [concurrentResource]);

    await Promise.all([
      upsertSeriesIndexes(concurrentSeries, [concurrentResource]),
      updateBangumi(seriesA.seriesId, {
        bangumi: {
          subjectId: 424242,
          name: '系列甲',
          name_cn: '系列甲',
          authors: ['作者甲'],
          tags: [],
          metaTags: [],
        },
        brief: '并发索引更新测试',
      }),
    ]);

    const afterConcurrentUpdates = await readSeriesIndex();
    const afterConcurrentResources = await readResourceIndex();
    assert(afterConcurrentUpdates.some(series => series.seriesId === seriesA.seriesId),
      'metadata update must retain the existing series');
    assert(afterConcurrentUpdates.some(series => series.seriesId === concurrentSeriesId),
      'concurrent metadata update must not overwrite the newly inserted series');
    assert.strictEqual(
      afterConcurrentUpdates.find(series => series.seriesId === seriesA.seriesId).bangumiSubjectId,
      424242,
      'the concurrent metadata update must be committed'
    );
    assert(afterConcurrentResources[concurrentResource.resourceId],
      'the concurrent resource insertion must be committed');
    for (const resourceId of Object.keys(afterDeletionResources)) {
      assert(afterConcurrentResources[resourceId], `concurrent updates must retain old resource ${resourceId}`);
    }

    const latestSeriesABundle = await readSeriesBundle(seriesA.seriesId);
    const lockedNewResource = {
      ...latestSeriesABundle.resources[0],
      resourceId: 'series-a-locked-volume-3',
      sourcePath: path.join(libraryRoot, '[系列甲][作者甲][Vol.03].epub'),
      relativePath: '[系列甲][作者甲][Vol.03].epub',
      title: 'Vol.03',
      detectedNumber: 3,
      detectedNumberEnd: 3,
      volumeNumber: 3,
      fileHash: 'locked-volume-3',
      lastIndexedAt: new Date().toISOString(),
    };
    await Promise.all([
      writeSeriesFromScanItem({
        series: { ...latestSeriesABundle.series },
        resources: [...latestSeriesABundle.resources, lockedNewResource],
      }),
      updateBangumi(seriesA.seriesId, {
        bangumi: {
          subjectId: 434343,
          name: '系列甲',
          name_cn: '系列甲',
          authors: ['作者甲'],
          tags: [],
          metaTags: [],
        },
        brief: '同系列串行更新测试',
      }),
    ]);
    const lockedBundle = await readSeriesBundle(seriesA.seriesId);
    const lockedResourceIndex = await readResourceIndex();
    assert(lockedBundle.resources.some(resource => resource.resourceId === lockedNewResource.resourceId),
      'metadata updates must not overwrite a resource added by the preceding scan commit');
    assert(lockedResourceIndex[lockedNewResource.resourceId],
      'the global resource index must retain the newly added resource');
    assert.strictEqual(lockedBundle.bangumi.subjectId, 434343,
      'the queued metadata update must still be applied');

    const windDir = path.join(
      libraryRoot,
      '[WIND BREAKER 防风铃][二位悟][Vol.01-Vol.26][未完][bili]'
    );
    await fs.mkdir(windDir, { recursive: true });
    await fs.writeFile(path.join(windDir, 'WIND BREAKER 防风铃 Vol.19.zip'), 'volume-19');
    await scanLibrary({ fast: true, concurrency: 2 });
    let windSeries = (await readSeriesIndex()).find(series => series.title === 'WIND BREAKER 防风铃');
    let windResources = Object.values(await readResourceIndex())
      .filter(resource => resource.seriesId === windSeries?.seriesId);
    assert.strictEqual(windResources.length, 1, 'the initial partial copy should contain one visible volume');

    for (let volume = 1; volume <= 26; volume += 1) {
      if (volume === 19) continue;
      const padded = String(volume).padStart(2, '0');
      await fs.writeFile(
        path.join(windDir, `WIND BREAKER 防风铃 Vol.${padded}.zip`),
        `volume-${padded}`
      );
    }
    await scanLibrary({ fast: true, concurrency: 2 });
    windSeries = (await readSeriesIndex()).find(series => series.title === 'WIND BREAKER 防风铃');
    windResources = Object.values(await readResourceIndex())
      .filter(resource => resource.seriesId === windSeries?.seriesId);
    assert.strictEqual(windResources.length, 26,
      'a successful rescan must expand an existing series from one volume to all 26 volumes');
    assert.deepStrictEqual(
      windResources.map(resource => resource.detectedNumber).sort((a, b) => a - b),
      Array.from({ length: 26 }, (_, index) => index + 1),
      'all volume numbers from 1 through 26 must remain distinct'
    );

    console.log('incremental scan ok');
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
