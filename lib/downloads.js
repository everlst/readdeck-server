const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { CACHE_DIR } = require('./runtimePaths');
const { getResource } = require('./metadataStore');
const { validateResource } = require('./resourcePaths');
const { getPages, getPageFile } = require('./readerProvider');
const { getCompatibleEpubFile } = require('./epubProvider');
const { runCommand, walkImages } = require('./utils');
const users = require('./userStore');
const settings = require('./settingsStore');
const root = path.join(CACHE_DIR, 'downloads');
const jobs = new Map();
const serving = new Map();
let chain = Promise.resolve();
let cleanupChain = Promise.resolve();
function cleanup(reserve = 0) {
  const operation = async () => {
    const limit = settings.snapshot().cache.maxSizeMb * 1024 * 1024;
    let used = [...jobs.values()].filter(j => j.state === 'ready').reduce((n, j) => n + (j.bytes || 0), 0);
    const candidates = [...jobs.values()].filter(j => !['queued', 'building'].includes(j.state))
      .sort((a, b) => String(a.accessedAt || a.createdAt).localeCompare(String(b.accessedAt || b.createdAt)));
    for (const job of candidates) {
      if (serving.has(job.id)) continue;
      if (job.state !== 'ready' || Date.now() - Date.parse(job.accessedAt || job.createdAt) > 7 * 86400000 || used + reserve > limit) {
        if (job.state === 'ready') used -= job.bytes || 0;
        jobs.delete(job.id); await fsp.rm(path.join(root, job.id), { recursive: true, force: true });
      }
    }
    if (used + reserve > limit) throw new Error('下载缓存正在使用，暂时没有足够空间，请稍后重试');
  };
  const next = cleanupChain.then(operation, operation); cleanupChain = next.catch(() => {}); return next;
}
function persist(job) {
  const directory = path.join(root, job.id); fs.mkdirSync(directory, { recursive: true });
  const tmp = path.join(directory, 'job.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 }); fs.renameSync(tmp, path.join(directory, 'job.json'));
}
function publicJob(job) {
  const { userId, sourceId, ...safe } = job;
  return { ...safe, fileURL: job.state === 'ready' ? `/api/downloads/${job.id}/file` : null };
}
function permitted(job) {
  const user = users.get(job.userId);
  return user?.enabled && (user.role === 'admin' || user.sourceIds.includes(job.sourceId));
}
async function fingerprint(resource) {
  const input = await validateResource(resource);
  const files = input.type === 'directory' ? await walkImages(input.sourcePath, input.recursive !== false) : [input.sourcePath];
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const stat = await fsp.stat(file); hash.update(`${file}\0${stat.size}\0${stat.mtimeMs}\n`);
  }
  return hash.digest('hex');
}
function checksum(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256'); const input = fs.createReadStream(file);
    input.on('error', reject); input.on('data', data => hash.update(data)); input.on('end', () => resolve(hash.digest('hex')));
  });
}
async function build(job) {
  if (job.state === 'cancelled') return;
  const directory = path.join(root, job.id); const staging = path.join(directory, 'staging');
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!permitted(job) || job.state === 'cancelled') throw new Error('任务已取消或访问权限已变更');
      job.state = 'building'; persist(job);
      const resource = await getResource(job.resourceId);
      if (!resource) throw new Error('资源不存在');
      job.revision = await fingerprint(resource);
      await fsp.rm(staging, { recursive: true, force: true }); await fsp.mkdir(staging, { recursive: true });
      const output = path.join(directory, 'content.part');
      if (resource.type === 'epub') {
        await fsp.copyFile(await getCompatibleEpubFile(resource), output); job.format = 'epub';
      } else {
        const pages = await getPages(resource.resourceId, { startPage: job.startPage, pageCount: job.pageCount });
        const manifest = { schemaVersion: 1, resourceId: resource.resourceId, seriesId: resource.seriesId,
          title: resource.title, resourceType: resource.type, revision: job.revision,
          startPage: pages.startPage, pageCount: pages.pageCount, pages: [] };
        job.total = pages.pageCount;
        for (let index = 0; index < pages.pageCount; index++) {
          if (!permitted(job) || job.state === 'cancelled') throw new Error('任务已取消或访问权限已变更');
          const source = await getPageFile(resource.resourceId, pages.startPage + index);
          const ext = path.extname(source).toLowerCase();
          if (!['.jpg','.jpeg','.png','.webp','.gif','.avif','.bmp'].includes(ext)) throw new Error('不支持的图片格式');
          const name = String(index + 1).padStart(6, '0') + ext;
          await fsp.copyFile(source, path.join(staging, name)); manifest.pages.push(name);
          job.completed = index + 1; if (index % 10 === 0) persist(job);
        }
        await fsp.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest));
        await runCommand('bsdtar', ['--format', 'zip', '-cf', output, '-C', staging, '.'], { timeout: 30 * 60 * 1000 });
        job.format = 'zip';
      }
      if (job.revision !== await fingerprint(resource)) { if (attempt === 0) continue; throw new Error('资源在下载包生成过程中发生变化，请重试'); }
      if (!permitted(job) || job.state === 'cancelled') throw new Error('任务已取消或访问权限已变更');
      const size = (await fsp.stat(output)).size;
      if (size > settings.snapshot().cache.maxSizeMb * 1024 * 1024) throw new Error('下载包超过服务器缓存容量上限');
      await cleanup(size);
      job.bytes = size; job.sha256 = await checksum(output);
      if (!permitted(job) || job.state === 'cancelled') throw new Error('任务已取消或访问权限已变更');
      await fsp.rename(output, path.join(directory, 'content'));
      if (!permitted(job) || job.state === 'cancelled') {
        await fsp.rm(path.join(directory, 'content'), { force: true });
        throw new Error('任务已取消或访问权限已变更');
      }
      job.state = 'ready'; job.completed = job.total; job.readyAt = new Date().toISOString(); persist(job); return;
    }
  } catch (error) {
    if (job.state !== 'cancelled') { job.state = 'failed'; job.error = error.message; }
    persist(job); await fsp.rm(path.join(directory, 'content.part'), { force: true });
  } finally { await fsp.rm(staging, { recursive: true, force: true }); }
}
async function initialize() {
  await fsp.mkdir(root, { recursive: true });
  for (const entry of await fsp.readdir(root)) {
    if (!/^[a-f0-9-]{36}$/.test(entry)) continue;
    const directory = path.join(root, entry);
    try {
      const job = JSON.parse(await fsp.readFile(path.join(directory, 'job.json'), 'utf8'));
      if (Date.now() - Date.parse(job.createdAt) > 7 * 86400000) { await fsp.rm(directory, { recursive: true, force: true }); continue; }
      if (['queued','building'].includes(job.state)) { job.state = 'failed'; job.error = '服务重启，请重试下载'; persist(job); }
      jobs.set(job.id, job);
    } catch { /* An incomplete export can be rebuilt by the client. */ }
  }
  const timer = setInterval(() => cleanup().catch(() => {}), 15 * 60 * 1000); timer.unref();
}
function install(app) {
  app.post('/api/downloads', async (req, res) => {
    try {
      const resource = await getResource(req.body?.resourceId);
      if (!resource) return res.status(404).json({ error: '资源不存在' });
      const active = [...jobs.values()].filter(j => j.userId === req.user.id && ['queued','building'].includes(j.state));
      if (active.length >= 50) return res.status(429).json({ error: '下载队列已满' });
      const startPage = req.body.startPage ?? 1, pageCount = req.body.pageCount ?? null;
      if (!Number.isInteger(startPage) || startPage < 1 || (pageCount !== null && (!Number.isInteger(pageCount) || pageCount < 1))) return res.status(400).json({ error: '下载范围无效' });
      const existing = [...jobs.values()].find(j => j.userId === req.user.id && j.resourceId === resource.resourceId && j.startPage === startPage && j.pageCount === pageCount && ['queued','building','ready'].includes(j.state));
      if (existing && (existing.state !== 'ready' || existing.revision === await fingerprint(resource))) return res.json(publicJob(existing));
      const job = { id: crypto.randomUUID(), userId: req.user.id, sourceId: resource.sourceId,
        resourceId: resource.resourceId, seriesId: resource.seriesId, title: resource.title,
        startPage, pageCount, state: 'queued', completed: 0, total: 0, createdAt: new Date().toISOString() };
      jobs.set(job.id, job); persist(job); chain = chain.then(() => build(job), () => build(job));
      res.status(202).json(publicJob(job));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  app.get('/api/downloads', (req, res) => res.json([...jobs.values()].filter(j => j.userId === req.user.id && permitted(j)).map(publicJob)));
  app.use('/api/downloads/:id', (req, res, next) => {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.user.id || !permitted(job)) return res.status(404).json({ error: '下载任务不存在' });
    req.downloadJob = job; next();
  });
  app.get('/api/downloads/:id', (req, res) => res.json(publicJob(req.downloadJob)));
  app.delete('/api/downloads/:id', async (req, res) => {
    const job = req.downloadJob; job.state = 'cancelled'; persist(job);
    // Keep the job's directory while its builder is unwinding; discard completed payloads now.
    await fsp.rm(path.join(root, job.id, 'content'), { force: true }).catch(() => {});
    res.json({ success: true });
  });
  app.get('/api/downloads/:id/file', async (req, res) => {
    const job = req.downloadJob;
    if (job.state !== 'ready') return res.status(409).json({ error: '下载包尚未就绪' });
    try {
      const resource = await getResource(job.resourceId);
      await validateResource(resource);
      job.accessedAt = new Date().toISOString(); persist(job);
      serving.set(job.id, (serving.get(job.id) || 0) + 1);
      res.once('close', () => { const remaining = (serving.get(job.id) || 1) - 1; if (remaining) serving.set(job.id, remaining); else serving.delete(job.id); });
      res.set({ 'Content-Type': job.format === 'epub' ? 'application/epub+zip' : 'application/zip',
        ETag: '"' + job.sha256 + '"', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-cache',
        'Content-Disposition': `attachment; filename="${job.id}.${job.format}"` });
      res.sendFile(path.join(root, job.id, 'content'));
    } catch { res.status(404).json({ error: '资源已不可访问' }); }
  });
}
module.exports = { initialize, install, fingerprint };
