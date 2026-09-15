const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { prepareSettings, fixtureSource } = require('./settings-fixture');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(10); }
  throw new Error(message);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-scheduling-'));
  const library = path.join(root, 'library'); await fs.mkdir(library);
  process.env.DATA_DIR = path.join(root, 'data');
  prepareSettings({ dataRoot: process.env.DATA_DIR, sources: [fixtureSource(library, { autoScrape: true })] });
  for (const title of ['A', 'B', 'C', 'D', 'E', 'F']) await fs.writeFile(path.join(library, `[${title}作品][作者][Vol.01].epub`), 'fixture');
  const store = require('../lib/settingsStore');
  const { readLibraryIndexes } = require('../lib/metadataStore');
  const archive = require('../lib/archiveSource');
  const scrapeLog = require('../lib/scrapeLog');
  const originalLog = console.log;
  const contextLines = [];
  console.log = (...args) => { contextLines.push(args.join(' ')); originalLog(...args); };
  const calls = [];
  let active = 0, releaseAutomatically = false;
  const activeSeries = new Set();
  archive.scrapeSeries = (seriesId, options) => {
    scrapeLog.log(`调度上下文检查 ${seriesId}`);
    assert(!activeSeries.has(seriesId), 'one series must never scrape concurrently with itself');
    activeSeries.add(seriesId); active++;
    let resolve, reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const call = { seriesId, manual: options.manualTest === true, released: false, release(error) {
      if (this.released) return;
      this.released = true; active--; activeSeries.delete(seriesId);
      if (error) reject(error); else resolve({ seriesId });
    } };
    calls.push(call);
    if (releaseAutomatically) setImmediate(() => call.release());
    return pending;
  };
  archive.refreshLocalWorkGrouping = async () => {};
  archive.fallbackBangumiToLocalMode = async () => null;
  const queue = require('../lib/taskQueue');
  const saveLimit = async limit => { const draft = store.snapshot(); draft.scanning.scrapeConcurrency = limit; await store.save(draft); };
  const manual = seriesId => queue.enqueueTask('scrapeSeries', { seriesId, force: true, manualTest: true });
  const idle = () => queue.snapshot().every(task => !['running', 'queued'].includes(task.status));
  try {
    await saveLimit(1);
    const batch = await queue.enqueueTask('scanAndScrape', { fastScan: true, force: true });
    await until(() => calls.length === 1 && batch.progress.total === 6, 'batch did not start at one slot');
    await saveLimit(3);
    await until(() => calls.length === 3, 'raising the saved limit must fill slots without waiting for a completion');
    assert.equal(active, 3);
    const ids = (await readLibraryIndexes()).seriesIndex.filter(series => !calls.some(call => call.seriesId === series.seriesId)).map(series => series.seriesId);
    const firstManual = await manual(ids[0]);
    const secondManual = await manual(ids[1]);
    assert.equal((await manual(ids[0])).id, firstManual.id, 'repeated queued clicks are deduplicated');
    assert.equal(batch.progress.total, 4, 'priority requests replace their pending batch entries');
    calls[0].release();
    await until(() => calls.length === 4, 'manual job did not take the released slot');
    assert.equal(calls[3].seriesId, ids[0]); assert(calls[3].manual);
    calls[1].release();
    await until(() => calls.length === 5, 'second manual job did not run');
    assert.equal(calls[4].seriesId, ids[1]); assert(calls[4].manual);
    await saveLimit(1);
    calls[2].release(); await delay(60);
    assert.equal(calls.length, 5, 'lowering the limit preserves active jobs and starts no replacements');
    calls[3].release(); await delay(60);
    assert.equal(calls.length, 5, 'a remaining active job occupies the new one-slot limit');
    calls[4].release();
    await until(() => calls.length === 6, 'batch did not resume after the priority queue');
    assert.equal(calls[5].seriesId, ids[2]); assert(!calls[5].manual); assert.equal(active, 1);
    calls[5].release();
    await queue.waitForTask(batch); await queue.waitForTask(firstManual); await queue.waitForTask(secondManual);
    await until(idle, 'first batch remained active');
    assert.equal(batch.progress.completed, batch.progress.total);
    for (const id of ids.slice(0, 2)) assert.equal(calls.filter(call => call.seriesId === id).length, 1);

    const nextBatch = await queue.enqueueTask('scanAndScrape', { fastScan: true, force: true });
    await until(() => calls.length === 7 && nextBatch.progress.total === 6, 'second batch did not start');
    const same = await manual(calls[6].seriesId);
    const anotherId = (await readLibraryIndexes()).seriesIndex.find(series => series.seriesId !== calls[6].seriesId).seriesId;
    const another = await manual(anotherId);
    calls[6].release();
    await until(() => calls.length === 8, 'same-series rerun did not start after its in-flight scrape');
    assert.equal(calls[7].seriesId, calls[6].seriesId); assert(calls[7].manual);
    assert.equal((await manual(calls[7].seriesId)).id, same.id, 'repeated running clicks reuse the current manual task');
    calls[7].release(new Error('intentional priority failure'));
    await until(() => calls.length === 9, 'a failed priority job did not release its slot');
    assert.equal(calls[8].seriesId, anotherId); assert(calls[8].manual);
    releaseAutomatically = true; calls[8].release();
    await queue.waitForTask(nextBatch); await queue.waitForTask(another);
    assert.equal(same.status, 'failed');
    await until(idle, 'scheduler did not finish');
    assert.equal(active, 0);

    releaseAutomatically = false;
    const beforePause = calls.length;
    const pausedBatch = await queue.enqueueTask('scanAndScrape', { fastScan: true, force: true });
    await until(() => calls.length === beforePause + 1 && pausedBatch.progress.total === 6, 'third batch did not start');
    const newPath = path.join(library, '[监听插入][作者][Vol.01].epub');
    await fs.writeFile(newPath, 'new book');
    const local = await queue.enqueueTask('scanLibrary', { automatic: true, reason: 'watcher', fastScan: true, changedPaths: [newPath] });
    await delay(50);
    assert.equal(local.status, 'queued', 'local reconciliation must wait for in-flight metadata writes');
    calls[beforePause].release();
    await queue.waitForTask(local);
    assert((await readLibraryIndexes()).seriesIndex.some(series => series.title === '监听插入'));
    assert.equal(pausedBatch.status, 'running', 'new books become visible before the whole scrape queue finishes');
    await until(() => calls.length === beforePause + 2, 'paused batch did not resume after the local scan');
    releaseAutomatically = true; calls[beforePause + 1].release();
    await queue.waitForTask(pausedBatch);
    await until(idle, 'resumed batch did not finish');

    const automaticSettings = store.snapshot(); automaticSettings.sources[0].autoScrape = true; await store.save(automaticSettings);
    releaseAutomatically = false;
    const beforeAutomatic = calls.length;
    const automaticBatch = await queue.enqueueTask('scanAndScrape', { fastScan: true, automatic: true });
    await until(() => calls.length === beforeAutomatic + 1 && automaticBatch.progress.total === 7, 'automatic batch did not start');
    const latestPath = path.join(library, '[自动监听插入][作者][Vol.01].epub'); await fs.writeFile(latestPath, 'new auto book');
    const localScrape = await queue.enqueueTask('scanAndScrape', { automatic: true, reason: 'watcher', fastScan: true, changedPaths: [latestPath] });
    assert.notEqual(localScrape.id, automaticBatch.id, 'file changes during scraping must not wait as a trailing full-batch rerun');
    calls[beforeAutomatic].release();
    await until(() => calls.length === beforeAutomatic + 2, 'local scrape did not run between batch works');
    const latest = (await readLibraryIndexes()).seriesIndex.find(series => series.title === '自动监听插入');
    assert(latest); assert.equal(calls[beforeAutomatic + 1].seriesId, latest.seriesId);
    assert.equal(automaticBatch.status, 'running');
    releaseAutomatically = true; calls[beforeAutomatic + 1].release();
    await queue.waitForTask(localScrape); await queue.waitForTask(automaticBatch);
    await until(idle, 'nested automatic scan did not resume its parent');
    const resumedIds = calls.slice(beforeAutomatic + 2).map(call => call.seriesId);
    assert(resumedIds.length > 0);
    for (const id of resumedIds) {
      assert(contextLines.some(line => line.includes(`#${automaticBatch.id} scanAndScrape`) && line.endsWith(`调度上下文检查 ${id}`)),
        'resumed workers must log under their own batch, not the intervening scan');
    }
    console.log('Live scrape limits, shared slots, FIFO manual priority, batch replacement, same-series dedupe and failure recovery passed.');
  } finally {
    releaseAutomatically = true;
    for (const call of calls) call.release();
    await until(idle, 'cleanup scheduler timeout');
    console.log = originalLog;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
