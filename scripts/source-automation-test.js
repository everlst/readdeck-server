const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { prepareSettings, fixtureSource } = require('./settings-fixture');

async function main() {
  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-plus-auto-'));
  let release;
  try {
    const sources = ['enabled', 'manual-only', 'offline'].map(id => fixtureSource(path.join(run, id), { id, autoScrape: id !== 'manual-only' }));
    await fs.mkdir(sources[0].path); await fs.mkdir(sources[1].path);
    process.env.DATA_DIR = path.join(run, 'data');
    prepareSettings({ dataRoot: process.env.DATA_DIR, sources });
    const store = require('../lib/settingsStore');
    const { resourcesForScrape } = require('../lib/automaticSources');
    const resources = sources.map(source => ({ resourceId: source.id, sourceId: source.id }));
    assert.deepEqual(await resourcesForScrape(resources, { automatic: true }), [resources[0]]);
    assert.deepEqual(await resourcesForScrape(resources, { automatic: true, sourceIds: ['manual-only'] }), []);
    assert.deepEqual(await resourcesForScrape(resources, { automatic: false }), resources, 'manual scrape ignores auto switches');
    assert.deepEqual(await resourcesForScrape(resources, { automatic: false, respectAutoScrape: true }), [resources[0]], 'button-triggered batches respect source switches');
    await fs.writeFile(path.join(sources[0].path, '[同名作品][作者][Vol.01].epub'), 'fixture');
    await fs.writeFile(path.join(sources[1].path, '[同名作品][作者][Vol.02].epub'), 'fixture');
    await fs.writeFile(path.join(sources[1].path, '[关闭来源独有作品][作者][Vol.01].epub'), 'fixture');
    const scanner = require('../lib/scanner');
    const scan = scanner.scanLibrary;
    let entered;
    const entry = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let paused = true;
    scanner.scanLibrary = async options => {
      if (paused) { paused = false; entered(); await gate; }
      return scan(options);
    };
    // Stub only the external-metadata boundary. Scanning, indexing, queue and source filtering remain real.
    const archive = require('../lib/archiveSource');
    const { readSeriesBundle } = require('../lib/metadataStore');
    const scraped = [];
    archive.scrapeSeries = async (id, options) => {
      const bundle = await readSeriesBundle(id);
      scraped.push({ seriesId: id, automatic: !!options.automatic, resources: await resourcesForScrape(bundle.resources, options) });
      return { seriesId: id };
    };
    archive.refreshLocalWorkGrouping = async () => {};
    const queue = require('../lib/taskQueue');
    const automatic = await queue.enqueueTask('scanAndScrape', { automatic: true, reason: 'watcher', sourceIds: ['enabled'] });
    await entry;
    const pendingSettings = store.snapshot();
    pendingSettings.sources[0].enabled = false;
    await assert.rejects(() => store.save(pendingSettings), e => e.status === 409);
    const display = store.snapshot(); display.sources[0].name = '正在运行时改名';
    await store.save(display);
    const changedA = path.join(sources[0].path, '[同名作品][作者][Vol.01].epub');
    const changedB = path.join(sources[1].path, '[同名作品][作者][Vol.02].epub');
    const reused = await queue.enqueueTask('scanAndScrape', { automatic: true, reason: 'watcher', sourceIds: ['enabled'], changedPaths: [changedA] });
    assert.equal(reused.id, automatic.id);
    await queue.enqueueTask('scanAndScrape', { automatic: true, reason: 'watcher', sourceIds: ['manual-only'], changedPaths: [changedB] });
    assert.deepEqual(new Set(automatic.rerunPayload.sourceIds), new Set(['enabled', 'manual-only']), 'trailing watcher events are combined');
    assert.deepEqual(new Set(automatic.rerunPayload.changedPaths), new Set([changedA, changedB]), 'trailing changes retain both paths');
    const manual = await queue.enqueueTask('scanAndScrape', { automatic: false, reason: 'manual', confirmSettings: true });
    assert.notEqual(manual.id, automatic.id, 'manual confirmation is not swallowed by automatic task dedupe');
    release();
    await queue.waitForTask(automatic);
    await queue.waitForTask(manual);
    for (;;) {
      const active = queue.snapshot().filter(t => ['queued', 'running'].includes(t.status));
      if (!active.length) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(scraped.some(item => item.automatic && item.resources.length === 1 && item.resources[0].sourceId === 'enabled'));
    assert(scraped.some(item => !item.automatic && item.resources.length === 1), 'manual batch still runs enabled sources');
    assert(scraped.every(item => item.resources.length && item.resources.every(r => r.sourceId === 'enabled')), 'all batches exclude disabled sources, including shared works');
    assert.equal(manual.payload.automatic, false, 'source filtering does not change manual scheduling or settings confirmation');
    assert.equal(manual.progress.total, 1);
    assert.equal(manual.progress.skipped, 1);

    const forced = await queue.enqueueTask('scanAndScrape', { automatic: false, force: true, respectAutoScrape: false });
    await queue.waitForTask(forced);
    assert.equal(forced.progress.total, 1, 'force refresh cannot override batch source exclusions');
    assert(scraped.every(item => item.resources.every(r => r.sourceId === 'enabled')));

    const { readLibraryIndexes } = require('../lib/metadataStore');
    const resourceIndex = Object.values((await readLibraryIndexes()).resourceIndex);
    const disabledOnly = resourceIndex.find(r => r.sourceId === 'manual-only' && !resourceIndex.some(other => other.seriesId === r.seriesId && other.sourceId === 'enabled'));
    assert(disabledOnly, 'excluded books remain scanned and indexed');
    const single = await queue.enqueueTask('scrapeSeries', { seriesId: disabledOnly.seriesId, force: true });
    await queue.waitForTask(single);
    assert.equal(scraped.at(-1).seriesId, disabledOnly.seriesId);
    assert.equal(scraped.at(-1).resources[0].sourceId, 'manual-only', 'explicit single-work rescrape remains available');

    const disabled = store.snapshot(); disabled.sources[0].autoScrape = false; await store.save(disabled);
    const callCount = scraped.length;
    const empty = await queue.enqueueTask('scanAndScrape', { automatic: false });
    await queue.waitForTask(empty);
    assert.equal(empty.progress.total, 0);
    assert.equal(scraped.length, callCount, 'all sources disabled means no metadata requests');
    console.log('batch source filtering, shared works, force exclusions, explicit single-work override, busy topology and task dedupe ok');
  } finally {
    release?.();
    await fs.rm(run, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
