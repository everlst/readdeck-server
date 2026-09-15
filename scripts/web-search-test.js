const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { prepareSettings } = require('./settings-fixture');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-web-search-'));
  process.env.DATA_DIR = root;
  prepareSettings({ dataRoot: root, sources: [] });
  const ai = require('../lib/aiProvider');
  let mode = 'sse', calls = 0, active = 0, peak = 0, lastRequest;
  const answer = () => ({ status: 'completed', output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://bangumi.tv/about' }] } },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Bangumi 番组计划 🎵', annotations: [
      { type: 'url_citation', url: 'https://bangumi.tv/about?utm_source=openai', title: '官方介绍' },
      { type: 'url_citation', url: 'javascript:alert(1)', title: 'unsafe' },
    ] }] },
  ] });
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer test-key') { res.writeHead(401); res.end(); return; }
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test-model' }] })); return; }
    assert.equal(req.url, '/v1/responses');
    calls++; active++; peak = Math.max(peak, active);
    let raw = ''; for await (const chunk of req) raw += chunk;
    lastRequest = JSON.parse(raw);
    if (mode === 'unsupported') { active--; res.writeHead(400); res.end('test-key: upstream diagnostics'); return; }
    if (mode === 'rate-limit') { active--; res.writeHead(429, { 'Content-Type': 'application/json', 'x-request-id': 'req_rate_limit' });
      res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Please retry; test-key; Bearer another-secret; sk-other-secret' } })); return; }
    if (mode === 'redirect') { active--; res.writeHead(302, { Location: '/leak' }); res.end(); return; }
    const data = answer();
    if (mode === 'no-call') data.output.shift();
    if (mode === 'failed-call') data.output[0].status = 'failed';
    if (mode === 'incomplete' || mode === 'sse-incomplete') { data.status = 'incomplete'; data.incomplete_details = { reason: 'max_output_tokens' }; }
    if (mode === 'sse-failed') { data.status = 'failed'; data.error = { code: 'server_error', message: 'Search unavailable test-key' }; }
    if (mode === 'no-sources') { data.output[0].action.sources = []; data.output[1].content[0].annotations = []; }
    if (mode === 'wrong-source') { data.output[0].action.sources = [{ url: 'https://example.org/' }]; data.output[1].content[0].annotations = []; }
    if (mode === 'delay') await new Promise(resolve => setTimeout(resolve, 35));
    if (mode === 'json' || ['no-call', 'no-sources', 'wrong-source', 'incomplete', 'failed-call'].includes(mode)) {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data));
    } else {
      res.setHeader('Content-Type', 'text/event-stream');
      const eventType = mode === 'sse-incomplete' ? 'response.incomplete' : mode === 'sse-failed' ? 'response.failed' : mode === 'sse-error' ? 'error' : 'response.completed';
      const event = eventType === 'error' ? { type: 'error', code: 'unsupported_tool', message: 'web_search not supported test-key' } : { type: eventType, response: data };
      const text = 'event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n' +
        (mode === 'truncated' ? '' : 'event: ' + eventType + '\r\ndata: ' + JSON.stringify(event) + '\r\n\r\n') + 'data: [DONE]\r\n\r\n';
      const bytes = Buffer.from(text);
      for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
      res.end();
    }
    active--;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { baseUrl: 'http://127.0.0.1:' + server.address().port, apiKey: 'test-key', model: 'test-model', effort: 'high', concurrency: 2 };
  let appServer;
  try {
    const messages = [{ role: 'user', content: 'search test' }];
    const result = await ai.webSearch({ messages }, options);
    assert.equal(result.text, 'Bangumi 番组计划 🎵');
    assert.equal(result.searchCalls, 1); assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].url, 'https://bangumi.tv/about');
    assert.deepEqual(lastRequest.input, messages); assert.deepEqual(lastRequest.reasoning, { effort: 'high' });
    assert.equal(lastRequest.reasoning_effort, undefined); assert.equal(lastRequest.store, false);
    assert.equal(lastRequest.stream, true); assert.equal(lastRequest.tool_choice, 'required');
    assert.deepEqual(lastRequest.tools, [{ type: 'web_search' }]);
    assert.deepEqual(lastRequest.include, ['web_search_call.action.sources']);
    mode = 'json'; assert.equal((await ai.testWebSearch(options)).success, true);
    for (const [failure, expected] of [['no-call', /真实/], ['failed-call', /真实/], ['no-sources', /来源/], ['incomplete', /完整/], ['truncated', /中断/], ['unsupported', /Responses/], ['redirect', /连接失败/]]) {
      mode = failure;
      await assert.rejects(ai.webSearch({ messages }, options), error => expected.test(error.message) && !error.message.includes('test-key'));
    }
    for (const [failure, fields] of [
      ['incomplete', ['incomplete', 'max_output_tokens']],
      ['sse-incomplete', ['response.incomplete', 'max_output_tokens']],
      ['sse-failed', ['response.failed', 'server_error', 'Search unavailable']],
      ['sse-error', ['unsupported_tool', 'web_search not supported']],
      ['rate-limit', ['HTTP 429', 'req_rate_limit', 'rate_limit_exceeded', 'Please retry']],
      ['no-call', ['webSearchCalls', '(none)']], ['failed-call', ['failed:search']],
    ]) {
      mode = failure;
      await assert.rejects(ai.webSearch({ messages }, options), error => {
        assert.equal(error.status, 502);
        for (const field of fields) assert.ok(error.message.includes(field), error.message);
        for (const secret of ['test-key', 'another-secret', 'sk-other-secret']) assert.ok(!error.message.includes(secret));
        return true;
      });
    }
    mode = 'delay';
    await assert.rejects(ai.webSearch({ messages }, { ...options, timeout: 5 }), /TimeoutError/);
    await new Promise(resolve => setTimeout(resolve, 50));
    mode = 'wrong-source'; await assert.rejects(ai.testWebSearch(options), /官方来源/);
    mode = 'delay'; peak = 0;
    const before = calls;
    await Promise.all(Array.from({ length: 5 }, (_, i) => ai.webSearch({ messages: [{ role: 'user', content: 'query ' + i }] }, options)));
    assert.equal(peak, 2); assert.equal(calls - before, 5);
    const duplicateStart = calls;
    await Promise.all(Array.from({ length: 3 }, () => ai.webSearch({ messages }, options)));
    assert.equal(calls - duplicateStart, 1, 'concurrent duplicate searches share one provider request');

    // Exercise the same server endpoint called by iOS and the browser with draft credentials.
    const express = require('express'); const app = express(); app.use(express.json());
    require('../lib/settingsApi').installSettingsApi(app, { watcher: { status: () => ({}) } });
    appServer = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const test = () => fetch('http://127.0.0.1:' + appServer.address().port + '/api/settings/test/ai-search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options),
    });
    mode = 'sse'; const success = await test(); assert.equal(success.status, 200); assert.equal((await success.json()).success, true);
    mode = 'no-call'; const rejected = await test(); assert.equal(rejected.status, 502); assert.match((await rejected.json()).error, /真实/);
    console.log('Native web search: Responses SSE/JSON, real call evidence, source validation, errors, concurrency, deduplication and settings endpoint passed.');
  } finally {
    if (appServer) await new Promise(resolve => appServer.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
