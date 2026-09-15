const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareSettings } = require('./settings-fixture');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-entity-summary-'));
  process.env.DATA_DIR = path.join(root, 'data');
  prepareSettings({ dataRoot: process.env.DATA_DIR, libraryRoot: path.join(root, 'library') });
  const config = require('../lib/config');
  Object.defineProperty(config, 'AI_API_KEY', { configurable: true, value: 'fixture-key' });
  const { localizeEntitySummaries, mergeEntities } = require('../lib/entitySummaries');
  const { enrichApiEntities } = require('../lib/archiveSource');
  const originalFetch = global.fetch;
  let aiCalls = 0, detailCalls = [], fail = false;
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.bgm.tv/v0/')) {
      detailCalls.push(String(url));
      return Response.json({ summary: '紹介の本文です。', infobox: [{ key: '中文名', value: '中文人物' }] });
    }
    assert(!String(url).includes('/responses'), 'disabled web search never reaches Responses');
    aiCalls++;
    const body = JSON.parse(options.body); assert(!body.tools, 'direct translation carries no search tool');
    const input = JSON.parse(body.messages.at(-1).content);
    assert.equal(input.context.chineseTitle, '作品');
    if (fail) return Response.json({ error: { message: 'fixture failure' } }, { status: 400 });
    return Response.json({ choices: [{ message: { content: '人物的简体中文简介。' } }] });
  };
  try {
    const persons = Array.from({ length: 35 }, (_, index) => ({ personId: index + 1, name: '人物', nameCn: '人物', image: 'https://example.org/avatar.jpg' }));
    const characters = Array.from({ length: 18 }, (_, index) => ({ characterId: index + 1, nameCn: '角色', image: 'https://example.org/avatar.jpg' }));
    characters[0].actors = [persons[0]];
    await enrichApiEntities(persons, characters);
    assert.equal(detailCalls.length, 53, 'all displayed entities enriched once, including beyond old 32/16 limits');
    assert(persons.every(item => item.summary)); assert(characters.every(item => item.summary));
    await enrichApiEntities(persons, characters); assert.equal(detailCalls.length, 53);
    await enrichApiEntities([persons[0]], [], { force: true }); assert.equal(detailCalls.length, 54);
    const rows = [{ personId: 81, name: '作者', nameCn: '作者', summary: '人物の紹介。' },
      { personId: 82, nameCn: '作者二', summary: 'Traditional Chinese? No, this is an English biography.' },
      { personId: 83, nameCn: '作者三', summary: '創作人員簡介' }, { personId: 84, nameCn: '作者四', summary: '简体中文简介' },
      { personId: 85, nameCn: '作者五', summary: '' }];
    const context = { chineseTitle: '作品', terms: [{ sourceName: '作者', nameCn: '作者' }] };
    await localizeEntitySummaries(rows, [], {}, context);
    assert.equal(aiCalls, 2); assert.equal(rows[0].translatedSummary, '人物的简体中文简介。');
    assert.equal(rows[2].translatedSummary, '创作人员简介'); assert.equal(rows[3].summaryTranslation.status, 'unchanged');
    assert.equal(rows[4].summary, '');
    await localizeEntitySummaries(rows, [], {}, context); assert.equal(aiCalls, 2);
    await localizeEntitySummaries([rows[0]], [], {}, context, { force: true }); assert.equal(aiCalls, 3);
    const merged = mergeEntities('person', [{ personId: 81, summary: '', image: '' }], rows);
    assert.equal(merged[0].summary, rows[0].summary);
    fail = true;
    await localizeEntitySummaries([{ ...rows[0] }], [], { persons: rows }, context, { force: true });
    const failure = [{ personId: 90, name: '失敗', summary: '翻訳に失敗。' }];
    await localizeEntitySummaries(failure, [], {}, context);
    assert.equal(failure[0].summary, '翻訳に失敗。'); assert.equal(failure[0].summaryTranslation.status, 'error');
    console.log('entity summaries ok: all details, request deduplication, direct translation, Chinese conversion, cache/force and failure preservation');
  } finally { global.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
