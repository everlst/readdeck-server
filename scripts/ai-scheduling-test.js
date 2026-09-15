const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createSendQueue, MIN_SEND_INTERVAL_MS } = require('../lib/aiSendQueue');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function controlled() {
  let time = 0, nextId = 0;
  const timers = new Map(), calls = [], releases = new Map();
  const queue = createSendQueue({ now: () => time, setTimer(fn, ms) {
    const id = ++nextId; timers.set(id, { fn, at: time + ms }); return id;
  }, clearTimer: id => timers.delete(id) });
  const tick = async ms => {
    const end = time + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      time = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      assert(timers.size <= 1, 'one wakeup timer');
    }
    time = end; await flush();
  };
  const submit = (id, priority = 0) => queue.enqueue(() => {
    calls.push({ id, at: time });
    return new Promise((resolve, reject) => releases.set(id, { resolve, reject }));
  }, id, priority);
  queue.setConcurrency(4);
  const tasks = Array.from({ length: 7 }, (_, i) => submit('job-' + i));
  tasks.forEach(task => task.catch(() => {}));
  await tick(2999); assert.equal(calls.length, 1);
  await tick(6001); assert.deepEqual(calls.map(call => call.at), [0, 3000, 6000, 9000]);
  await tick(30000); assert.equal(calls.length, 4, 'long requests occupy all slots');
  queue.setConcurrency(2);
  releases.get('job-0').resolve(); releases.get('job-1').resolve(); await flush();
  assert.equal(calls.length, 4, 'lowered limit waits for old requests');
  queue.promote('job-6', 2);
  releases.get('job-2').reject(Error('failure')); await flush();
  assert.equal(calls.at(-1).id, 'job-6'); assert.equal(calls.at(-1).at, 39000);
  queue.setConcurrency(6);
  await tick(2999); assert.equal(calls.length, 5, 'raising limit cannot burst');
  await tick(1); assert.equal(calls.at(-1).id, 'job-4');
  releases.get('job-6').resolve(); releases.get('job-3').resolve(); await flush();
  await tick(3000); assert.equal(calls.at(-1).id, 'job-5');
  releases.get('job-4').resolve(); releases.get('job-5').resolve();
  await Promise.allSettled(tasks);
  await tick(60000);
  const a = submit('idle-a'), b = submit('idle-b');
  assert.equal(calls.at(-1).id, 'idle-a');
  await tick(2999); assert.equal(calls.at(-1).id, 'idle-a', 'idle time does not accumulate credit');
  await tick(1); assert.equal(calls.at(-1).id, 'idle-b');
  releases.get('idle-a').resolve(); releases.get('idle-b').resolve(); await Promise.all([a, b]);
  assert.equal(MIN_SEND_INTERVAL_MS, 3000);
}

async function realTiming() {
  const ai = require('../lib/aiProvider');
  const original = global.fetch, calls = [];
  global.fetch = async (url, options) => {
    calls.push({ at: performance.now(), url });
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'test-model' }] });
    if (calls.filter(call => !call.url.endsWith('/models')).length === 1) {
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    if (String(url).endsWith('/responses')) return Response.json({ status: 'completed', output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://bangumi.tv/' }] } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Bangumi' }] },
    ] });
    return Response.json({ choices: [{ message: { content: 'done' } }] });
  };
  const settings = { baseUrl: 'https://clock-fixture.invalid/v1', apiKey: 'test-key', model: 'test-model', concurrency: 4, timeout: 100 };
  try {
    const first = ai.complete({ messages: [{ role: 'user', content: 'timeout' }] }, settings);
    first.catch(() => {});
    const search = ai.testWebSearch(settings);
    const request = { messages: [{ role: 'user', content: 'same prompt' }] };
    const a = ai.complete(request, settings), b = ai.withPriority(1, () => ai.complete(request, settings));
    await ai.listModels(settings);
    await assert.rejects(first, /超时|timed out|连接失败/);
    await Promise.all([search, a, b]);
    const sent = calls.filter(call => !call.url.endsWith('/models'));
    assert.equal(sent.length, 3, 'duplicates consume only one send');
    for (let i = 1; i < sent.length; i++) assert(sent[i].at - sent[i - 1].at >= 2999.5, JSON.stringify(sent));
    assert(sent[1].url.endsWith('/chat/completions'), 'promoted duplicate starts next');
    console.log('Real default send intervals:', sent.slice(1).map((call, i) => Math.round(call.at - sent[i].at)));
  } finally { global.fetch = original; }
}
(async () => { await controlled(); await realTiming(); console.log('AI global pacing, concurrency, priority, dedupe, failures and send-time deadlines passed.'); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
