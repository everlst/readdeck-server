// Local-only fault injection for the real iOS background URLSession workflow.
const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { once } = require('events');
let fixtureProcess;
let fixtureProxy;
let stopping = false;
const transfers = new Set();
function stop() {
  if (stopping) return; stopping = true;
  for (const transfer of transfers) transfer.destroy();
  fixtureProxy?.closeAllConnections(); fixtureProxy?.close(); fixtureProcess?.kill('SIGINT');
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);

async function main() {
  const upstreamPort = Number(process.env.READDECK_TRANSFER_UPSTREAM_PORT || 15933);
  const proxyPort = Number(process.env.READDECK_TRANSFER_PORT || 15934);
  for (const port of [upstreamPort, proxyPort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('测试服务端口无效');
  const child = spawn(process.execPath, [path.join(__dirname, 'readdeck-test.js'), '--serve'], {
    env: { ...process.env, READDECK_TEST_PORT: String(upstreamPort) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  fixtureProcess = child;
  let output = '';
  const fixture = await new Promise((resolve, reject) => {
    child.once('exit', code => reject(new Error('Fixture exited: ' + code)));
    child.stdout.on('data', bytes => {
      output += bytes;
      const line = output.split('\n').find(line => line.startsWith('{"base"'));
      if (line) { try { resolve(JSON.parse(line)); } catch {} }
    });
  });
  const publication = path.join(fixture.root, 'epub');
  // Incompressible, harmless publication data makes pause/resume observable on localhost.
  await fs.writeFile(path.join(publication, 'transfer-padding.bin'), crypto.randomBytes(12 * 1024 * 1024));
  execFileSync('bsdtar', ['--format', 'zip', '-cf', fixture.epubFile, '-C', publication, '.']);
  const state = { offline: false, corrupt: false, delayMs: 120, rangeRequests: 0, fileRequests: 0, interrupted: 0 };
  const proxy = http.createServer(async (req, res) => {
    if (req.url === '/__test/control') {
      if (req.method === 'POST') {
        let text = ''; for await (const bytes of req) text += bytes;
        try {
          const next = JSON.parse(text);
          for (const key of ['offline', 'corrupt']) if (typeof next[key] === 'boolean') state[key] = next[key];
          if (Number.isInteger(next.delayMs)) state.delayMs = Math.min(1000, Math.max(0, next.delayMs));
          if (state.offline) for (const transfer of transfers) transfer.destroy();
        } catch { res.writeHead(400); res.end(); return; }
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)); return;
    }
    if (state.offline) { res.writeHead(503); res.end('Test server is offline'); return; }
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` } }, async response => {
      res.writeHead(response.statusCode, response.headers);
      const isFile = /^\/api\/downloads\/[^/]+\/file$/.test(req.url) && [200, 206].includes(response.statusCode);
      if (!isFile) { response.pipe(res); res.once('close', () => response.destroy()); return; }
      state.fileRequests++; if (req.headers.range) state.rangeRequests++;
      transfers.add(res);
      res.once('close', () => { if (!res.writableEnded) state.interrupted++; transfers.delete(res); response.destroy(); });
      let first = true;
      try {
        for await (const bytes of response) {
          if (res.destroyed) break;
          const chunk = Buffer.from(bytes);
          if (first && state.corrupt && chunk.length) chunk[0] ^= 0xff;
          first = false;
          if (!res.write(chunk)) await new Promise(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
            res.once('drain', done); res.once('close', done);
          });
          if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
        }
        res.end();
      } catch { res.destroy(); }
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  fixtureProxy = proxy;
  proxy.listen(proxyPort, '127.0.0.1'); await once(proxy, 'listening');
  console.log(`Transfer fixture ready at http://127.0.0.1:${proxyPort}`);
  child.once('exit', () => { if (!stopping) stop(); });
}
main().catch(error => { console.error(error); stop(); process.exitCode = 1; });
