const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const ai = require('../lib/aiProvider');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-ai-test-'));
  process.env.DATA_DIR = path.join(root, 'data');
  let lastRequest, mode = 'normal', calls = 0, active = 0, peak = 0, completions = 0;
  const server = http.createServer(async (req, res) => {
    calls++;
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== 'Bearer test-key') return send(401, { error: req.headers.authorization });
    if (mode === 'html') { res.end('<html>Wrong endpoint</html>'); return; }
    if (mode === 'redirect') { res.writeHead(302, { Location: '/leaked' }); res.end(); return; }
    if (req.url === '/v1/models') return send(200, { data: [
      { id: 'gpt-6-astra' }, { id: 'gpt-5.4-mini' }, { id: 'gpt-5.4-mini' },
      { id: 'gpt-5.5', supported_reasoning_efforts: ['low', 'high'] },
      { id: 'custom', reasoning: { efforts: ['medium'] } }, { id: 'unknown-alias' },
      { id: 'text-embedding-3-small' }, { id: 'image-model' },
      { id: 'responses-only', supported_endpoint_types: ['responses'] }, { invalid: true },
    ] });
    if (req.url === '/v1/chat/completions') {
      completions++; active++; peak = Math.max(peak, active);
      if (mode === 'delay') await new Promise(resolve => setTimeout(resolve, 25));
      let body = ''; for await (const data of req) body += data;
      lastRequest = JSON.parse(body);
      active--;
      if (lastRequest.reasoning_effort === 'high') return send(400, { error: 'secret upstream diagnostic test-key' });
      return send(200, { choices: [{ message: { content: mode === 'empty' ? '' : '{"ok":true}' } }] });
    }
    send(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const connection = { baseUrl, apiKey: 'test-key' };
  try {
    assert.equal(ai.normalizeBaseUrl('https://example.com/'), 'https://example.com/v1');
    assert.equal(ai.normalizeBaseUrl(' https://example.com/v1/chat/completions/ '), 'https://example.com/v1');
    assert.equal(ai.normalizeBaseUrl('https://example.com/gateway/v1/models'), 'https://example.com/gateway/v1');
    for (const url of ['file:///tmp/key', 'https://user:key@example.com', 'https://example.com?key=x', 'https://example.com/#x']) assert.throws(() => ai.normalizeBaseUrl(url));
    assert.throws(() => ai.apiKey('a\r\nx'), /格式/);
    const settings = { metadata: { aiBaseUrl: baseUrl } }, secrets = { aiApiKey: 'test-key' };
    assert.equal(ai.connection({ baseUrl: baseUrl + '/v1' }, settings, secrets).apiKey, 'test-key');
    assert.throws(() => ai.connection({ baseUrl: baseUrl + '/other' }, settings, secrets), /重新输入/);
    assert.throws(() => ai.connection({ clearApiKey: true }, settings, secrets), /请先填写/);
    let catalog = await ai.listModels(connection);
    assert.equal(catalog.models.length, 5);
    assert.equal(catalog.models.find(m => m.id === 'gpt-5.5').reasoning.source, 'provider');
    assert.deepEqual(catalog.models.find(m => m.id === 'gpt-5.5').reasoning.options.filter(o => !o.disabled).map(o => o.value), ['low', 'high']);
    assert.deepEqual(catalog.models.find(m => m.id === 'unknown-alias').reasoning.options.map(o => o.label), ['无', '低', '中', '高']);
    await ai.validateSelection(connection, 'gpt-6-astra', 'high');
    assert.equal(catalog.models.find(m => m.id === 'gpt-6-astra').reasoning.defaultEffort, 'low');
    assert.equal(catalog.models.find(m => m.id === 'gpt-5.4-mini').reasoning.defaultEffort, 'none');
    await assert.rejects(() => ai.validateSelection(connection, 'gpt-6-astra', 'none'), /思考程度/);
    await assert.rejects(() => ai.validateSelection(connection, 'typo-model', ''), /模型/);
    const beforeCache = calls; await ai.listModels(connection); assert.equal(calls, beforeCache);
    await assert.rejects(() => ai.listModels({ ...connection, apiKey: 'wrong-key' }), e => e.status === 502 && !e.message.includes('wrong-key'));
    await ai.complete({ messages: [{ role: 'user', content: 'JSON please' }], temperature: 0, response_format: { type: 'json_object' } }, { ...connection, model: 'gpt-5.4-mini', effort: 'low' });
    assert.equal(lastRequest.reasoning_effort, 'low'); assert.equal(lastRequest.temperature, undefined);
    assert.deepEqual(lastRequest.response_format, { type: 'json_object' });
    await ai.complete({ messages: [] }, { ...connection, model: 'unknown-alias', effort: '' });
    assert.equal(lastRequest.reasoning_effort, undefined);
    await assert.rejects(() => ai.complete({ messages: [] }, { ...connection, model: 'gpt-5.4-mini', effort: 'high' }), e => e.status === 502 && !e.message.includes('test-key'));
    mode = 'html'; await assert.rejects(() => ai.listModels(connection, { refresh: true }), /JSON/);
    mode = 'redirect'; const beforeRedirect = calls;
    await assert.rejects(() => ai.listModels(connection, { refresh: true })); assert.equal(calls, beforeRedirect + 1, 'redirect must not forward the key');
    mode = 'empty'; await assert.rejects(() => ai.complete({ messages: [] }, { ...connection, model: 'custom' }), /有效的文本/);
    mode = 'delay'; peak = 0;
    const options = { ...connection, model: 'custom', effort: '', concurrency: 2 };
    await Promise.all(Array.from({ length: 7 }, (_, i) => ai.complete({ messages: [{ role: 'user', content: String(i) }] }, options)));
    assert.equal(peak, 2, 'all AI work shares a bounded global concurrency limit');
    const beforeDedupe = completions;
    const duplicates = await Promise.all(Array.from({ length: 6 }, () => ai.complete({ messages: [{ role: 'user', content: 'same prompt' }] }, options)));
    assert.equal(completions - beforeDedupe, 1, 'identical in-flight requests share one provider call');
    duplicates[0].choices[0].message.content = 'changed';
    assert.notEqual(duplicates[1].choices[0].message.content, 'changed', 'callers receive independent result objects');
    const failures = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => ai.complete({ messages: [{ role: 'user', content: String(i) }] }, { ...options, effort: 'high' })));
    assert(failures.every(result => result.status === 'rejected'));
    await ai.complete({ messages: [] }, options); // Rejections release every occupied slot.
    mode = 'normal';

    // A real persisted legacy configuration is read and rewritten using the new fields.
    const { prepareSettings } = require('./settings-fixture');
    const legacy = prepareSettings({ dataRoot: process.env.DATA_DIR, sources: [] });
    delete legacy.metadata.aiWebSearchEnabled;
    legacy.metadata.deepseekBaseUrl = baseUrl; legacy.metadata.deepseekModel = 'gpt-5.4-mini';
    await fs.writeFile(path.join(process.env.DATA_DIR, 'config/settings.json'), JSON.stringify(legacy));
    const secretFile = path.join(process.env.DATA_DIR, 'config/secrets.json');
    const legacySecrets = JSON.parse(await fs.readFile(secretFile)); legacySecrets.deepseekApiKey = 'test-key';
    await fs.writeFile(secretFile, JSON.stringify(legacySecrets));
    const store = require('../lib/settingsStore'); await store.initialize();
    assert.equal(store.snapshot().metadata.aiBaseUrl, baseUrl + '/v1');
    assert.equal(store.snapshot().metadata.aiModel, 'gpt-5.4-mini');
    assert.equal(store.secrets().aiApiKey, 'test-key');
    assert.equal(store.snapshot().metadata.deepseekModel, undefined);
    assert.equal(store.snapshot().metadata.aiWebSearchEnabled, true, 'legacy settings keep web research enabled');
    assert(!JSON.stringify(await store.publicSettings()).includes('test-key'));
    const save = change => { const draft = store.snapshot(); change(draft); return store.save(draft); };
    await assert.rejects(() => save(d => { d.metadata.aiModel = 'typo'; }), /模型/);
    await assert.rejects(() => save(d => { d.metadata.aiReasoningEffort = 'max'; }), /思考程度/);
    await assert.rejects(() => save(d => { d.metadata.aiConcurrency = 13; }), /并发/);
    await assert.rejects(() => save(d => { d.scanning.scrapeConcurrency = 0; }), /并发/);
    await assert.rejects(() => save(d => { d.metadata.aiBaseUrl = baseUrl + '/other'; }), /重新输入/);
    await save(d => { d.metadata.aiReasoningEffort = 'low'; });
    const stored = JSON.parse(await fs.readFile(secretFile));
    assert.equal(stored.aiApiKey, 'test-key'); assert.equal(stored.deepseekApiKey, undefined);
    assert.equal(stored.signingKey, legacySecrets.signingKey, 'migration preserves login signing key');
    assert.equal(require('../lib/config').AI_REASONING_EFFORT, 'low');
    const beforeToggleCalls = calls;
    const disabled = await save(d => { d.metadata.aiWebSearchEnabled = false; });
    assert.equal(disabled.metadata.aiWebSearchEnabled, false);
    assert.equal(require('../lib/config').AI_WEB_SEARCH_ENABLED, false, 'toggle takes effect without a restart');
    assert.equal(calls, beforeToggleCalls, 'saving only the search toggle does not contact the model service');
    await save(d => { delete d.metadata.aiWebSearchEnabled; });
    assert.equal(store.snapshot().metadata.aiWebSearchEnabled, false, 'older clients cannot reset the switch');
    assert.equal(JSON.parse(await fs.readFile(path.join(process.env.DATA_DIR, 'config/settings.json'))).metadata.aiWebSearchEnabled, false);
    for (const invalid of ['false', 0, null]) await assert.rejects(() => save(d => { d.metadata.aiWebSearchEnabled = invalid; }), /联网搜索/);
    await ai.complete({ messages: [] }); assert.equal(lastRequest.reasoning_effort, 'low');
    await save(d => { d.metadata.aiWebSearchEnabled = true; });
    assert.equal(require('../lib/config').AI_WEB_SEARCH_ENABLED, true);
    await save(d => { d.credentials = { clearAiApiKey: true }; });
    assert.equal(store.secrets().aiApiKey, '');
    console.log('AI URL, catalog, capabilities, credential isolation, transport, migration, concurrency, deduplication and save validation ok');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
