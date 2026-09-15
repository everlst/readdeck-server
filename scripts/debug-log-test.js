const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { prepareSettings } = require('./settings-fixture');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-debug-'));
  process.env.DATA_DIR = root;
  prepareSettings({ dataRoot: root, sources: [] });
  const debug = require('../lib/debugLog');
  const store = require('../lib/settingsStore');
  const ai = require('../lib/aiProvider');
  const originalLog = console.log, lines = [];
  console.log = line => lines.push(String(line));
  let mode = 'sse', release, started;
  const provider = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* consume request */ }
    if (req.url.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test-model' }] })); return; }
    if (mode === 'html') { res.writeHead(502, { 'Content-Type': 'text/html' }); res.end('<html>upstream failed draft-secret</html>'); return; }
    const data = { id: 'response-fixture', status: 'completed', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<tool_call>web_search</tool_call> draft-secret', annotations: [] }] },
    ] };
    if (req.url.endsWith('/chat/completions')) {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'OK draft-secret' } }] })); return;
    }
    if (mode === 'json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': 'provider-request' });
    res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    if (mode === 'paused') { started(); await new Promise(resolve => { release = resolve; }); }
    res.end('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: data }) + '\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const options = { baseUrl: 'http://127.0.0.1:' + provider.address().port, apiKey: 'draft-secret', model: 'test-model', effort: 'high' };
  const express = require('express'), app = express(); app.use(express.json());
  require('../lib/settingsApi').installSettingsApi(app, { watcher: { status() { throw new Error('fixture internal stored-secret'); } } });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const saveDebug = enabled => { const draft = store.snapshot(); draft.diagnostics = { debugEnabled: enabled }; return store.save(draft); };
  const entries = () => lines.filter(line => line.startsWith('[debug] ')).map(line => JSON.parse(line.slice(8)));
  try {
    assert.equal(store.snapshot().diagnostics.debugEnabled, false, 'legacy settings default to debug off');
    await assert.rejects(ai.testWebSearch(options), /没有真实完成/);
    assert.equal(lines.length, 0, 'disabled mode emits no debug logs');
    await saveDebug(true);
    assert.equal(debug.isEnabled(), true, 'saving takes effect immediately');
    assert(entries().some(e => e.event === 'settings.saved' && e.details.settings.diagnostics.debugEnabled));
    const oldClient = store.snapshot(); delete oldClient.diagnostics; await store.save(oldClient);
    assert.equal(store.snapshot().diagnostics.debugEnabled, true, 'old clients preserve the switch');
    for (const invalid of [null, 'true', 1]) await assert.rejects(saveDebug(invalid), /调试模式/);
    const restart = execFileSync(process.execPath, ['-e', "const s=require('./lib/settingsStore'); console.log('persisted='+s.snapshot().diagnostics.debugEnabled)"], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: root }, encoding: 'utf8' });
    assert.match(restart, /persisted=true/);
    assert.match(restart, /settings.loaded/);
    lines.length = 0;
    const response = await fetch(url + '/api/settings/test/ai-search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) });
    assert.equal(response.status, 502);
    const error = await response.json();
    assert.match(error.error, /没有真实完成.*请求编号/);
    assert.equal(error.requestId, response.headers.get('x-readdeck-request-id'));
    const events = entries();
    for (const event of ['settings.request', 'ai.request', 'ai.response.headers', 'ai.response.event', 'ai.response.stream', 'ai.search.failed', 'settings.error', 'settings.completed']) {
      assert(events.some(e => e.event === event && e.traceId === error.requestId), event + ' shares the settings trace');
    }
    assert(events.some(e => e.event === 'ai.request' && e.details.body?.tools?.[0]?.type === 'web_search'));
    assert(lines.some(line => line.includes('<tool_call>web_search</tool_call>')), 'ordinary text tool claims remain visible for diagnosis');
    assert(!lines.join('\n').includes('draft-secret'));
    mode = 'json'; await assert.rejects(ai.testWebSearch(options));
    assert(entries().some(e => e.event === 'ai.response.body'));
    await ai.complete({ messages: [{ role: 'user', content: 'test-title' }] }, options);
    assert(entries().some(e => e.event === 'ai.response.body' && e.details.body.choices));
    mode = 'html'; await assert.rejects(ai.testWebSearch(options));
    assert(entries().some(e => e.event === 'ai.response.error' && /upstream failed/.test(e.details.body)));
    assert(!lines.join('\n').includes('draft-secret'));

    const secretsFile = path.join(root, 'config/secrets.json');
    const secrets = JSON.parse(await fs.readFile(secretsFile)); secrets.aiApiKey = 'stored-secret';
    await fs.writeFile(secretsFile, JSON.stringify(secrets));
    const unknown = await fetch(url + '/api/settings');
    assert.equal(unknown.status, 500);
    assert.match((await unknown.json()).error, /请求编号/);
    assert(entries().some(e => e.event === 'settings.error' && e.details.error.stack.includes('fixture internal')));
    assert(!lines.join('\n').includes('stored-secret'));
    // Restore only this temporary fixture's secret before later saves validate the model.
    secrets.aiApiKey = ''; await fs.writeFile(secretsFile, JSON.stringify(secrets));

    const sanitized = debug.sanitize({ password: 'password-fixture', token: 'token-fixture', nested: { apiKey: 'key-fixture' },
      text: 'password-fixture token-fixture key-fixture Bearer other-secret sk-sample-secret',
      url: 'https://user:pass@example.org/?api_key=url-secret', usage: { input_tokens: 100 },
      raw: 'password=raw-password; api_key="raw-key"',
      long: 'x'.repeat(100000), apiKeyConfigured: true });
    for (const secret of ['password-fixture', 'token-fixture', 'key-fixture', 'other-secret', 'sk-sample-secret', 'url-secret', 'user:pass', 'raw-password', 'raw-key']) assert(!JSON.stringify(sanitized).includes(secret));
    assert.equal(sanitized.usage.input_tokens, 100); assert.equal(sanitized.apiKeyConfigured, true);
    assert.match(sanitized.long, /TRUNCATED/);
    const cyclic = {}; cyclic.self = cyclic; assert.equal(debug.sanitize(cyclic).self, '[CIRCULAR]');
    const ready = new Promise(resolve => { started = resolve; });
    mode = 'paused'; lines.length = 0;
    const pending = assert.rejects(ai.testWebSearch(options)); await ready;
    for (let i = 0; i < 100 && !entries().some(e => e.event === 'ai.response.event'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(entries().some(e => e.event === 'ai.response.event'), 'stream events log before completion');
    await saveDebug(false); lines.length = 0;
    release(); await pending;
    assert.equal(lines.length, 0, 'disabling also silences in-flight responses');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'config/settings.json'))).diagnostics.debugEnabled, false);
  } finally {
    release?.(); debug.setEnabled(false); console.log = originalLog;
    server.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('Debug settings persistence, runtime switch, AI SSE/JSON/HTTP errors, trace correlation, redaction and bounded output passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
