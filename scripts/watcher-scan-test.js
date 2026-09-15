const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { prepareSettings, fixtureSource } = require('./settings-fixture');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-watcher-scan-'));
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  await fs.mkdir(a); await fs.mkdir(b);
  process.env.DATA_DIR = path.join(root, 'data');
  prepareSettings({ dataRoot: process.env.DATA_DIR, sources: [fixtureSource(a, { id: 'a' }), fixtureSource(b, { id: 'b' })] });
  const { scanLibrary } = require('../lib/scanner');
  const { readLibraryIndexes, readSeriesBundle } = require('../lib/metadataStore');
  const { onLibraryChanged } = require('../lib/libraryEvents');
  const write = async (relative, content = 'fixture') => {
    const target = path.join(a, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content); return target;
  };
  const scan = changedPaths => scanLibrary({ fast: true, concurrency: 2, changedPaths });
  const io = [];
  const originals = {};
  let failPath = '';
  try {
    const first = await write('[同名作品][作者][Vol.01].epub');
    const other = path.join(b, '[同名作品][作者][Vol.03].epub');
    await fs.writeFile(other, 'other source');
    const untouched = await write('不应重扫/Vol.01.epub');
    await write('comics/作品甲/Vol.01.epub');
    await write('comics/作品乙/Vol.01.epub');
    await scan();
    const baseline = await readLibraryIndexes();
    const unchangedId = Object.values(baseline.resourceIndex).find(r => r.sourcePath === untouched).seriesId;
    const unchangedBundle = await readSeriesBundle(unchangedId);
    for (const method of ['readdir', 'lstat', 'stat', 'readFile']) {
      originals[method] = fs[method];
      fs[method] = async (target, ...args) => {
        const absolute = path.resolve(String(target));
        if (absolute === a || absolute.startsWith(a + path.sep) || absolute === b || absolute.startsWith(b + path.sep)) io.push({ method, path: absolute });
        if (method === 'readdir' && absolute === failPath) throw Object.assign(new Error('simulated I/O failure'), { code: 'EIO' });
        return originals[method](target, ...args);
      };
    }
    const added = await write('[同名作品][作者][Vol.02].epub');
    const result = await scan([added]);
    assert.equal(result.addedVolumeResources.length, 1);
    assert.equal(result.resourceList.length, 3, 'same-title volumes from other files and sources survive');
    assert(!io.some(call => call.path === b || call.path.startsWith(b + path.sep)), 'no disk access to unrelated sources');
    assert(!io.some(call => call.method === 'readdir' && call.path === a), 'a flat addition never enumerates the library root');
    assert(!io.some(call => call.path.startsWith(path.dirname(untouched))), 'unrelated series is never traversed');
    assert.deepEqual(await readSeriesBundle(unchangedId), unchangedBundle, 'untouched metadata and timestamps stay identical');
    assert.equal(Object.keys((await readLibraryIndexes()).resourceIndex).length, 6);

    const events = [];
    const stop = onLibraryChanged(event => events.push(event));
    await scan([added, added]); stop();
    assert.equal(events.length, 0, 'duplicate/no-change events do not refresh or reorder the shelf');
    await fs.writeFile(added, 'changed file with a different length');
    await scan([added]);
    assert.equal(Object.values((await readLibraryIndexes()).resourceIndex).find(r => r.sourcePath === added).fileSize, 36);

    await fs.unlink(first);
    await scan([first]);
    const afterDelete = await readLibraryIndexes();
    assert(!Object.values(afterDelete.resourceIndex).some(r => r.sourcePath === first));
    const remaining = Object.values(afterDelete.resourceIndex).filter(r => r.seriesId === result.seriesList[0].seriesId);
    assert.equal(remaining.length, 2);
    assert((await readSeriesBundle(remaining[0].seriesId)).resources.some(r => r.sourcePath === other));

    const renamed = path.join(a, '[重命名作品][作者][Vol.01].epub');
    await fs.rename(added, renamed);
    await scan([added, renamed]);
    const renamedResource = Object.values((await readLibraryIndexes()).resourceIndex).find(r => r.sourcePath === renamed);
    assert(renamedResource);
    await fs.unlink(renamed); await scan([renamed]);
    assert(!(await readLibraryIndexes()).seriesIndex.some(s => s.seriesId === renamedResource.seriesId));
    assert.equal((await readSeriesBundle(renamedResource.seriesId)).resources.length, 0, 'deleted series cannot expose stale detail resources');

    const nested = await write('comics/作品甲/Vol.02.epub');
    io.length = 0; await scan([nested]);
    assert(!io.some(call => call.path.startsWith(path.join(a, 'comics/作品乙'))), 'mount changes scan only the affected work');
    assert(Object.values((await readLibraryIndexes()).resourceIndex).some(r => r.sourcePath === nested));
    await fs.rename(path.join(a, 'comics/作品甲'), path.join(a, 'comics/作品丙'));
    await scan([path.join(a, 'comics/作品甲'), path.join(a, 'comics/作品丙')]);
    assert(!Object.values((await readLibraryIndexes()).resourceIndex).some(r => r.sourcePath.includes('作品甲')));
    assert.equal(Object.values((await readLibraryIndexes()).resourceIndex).filter(r => r.sourcePath.includes('作品丙')).length, 2);

    const page = await write('图片系列/第1话/1.png');
    await scan([page]);
    const page2 = await write('图片系列/第1话/2.png');
    await scan([page2]);
    assert.equal(Object.values((await readLibraryIndexes()).resourceIndex).find(r => r.sourcePath === path.dirname(page)).pageCount, 2);
    await fs.rm(path.join(a, '图片系列'), { recursive: true }); await scan([path.join(a, '图片系列')]);
    assert(!Object.values((await readLibraryIndexes()).resourceIndex).some(r => r.sourcePath.includes('图片系列')));

    const beforeFailure = await readLibraryIndexes();
    const newFile = await write('新增但未提交.epub');
    failPath = path.dirname(untouched);
    await assert.rejects(scan([newFile, failPath]), error => error.code === 'SCAN_INCOMPLETE');
    const afterFailure = await readLibraryIndexes();
    for (const [id, resource] of Object.entries(beforeFailure.resourceIndex)) assert.deepEqual(afterFailure.resourceIndex[id], resource,
      'a failed local batch retains all previously indexed resources');
    failPath = '';
    await fs.rename(a, a + '-offline');
    await scan([newFile, first]);
    assert.deepEqual(await readLibraryIndexes(), afterFailure, 'offline source events cannot remove its books');
    await fs.rename(a + '-offline', a);
    await scan([a]);
    assert(Object.values((await readLibraryIndexes()).resourceIndex).some(r => r.sourcePath === newFile), 'reconnect reconciles only the restored source');
    const beforeOutside = await readLibraryIndexes();
    await scan([path.join(root, 'outside.epub')]);
    assert.deepEqual(await readLibraryIndexes(), beforeOutside, 'out-of-source events do not turn into a full scan');
    console.log('Watcher-scoped add/change/delete/rename, shared series, mounts, images, no-op, failure and reconnect passed.');
  } finally {
    for (const [method, original] of Object.entries(originals)) fs[method] = original;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
