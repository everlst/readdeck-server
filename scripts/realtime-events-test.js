const { prepareSettings } = require('./settings-fixture');
const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const { once } = require('events');

function waitForOutput(child, pattern, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${pattern}: ${output}`));
    }, timeoutMs);
    const onData = chunk => {
      output += chunk.toString();
      if (!pattern.test(output)) return;
      cleanup();
      resolve(output);
    };
    const onExit = code => {
      cleanup();
      reject(new Error(`server exited early with code ${code}: ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

async function readSseEvents(response, predicate, timeoutMs = 15000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE event timeout')), timeoutMs); });

  const consume = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream closed before expected event');
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let eventName = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        const event = { event: eventName, data: JSON.parse(dataLines.join('\n')) };
        events.push(event);
        if (predicate(events)) {
          await reader.cancel();
          return events;
        }
      }
    }
  })();

  try { return await Promise.race([consume, timeout]); }
  finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
}

async function main() {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-plus-sse-'));
  const libraryRoot = path.join(runRoot, 'library');
  const dataRoot = path.join(runRoot, 'data');
  const listener = http.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  await fs.mkdir(libraryRoot, { recursive: true });

  prepareSettings({ dataRoot, libraryRoot, username: 'sse-test', password: 'sse-test', watch: true });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  child.stdout.on('data', chunk => { serverLog += chunk; });
  child.stderr.on('data', chunk => { serverLog += chunk; });
  try {
    await waitForOutput(child, /ReadDeck running/);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'sse-test', password: 'sse-test' }),
    });
    assert.strictEqual(login.ok, true);
    const { token } = await login.json();

    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/events?token=${encodeURIComponent(token)}`,
      { signal: controller.signal }
    );
    assert.strictEqual(response.ok, true);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);

    const eventsPromise = readSseEvents(response, events => {
      const hasTask = events.some(event => event.event === 'tasks_changed');
      const hasLibrary = events.some(event =>
        event.event === 'library_changed' && event.data.reason === 'derived_indexes_written'
      );
      return hasTask && hasLibrary;
    });

    await fs.writeFile(
      path.join(libraryRoot, '[实时推送测试][测试作者][Vol.01].epub'),
      'realtime fixture'
    );
    const events = await eventsPromise;
    assert(events.some(event => event.event === 'ready'), 'SSE should send an initial ready event');
    assert(events.some(event => event.event === 'tasks_changed'), 'SSE should push task state changes');
    assert(events.some(event =>
      event.event === 'library_changed' && event.data.reason === 'derived_indexes_written'
    ), 'SSE should push committed library index changes');
    controller.abort();

    console.log('realtime events ok');
  } catch (error) {
    error.message += '\nServer output:\n' + serverLog;
    throw error;
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await fs.rm(runRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
