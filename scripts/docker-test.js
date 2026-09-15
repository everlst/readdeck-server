const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const assert = require('assert/strict');
const sharp = require('sharp');
const { prepareSettings, fixtureSource } = require('./settings-fixture');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-docker-'));
  const name = 'readdeck-test-' + crypto.randomUUID().slice(0, 8);
  let running = false;
  try {
    await fs.mkdir(path.join(root, 'library', 'comics', 'Work', 'Chapter'), { recursive: true });
    await sharp({ create: { width: 60, height: 90, channels: 3, background: '#dd7733' } }).png().toFile(path.join(root, 'library', 'comics', 'Work', 'Chapter', '1.png'));
    await fs.mkdir(path.join(root, 'library', 'comics', '.sync', 'Archive'), { recursive: true });
    await fs.writeFile(path.join(root, 'library', 'comics', '.sync', 'Archive', 'ignored.epub'), 'sync metadata fixture');
    prepareSettings({ dataRoot: path.join(root, 'data'), sources: [fixtureSource('/app/library/comics', { id: 'docker-source' })] });
    docker('run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::13000', '-v', path.join(root, 'data') + ':/app/data',
      '-v', path.join(root, 'library') + ':/app/library', process.env.READDECK_DOCKER_TEST_IMAGE || 'readdeck-server:local'); running = true;
    let base;
    const wait = async () => {
      base = 'http://' + docker('port', name, '13000/tcp').split('\n')[0];
      for (let i = 0; i < 100; i++) {
        try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {}
        await sleep(150);
      }
      throw new Error('容器启动超时');
    };
    await wait();
    assert.match(docker('exec', name, 'bsdtar', '--version'), /bsdtar/);
    docker('exec', name, 'sh', '-c', 'command -v pdftoppm && command -v pdfinfo');
    docker('exec', name, 'node', '-e', "const {schema,POLICY_VERSION}=require('/app/lib/webScrape'); if(schema.title!=='WebScrapeResultV1'||POLICY_VERSION!==4) process.exit(1); require('/app/lib/webMetadataFlow'); require('/app/lib/userPreferences');");
    const first = await (await fetch(base + '/api/server')).json();
    const login = async () => {
      const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password' }) });
      assert.equal(r.status, 200); return (await r.json()).token;
    };
    let token = await login();
    const preferences = await (await fetch(base + '/api/me/preferences', { headers: { Authorization: 'Bearer ' + token } })).json();
    const preferred = [...preferences.detailSections].reverse().map(row => ({ ...row, visible: row.id !== 'persons' }));
    const savedPreferences = await fetch(base + '/api/me/preferences', { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: preferences.revision, detailSections: preferred }) });
    assert.equal(savedPreferences.status, 200);
    for (const asset of ['/detail-preferences.js', '/detail-presentation.css']) assert.equal((await fetch(base + asset)).status, 200);
    const scan = await fetch(base + '/api/tasks/scan', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ scrape: false }) });
    assert.ok(scan.ok, await scan.text());
    let library = [];
    for (let i = 0; i < 100; i++) {
      library = await (await fetch(base + '/api/library', { headers: { Authorization: 'Bearer ' + token } })).json();
      if (library.length) break; await sleep(150);
    }
    assert.equal(library.length, 1, JSON.stringify(await (await fetch(base + '/api/tasks', { headers: { Authorization: 'Bearer ' + token } })).json()));
    docker('restart', name); await wait(); token = await login();
    assert.equal((await (await fetch(base + '/api/server')).json()).instanceId, first.instanceId);
    assert.equal((await (await fetch(base + '/api/library', { headers: { Authorization: 'Bearer ' + token } })).json()).length, 1);
    assert.deepEqual((await (await fetch(base + '/api/me/preferences', { headers: { Authorization: 'Bearer ' + token } })).json()).detailSections, preferred);
    console.log('Docker startup, native dependencies, scan, login, new UI assets and persistent metadata/preferences passed.');
  } catch (error) {
    if (running) console.error(docker('logs', name));
    throw error;
  } finally {
    if (running) docker('rm', '-f', name);
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
