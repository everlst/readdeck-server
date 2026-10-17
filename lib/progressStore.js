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
const invalidKey = key => typeof key !== 'string' || !key || key.length > 512 || ['__proto__', 'constructor', 'prototype'].includes(key);

function resourceEntries(progress = {}) {
  progress ||= {};
  const resources = {};
  const add = (value, resourceId, chapterUuid) => {
    if (!value || invalidKey(resourceId)) return;
    const entry = {
      chapterUuid: value.chapterUuid || chapterUuid || resourceId,
      chapterTitle: value.chapterTitle || '', groupName: value.groupName || '',
      page: value.page ?? 0, resourceId, resourceType: value.resourceType || '',
      sourceStartPage: value.sourceStartPage || null, sourcePageCount: value.sourcePageCount || null,
      cfi: value.cfi || '', scrollPercent: value.scrollPercent || 0,
      readAt: value.readAt || value.updatedAt || '', updatedAt: value.updatedAt || value.readAt || '',
      deviceId: value.deviceId || '', sequence: value.sequence || 0,
      seriesId: value.seriesId || progress.seriesId || '',
    };
    if (!resources[resourceId] || order(entry, resources[resourceId]) >= 0) resources[resourceId] = entry;
  };
  for (const [chapterUuid, entry] of Object.entries(progress.chapters || {})) add(entry, entry?.resourceId, chapterUuid);
  add({
    chapterTitle: progress.lastChapterTitle, groupName: progress.lastGroupName,
    page: progress.lastPage, resourceType: progress.lastResourceType,
    sourceStartPage: progress.lastSourceStartPage, sourcePageCount: progress.lastSourcePageCount,
    cfi: progress.lastCfi, scrollPercent: progress.lastScrollPercent,
    readAt: progress.readAt, updatedAt: progress.updatedAt,
    deviceId: progress.deviceId, sequence: progress.sequence, seriesId: progress.seriesId,
  }, progress.lastResourceId, progress.lastChapterUuid);
  for (const [resourceId, entry] of Object.entries(progress.resources || {})) add(entry, resourceId, entry?.chapterUuid);
  return resources;
}

function forResource(progress, resourceId) {
  if (invalidKey(resourceId)) return {};
  const resources = resourceEntries(progress);
  if (!Object.hasOwn(resources, resourceId)) return {};
  const entry = resources[resourceId];
  const chapters = Object.fromEntries(Object.entries(progress.chapters || {})
    .filter(([key, value]) => !invalidKey(key) && value?.resourceId === resourceId));
  const chapterUuid = invalidKey(entry.chapterUuid) ? resourceId : entry.chapterUuid;
  chapters[chapterUuid] = { ...entry, chapterUuid };
  return {
    seriesId: entry.seriesId, readAt: entry.readAt, updatedAt: entry.updatedAt,
    deviceId: entry.deviceId, sequence: entry.sequence,
    lastChapterUuid: chapterUuid, lastChapterTitle: entry.chapterTitle, lastGroupName: entry.groupName,
    lastPage: entry.page, lastResourceId: resourceId, lastResourceType: entry.resourceType,
    lastSourceStartPage: entry.sourceStartPage, lastSourcePageCount: entry.sourcePageCount,
    lastCfi: entry.cfi, lastScrollPercent: entry.scrollPercent,
    chapters, resources: { [resourceId]: entry },
  };
}
async function save(userId, seriesId, body) {
  const operation = async () => {
    if (invalidKey(seriesId) || invalidKey(body.chapterUuid)
      || (body.resourceId != null && body.resourceId !== '' && invalidKey(body.resourceId))
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
    const entry = { chapterUuid: body.chapterUuid, chapterTitle: body.chapterTitle || '', groupName: body.groupName || '',
      page: body.page, resourceId: body.resourceId || '', resourceType: body.resourceType || '',
      sourceStartPage: body.sourceStartPage || null, sourcePageCount: body.sourcePageCount || null,
      scrollPercent: Number(body.scrollPercent || 0), cfi: String(body.cfi || ''), seriesId,
      updatedAt: stamp.readAt, ...stamp };
    const chapters = { ...previous.chapters };
    if (order(stamp, chapters[body.chapterUuid]) > 0) chapters[body.chapterUuid] = entry;
    const resources = resourceEntries({ ...previous, seriesId });
    if (entry.resourceId && (!resources[entry.resourceId] || order(stamp, resources[entry.resourceId]) > 0)) resources[entry.resourceId] = entry;
    const applied = order(stamp, previous) > 0;
    data[seriesId] = applied ? { ...previous, ...stamp, updatedAt: stamp.readAt, chapters, resources,
      lastChapterUuid: body.chapterUuid, lastChapterTitle: body.chapterTitle || '', lastGroupName: body.groupName || '',
      lastPage: body.page, lastResourceId: entry.resourceId, lastResourceType: entry.resourceType,
      lastSourceStartPage: entry.sourceStartPage, lastSourcePageCount: entry.sourcePageCount,
      lastCfi: entry.cfi, lastScrollPercent: entry.scrollPercent } : { ...previous, chapters, resources };
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
module.exports = { read, save, order, resourceEntries, forResource };
