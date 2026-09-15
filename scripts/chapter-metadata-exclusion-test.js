const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareSettings } = require('./settings-fixture');
const fixture = require('./fixtures/web-metadata-flow');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-no-chapter-ai-'));
  const library = path.join(root, 'library'); await fs.mkdir(library);
  process.env.DATA_DIR = path.join(root, 'data');
  const settings = prepareSettings({ dataRoot: process.env.DATA_DIR, libraryRoot: library, aiWebSearchEnabled: true });
  settings.metadata = { ...settings.metadata, aiBaseUrl: 'https://ai.example.test/v1', aiModel: 'fixture-model', aiWebSearchEnabled: true };
  await fs.writeFile(path.join(process.env.DATA_DIR, 'config/settings.json'), JSON.stringify(settings));
  const secretsPath = path.join(process.env.DATA_DIR, 'config/secrets.json');
  const secrets = JSON.parse(await fs.readFile(secretsPath, 'utf8')); secrets.aiApiKey = 'fixture-no-chapter-key';
  await fs.writeFile(secretsPath, JSON.stringify(secrets));
  const { needsScrape, collectInput } = require('../lib/webMetadataFlow');
  const { identifyWork } = require('../lib/workIdentification');
  const { localizeFallbackMetadata } = require('../lib/fallbackLocalization');
  const originalFetch = global.fetch, inputs = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert(!options.body.includes('CHAPTER_SENTINEL'), 'no chapter titles or hints in any AI request');
    if (String(url).endsWith('/responses')) {
      const input = JSON.parse(body.input.at(-1).content); inputs.push(input);
      return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ subjectId: 123, status: 'matched', reason: 'matched', evidence: [] }) }] }] });
    }
    const input = JSON.parse(body.messages.at(-1).content);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ results: input.entries.map(row => ({ key: row.key, text: '中文作品' })) }) } }] });
  };
  function resource(id, chapter, work = 'Work') {
    return { resourceId: id, seriesId: work, sourceId: 'fixture-source', seriesRelativePath: work,
      relativePath: `${work}/${chapter ? 'CHAPTER_SENTINEL' : 'Vol.1'}`, sourcePath: path.join(library, work, chapter ? 'CHAPTER_SENTINEL' : 'Vol.1'),
      originalTitle: chapter ? 'CHAPTER_SENTINEL' : 'Vol.1', title: chapter ? 'CHAPTER_SENTINEL' : 'Vol.1',
      type: 'directory', category: 'comic', contentType: chapter ? 'chapter' : 'volume',
      detectedNumberType: chapter ? 'chapter' : 'volume', detectedNumber: 1, parseHints: chapter ? { title: 'CHAPTER_SENTINEL' } : {} };
  }
  const bundle = resources => ({ series: { seriesId: resources[0].seriesId, title: '星之旅', category: 'comic' }, resources, bangumi: {}, volumeDetails: {}, overrides: {} });
  try {
    const chapter = resource('chapter', true), volume = resource('volume', false);
    const mixed = bundle([chapter, volume]);
    const raw = await collectInput(mixed, mixed.resources);
    assert.deepEqual(raw.input.resources.map(row => row.resourceId), ['volume']);
    const first = await identifyWork(mixed, mixed.resources);
    assert.equal(first.subjectId, 123);
    assert.deepEqual(inputs[0].resources.map(row => row.resourceId), ['volume']);
    const expanded = { ...mixed, bangumi: { subjectId: first.subjectId }, resources: [...mixed.resources, { ...chapter, resourceId: 'chapter-2', title: 'CHAPTER_SENTINEL 2' }] };
    assert.equal(await needsScrape(expanded), false, 'new chapters do not invalidate work/volume metadata');
    const only = bundle([resource('only-chapter', true, 'ChapterOnlyWork')]);
    const work = await identifyWork(only, only.resources);
    assert.equal(inputs.length, 2); assert.deepEqual(inputs[1].resources, []);
    assert.equal(work.subjectId, 123, 'a chapter-only work can identify its parent work');
    assert.equal(await needsScrape({ ...only, bangumi: { subjectId: work.subjectId } }), false);
    const fallback = await localizeFallbackMetadata({ title: '作品' }, [chapter, volume]);
    assert.deepEqual(fallback.resources[0], chapter, 'fallback translation cannot rewrite chapters');
    const previousCalls = inputs.length;
    const skipped = await require('../lib/archiveSource').resolveMetadataOnly({ title: '第01话', originalName: '第01话.cbz', mediaType: 'comic', author: '' }, { force: true });
    assert.equal(skipped.scrapeStatus, 'skipped'); assert.equal(inputs.length, previousCalls);
    console.log('chapter exclusion ok: mixed and chapter-only works, new-chapter reuse, immutable chapter records, fallback exclusion');
  } finally { global.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
