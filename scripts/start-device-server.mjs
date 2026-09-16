import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// A persistent, disposable LAN library. Never scan or edit the reference directory directly.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.resolve(process.env.READDECK_DEVICE_RUNTIME || path.join(project, 'build/device-debug'));
const library = path.join(runtime, 'library');
const accountFile = path.join(runtime, 'account.json');
process.env.DATA_DIR = path.join(runtime, 'server-data');
process.env.PORT ||= '13090';
const require = createRequire(import.meta.url);
const settings = require('../lib/settingsStore.js');

async function copySamples(source, target, skipped) {
  let entries;
  try { entries = await fs.readdir(source, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'EACCES') throw error;
    skipped.push(source); return;
  }
  await fs.mkdir(target, { recursive: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'Thumbs.db') continue;
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) await copySamples(from, to, skipped);
    else if (entry.isFile()) {
      try { await fs.copyFile(from, to); }
      catch (error) { if (error.code !== 'EACCES') throw error; skipped.push(from); continue; }
      // Finder ACLs may grant access while POSIX mode is 000; copyFile drops those ACLs.
      await fs.chmod(to, 0o600);
    }
  }
}

await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
await settings.initialize();
if (!settings.snapshot().libraryConfirmed) {
  const source = process.argv[2];
  if (!source) throw new Error('首次启动请传入资源示例目录：node scripts/start-device-server.mjs /绝对路径/资源示例');
  const original = await fs.realpath(source);
  if (settings.contains(original, runtime) || settings.contains(runtime, original)) throw new Error('资源示例与调试运行目录不可重叠');
  const skipped = [];
  await copySamples(original, library, skipped);
  const password = crypto.randomBytes(12).toString('base64url');
  // Keep the generated password recoverable if initialization is interrupted.
  let account;
  try { account = JSON.parse(await fs.readFile(accountFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  account ||= { username: 'admin', password };
  await settings.atomicWrite(accountFile, account);
  if (settings.secrets().account.mustChangePassword) {
    await settings.updateAccount({ currentPassword: 'admin', ...account });
  }
  const next = settings.snapshot();
  next.sources = [{ id: 'device-samples', name: '真机调试资源', path: library, enabled: true, order: 0, mode: 'auto', categoryId: '', watch: false, autoScrape: false }];
  next.scanning = { ...next.scanning, onStart: false, autoScrapeOnStart: false };
  await settings.save(next);
  await fs.writeFile(path.join(runtime, 'sample-copy-report.json'), JSON.stringify({ source: original, skipped }, null, 2));
  if (skipped.length) console.log(`跳过 ${skipped.length} 个不可读目录，详见 sample-copy-report.json。`);
}

// Optional secret file is JSON: { "deepseekApiKey": "..." }. Never pass the key on the command line.
if (process.env.READDECK_DEVICE_KEY_FILE) {
  const credentials = JSON.parse(await fs.readFile(process.env.READDECK_DEVICE_KEY_FILE, 'utf8'));
  await settings.save({ ...settings.snapshot(), credentials: { deepseekApiKey: credentials.deepseekApiKey } });
}
console.log(`管理员凭据保存在 ${accountFile}`);
for (const addresses of Object.values(os.networkInterfaces())) {
  for (const address of addresses || []) {
    if (address.family === 'IPv4' && !address.internal) console.log(`局域网地址：http://${address.address}:${process.env.PORT}`);
  }
}
require('../server.js');
