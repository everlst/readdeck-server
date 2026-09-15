require('./fixtures/fast-ai-clock');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareSettings } = require('./settings-fixture');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-bangumi-search-'));
  process.env.DATA_DIR = path.join(root, 'data');
  prepareSettings({ dataRoot: process.env.DATA_DIR, libraryRoot: path.join(root, 'library') });
  const config = require('../lib/config');
  for (const [key, value] of Object.entries({ AI_API_KEY: 'synthetic-key', AI_MODEL: 'test-model',
    DEEPSEEK_MATCH_ENABLED: true, AI_WEB_SEARCH_ENABLED: false })) {
    Object.defineProperty(config, key, { configurable: true, value });
  }
  const archive = require('../lib/archiveSource');
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const originalLog = console.log;
  const logs = [];
  const attempts = new Map();
  let keywords = ['早期检索', '瞬时失败', '持续失败', '后续检索'];
  let search;
  let selectedId = 42;
  let aiCandidates;
  const item = id => ({ id, type: 1, name: '早期检索', name_cn: '早期检索', platform: '漫画',
    infobox: [{ key: '作者', value: '测试作者' }], summary: '测试简介' });
  const networkError = () => new TypeError('fetch failed', { cause: new AggregateError([
    Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    Object.assign(new Error('DNS lookup failed'), { code: 'EAI_AGAIN' }),
  ], 'connection failed') });
  const series = { title: '早期检索', category: 'comic' };
  const resolve = () => archive.resolveMetadataOnly({ title: series.title, originalName: series.title + '.cbz', mediaType: 'comic' }, { force: true });
  try {
    console.warn = (...args) => logs.push(args.join(' '));
    console.log = (...args) => logs.push(args.join(' '));
    global.fetch = async (url, options = {}) => {
      if (String(url).includes('api.bgm.tv')) {
        assert(String(url).includes('/search/'), 'candidate collection must not fetch subject details');
        assert(options.signal instanceof AbortSignal, 'every search attempt must have a deadline');
        const { keyword } = JSON.parse(options.body);
        const count = (attempts.get(keyword) || 0) + 1;
        attempts.set(keyword, count);
        return search(keyword, count);
      }
      const payload = JSON.parse(JSON.parse(options.body).messages.at(-1).content);
      let result;
      if (payload.task === 'suggest_bangumi_book_search_keywords') result = { keywords };
      else if (payload.task === 'choose_best_bangumi_book_subject') {
        aiCandidates = payload.candidates;
        result = { matched: selectedId != null, subjectId: selectedId, confidence: 1, reason: 'AI 判决' };
      } else if (payload.task === 'parse_resource_name') result = { title: series.title, authors: [], alternateTitles: [],
        publishers: [], tags: [], status: '', contentType: 'volume', detectedNumber: null, detectedNumberEnd: null, detectedNumberType: 'volume' };
      else throw new Error('Unexpected AI task: ' + payload.task);
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
    };

    await fs.mkdir(config.ARCHIVE_DIR, { recursive: true });
    const archivePath = path.join(config.ARCHIVE_DIR, 'subject.jsonlines');
    await fs.writeFile(archivePath, [item(1), ...Array.from({ length: 15 }, (_, i) => item(500 + i))].map(JSON.stringify).join('\n'));
    search = (keyword, count) => {
      if (keyword === '瞬时失败' && count === 1 || keyword === '持续失败') throw networkError();
      return Response.json({ data: keyword === '早期检索' ? Array.from({ length: 15 }, (_, i) => item(i + 1))
        : keyword === '瞬时失败' ? [item(16)] : [item(1), item(42)] });
    };
    const collected = await archive.collectSubjectCandidates(series);
    assert.equal(attempts.get('瞬时失败'), 2);
    assert.equal(attempts.get('持续失败'), 3);
    assert.equal(attempts.get('后续检索'), 1, 'later keywords must run after retry exhaustion');
    assert.equal(collected.candidates.length, 32, 'all API and archive candidates must survive deduplication');
    assert.equal(collected.failures.length, 1);
    assert(collected.candidates.some(row => row.id === 1), 'earlier successful candidates must survive a later failure');
    assert(collected.candidates.some(row => row.id === 42), 'later successful candidates must be retained');
    assert.equal((await archive.chooseSubjectWithDeepSeek(series, collected.candidates)).id, 42);
    assert.equal(aiCandidates.length, 32);
    assert(logs.some(line => line.includes('持续失败') && line.includes('3/3') && line.includes('ECONNRESET') && line.includes('EAI_AGAIN')));
    assert(logs.some(line => line.includes('去重后=32')));

    keywords = [series.title];
    attempts.clear();
    search = (_, count) => count === 1 ? new Response('', { status: 429 }) : Response.json({ data: [item(42)] });
    assert.equal((await archive.collectSubjectCandidates(series)).failures.length, 0);
    assert.equal(attempts.get(series.title), 2, 'rate-limited searches must retry');

    await fs.writeFile(archivePath, '');
    selectedId = null;
    attempts.clear();
    search = () => { throw networkError(); };
    await assert.rejects(resolve(), error => error.code === 'BANGUMI_NETWORK_ERROR' &&
      /API 检索全部失败/.test(error.message) && /ECONNRESET/.test(error.message) && !/未找到 Bangumi 匹配/.test(error.message));
    assert.equal(attempts.get(series.title), 3);

    attempts.clear();
    keywords = [series.title, '持续失败'];
    search = keyword => { if (keyword === '持续失败') throw networkError(); return Response.json({ data: [] }); };
    await assert.rejects(resolve(), error => error.code === 'BANGUMI_NETWORK_ERROR' && /部分检索未完成/.test(error.message));

    keywords = [series.title];
    search = () => Response.json({ data: [] });
    await assert.rejects(resolve(), error => error.code === 'BANGUMI_NO_MATCH' && /搜索成功但无可信匹配/.test(error.message));
    search = () => Response.json({ data: [item(1)] });
    await assert.rejects(resolve(), error => error.code === 'BANGUMI_NO_MATCH', 'an AI rejection after successful retrieval is a genuine no-match');

    attempts.clear();
    search = () => new Response('', { status: 403 });
    await assert.rejects(resolve(), error => error.code === 'BANGUMI_SEARCH_ERROR' && /HTTP 403/.test(error.message));
    assert.equal(attempts.get(series.title), 1, 'permanent HTTP failures must not repeat identical requests');

    attempts.clear();
    search = () => Response.json({ error: 'invalid shape' });
    await assert.rejects(resolve(), error => error.code === 'BANGUMI_SEARCH_ERROR' && /缺少 data 数组/.test(error.message));
    assert.equal(attempts.get(series.title), 3, 'malformed responses must not be interpreted as empty successful searches');

    Object.defineProperty(config, 'DEEPSEEK_MATCH_ENABLED', { configurable: true, value: false });
    search = () => { throw networkError(); };
    await assert.rejects(resolve(), error => error.code === 'BANGUMI_NETWORK_ERROR', 'non-AI matching must also preserve transport failures');
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
    console.log = originalLog;
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('Bangumi keyword retries, complete candidate aggregation, AI selection and distinct search failures passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
