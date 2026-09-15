const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const engine = require('../lib/webScrape');
const { WEB_SCRAPE_POLICY_VERSION } = require('../lib/scrapeContext');
const { resultFor } = require('./fixtures/web-metadata-flow');
const options = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', model: 'fixture-model', effort: 'medium', concurrency: 2 };
function input(count = 1, mode = 'full') {
  return { mode, forcedBangumiSubjectId: null, localWork: { title: '本地作品', mediaType: 'comic',
    originalDirectoryNames: ['[本地作品][作者][Vol.01-Vol.09]'], authors: [], aliases: [], localMetadata: {}, existingParseHints: {} },
    knownWork: mode === 'resources' ? { originalName: '本地作品', nameCn: '本地作品' } : null, knownTerms: [],
    resources: Array.from({ length: count }, (_, i) => ({ resourceId: 'resource-' + i, originalName: `Vol.${i + 1}.cbz`, format: 'cbz', embeddedMetadata: {}, existingParseHints: {} })) };
}
const response = result => ({ text: JSON.stringify(result), searchCalls: 0, sources: [] });

test('complete prompt asks for Chinese biographies, original names, every cover and Bangumi Chinese priority', async () => {
  const request = input(8), result = resultFor(request);
  const before = structuredClone(request);
  const answer = await engine.scrapeBatch(request, options, { webSearch: async (args, connection) => {
    assert.equal(args.allowUnverifiedResult, true);
    assert.equal(connection.model, options.model); assert.equal(connection.effort, 'medium');
    assert.equal(args.messages.length, 2);
    const content = args.messages[0].content;
    assert(content.startsWith(fs.readFileSync(path.join(__dirname, '../lib/webScrapePrompt.txt'), 'utf8').trimEnd()));
    assert(content.endsWith(JSON.stringify(engine.schema, null, 2)));
    for (const text of ['程序会直接采用你的内容', '简体中文名', '完整翻译', '达坦玛', '不要把示例角色加入结果',
      '人物简介和头像', '卷册简介、封面', '/v0/characters/{id}', '逐条重复打开']) assert(content.includes(text), text);
    assert(!content.includes('previousAttemptObservedSourceUrls'));
    assert.equal(JSON.parse(args.messages[1].content).resources.length, 8);
    return response(result);
  }});
  assert.deepEqual(answer.result, result); assert.deepEqual(request, before);
  assert.equal(engine.POLICY_VERSION, WEB_SCRAPE_POLICY_VERSION); assert.equal(engine.POLICY_VERSION, 4);
  assert.equal(engine.validateResult, undefined, 'the obsolete output acceptance validator is removed');
  for (const type of ['work', 'person', 'character', 'relation', 'resource']) assert(engine.schema.definitions[type].properties.coverUrl);
});

test('accept the exact AI output without source, schema, language, reference or matching review', async () => {
  const request = input(); request.forcedBangumiSubjectId = 42;
  const result = resultFor(request, { rich: true, bangumiId: 99 });
  result.work.nameCn = '日文カナ與繁體';
  result.work.extraModelField = 'preserved';
  result.fieldSources = [{ field: '/work/unknownField', sourceIds: ['not-in-tool-record'] }];
  result.resources.push({ ...result.resources[0] });
  let calls = 0;
  const answer = await engine.scrapeBatch(request, options, { webSearch: async () => { calls++; return response(result); },
    sleep: () => { throw Error('AI content must not trigger a retry'); } });
  assert.equal(calls, 1); assert.equal(answer.attempts, 1);
  assert.deepEqual(answer.result, result);
  assert.deepEqual(answer.evidence, { searchCalls: 0, sources: [] });
});

test('failed and partial are model decisions, not rejected or researched again', async () => {
  for (const status of ['failed', 'partial']) {
    const request = input(); const result = resultFor(request, { failed: status === 'failed', failedIds: ['resource-0'] });
    result.status = status;
    const answer = await engine.scrapeBatch(request, options, { webSearch: async () => response(result), sleep: () => assert.fail('no retry') });
    assert.equal(answer.attempts, 1); assert.deepEqual(answer.result, result);
  }
});

test('resource batches carry the confirmed work/terms but trust returned content directly', async () => {
  const request = input(1, 'resources'); request.knownTerms = [{ originalName: '名前', nameCn: '姓名' }];
  const result = resultFor(request); result.work = { extra: 'caller owns whether work is persisted' };
  const answer = await engine.scrapeBatch(request, options, { webSearch: async args => {
    const sent = JSON.parse(args.messages[1].content); assert.deepEqual(sent.knownTerms, request.knownTerms);
    return response(result);
  }});
  assert.deepEqual(answer.result, result);
});

test('only request failure or undecodable JSON retries at 1s/2s with the same task/configuration', async () => {
  const request = input(), result = resultFor(request), delays = [], sent = [];
  const original = structuredClone(options);
  const answer = await engine.scrapeBatch(request, options, { webSearch: async (args, connection) => {
    sent.push(structuredClone(args)); assert.deepEqual(connection, original);
    connection.model = 'mutated';
    if (sent.length === 1) throw Error('request disconnected');
    if (sent.length === 2) return { text: '{broken', sources: [], searchCalls: 0 };
    return response(result);
  }, sleep: ms => { delays.push(ms); } });
  assert.equal(answer.attempts, 3); assert.deepEqual(delays, [1000, 2000]);
  assert.deepEqual(sent[0], sent[1]); assert.deepEqual(sent[1], sent[2]);
  assert.deepEqual(options, original); assert.deepEqual(answer.result, result);
});

test('request exhaustion is returned to local fallback, with secrets redacted', async () => {
  const answer = await engine.scrapeBatch(input(), options, { webSearch: async () => { throw Error('failed ' + options.apiKey); }, sleep: () => {} });
  assert.equal(answer.attempts, 3); assert.equal(answer.result, null);
  assert(!JSON.stringify(answer).includes(options.apiKey)); assert.equal(answer.failure.code, 'retry_exhausted');
});

test('metadata-only input boundary still excludes paths, file bytes, progress and credentials', async () => {
  const request = input();
  Object.assign(request.resources[0], { sourcePath: '/Users/private/book.cbz', bytes: 'private bytes', progress: 0.5 });
  request.localWork.localMetadata = { title: '原始资料', body: 'private body', apiKey: 'private key' };
  request.localWork.existingParseHints = { title: '已有处理结果' };
  await engine.scrapeBatch(request, options, { webSearch: async args => {
    const sent = args.messages[1].content;
    assert(sent.includes('原始资料')); assert(sent.includes('已有处理结果'));
    for (const secret of ['sourcePath', 'private bytes', 'private body', 'private key', 'progress']) assert(!sent.includes(secret));
    return response(resultFor(request));
  }});
  for (const value of ['/app/library/book', '/Users/private/book', options.apiKey]) {
    const bad = input(); bad.localWork.title = value;
    const outcome = await engine.scrapeBatch(bad, options, { webSearch: () => assert.fail('private input must not be transmitted') });
    assert.equal(outcome.failure.code, 'input_invalid');
  }
});

test('the program still sends at most eight local resource descriptors per batch', async () => {
  const answer = await engine.scrapeBatch(input(9), options, { webSearch: () => assert.fail('oversized input batch') });
  assert.equal(answer.attempts, 0); assert.equal(answer.failure.code, 'input_invalid');
});
