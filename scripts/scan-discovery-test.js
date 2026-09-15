const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareSettings, fixtureSource } = require('./settings-fixture');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 8000) { const started = Date.now(); while (!await predicate()) { if (Date.now() - started > ms) throw Error('Timed out'); await sleep(25); } }
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-discovery-'));
  const library = path.join(root, 'library'); await fs.mkdir(library);
  process.env.DATA_DIR = path.join(root, 'data');
  const settings = prepareSettings({ dataRoot: process.env.DATA_DIR, sources: [fixtureSource(library, { watch: true })], aiWebSearchEnabled: true });
  Object.assign(settings.metadata, { aiModel: 'fixture-model', aiBaseUrl: 'https://fixture.invalid/v1', aiReasoningEffort: 'medium' });
  await fs.writeFile(path.join(process.env.DATA_DIR, 'config/settings.json'), JSON.stringify(settings));
  const secretsFile = path.join(process.env.DATA_DIR, 'config/secrets.json');
  const secrets = JSON.parse(await fs.readFile(secretsFile)); secrets.aiApiKey = 'fixture-key'; await fs.writeFile(secretsFile, JSON.stringify(secrets));
  const write = async name => { const f = path.join(library, name); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, 'local fixture'); return f; };
  const scanner = require('../lib/scanner'), metadata = require('../lib/metadataStore'), config = require('../lib/config');
  const { walkImages } = require('../lib/utils');
  const { isIgnoredLibraryPath } = require('../lib/libraryIgnore');
  const originalFetch = global.fetch, originalRead = fs.readdir;
  let requests = 0, watcher, release, running;
  global.fetch = async () => { requests++; throw Error('local discovery must not call AI'); };
  try {
    for (let n = 1; n <= 9; n++) await write(`A发现作品/Vol.${String(n).padStart(2, '0')}.cbz`);
    await write('A发现作品/.sync/Archive/旧卷.cbz'); await write('A发现作品/.sync/旧页.jpg');
    await write('.sync/Archive/备份.cbz'); await write('.stversions/old.epub'); await write('.git/hidden.cbz');
    await write('__MACOSX/._hidden.cbz'); await write('._hidden.cbz');
    await write('B图片作品/第1话/1.jpg'); await write('B图片作品/第1话/.sync/extra.jpg');
    await write('C空目录/readme.txt'); await write('.正常书名.cbz');
    await write('Z最后作品/Vol.01.cbz');
    let entered = false, done = false;
    const gate = new Promise(resolve => { release = resolve; });
    fs.readdir = async (target, ...args) => {
      if (String(target) === path.join(library, 'Z最后作品')) { entered = true; await gate; }
      return originalRead(target, ...args);
    };
    running = scanner.scanLibrary({ fast: true, concurrency: 1 }).then(value => { done = true; return value; });
    await until(() => entered);
    assert.equal(done, false);
    const partial = await metadata.readLibraryIndexes();
    assert(Object.values(partial.resourceIndex).some(r => r.sourcePath.includes('A发现作品')),
      'new cards must be backed by a published index before the scan finishes');
    assert(Object.values(partial.resourceIndex).every(r => !isIgnoredLibraryPath(r.relativePath)));
    release(); const result = await running; fs.readdir = originalRead;
    assert.equal(requests, 0, 'configured AI cannot delay web-mode local discovery');
    assert.equal(result.resourceList.length, 12);
    assert.equal(result.seriesList.length, 4);
    assert(result.resourceList.some(r => r.sourcePath.endsWith('.正常书名.cbz')), 'do not hide legitimate dot-prefixed books');
    assert.equal((await walkImages(path.join(library, 'B图片作品'))).length, 1, 'reader and scan use identical exclusions');

    const baseline = await metadata.readLibraryIndexes();
    await write('A0已经发现的新作品/Vol.01.cbz');
    fs.readdir = async (target, ...args) => {
      if (String(target) === path.join(library, 'Z最后作品')) throw Object.assign(new Error('read failure'), { code: 'EIO' });
      return originalRead(target, ...args);
    };
    await assert.rejects(scanner.scanLibrary({ fast: true, concurrency: 1 }), e => e.code === 'SCAN_INCOMPLETE');
    fs.readdir = originalRead;
    const failed = await metadata.readLibraryIndexes();
    for (const [id, resource] of Object.entries(baseline.resourceIndex)) assert.deepEqual(failed.resourceIndex[id], resource,
      'partial failures cannot remove or overwrite existing resources');
    assert(Object.values(failed.resourceIndex).some(r => r.sourcePath.includes('A0已经发现的新作品')));

    Object.defineProperty(config, 'AI_WEB_SEARCH_ENABLED', { configurable: true, value: false });
    const parseInputs = [];
    global.fetch = async (_, options) => {
      const input = JSON.parse(JSON.parse(options.body).messages.at(-1).content); parseInputs.push(input.name);
      // Exact model response supplied in the user's failure log.
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '', alternateTitles: [],
        authors: [], publishers: [], status: '', tags: [], contentType: 'unknown', detectedNumber: null,
        detectedNumberEnd: null, detectedNumberType: '' }) } }] }));
    };
    const traditional = await scanner.scanLibrary({ fast: true, concurrency: 2 });
    assert.equal(traditional.resourceList.length, 13, 'optional AI parsing failure must not abort file discovery');
    assert.equal(parseInputs.length, 0, 'traditional scanning also never calls AI');
    for (const resource of result.resourceList) {
      const current = traditional.resourceList.find(item => item.resourceId === resource.resourceId);
      for (const key of ['seriesId', 'contentType', 'detectedNumber', 'detectedNumberType', 'firstIndexedAt']) {
        assert.deepEqual(current[key], resource[key], key + ' must be mode independent');
      }
    }

    const queued = [];
    watcher = require('../lib/libraryWatcher').createLibraryWatcher({ enqueueTask: async (type, payload) => queued.push({ type, payload }), invalidate() {} });
    await watcher.rebuild(); await sleep(150);
    const visible = await write('监听可见作品.cbz');
    await until(() => queued.some(t => t.payload.changedPaths.includes(visible)));
    queued.length = 0;
    await write('.sync/Archive/另一个备份.cbz'); await write('A发现作品/.sync/新的子目录/页.jpg');
    await sleep(3500);
    assert.equal(queued.length, 0, 'synchronizer files must not trigger watcher rescans');
    console.log('Scan discovery: .sync exclusions, AI-free web scanning, streaming cards, readable-file detection, old-state protection and watcher exclusion passed.');
  } finally {
    release?.(); await running?.catch(() => {}); fs.readdir = originalRead; global.fetch = originalFetch;
    await watcher?.close(); await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
