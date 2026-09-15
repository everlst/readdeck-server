const path = require('path');
const crypto = require('crypto');
const { METADATA_DIR } = require('./runtimePaths');
const { atomicWrite } = require('./settingsStore');
const { readJson, normalizeText, unique, parseVolumeNumberFromText } = require('./utils');
const { inputFingerprint, WEB_SCRAPE_POLICY_VERSION, TRADITIONAL_SCRAPE_POLICY_VERSION } = require('./scrapeContext');

const directory = path.join(METADATA_DIR, 'shared-scrapes');
const indexFile = path.join(directory, 'index.json');
const operations = new Map();
let indexPromise;

function titleKey(value) {
  return normalizeText(String(value || '').normalize('NFKC')
    .replace(/\.(epub|pdf|zip|cbz|rar|cbr)$/i, '')
    .replace(/[\[【(（](?:高清|掃圖|扫图|电子版|電子版|修订版|修訂版|精校版|简体|簡體|繁体|繁體|重制版|重製版|\d+p)[\]】)）]/gi, '')
    .replace(/\s*(?:vol\.?\s*\d+(?:\.\d+)?|第\s*\d+(?:\.\d+)?\s*[卷巻册冊])\s*$/i, ''));
}
function mediaType(series = {}, resources = []) {
  if (resources.length) return resources.every(r => r.type === 'epub') ? 'novel' : 'comic';
  return series.category === 'novel' ? 'novel' : 'comic';
}
function identity(series, resources = []) {
  return {
    mediaType: mediaType(series, resources),
    titles: unique([series.title, ...(series.alternateTitles || [])].map(titleKey).filter(Boolean)),
    authors: unique((series.authors || []).map(a => normalizeText(typeof a === 'string' ? a : a?.name)).filter(Boolean)),
  };
}
function identityKey(series, resources = []) {
  const value = identity(series, resources);
  return `${value.mediaType}:${value.titles[0] || ''}:${value.authors.slice().sort().join('|')}`;
}
function matches(left, right) {
  if (left.mediaType !== right.mediaType || !left.titles.some(t => right.titles.includes(t))) return false;
  return !left.authors.length || !right.authors.length || left.authors.some(a => right.authors.includes(a));
}
async function withLock(key, operation) {
  const previous = operations.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(operation);
  operations.set(key, run);
  try { return await run; }
  finally { if (operations.get(key) === run) operations.delete(key); }
}
const fileFor = id => path.join(directory, crypto.createHash('sha256').update(id).digest('hex') + '.json');
function entries() { return indexPromise ||= readJson(indexFile, {}); }
function traditionalRecord(record) {
  return !!record && (record.mode === undefined || record.mode === 'traditional') && !record.data?.bangumi?.webScrape;
}
function cleanData(bundle) {
  const bangumi = structuredClone(bundle.bangumi || {});
  delete bangumi.volumeMatches;
  delete bangumi.resourceFingerprints;
  delete bangumi.pendingResourceIds;
  const volumeDetails = Object.fromEntries(Object.entries(bundle.volumeDetails || {}).map(([id, original]) => {
    const value = structuredClone(original); delete value.resourceIds; delete value.localSummary;
    return [id, value];
  }));
  return { bangumi, volumeDetails, brief: bangumi.translatedSummary || bangumi.summary || '',
    relations: bundle.relations || bangumi.relatedSubjects || [], persons: bundle.persons || bangumi.persons || [],
    characters: bundle.characters || bangumi.characters || [], translations: bundle.translations || [] };
}
async function remember(series, bundle, resources = bundle.resources || [], { replace = false } = {}) {
  if (bundle.bangumi?.webScrape) return null;
  const subjectId = Number(bundle.bangumi?.subjectId || 0);
  if (!subjectId) return null;
  // Audit the identifying input only. Traditional matching remains based on
  // titles/authors rather than imposing the web cache's exact-input semantics.
  const identityInput = identity(series, resources);
  const info = identity({ ...series, alternateTitles: unique([...(series.alternateTitles || []), bundle.series?.title, bundle.bangumi.name, bundle.bangumi.name_cn].filter(Boolean)),
    authors: unique([...(series.authors || []), ...(bundle.bangumi.authors || [])]) }, resources);
  const id = `${info.mediaType}:${subjectId}`;
  return withLock('cache-index', async () => {
    const all = await entries();
    const cached = await readJson(fileFor(id), null);
    const previous = !replace && traditionalRecord(cached) ? cached : null;
    const data = cleanData(bundle);
    data.volumeDetails = { ...(previous?.data.volumeDetails || {}), ...data.volumeDetails };
    const record = { schemaVersion: 1, id, subjectId, ...info, mode: 'traditional',
      policyVersion: TRADITIONAL_SCRAPE_POLICY_VERSION, inputFingerprint: inputFingerprint(identityInput),
      titles: unique([...(previous?.titles || []), ...info.titles]), authors: unique([...(previous?.authors || []), ...info.authors]),
      sourceSeriesId: bundle.series?.seriesId || '', data, updatedAt: new Date().toISOString() };
    await atomicWrite(fileFor(id), record);
    all[id] = { id, subjectId, mediaType: record.mediaType, titles: record.titles, authors: record.authors, sourceSeriesId: record.sourceSeriesId,
      mode: record.mode, policyVersion: record.policyVersion, inputFingerprint: record.inputFingerprint };
    await atomicWrite(indexFile, all);
    return record;
  });
}
async function find(series, resources = [], { subjectId, excludeSeriesId } = {}) {
  const info = identity(series, resources);
  const candidates = Object.values(await entries()).filter(row => traditionalRecord(row) && row.mediaType === info.mediaType &&
    (!excludeSeriesId || row.sourceSeriesId !== excludeSeriesId) && (subjectId ? row.subjectId === Number(subjectId) : matches(info, row)));
  const records = (await Promise.all(candidates.map(row => readJson(fileFor(row.id), null))))
    .filter(traditionalRecord);
  // A shared title alone must not merge two distinct works or adaptations.
  if (records.length !== 1) return null;
  return records[0];
}
function reusedVolumeMatches(bundle) {
  const details = Object.values(bundle.volumeDetails || {});
  return (bundle.resources || []).filter(r => r.contentType === 'volume').flatMap(resource => {
    const existing = (bundle.bangumi?.volumeMatches || []).find(m => m.matched && m.subjectId && m.resourceId === resource.resourceId &&
      (!resource.detectedNumber || Number(m.detectedNumber) === Number(resource.detectedNumber)));
    if (existing) return [{ ...existing, source: 'reused_volume' }];
    const number = Number(resource.detectedNumber || 0);
    if (!number || (resource.detectedNumberEnd && Number(resource.detectedNumberEnd) !== number)) return [];
    const candidates = details.filter(d => d.subjectId && d.updatedAt &&
      ((d.volumeNumbers || []).map(Number).includes(number) || parseVolumeNumberFromText(d.nameCn || d.nameJa) === number));
    if (candidates.length !== 1) return [];
    const detail = candidates[0];
    const aiTitle = detail.displayTitleSource === 'ai' && typeof detail.displayTitle === 'string' ? detail.displayTitle.trim() : '';
    return [{ resourceId: resource.resourceId, resourceKey: resource.resourceId, originalTitle: resource.originalTitle || resource.title,
      localTitle: resource.title, detectedNumber: number, subjectId: Number(detail.subjectId), matched: true, confidence: 100,
      displayTitle: aiTitle || detail.nameCn || detail.nameJa || resource.title,
      ...(aiTitle ? { displayTitleSource: 'ai' } : {}), source: 'reused_volume', reason: '复用同作品同卷册的元数据',
      candidateName: detail.nameJa || '', candidateNameCn: detail.nameCn || '', updatedAt: new Date().toISOString() }];
  });
}

// Exact web input results never enter the traditional title/author matching index.
function webCacheIdentity(fingerprint, policyVersion) {
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new TypeError('联网缓存需要完整 SHA-256 输入指纹');
  if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) throw new TypeError('联网刮削策略版本无效');
  return { id: `web:${policyVersion}:${fingerprint}`, filename: path.join(directory, `web-v${policyVersion}`, fingerprint + '.json') };
}
async function findWeb(fingerprint, { policyVersion = WEB_SCRAPE_POLICY_VERSION, force = false } = {}) {
  const { id, filename } = webCacheIdentity(fingerprint, policyVersion);
  if (force) return null;
  const record = await readJson(filename, null);
  if (record?.schemaVersion !== 1 || record.id !== id || record.mode !== 'web' ||
      record.policyVersion !== policyVersion || record.inputFingerprint !== fingerprint || !record.data) return null;
  return record;
}
async function rememberWeb(fingerprint, data, { policyVersion = WEB_SCRAPE_POLICY_VERSION } = {}) {
  const { id, filename } = webCacheIdentity(fingerprint, policyVersion);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('联网缓存结果必须是元数据对象');
  const record = { schemaVersion: 1, id, mode: 'web', policyVersion, inputFingerprint: fingerprint,
    data: structuredClone(data), updatedAt: new Date().toISOString() };
  return withLock(id, async () => { await atomicWrite(filename, record); return structuredClone(record); });
}
async function findDescription(descriptor) {
  const record = await readJson(path.join(directory, 'descriptions', inputFingerprint(descriptor) + '.json'), null);
  return record?.metadata || null;
}
async function rememberDescription(descriptor, metadata) {
  await atomicWrite(path.join(directory, 'descriptions', inputFingerprint(descriptor) + '.json'), { metadata });
}
function descriptionWorkKey(descriptor) {
  return descriptor.author?.trim() ? inputFingerprint({ title: descriptor.title, author: descriptor.author, mediaType: descriptor.mediaType }) : null;
}
async function findDescriptionWork(descriptor) {
  const key = descriptionWorkKey(descriptor);
  return key ? readJson(path.join(directory, 'description-works', key + '.json'), null) : null;
}
async function rememberDescriptionWork(descriptor, data) {
  const key = descriptionWorkKey(descriptor);
  if (key) await atomicWrite(path.join(directory, 'description-works', key + '.json'), data);
}
module.exports = { identity, identityKey, matches, titleKey, mediaType, find, remember, withLock, reusedVolumeMatches,
  findDescription, rememberDescription, descriptionWorkKey, findDescriptionWork, rememberDescriptionWork,
  inputFingerprint, findWeb, rememberWeb };
