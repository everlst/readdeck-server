const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareSettings, fixtureSource } = require('./settings-fixture');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-scrape-log-'));
  process.env.DATA_DIR = root;
  const libraryRoot = path.join(root, 'library'); await fs.mkdir(libraryRoot);
  prepareSettings({ dataRoot: root, sources: [fixtureSource(libraryRoot, { autoScrape: true })] });
  const metadata = require('../lib/metadataStore');
  const log = require('../lib/scrapeLog');
  const archive = require('../lib/archiveSource');
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  let queue;
  try {
    const seriesList = [], resourceList = [];
    for (const id of ['success', 'fallback', 'failure', 'skipped', 'protected']) {
      const series = { seriesId: id, title: `显示书名-${id}`, category: 'comic' };
      const resources = [{ seriesId: id, resourceId: `resource-${id}`, sourceId: 'fixture-source', type: 'directory', contentType: 'chapter',
        relativePath: `原始文件夹-${id}/第1话`, seriesRelativePath: `原始文件夹-${id}` }];
      await metadata.writeSeriesBundle(series, resources);
      if (id === 'protected') await metadata.updateSeriesOverrides(id, { bangumiScrapeCompletedAt: new Date().toISOString() });
      seriesList.push(series); resourceList.push(...resources);
    }
    require('../lib/scanner').scanLibrary = async () => ({ seriesList, resourceList });
    archive.refreshLocalWorkGrouping = async () => {};
    archive.fallbackBangumiToLocalMode = async () => null;
    archive.scrapeSeries = async seriesId => {
      await new Promise(resolve => setTimeout(resolve, seriesId === 'success' ? 30 : 5));
      log.log(`步骤完成-${seriesId}`);
      if (seriesId === 'failure') throw new Error('BGM HTTP 503\nupstream failed sk-fixture-secret');
      if (seriesId === 'fallback') {
        const bundle = await metadata.readSeriesBundle(seriesId);
        await metadata.writeSeriesBundle({ ...bundle.series, title: '回退后新书名' }, bundle.resources);
        return { bangumi: { matchedBy: 'local_metadata_fallback', fallbackReason: '未找到 Bangumi 匹配' } };
      }
      if (seriesId === 'skipped') return { skipped: true, reason: '来源已禁用' };
      return { seriesId, bangumi: { subjectId: 123 } };
    };
    for (const level of Object.keys(originals)) console[level] = line => lines.push(String(line));
    queue = require('../lib/taskQueue');
    assert.equal(require('../lib/debugLog').isEnabled(), false);
    const batch = await queue.enqueueTask('scanAndScrape');
    await queue.waitForTask(batch);
    assert.equal(batch.progress.total, 4);
    assert.equal(batch.progress.completed, 4);
    assert.equal(batch.progress.success, 1);
    assert.equal(batch.progress.failed, 2);
    assert.equal(batch.progress.skipped, 2);
    assert(lines.some(line => line.includes(`#${batch.id}`) && line.includes('成功 1 本，失败 2 本，跳过 2 本')));
    for (const id of ['success', 'fallback', 'failure', 'skipped']) {
      const step = lines.find(line => line.includes(`步骤完成-${id}`));
      assert(step.includes(`作品="显示书名-${id}"`) && step.includes(`原始文件夹-${id}`) && step.includes(`#${batch.id} scanAndScrape`), step);
    }
    const failures = lines.filter(line => line.includes('失败清单:'));
    assert.equal(failures.length, 2);
    for (const id of ['fallback', 'failure']) assert(failures.some(line => line.includes(`原始文件夹-${id}`)));
    assert(failures.some(line => line.includes('显示书名-fallback')), 'summary retains the name before fallback');
    assert(lines.every(line => !/[\r\n]/.test(line)), 'each event occupies one physical line');
    assert(!lines.join('\n').includes('sk-fixture-secret'));
    const saved = await metadata.readIndex('task-state.json', []);
    assert.equal(saved[0].progress.failedSeries.length, 2);
    const snapshot = queue.snapshot(); snapshot[0].progress.failedSeries[0].originalPaths.push('mutated');
    assert(!queue.snapshot()[0].progress.failedSeries[0].originalPaths.includes('mutated'));

    lines.length = 0;
    const single = await queue.enqueueTask('scrapeSeries', { seriesId: 'failure', force: true });
    await assert.rejects(queue.waitForTask(single), /BGM HTTP 503/);
    assert(lines.some(line => line.includes('成功 0 本，失败 1 本')));
    assert(lines.some(line => line.includes('失败清单:') && line.includes(`#${single.id}`) && line.includes('原始文件夹-failure')));

    lines.length = 0;
    seriesList.splice(0); resourceList.splice(0);
    const empty = await queue.enqueueTask('scanAndScrape');
    await queue.waitForTask(empty);
    assert(lines.some(line => line.includes('成功 0 本，失败 0 本，跳过 0 本')));
  } finally {
    Object.assign(console, originals);
    if (queue) for (let i = 0; i < 100 && queue.snapshot().some(task => ['queued', 'running'].includes(task.status)); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('Default scrape logs: concurrent work identity, original paths, failure/fallback/skip counts, summaries and redaction passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
