const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-resource-progress-'));
  const originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = root;
  const store = require('../lib/progressStore');
  const stamp = second => ({ readAt: `2025-01-01T00:00:${String(second).padStart(2, '0')}.000Z`, deviceId: 'web', sequence: second });
  const write = (resourceId, page, second, patch = {}) => store.save('alice', 'series', {
    chapterUuid: 'shared-volume', chapterTitle: '第一卷', groupName: '单行本',
    resourceId, resourceType: 'cbz', page, ...stamp(second), ...patch,
  });
  try {
    await write('source-a', 80, 1);
    await write('source-b', 7, 2);
    let progress = (await store.read('alice')).series;
    assert.equal(progress.chapters['shared-volume'].resourceId, 'source-b');
    assert.equal(store.forResource(progress, 'source-a').lastPage, 80);
    assert.equal(store.forResource(progress, 'source-b').lastPage, 7);
    assert.equal(store.forResource(progress, 'source-a').chapters['shared-volume'].page, 80);
    assert.deepEqual(Object.keys(store.forResource(progress, 'source-a').resources), ['source-a']);
    assert.deepEqual(store.forResource(progress, 'missing'), {});
    assert.deepEqual(store.forResource(progress, 'toString'), {});
    assert.deepEqual(await store.read('bob'), {}, 'accounts remain isolated');

    await write('source-a', 81, 3);
    assert.equal((await write('source-a', 1, 1)).applied, false);
    assert.equal((await write('source-a', 0, 3)).applied, false, 'duplicate stamps are idempotent');
    progress = (await store.read('alice')).series;
    assert.equal(store.forResource(progress, 'source-a').lastPage, 81);
    assert.equal(store.forResource(progress, 'source-b').lastPage, 7);
    assert.equal(progress.lastResourceId, 'source-a');

    await write('epub-a', 2, 4, { resourceType: 'epub', cfi: 'epubcfi(/6/4)', scrollPercent: 25 });
    await write('epub-b', 5, 5, { resourceType: 'epub', cfi: 'epubcfi(/6/10)', scrollPercent: 60 });
    progress = (await store.read('alice')).series;
    assert.equal(store.forResource(progress, 'epub-a').lastCfi, 'epubcfi(/6/4)');
    assert.equal(store.forResource(progress, 'epub-b').lastCfi, 'epubcfi(/6/10)');
    assert.equal(store.forResource(progress, 'epub-a').lastScrollPercent, 25);
    const resourceOnly = await write('source-b', 8, 4);
    assert.equal(resourceOnly.applied, false, 'older than work summary still updates its resource');
    assert.equal(store.forResource(resourceOnly.progress, 'source-b').lastPage, 8);
    assert.equal(resourceOnly.progress.lastResourceId, 'epub-b');

    const oldProgress = {
      ...stamp(6), updatedAt: stamp(6).readAt,
      lastChapterUuid: 'shared-volume', lastChapterTitle: '旧版第一卷', lastGroupName: '单行本',
      lastResourceId: 'old-a', lastPage: 45, lastResourceType: 'cbz',
      chapters: {
        'shared-volume': { resourceId: 'old-a', page: 45, updatedAt: stamp(6).readAt, ...stamp(6) },
        earlier: { resourceId: 'old-b', page: 12, updatedAt: stamp(2).readAt },
        unrelated: { page: 9, updatedAt: stamp(1).readAt },
      },
    };
    const target = path.join(root, 'users', 'alice', 'progress.json');
    await fs.writeFile(target, JSON.stringify({ series: oldProgress }));
    await write('new-c', 3, 7);
    progress = (await store.read('alice')).series;
    assert.equal(progress.resources['old-a'].page, 45, 'first new save migrates old resource positions');
    assert.equal(progress.resources['old-b'].page, 12);
    assert.equal(progress.resources['old-a'].chapterTitle, '旧版第一卷');
    assert.equal(progress.resources['old-a'].seriesId, 'series');
    const restored = store.forResource(progress, 'old-a');
    assert.deepEqual(Object.keys(restored.chapters), ['shared-volume']);
    assert.equal(restored.lastPage, 45);
    assert.equal(progress.chapters.unrelated.page, 9, 'resource-less legacy history stays intact');
    assert.equal(store.resourceEntries({ ...oldProgress, chapters: {} })['old-a'].page, 45, 'top-level legacy records migrate');

    await store.save('alice', 'legacy', { chapterUuid: 'legacy-chapter', page: 8, ...stamp(8) });
    const legacy = (await store.read('alice')).legacy;
    assert.equal(legacy.lastPage, 8);
    assert.equal(legacy.chapters['legacy-chapter'].page, 8);
    assert.deepEqual(legacy.resources, {});
    assert.deepEqual(store.forResource(legacy, 'anything'), {});
    for (const resourceId of ['__proto__', 'constructor', 'prototype', 42, 'x'.repeat(513)]) {
      await assert.rejects(write(resourceId, 0, 9), error => error.status === 400);
    }

    const newerChapter = { resourceId: 'old-a', page: 49, ...stamp(10) };
    const mixed = { ...oldProgress, resources: { 'old-a': { resourceId: 'old-a', page: 46, chapterUuid: 'resource-entry', ...stamp(9) } },
      chapters: { ...oldProgress.chapters, newer: newerChapter } };
    assert.equal(store.resourceEntries(mixed)['old-a'].page, 49, 'merge takes newest timestamp across every storage shape');
    assert.equal(store.forResource(mixed, 'old-a').lastChapterUuid, 'newer');
    assert.equal(Object.values(store.forResource(mixed, 'old-a').chapters).every(entry => entry.resourceId === 'old-a'), true);
    console.log('resource progress ok: independent versions, shared UUID, EPUB CFI, legacy migration, ordering and account isolation');
  } finally {
    if (originalDataDir == null) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
