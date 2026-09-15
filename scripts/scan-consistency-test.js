const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareSettings } = require('./settings-fixture');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-scan-consistency-'));
  const library = path.join(root, 'library'); await fs.mkdir(library);
  process.env.DATA_DIR = path.join(root, 'data'); prepareSettings({ dataRoot: process.env.DATA_DIR, libraryRoot: library });
  const config = require('../lib/config'), scanner = require('../lib/scanner'), storage = require('../lib/metadataStore');
  const fixtures = ['卷号/Vol.01/1.jpg', '章节/第1话/1.jpg', '章节/第2话/1.jpg', '父目录/chapter/01/1.jpg',
    '父目录/单行本/01/1.jpg', '分组文件/chapter/01.cbz', '分组文件/单行本/02.cbz',
    '直接图片/1.jpg', '嵌套图片/内容/分页/1.jpg', '独立作品 Vol.01.cbz'];
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw Error('AI must not be used'); };
  const selected = result => result.resourceList.map(r => Object.fromEntries(['resourceId', 'seriesId', 'relativePath', 'contentType',
    'detectedNumber', 'detectedNumberType', 'firstIndexedAt'].map(key => [key, r[key]]))).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  try {
    for (const name of fixtures) { const file = path.join(library, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'fixture'); }
    let baseline;
    for (const [web, key] of [[true, 'fixture'], [false, 'fixture'], [false, '']]) {
      Object.defineProperty(config, 'AI_WEB_SEARCH_ENABLED', { configurable: true, value: web });
      Object.defineProperty(config, 'AI_API_KEY', { configurable: true, value: key });
      for (const fast of [true, false]) {
        const result = selected(await scanner.scanLibrary({ fast }));
        if (!baseline) baseline = result; else assert.deepEqual(result, baseline);
      }
    }
    assert.equal(calls, 0);
    const byPath = name => baseline.find(r => r.relativePath === name);
    for (const name of ['卷号/Vol.01', '父目录/单行本/01', '分组文件/单行本/02.cbz', '嵌套图片']) assert.equal(byPath(name).contentType, 'volume', name);
    for (const name of ['章节/第1话', '父目录/chapter/01', '分组文件/chapter/01.cbz', '直接图片']) assert.equal(byPath(name).contentType, 'chapter', name);
    const image = path.join(library, '嵌套图片/内容/分页/1.jpg');
    const before = await storage.getResource(byPath('嵌套图片').resourceId);
    const protection = require('../lib/scrapeProtection');
    assert.equal(protection.resourceChanged({ ...before, contentFingerprint: undefined }, before), false,
      'adding the first content fingerprint cannot invalidate a legacy scrape');
    await fs.appendFile(image, 'changed');
    await scanner.scanLibrary({ fast: true, changedPaths: [image] });
    const after = await storage.getResource(before.resourceId);
    assert.notEqual(after.contentFingerprint, before.contentFingerprint); assert.equal(after.firstIndexedAt, before.firstIndexedAt); assert.equal(calls, 0);
    console.log('Scan modes/AI unavailable, fast/full/incremental, numbering, parent groups and image structure agree without AI.');
  } finally { global.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
