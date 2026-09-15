const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./runtimePaths');
const access = require('./access');
const queues = new Map();
function file(userId) { return path.join(DATA_DIR, 'users', encodeURIComponent(userId), 'progress.json'); }
async function read(userId = access.user()?.id || 'admin') {
  try { return JSON.parse(await fs.readFile(file(userId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function order(a, b) {
  const compare = (a, b) => a === b ? 0 : a > b ? 1 : -1;
  return compare(String(a?.readAt || a?.updatedAt || ''), String(b?.readAt || b?.updatedAt || ''))
    || compare(String(a?.deviceId || ''), String(b?.deviceId || ''))
    || Number(a?.sequence || 0) - Number(b?.sequence || 0);
}
async function save(userId, seriesId, body) {
  const operation = async () => {
    const invalidKey = key => typeof key !== 'string' || !key || key.length > 512 || ['__proto__', 'constructor', 'prototype'].includes(key);
    if (invalidKey(seriesId) || invalidKey(body.chapterUuid)
      || !Number.isSafeInteger(body.page) || body.page < 0
      || (body.sequence != null && (!Number.isSafeInteger(body.sequence) || body.sequence < 0))
      || (body.deviceId != null && (typeof body.deviceId !== 'string' || body.deviceId.length > 128))
      || (body.cfi != null && (typeof body.cfi !== 'string' || body.cfi.length > 8192))
      || (body.scrollPercent != null && (!Number.isFinite(body.scrollPercent) || body.scrollPercent < 0 || body.scrollPercent > 100))) throw Object.assign(new Error('阅读位置无效'), { status: 400 });
    const readTime = Date.parse(body.readAt || new Date().toISOString());
    if (!Number.isFinite(readTime)) throw Object.assign(new Error('阅读时间无效'), { status: 400 });
    const stamp = { readAt: new Date(Math.min(readTime, Date.now() + 60000)).toISOString(),
      deviceId: String(body.deviceId || 'web').slice(0, 128), sequence: Math.max(0, Number(body.sequence) || 0) };
    const data = await read(userId);
    const previous = data[seriesId] || { chapters: {} };
    const entry = { page: body.page, resourceId: body.resourceId || '', resourceType: body.resourceType || '',
      sourceStartPage: body.sourceStartPage || null, sourcePageCount: body.sourcePageCount || null,
      scrollPercent: Number(body.scrollPercent || 0), cfi: String(body.cfi || ''), seriesId,
      updatedAt: stamp.readAt, ...stamp };
    const chapters = { ...previous.chapters };
    if (order(stamp, chapters[body.chapterUuid]) > 0) chapters[body.chapterUuid] = entry;
    const applied = order(stamp, previous) > 0;
    data[seriesId] = applied ? { ...previous, ...stamp, updatedAt: stamp.readAt, chapters,
      lastChapterUuid: body.chapterUuid, lastChapterTitle: body.chapterTitle || '', lastGroupName: body.groupName || '',
      lastPage: body.page, lastResourceId: entry.resourceId, lastResourceType: entry.resourceType,
      lastSourceStartPage: entry.sourceStartPage, lastSourcePageCount: entry.sourcePageCount,
      lastCfi: entry.cfi, lastScrollPercent: entry.scrollPercent } : { ...previous, chapters };
    const target = file(userId); await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = target + '.' + crypto.randomUUID();
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return { success: true, applied, progress: data[seriesId] };
  };
  const next = (queues.get(userId) || Promise.resolve()).then(operation, operation);
  queues.set(userId, next.catch(() => {})); return next;
}
module.exports = { read, save, order };
