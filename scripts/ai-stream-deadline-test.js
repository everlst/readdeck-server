const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { prepareSettings } = require('./settings-fixture');

async function bounded(operation, milliseconds = 2000) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('SSE operation exceeded fixture deadline')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for fixture transport');
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-sse-lifecycle-'));
  process.env.DATA_DIR = root; prepareSettings({ dataRoot: root, sources: [] });
  const ai = require('../lib/aiProvider');
  const originalFetch = global.fetch;
  const calls = [], sockets = new Set(), intervals = new Set();
  const finalText = JSON.stringify({ title: '完整刮削结果 🎵', summary: '完整简介。'.repeat(1000), lastField: '尾部不得丢失' });
  const search = { id: 'search-full', type: 'web_search_call', status: 'completed', action: { type: 'search',
    queries: ['test'], sources: [{ url: 'https://bgm.tv/subject/1', title: '完整来源', snippet: '工具摘录' }] } };
  const response = { id: 'response-full', status: 'completed', output: [search,
    { id: 'open-full', type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://example.test/book' } },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: finalText,
      annotations: [{ type: 'url_citation', url: 'https://bgm.tv/subject/1', title: '完整来源', start_index: 0, end_index: 5 }] }] },
  ] };
  const completeEvent = 'event: response.completed\r\ndata: ' + JSON.stringify({ type: 'response.completed', response }) + '\r\n\r\n';
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body), mode = input.input[0].content;
    const call = { mode, closed: false, res }; calls.push(call);
    res.on('close', () => { call.closed = true; });
    if (mode === 'no-headers') return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n');
    if (mode === 'never-complete') {
      // Heartbeats must not reset the request's total deadline.
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 10); intervals.add(timer);
      res.on('close', () => { clearInterval(timer); intervals.delete(timer); });
      return;
    }
    const bytes = Buffer.from(completeEvent);
    const split = bytes.indexOf(Buffer.from('🎵')) + 1;
    res.write(bytes.subarray(0, split));
    setImmediate(() => {
      if (res.destroyed) return;
      // A post-terminal malformed trailer must not override the completed result.
      res.write(Buffer.concat([bytes.subarray(split), Buffer.from('data: not-json-after-completion\n\n')]));
      // Deliberately never res.end(): the client must stop reading and disconnect.
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { baseUrl: 'http://127.0.0.1:' + server.address().port, apiKey: 'fixture-key', model: 'fixture-model', concurrency: 1 };
  const request = (mode, extra = {}) => ai.webSearch({ messages: [{ role: 'user', content: mode }] }, { ...options, ...extra });
  try {
    const started = Date.now();
    const first = await bounded(request('complete-open', { timeout: 5000 }));
    assert.ok(Date.now() - started < 2000, 'completed result must return before the request deadline or EOF');
    assert.equal(first.text, finalText); assert.equal(JSON.parse(first.text).lastField, '尾部不得丢失');
    assert.equal(first.searchCalls, 1); assert.deepEqual(first.searchCallDetails, response.output.slice(0, 2));
    assert.equal(first.toolSources[0].snippet, '工具摘录'); assert.equal(first.sources.length, 2);
    assert.deepEqual(first.annotations, response.output[2].content[0].annotations);
    await until(() => calls[0].closed);
    assert.equal(calls[0].res.writableEnded, false, 'fixture did not close the response on the server');

    const before = calls.length;
    const timeout = request('never-complete', { timeout: 120 });
    const failed = assert.rejects(timeout, error => error.status === 502 && /TimeoutError/.test(error.message) && /120/.test(error.message));
    const queued = request('after-timeout', { timeout: 5000 });
    const [, recovered] = await bounded(Promise.all([failed, queued]));
    assert.equal(recovered.text, finalText, 'total timeout must release the single concurrency slot');
    assert.deepEqual(calls.slice(before).map(call => call.mode), ['never-complete', 'after-timeout']);
    await until(() => calls.slice(before).every(call => call.closed));
    await assert.rejects(bounded(request('no-headers', { timeout: 100 })), /TimeoutError/);
    await bounded(request('retry-after-timeout', { timeout: 1000 }));

    // Exercise a stream whose cancellation never settles. Do not await cancel,
    // including when a pending read ignores the request's abort signal.
    let cancels = 0, aborted = 0;
    global.fetch = async (_, settings) => {
      const mode = JSON.parse(settings.body).input[0].content;
      settings.signal.addEventListener('abort', () => { aborted++; }, { once: true });
      const stream = new ReadableStream({
        start(controller) {
          if (mode === 'stuck-cancel-completed') controller.enqueue(new TextEncoder().encode(completeEvent));
        },
        cancel() { cancels++; return new Promise(() => {}); },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const completeStuck = await bounded(request('stuck-cancel-completed', { timeout: 5000 }));
    assert.equal(completeStuck.text, finalText); assert.equal(cancels, 1);
    const stuck = assert.rejects(request('stuck-read', { timeout: 80 }), /TimeoutError/);
    const unblocked = request('stuck-cancel-completed', { timeout: 1000 });
    const [, afterStuck] = await bounded(Promise.all([stuck, unblocked]));
    assert.equal(afterStuck.text, finalText); assert.equal(cancels, 3); assert.equal(aborted, 3);
    console.log('AI stream deadline: completed without EOF, complete output/evidence, fragmented UTF-8, ignored trailers, HTTP total timeout, queue release and non-settling cancellation passed.');
  } finally {
    global.fetch = originalFetch;
    for (const timer of intervals) clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
