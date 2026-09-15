const path = require('path');
const config = require('./config');
const protection = require('./scrapeProtection');
const { emitLibraryChanged } = require('./libraryEvents');
const {
  ensureDir,
  hashString,
  normalizeText,
  readJson,
  unique,
  writeJson,
} = require('./utils');

const SERIES_DIR = path.join(config.METADATA_DIR, 'series');
const INDEX_DIR = path.join(config.METADATA_DIR, 'indexes');
let indexOperationChain = Promise.resolve();
const seriesOperationChains = new Map();

function withIndexOperation(operation) {
  const run = indexOperationChain.then(operation, operation);
  indexOperationChain = run.then(() => undefined, () => undefined);
  return run;
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deduplicateResources(resources) {
  const resourcesById = new Map();
  const ordered = [];
  for (const resource of Array.isArray(resources) ? resources : []) {
    const resourceId = String(resource?.resourceId || '').trim();
    if (!resourceId) {
      ordered.push({ resource });
      continue;
    }
    if (!resourcesById.has(resourceId)) ordered.push({ resourceId });
    resourcesById.set(resourceId, resource);
  }
  return ordered.map(item => item.resourceId
    ? resourcesById.get(item.resourceId)
    : item.resource);
}

function withSeriesOperation(seriesId, operation) {
  const key = String(seriesId || '');
  const previous = seriesOperationChains.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const tracked = current.finally(() => {
    if (seriesOperationChains.get(key) === tracked) seriesOperationChains.delete(key);
  });
  seriesOperationChains.set(key, tracked);
  return tracked;
}

function notifyLibraryChanged(reason, payload = {}) {
  emitLibraryChanged(reason, payload);
}

function seriesStorageDir(seriesId) {
  return path.join(SERIES_DIR, encodeURIComponent(seriesId));
}

async function ensureMetadataLayout() {
  await Promise.all([
    ensureDir(SERIES_DIR),
    ensureDir(INDEX_DIR),
    ensureDir(config.ARCHIVE_DIR),
    ensureDir(config.READER_CACHE_DIR),
    ensureDir(config.PDF_CACHE_DIR),
    ensureDir(config.THUMBNAIL_CACHE_DIR),
  ]);
}

function emptyBangumi() {
  return {
    subjectId: null,
    matchedBy: '',
    confidence: 0,
    source: '',
    matchedTitle: '',
    matchedAt: '',
    isManualOverride: false,
    offprints: [],
    relatedSubjects: [],
    persons: [],
    characters: [],
    externalLinks: [],
  };
}

async function ensureSeriesFiles(seriesId) {
  const dir = seriesStorageDir(seriesId);
  await ensureDir(dir);
  const defaults = {
    'series.json': {},
    'resources.json': [],
    'bangumi.json': emptyBangumi(),
    'translations.json': [],
    'volume_details.json': {},
    'relations.json': [],
    'persons.json': [],
    'characters.json': [],
    'search.json': {},
    'overrides.json': {},
  };
  for (const [file, value] of Object.entries(defaults)) {
    const filePath = path.join(dir, file);
    const current = await readJson(filePath, null);
    if (current === null) await writeJson(filePath, value);
  }
}

function buildSearchDoc(series, resources, bangumi, translations, volumeDetails = {}) {
  const translationTexts = (translations || [])
    .map(t => t.translatedText)
    .filter(Boolean);
  const volumeTexts = Object.values(volumeDetails || {})
    .flatMap(detail => [
      detail?.nameCn,
      detail?.nameJa,
      detail?.summary,
      detail?.translatedSummary,
    ])
    .filter(Boolean);
  const relationNames = (bangumi?.relatedSubjects || [])
    .flatMap(r => [r.name, r.name_cn])
    .filter(Boolean);
  const persons = (bangumi?.persons || [])
    .flatMap(p => [p.nameCn, p.name, p.relation])
    .filter(Boolean);
  const characters = (bangumi?.characters || [])
    .flatMap(c => [c.nameCn, c.name])
    .filter(Boolean);
  const textParts = [
    series.title,
    bangumi?.name,
    bangumi?.name_cn,
    ...(series.alternateTitles || []),
    ...(series.authors || []),
    ...(series.publishers || []),
    ...(series.tags || []),
    series.brief,
    ...resources.map(r => r.title),
    ...resources.map(r => r.originalTitle),
    ...volumeTexts,
    ...translationTexts,
    ...relationNames,
    ...persons,
    ...characters,
  ].filter(Boolean);

  return {
    seriesId: series.seriesId,
    text: textParts.join('\n'),
    normalizedText: normalizeText(textParts.join(' ')),
    tags: series.tags || [],
    updatedAt: new Date().toISOString(),
  };
}

async function writeSeriesBundle(series, resources, extra = {}) {
  await ensureSeriesFiles(series.seriesId);
  const dir = seriesStorageDir(series.seriesId);
  const normalizedResources = deduplicateResources(resources);
  const currentBangumi = await readJson(path.join(dir, 'bangumi.json'), emptyBangumi());
  const currentTranslations = await readJson(path.join(dir, 'translations.json'), []);
  const currentVolumeDetails = await readJson(path.join(dir, 'volume_details.json'), {});
  const bangumi = extra.bangumi || currentBangumi || emptyBangumi();
  const translations = extra.translations || currentTranslations || [];
  const volumeDetails = extra.volumeDetails || currentVolumeDetails || {};
  const mergedSeries = {
    schemaVersion: 1,
    ...series,
    tags: unique([
      ...(series.tags || []),
      ...(bangumi.tags || []),
      ...(bangumi.metaTags || []),
    ]),
    lastUpdatedAt: new Date().toISOString(),
  };

  await writeJson(path.join(dir, 'series.json'), mergedSeries);
  await writeJson(path.join(dir, 'resources.json'), normalizedResources);
  if (extra.bangumi) await writeJson(path.join(dir, 'bangumi.json'), extra.bangumi);
  if (extra.relations) await writeJson(path.join(dir, 'relations.json'), extra.relations);
  if (extra.persons) await writeJson(path.join(dir, 'persons.json'), extra.persons);
  if (extra.characters) await writeJson(path.join(dir, 'characters.json'), extra.characters);
  if (extra.translations) await writeJson(path.join(dir, 'translations.json'), extra.translations);
  if (extra.volumeDetails) await writeJson(path.join(dir, 'volume_details.json'), volumeDetails);
  await writeJson(
    path.join(dir, 'search.json'),
    buildSearchDoc(mergedSeries, normalizedResources, bangumi, translations, volumeDetails)
  );
  notifyLibraryChanged('series_bundle_written', {
    seriesId: mergedSeries.seriesId,
    resourceCount: normalizedResources.length,
  });

  return mergedSeries;
}

async function readSeriesBundle(seriesId) {
  const dir = seriesStorageDir(seriesId);
  const series = await readJson(path.join(dir, 'series.json'), null);
  if (!series?.seriesId) return null;
  return {
    series,
    resources: deduplicateResources(await readJson(path.join(dir, 'resources.json'), [])),
    bangumi: await readJson(path.join(dir, 'bangumi.json'), emptyBangumi()),
    translations: await readJson(path.join(dir, 'translations.json'), []),
    volumeDetails: await readJson(path.join(dir, 'volume_details.json'), {}),
    relations: await readJson(path.join(dir, 'relations.json'), []),
    persons: await readJson(path.join(dir, 'persons.json'), []),
    characters: await readJson(path.join(dir, 'characters.json'), []),
    search: await readJson(path.join(dir, 'search.json'), {}),
    overrides: await readJson(path.join(dir, 'overrides.json'), {}),
  };
}

async function readIndex(name, fallback) {
  return readJson(path.join(INDEX_DIR, name), fallback);
}

async function writeIndex(name, data) {
  return writeJson(path.join(INDEX_DIR, name), data);
}

function buildSeriesIndexEntry(series) {
  return {
    seriesId: series.seriesId,
    title: series.title,
    titleNormalized: series.titleNormalized,
    alternateTitles: series.alternateTitles || [],
    authors: series.authors || [],
    publishers: series.publishers || [],
    tags: series.tags || [],
    cover: series.cover || '',
    bangumiSubjectId: series.bangumiSubjectId || null,
    metadataKey: series.metadataKey || '',
    sourceUrl: series.sourceUrl || '',
    category: series.category || 'comic',
    hasVolumes: !!series.hasVolumes,
    hasChapters: !!series.hasChapters,
    hasMixedResources: !!series.hasMixedResources,
    contentMode: series.contentMode || '',
    latestAddedAt: series.latestAddedAt || '',
    updatedAt: series.lastUpdatedAt || '',
    source: series.source || '',
  };
}

function buildTagIndex(seriesIndex) {
  const tagMap = new Map();
  const seenTagOwners = new Set();
  for (const series of seriesIndex) {
    const ownerId = series.bangumiSubjectId
      ? `subject:${series.bangumiSubjectId}`
      : `series:${series.seriesId}`;
    for (const tag of series.tags || []) {
      const key = normalizeText(tag);
      if (!key) continue;
      const ownerKey = `${key}|${ownerId}`;
      if (seenTagOwners.has(ownerKey)) continue;
      seenTagOwners.add(ownerKey);
      if (!tagMap.has(key)) tagMap.set(key, { name: tag, count: 0, seriesIds: [] });
      const item = tagMap.get(key);
      item.count += 1;
      item.seriesIds.push(series.seriesId);
    }
  }
  return Array.from(tagMap.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function buildSubjectIndex(seriesIndex) {
  return seriesIndex
    .filter(s => s.bangumiSubjectId)
    .map(s => ({
      subjectId: s.bangumiSubjectId,
      seriesId: s.seriesId,
      title: s.title,
      category: s.category || 'comic',
    }));
}

async function writeDerivedIndexes(seriesIndex, resourceIndex) {
  await writeIndex('series-index.json', seriesIndex);
  await writeIndex('resource-index.json', resourceIndex);
  await writeIndex('tag-index.json', buildTagIndex(seriesIndex));
  await writeIndex('subject-index.json', buildSubjectIndex(seriesIndex));
  notifyLibraryChanged('derived_indexes_written', {
    seriesCount: Array.isArray(seriesIndex) ? seriesIndex.length : 0,
    resourceCount: resourceIndex ? Object.keys(resourceIndex).length : 0,
  });
}

async function rebuildIndexes(seriesList, resourceList) {
  return withIndexOperation(async () => {
    const currentSeriesIndex = await readIndex('series-index.json', []);
    const desiredSeriesEntries = (seriesList || []).map(buildSeriesIndexEntry);
    const desiredSeriesById = new Map(desiredSeriesEntries.map(entry => [entry.seriesId, entry]));
    const seriesIndex = [];

    for (const current of Array.isArray(currentSeriesIndex) ? currentSeriesIndex : []) {
      const desired = desiredSeriesById.get(current.seriesId);
      if (!desired) continue;
      seriesIndex.push(desired);
      desiredSeriesById.delete(current.seriesId);
    }
    for (const entry of desiredSeriesEntries) {
      if (!desiredSeriesById.has(entry.seriesId)) continue;
      seriesIndex.push(entry);
      desiredSeriesById.delete(entry.seriesId);
    }

    const currentResourceIndex = await readIndex('resource-index.json', {});
    const desiredResources = Array.isArray(resourceList) ? resourceList : [];
    const desiredResourceById = new Map(desiredResources.map(resource => [resource.resourceId, resource]));
    const resourceIndex = {};

    for (const [resourceId] of Object.entries(currentResourceIndex || {})) {
      const desired = desiredResourceById.get(resourceId);
      if (!desired) continue;
      resourceIndex[resourceId] = desired;
      desiredResourceById.delete(resourceId);
    }
    for (const resource of desiredResources) {
      if (!desiredResourceById.has(resource.resourceId)) continue;
      resourceIndex[resource.resourceId] = resource;
      desiredResourceById.delete(resource.resourceId);
    }

    const tagIndex = buildTagIndex(seriesIndex);
    const subjectIndex = buildSubjectIndex(seriesIndex);
    const currentTagIndex = await readIndex('tag-index.json', []);
    const currentSubjectIndex = await readIndex('subject-index.json', []);
    const changed = !jsonEqual(currentSeriesIndex, seriesIndex) ||
      !jsonEqual(currentResourceIndex || {}, resourceIndex) ||
      !jsonEqual(currentTagIndex, tagIndex) ||
      !jsonEqual(currentSubjectIndex, subjectIndex);
    if (changed) await writeDerivedIndexes(seriesIndex, resourceIndex);
    return { seriesIndex, resourceIndex, changed };
  });
}

async function upsertSeriesIndexes(series, resources) {
  return withIndexOperation(async () => {
    const entry = buildSeriesIndexEntry(series);
    const currentSeriesIndex = await readIndex('series-index.json', []);
    const nextSeriesIndex = Array.isArray(currentSeriesIndex) ? [...currentSeriesIndex] : [];
    const existingSeriesIndex = nextSeriesIndex.findIndex(item => item.seriesId === series.seriesId);
    if (existingSeriesIndex >= 0) nextSeriesIndex[existingSeriesIndex] = entry;
    else nextSeriesIndex.push(entry);

    const currentResourceIndex = await readIndex('resource-index.json', {});
    const desiredResources = Array.isArray(resources) ? resources : [];
    const desiredResourceById = new Map(desiredResources.map(resource => [resource.resourceId, resource]));
    const nextResourceIndex = {};

    for (const [resourceId, resource] of Object.entries(currentResourceIndex || {})) {
      if (resource?.seriesId !== series.seriesId) {
        nextResourceIndex[resourceId] = resource;
        continue;
      }
      const desired = desiredResourceById.get(resourceId);
      if (!desired) continue;
      nextResourceIndex[resourceId] = desired;
      desiredResourceById.delete(resourceId);
    }
    for (const resource of desiredResources) {
      if (!desiredResourceById.has(resource.resourceId)) continue;
      nextResourceIndex[resource.resourceId] = resource;
      desiredResourceById.delete(resource.resourceId);
    }

    const tagIndex = buildTagIndex(nextSeriesIndex);
    const subjectIndex = buildSubjectIndex(nextSeriesIndex);
    const currentTagIndex = await readIndex('tag-index.json', []);
    const currentSubjectIndex = await readIndex('subject-index.json', []);
    const changed = !jsonEqual(currentSeriesIndex, nextSeriesIndex) ||
      !jsonEqual(currentResourceIndex || {}, nextResourceIndex) ||
      !jsonEqual(currentTagIndex, tagIndex) ||
      !jsonEqual(currentSubjectIndex, subjectIndex);
    if (changed) await writeDerivedIndexes(nextSeriesIndex, nextResourceIndex);
    return { seriesIndex: nextSeriesIndex, resourceIndex: nextResourceIndex, changed };
  });
}

async function readLibraryIndexes() {
  return withIndexOperation(async () => ({
    seriesIndex: await readIndex('series-index.json', []),
    resourceIndex: await readIndex('resource-index.json', {}),
  }));
}

async function persistLibrary(seriesMap) {
  await ensureMetadataLayout();
  const seriesList = [];
  const resourceList = [];
  for (const item of seriesMap.values()) {
    const persisted = await writeSeriesFromScanItem(item);
    seriesList.push(persisted.series);
    resourceList.push(...persisted.resources);
  }
  await rebuildIndexes(seriesList, resourceList);
  return { seriesList, resourceList };
}

async function persistLibraryChanges(seriesMap) {
  const seriesList = [];
  const resourceList = [];
  for (const item of seriesMap.values()) {
    // Keep an empty bundle so stale resources cannot reappear through detail/scrape paths.
    const persisted = await writeSeriesFromScanItem(item);
    if (persisted.resources.length) seriesList.push(persisted.series);
    resourceList.push(...persisted.resources);
  }
  if (!seriesMap.size) return { seriesList, resourceList };
  await withIndexOperation(async () => {
    const affected = new Set(seriesMap.keys());
    const currentSeries = await readIndex('series-index.json', []);
    const currentResources = await readIndex('resource-index.json', {});
    const replacements = new Map(seriesList.map(series => [series.seriesId, buildSeriesIndexEntry(series)]));
    const seriesIndex = currentSeries.flatMap(series => {
      if (!affected.has(series.seriesId)) return [series];
      const replacement = replacements.get(series.seriesId);
      replacements.delete(series.seriesId);
      return replacement ? [replacement] : [];
    });
    seriesIndex.push(...replacements.values());
    const desired = new Map(resourceList.map(resource => [resource.resourceId, resource]));
    const resourceIndex = {};
    for (const [id, resource] of Object.entries(currentResources)) {
      if (!affected.has(resource.seriesId)) resourceIndex[id] = resource;
      else if (desired.has(id)) { resourceIndex[id] = desired.get(id); desired.delete(id); }
    }
    for (const [id, resource] of desired) resourceIndex[id] = resource;
    if (!jsonEqual(currentSeries, seriesIndex) || !jsonEqual(currentResources, resourceIndex)) {
      await writeDerivedIndexes(seriesIndex, resourceIndex);
    }
  });
  return { seriesList, resourceList };
}

async function normalizeSeriesForScanPersist(item) {
  const currentSeries = { ...(item?.series || {}) };
  const resources = deduplicateResources(item?.resources);
  const previous = await readSeriesBundle(currentSeries.seriesId);
  const bangumi = previous?.bangumi || emptyBangumi();
  const customCoverPrefix = `/api/series/${encodeURIComponent(currentSeries.seriesId)}/custom-cover`;

  if (String(previous?.series?.cover || '').startsWith(customCoverPrefix)) {
    currentSeries.cover = previous.series.cover;
  }
  if (previous?.series?.lastMatchedAt) currentSeries.lastMatchedAt = previous.series.lastMatchedAt;

  const hasPersistedScrapeResult = protection.hasResult(previous);

  if (hasPersistedScrapeResult) {
    {
      for (const field of ['metadataKey', 'sourceUrl', 'publishers', 'status', 'cover', 'source', 'language']) {
        currentSeries[field] = previous.series?.[field] ?? currentSeries[field];
      }
      const oldResources = new Map((previous.resources || []).map(resource => [resource.resourceId, resource]));
      for (const resource of resources) {
        const old = oldResources.get(resource.resourceId);
        if (!old || old.fileHash !== resource.fileHash || old.modifiedTime !== resource.modifiedTime) continue;
        for (const field of ['title', 'titleLocalizationProvider', 'detailKey', 'metadataKey', 'sourceUrl',
          'firstIndexedAt', 'contentType', 'detectedNumber', 'detectedNumberEnd', 'detectedNumberType', 'volumeNumber', 'chapterNumber']) {
          if (old[field] !== undefined) resource[field] = old[field];
        }
      }
    }
    currentSeries.title = previous.series?.title || currentSeries.title;
    currentSeries.titleNormalized = previous.series?.titleNormalized || currentSeries.titleNormalized;
    currentSeries.alternateTitles = previous.series?.alternateTitles || currentSeries.alternateTitles;
    currentSeries.authors = previous.series?.authors || currentSeries.authors;
    currentSeries.brief = previous.series?.brief || currentSeries.brief;
    currentSeries.bangumiSubjectId = bangumi.subjectId || null;
    currentSeries.tags = previous.series?.tags || currentSeries.tags;
  }

  return {
    series: currentSeries,
    resources,
    previous,
  };
}

const SCAN_SERIES_FIELDS = [
  'schemaVersion',
  'seriesId',
  'title',
  'titleNormalized',
  'alternateTitles',
  'authors',
  'publishers',
  'language',
  'category',
  'contentMode',
  'status',
  'tags',
  'cover',
  'bangumiSubjectId',
  'hasVolumes',
  'hasChapters',
  'hasMixedResources',
  'source',
  'lastMatchedAt',
  'latestAddedAt',
  'brief',
];

function comparableScanSeries(series) {
  return Object.fromEntries(SCAN_SERIES_FIELDS.map(field => [field, series?.[field]]));
}

function comparableScanResources(resources) {
  return (Array.isArray(resources) ? resources : [])
    .map(resource => {
      const comparable = { ...resource };
      delete comparable.lastIndexedAt;
      return comparable;
    })
    .sort((a, b) => String(a.resourceId || '').localeCompare(String(b.resourceId || '')));
}

function scanBundleUnchanged(previous, series, resources) {
  if (!previous?.series) return false;
  return jsonEqual(comparableScanSeries(previous.series), comparableScanSeries(series)) &&
    jsonEqual(comparableScanResources(previous.resources), comparableScanResources(resources));
}

async function writeSeriesFromScanItem(item) {
  const seriesId = item?.series?.seriesId;
  return withSeriesOperation(seriesId, async () => {
    await ensureMetadataLayout();
    const normalized = await normalizeSeriesForScanPersist(item);
    if (scanBundleUnchanged(normalized.previous, normalized.series, normalized.resources)) {
      return {
        series: normalized.previous.series,
        resources: normalized.previous.resources,
        changed: false,
      };
    }
    let extra;
    if (protection.hasResult(normalized.previous)) {
      const old = new Map(normalized.previous.resources.map(resource => [resource.resourceId, resource]));
      const changed = normalized.resources.filter(resource => protection.resourceChanged(old.get(resource.resourceId), resource));
      if (changed.length) extra = { bangumi: { ...normalized.previous.bangumi,
        pendingResourceIds: unique([...(normalized.previous.bangumi.pendingResourceIds || []), ...changed.map(resource => resource.resourceId)]) } };
    }
    const writtenSeries = await writeSeriesBundle(normalized.series, normalized.resources, extra);
    return {
      series: writtenSeries,
      resources: normalized.resources,
      changed: true,
    };
  });
}

async function getResource(resourceId) {
  const index = await readIndex('resource-index.json', {});
  return index[resourceId] || null;
}

async function updateBangumi(seriesId, data) {
  return withSeriesOperation(seriesId, async () => {
    const bundle = await readSeriesBundle(seriesId);
    if (!bundle) throw new Error(`Series not found: ${seriesId}`);
    const bangumi = {
      ...emptyBangumi(),
      ...(data.replace ? {} : bundle.bangumi || {}),
      ...data.bangumi,
      detailsSchemaVersion: Number(
        data.bangumi?.detailsSchemaVersion || bundle.bangumi?.detailsSchemaVersion || 1
      ),
      detailsFetchedAt: new Date().toISOString(),
    };
    const baseSeries = data.replace ? { ...bundle.series, ...data.series } : bundle.series;
    const resources = data.resources || bundle.resources;
    const series = {
      ...baseSeries,
      title: bangumi.name_cn || bangumi.name || bundle.series.title,
      titleNormalized: normalizeText(bangumi.name_cn || bangumi.name || bundle.series.title),
      alternateTitles: unique([
        baseSeries.title,
        ...(baseSeries.alternateTitles || []),
        bangumi.name,
        bangumi.name_cn,
      ].filter(Boolean)),
      authors: (bangumi.authors && bangumi.authors.length > 0)
        ? bangumi.authors
        : baseSeries.authors,
      bangumiSubjectId: bangumi.subjectId || null,
      brief: data.replace ? data.brief || '' : data.brief || bundle.series.brief,
      tags: bangumi.subjectId
        ? unique([...(bangumi.tags || []), ...(bangumi.metaTags || [])])
        : unique(bundle.series.tags || []),
      lastMatchedAt: new Date().toISOString(),
    };
    const writtenSeries = await writeSeriesBundle(series, resources, {
      bangumi,
      relations: data.relations || bangumi.relatedSubjects || [],
      persons: data.persons || bangumi.persons || [],
      characters: data.characters || bangumi.characters || [],
      translations: data.translations || bundle.translations || [],
      volumeDetails: data.volumeDetails || bundle.volumeDetails || {},
    });

    await upsertSeriesIndexes(writtenSeries, resources);
    return readSeriesBundle(seriesId);
  });
}

function makeSeriesId(titleNormalized) {
  return `series-${hashString(titleNormalized || 'untitled', 20)}`;
}

async function readVolumeTranslations(seriesId) {
  const details = await readVolumeDetails(seriesId);
  const out = {};
  for (const [subjectId, detail] of Object.entries(details || {})) {
    out[subjectId] = {
      translatedText: detail.translatedSummary || '',
      sourceText: detail.summary || '',
      translatedAt: detail.translation?.translatedAt || detail.updatedAt || '',
      fieldName: 'summary',
    };
  }
  return out;
}

async function writeVolumeTranslation(seriesId, subjectId, data) {
  // Backward-compatible API; writes into unified volume_details.json
  return upsertVolumeDetail(seriesId, subjectId, {
    translatedSummary: data.translatedText || '',
    summary: data.sourceText || '',
    translation: {
      fieldName: data.fieldName || 'summary',
      translatedAt: data.translatedAt || new Date().toISOString(),
      provider: 'deepseek',
      status: data.translatedText ? 'translated' : 'empty',
    },
  });
}

async function readVolumeDetails(seriesId) {
  const dir = seriesStorageDir(seriesId);
  return readJson(path.join(dir, 'volume_details.json'), {});
}

async function updateSeriesOverrides(seriesId, patch = {}) {
  await ensureSeriesFiles(seriesId);
  const dir = seriesStorageDir(seriesId);
  const current = await readJson(path.join(dir, 'overrides.json'), {});
  const next = {
    ...(current || {}),
    ...(patch || {}),
    updatedAt: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) delete next[key];
  }
  await writeJson(path.join(dir, 'overrides.json'), next);
  return next;
}

async function upsertVolumeDetail(seriesId, subjectId, data) {
  const dir = seriesStorageDir(seriesId);
  const current = await readJson(path.join(dir, 'volume_details.json'), {});
  const key = String(subjectId);
  const prev = current[key] || {};
  const next = {
    ...prev,
    ...data,
    subjectId: Number(subjectId) || prev.subjectId || null,
    updatedAt: new Date().toISOString(),
  };
  if (Array.isArray(prev.resourceIds) || Array.isArray(data.resourceIds)) {
    next.resourceIds = unique([...(prev.resourceIds || []), ...(data.resourceIds || [])]);
  }
  if (Array.isArray(prev.volumeNumbers) || Array.isArray(data.volumeNumbers)) {
    next.volumeNumbers = unique([...(prev.volumeNumbers || []), ...(data.volumeNumbers || [])]);
  }
  current[key] = next;
  await writeJson(path.join(dir, 'volume_details.json'), current);
  return next;
}

module.exports = {
  buildSearchDoc,
  emptyBangumi,
  ensureMetadataLayout,
  getResource,
  makeSeriesId,
  persistLibrary,
  persistLibraryChanges,
  readIndex,
  readLibraryIndexes,
  readSeriesBundle,
  readVolumeDetails,
  readVolumeTranslations,
  rebuildIndexes,
  seriesStorageDir,
  upsertSeriesIndexes,
  upsertVolumeDetail,
  updateSeriesOverrides,
  updateBangumi,
  withSeriesOperation,
  writeSeriesFromScanItem,
  writeIndex,
  writeSeriesBundle,
  writeVolumeTranslation,
};

// Request-scoped filtering happens before work/version aggregation. Background
// scanners have no request context and retain access to the complete index.
const access = require('./access');
async function permittedIndexes() {
  const indexes = await readLibraryIndexes();
  if (!access.isReader()) return indexes;
  const resourceIndex = Object.fromEntries(Object.entries(indexes.resourceIndex || {}).filter(([, r]) => access.canRead(r)));
  const visible = new Set(Object.values(resourceIndex).map(r => r.seriesId));
  return { ...indexes, resourceIndex, seriesIndex: indexes.seriesIndex.filter(s => visible.has(s.seriesId)) };
}
module.exports.readLibraryIndexes = permittedIndexes;
module.exports.getResource = async id => { const r = await getResource(id); return access.canRead(r) ? r : null; };
module.exports.readSeriesBundle = async id => {
  const bundle = await readSeriesBundle(id);
  if (!access.isReader() || !bundle) return bundle;
  const resources = bundle.resources.filter(access.canRead);
  return resources.length ? { ...bundle, resources } : null;
};
module.exports.readIndex = async (name, fallback) => {
  if (!access.isReader()) return readIndex(name, fallback);
  const indexes = await permittedIndexes();
  if (name === 'resource-index.json') return indexes.resourceIndex;
  if (name === 'series-index.json') return indexes.seriesIndex;
  if (name === 'tag-index.json') return buildTagIndex(indexes.seriesIndex);
  if (name === 'subject-index.json') return buildSubjectIndex(indexes.seriesIndex);
  return readIndex(name, fallback);
};
