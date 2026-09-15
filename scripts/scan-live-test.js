const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { prepareSettings, fixtureSource } = require('./settings-fixture');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-live-scan-'));
  const library = path.join(root, 'library'), dataRoot = path.join(root, 'data');
  await fs.mkdir(library); const staging = path.join(root, 'page'); await fs.mkdir(staging);
  await require('sharp')({ create: { width: 60, height: 90, channels: 3, background: '#486991' } }).png().toFile(path.join(staging, '1.png'));
  const archive = path.join(root, 'fixture.cbz'); execFileSync('bsdtar', ['--format', 'zip', '-cf', archive, '-C', staging, '1.png']);
  for (let n = 1; n <= 35; n++) {
    const dir = path.join(library, `A${String(n).padStart(2, '0')} 扫描展示作品`); await fs.mkdir(dir); await fs.copyFile(archive, path.join(dir, 'Vol.01.cbz'));
  }
  const slow = path.join(library, 'Z稍后完成的作品'); await fs.mkdir(slow); await fs.copyFile(archive, path.join(slow, 'Vol.01.cbz'));
  await fs.mkdir(path.join(library, '.sync', 'Archive'), { recursive: true });
  await fs.copyFile(archive, path.join(library, '.sync', 'Archive', '不应显示.cbz'));
  const settings = prepareSettings({ dataRoot, sources: [fixtureSource(library)], aiWebSearchEnabled: true });
  Object.assign(settings.metadata, { aiModel: 'fixture-model', aiBaseUrl: 'https://fixture.invalid/v1' });
  await fs.writeFile(path.join(dataRoot, 'config/settings.json'), JSON.stringify(settings));
  const secretFile = path.join(dataRoot, 'config/secrets.json'), secret = JSON.parse(await fs.readFile(secretFile));
  secret.aiApiKey = 'configured-fixture-key'; await fs.writeFile(secretFile, JSON.stringify(secret));
  const release = path.join(root, 'release-scan'), requests = path.join(root, 'unexpected-network.jsonl');
  await fs.writeFile(requests, '');
  const preload = path.join(root, 'preload.cjs'), server = path.resolve(__dirname, '..');
  await fs.writeFile(preload, `const fs=require('fs');const read=fs.promises.readdir;
fs.promises.readdir=async(target,...args)=>{if(String(target)===${JSON.stringify(slow)}){while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,25));}return read(target,...args);};
global.fetch=async(url)=>{fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify({url:String(url)})+'\\n');throw Error('Scanning must not call AI');};
const archive=require(${JSON.stringify(path.join(server, 'lib/archiveSource'))});archive.scrapeSeries=async id=>({seriesId:id});archive.refreshLocalWorkGrouping=async()=>{};
`);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['--require', preload, 'server.js'], { cwd: server,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let n = 0; !logs.includes('ReadDeck running'); n++) { if (child.exitCode !== null || n > 100) throw Error(logs); await sleep(50); }
    const token = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password' }) }).then(r => r.json()).then(r => r.token);
    assert(token); const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (process.argv.includes('--serve')) {
      console.log(JSON.stringify({ base, root, release, username: 'admin', password: 'test-password', expectedDuringScan: 35 }));
      process.once('SIGTERM', () => child.kill('SIGTERM')); process.once('SIGINT', () => child.kill('SIGTERM'));
      await new Promise(resolve => child.once('exit', resolve)); return;
    }
    const started = Date.now();
    const scan = await fetch(base + '/api/tasks/scan', { method: 'POST', headers, body: JSON.stringify({ scrape: true }) }); assert(scan.ok);
    let tasks, books;
    for (let n = 0; n < 150; n++) {
      tasks = await fetch(base + '/api/tasks', { headers }).then(r => r.json());
      books = await fetch(base + '/api/comics', { headers }).then(r => r.json());
      if (books.length === 35) break;
      await sleep(50);
    }
    assert.equal(books.length, 35, '35 new cards must be available during the unfinished scan');
    const taskList = Array.isArray(tasks) ? tasks : tasks.tasks;
    assert(taskList.some(task => task.status === 'running' && task.progress?.scanDone === false));
    assert.equal(await fs.readFile(requests, 'utf8'), '', 'no scan-time AI requests');
    assert(!books.some(book => String(book.name).includes('.sync')));
    const firstStageMs = Date.now() - started;
    await fs.writeFile(release, 'done');
    for (let n = 0; n < 100; n++) {
      tasks = await fetch(base + '/api/tasks', { headers }).then(r => r.json());
      if ((Array.isArray(tasks) ? tasks : tasks.tasks).every(task => task.status === 'success')) break;
      await sleep(50);
    }
    books = await fetch(base + '/api/comics', { headers }).then(r => r.json());
    assert.equal(books.length, 36); assert.equal(await fs.readFile(requests, 'utf8'), '');
    console.log(`Live scan HTTP: 35 cards visible in ${firstStageMs}ms before completion; 36 after; .sync skipped and no scan-time AI requests.`);
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
