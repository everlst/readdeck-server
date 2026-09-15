const path = require('path');
const crypto = require('crypto');
const { getEpubEmbeddedMetadata } = require('./epubProvider');
const { metadataPaths } = require('./resourcePaths');
const { resourcesForScrape } = require('./automaticSources');
const { isMetadataResource } = require('./metadataResources');
const { readJson, normalizeText, unique, resourceRootFromRelativePath } = require('./utils');
const cache = require('./metadataCache');

const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function safeText(value, limit = 4000) {
  if (typeof value !== 'string') return '';
  return value.replace(/sk-[\w-]+/g, '[redacted]').replace(/Bearer\s+\S+/gi, '[redacted]')
    .replace(/(^|[\s"'(])(?:file:\/\/[^\s"<>]+|[A-Za-z]:[\\/][^\s"<>]+|\/[^\s"<>]+)/g, '$1[local-path]')
    .slice(0, limit).trim();
}
const texts = value => (Array.isArray(value) ? value : value ? [value] : [])
  .map(item => safeText(typeof item === 'string' ? item : item?.name || item?.display)).filter(Boolean).slice(0, 40);
function hints(value = {}) {
  const out = {};
  for (const key of ['title', 'aiName', 'seriesName', 'author', 'publisher', 'status', 'contentType', 'detectedNumberType', 'provider']) {
    if (typeof value[key] === 'string') out[key] = safeText(value[key], 512);
  }
  for (const key of ['detectedNumber', 'detectedNumberEnd', 'volumeNumber', 'chapterNumber']) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) out[key] = value[key];
  }
  for (const key of ['authors', 'publishers', 'alternateTitles', 'tags']) if (Array.isArray(value[key])) out[key] = texts(value[key]);
  return out;
}
function localFields(comic = {}) {
  return { title: safeText(comic.name || comic.title), authors: texts(comic.author || comic.authors),
    aliases: texts(comic.alias || comic.aliases), publishers: texts(comic.publisher || comic.publishers),
    tags: texts(comic.theme || comic.tags), summary: safeText(comic.brief || comic.summary, 8000),
    status: safeText(comic.status?.display || comic.status), date: safeText(comic.date),
    language: safeText(comic.language) };
}
function embeddedFields(value = {}) {
  return { title: safeText(value.title), authors: texts(value.authors), publishers: texts(value.publishers),
    dates: texts(value.dates), languages: texts(value.languages), identifiers: texts(value.identifiers),
    tags: texts(value.tags), description: safeText(value.description, 8000) };
}
async function collectInput(bundle, resources, { force = false, subjectId } = {}) {
  resources = resources.filter(isMetadataResource);
  // A chapter-only work still has a work identity. Only its parent directory and
  // work-level metadata may be used; chapter names/hints/content never enter rows.
  const workSources = resources.length ? resources : bundle.resources;
  const local = [];
  for (const file of (await metadataPaths(workSources)).sort()) {
    const value = await readJson(file, null);
    if (value?.comic) local.push(localFields(value.comic));
  }
  const originals = unique(workSources.map(resource => safeText(path.basename(resource.seriesRelativePath || '') ||
    (String(resource.relativePath || '').includes('/') ? resourceRootFromRelativePath(resource.relativePath) : '')))
    .filter(value => value && value !== '.')).sort();
  const descriptor = bundle.descriptor;
  const first = local.find(row => row.title) || {};
  const anchor = (!force && resources.find(resource => resource.resourceId === bundle.bangumi?.webScrape?.rawResourceAnchorId)) || resources[0];
  const rawTitle = descriptor?.title || first.title || originals[0] || path.basename(anchor?.sourcePath || '') || anchor?.originalTitle || bundle.series.title;
  const localWork = { originalDirectoryNames: descriptor ? [] : originals, title: safeText(rawTitle, 512),
    mediaType: descriptor?.mediaType || (['novel', 'comic'].includes(bundle.series.category)
      ? bundle.series.category : cache.mediaType(bundle.series, resources)),
    authors: descriptor ? texts(descriptor.author) : first.authors || [], aliases: first.aliases || [],
    localMetadata: { entries: local }, existingParseHints: force ? {} : {
      ...hints(bundle.series.parseHints || {}),
      // Clearly separated historical output; never used to establish identity or the input fingerprint.
      title: safeText(bundle.series.title, 512), authors: texts(bundle.series.authors),
      historicalBangumiId: bundle.bangumi?.subjectId || null,
    } };
  const rows = [];
  for (const resource of resources) {
    const embedded = !resource.metadataOnly && resource.type === 'epub'
      ? await getEpubEmbeddedMetadata(resource).catch(() => ({})) : {};
    rows.push({ resourceId: String(resource.resourceId), originalName: safeText(path.basename(resource.sourcePath || '') ||
      descriptor?.originalName || resource.originalTitle || resource.title, 512), format: resource.type || '',
      embeddedMetadata: embeddedFields(embedded), existingParseHints: force ? {} : hints(resource.parseHints || {}) });
  }
  if (subjectId != null && subjectId !== '' && (!Number.isSafeInteger(Number(subjectId)) || Number(subjectId) <= 0)) {
    throw new Error('指定的 Bangumi ID 必须为正整数，未覆盖已有元数据');
  }
  const forced = Number(subjectId || (!force && bundle.overrides?.forcedSubjectId) || 0);
  const input = { mode: 'full', forcedBangumiSubjectId: Number.isSafeInteger(forced) && forced > 0 ? forced : null,
    localWork, knownWork: null, knownTerms: [], resources: rows };
  const workInputFingerprint = fingerprint({ resourceScope: 'works-and-volumes', ...localWork, existingParseHints: undefined, forcedBangumiSubjectId: input.forcedBangumiSubjectId });
  const resourceFingerprints = Object.fromEntries(rows.map((row, index) => [row.resourceId, fingerprint({
    ...row, existingParseHints: undefined, fileHash: resources[index].fileHash || '',
    modifiedTime: resources[index].modifiedTime || '', fileSize: resources[index].fileSize ?? null,
  })]));
  return { input, workInputFingerprint, resourceFingerprints, rawResourceAnchorId: anchor?.resourceId || '' };
}
// Kept as internal compatibility entry points for callers of the previous flow.
async function needsScrape(bundle, options = {}) {
  const protection = require('./scrapeProtection');
  if (options.force) return true;
  const eligible = await resourcesForScrape(bundle.resources, options);
  if (!eligible.length) return false;
  return !protection.hasResult(bundle) || !!(protection.subjectId(bundle.bangumi?.subjectId) &&
    protection.changedResources(bundle).some(resource => eligible.some(item => item.resourceId === resource.resourceId)));
}

function scrapeSeriesWeb(seriesId, options = {}) {
  return require('./archiveSource').scrapeSeries(seriesId, options);
}
function resolveDescriptionWeb(descriptor, options = {}) {
  return require('./archiveSource').resolveMetadataOnly(descriptor, options);
}

module.exports = { collectInput, safeText, needsScrape, scrapeSeriesWeb, resolveDescriptionWeb, fingerprint };
