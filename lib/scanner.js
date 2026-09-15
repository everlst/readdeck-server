const fs = require('fs').promises;
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config');
const settingsStore = require('./settingsStore');
const { allowedPath } = require('./resourcePaths');
const {
  makeSeriesId,
  persistLibrary,
  persistLibraryChanges,
  readLibraryIndexes,
  readSeriesBundle,
} = require('./metadataStore');
const { parseName } = require('./nameParser');
const { isIgnoredLibraryEntry: shouldIgnoreEntry } = require('./libraryIgnore');
const { probeReadable } = require('./readerProvider');
const { hasEpubCover } = require('./epubProvider');
const {
  hashString,
  isCoverFile,
  isImageFile,
  looksLikeLibraryMountSegment,
  naturalCompare,
  normalizeText,
  readJson,
  safePath,
  unique,
} = require('./utils');

const RESOURCE_EXTS = new Map([
  ['.zip', 'zip'],
  ['.cbz', 'cbz'],
  ['.rar', 'rar'],
  ['.pdf', 'pdf'],
  ['.epub', 'epub'],
]);
const IMAGE_RESOURCE_EXTS = new Set(['.avif', '.bmp', '.gif', '.jpg', '.jpeg', '.png', '.webp']);
const SINGLE_FILE_VOLUME_TYPES = new Set(RESOURCE_EXTS.values());

const scanErrorStorage = new AsyncLocalStorage();
let scanOperationChain = Promise.resolve();

function recordScanIoError(targetPath, error) {
  if (!error) return;
  scanErrorStorage.getStore()?.push({ path: targetPath, error });
}

async function listDirSafe(dir) {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    recordScanIoError(dir, error);
    return [];
  }
}

async function statSafe(targetPath) {
  try {
    if ((await fs.lstat(targetPath)).isSymbolicLink()) return null;
    const source = config.LIBRARY_SOURCES.find(s => settingsStore.contains(s.path, path.resolve(targetPath)));
    await allowedPath(source, targetPath, { allowRoot: true });
    return await fs.stat(targetPath);
  } catch (error) {
    recordScanIoError(targetPath, error);
    return null;
  }
}

async function statOptional(targetPath) {
  try {
    if ((await fs.lstat(targetPath)).isSymbolicLink()) return null;
    const source = config.LIBRARY_SOURCES.find(s => settingsStore.contains(s.path, path.resolve(targetPath)));
    await allowedPath(source, targetPath, { allowRoot: true });
    return await fs.stat(targetPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') recordScanIoError(targetPath, error);
    return null;
  }
}

async function walkImages(rootDir, recursive = true) {
  const out = [];

  async function walk(dir) {
    const entries = await listDirSafe(dir);
    for (const entry of entries.sort(naturalCompare)) {
      if (shouldIgnoreEntry(entry)) continue;
      const fp = path.join(dir, entry);
      const stat = await statSafe(fp);
      if (!stat) continue;
      if (stat.isDirectory() && recursive) await walk(fp);
      else if (stat.isFile() && isImageFile(entry)) out.push(fp);
    }
  }

  await walk(rootDir);
  return out;
}

function makeScanContext(rootDir = config.LIBRARY_DIR, options = {}) {
  const categoryOverride = options.categoryOverride || '';
  return {
    rootDir,
    sourceId: options.sourceId || '',
    source: options.source || null,
    categoryOverride,
    idScope: options.idScope || '',
    allowMountExpansion: options.allowMountExpansion !== false,
    fastScan: options.fast === true,
  };
}

async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const maxWorkers = Math.max(1, Number(limit || 1));
  let cursor = 0;

  async function runWorker() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      await worker(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxWorkers, list.length) }, () => runWorker()));
}

function relativeToContext(ctx, absPath) {
  return path.relative(ctx?.rootDir || config.LIBRARY_DIR, absPath);
}

function resourceIdScopePrefix(ctx) {
  return ctx?.idScope ? `${ctx.idScope}:` : '';
}

function categoryForResource(type, ctx) {
  if (ctx?.categoryOverride) return ctx.categoryOverride;
  return type === 'epub' ? 'novel' : 'comic';
}

function categoryForResources(resources, ctx) {
  if (ctx?.categoryOverride) return ctx.categoryOverride;
  const list = Array.isArray(resources) ? resources : [];
  return list.length > 0 && list.every(resource => resource.category === 'novel')
    ? 'novel'
    : 'comic';
}

function isPathBoundCategory(category) {
  return !!category && config.PATH_BOUND_LIBRARY_CATEGORY_KEYS?.has(category);
}

function mergeSeriesCategory(current, next) {
  if (!next) return current || 'comic';
  if (!current || current === next) return next;
  if (isPathBoundCategory(current)) return current;
  if (isPathBoundCategory(next)) return next;
  if (current === 'comic' || next === 'comic') return 'comic';
  if (current === 'novel' || next === 'novel') return 'novel';
  return next;
}

function makeScopedSeriesId(parsed, fallbackName, ctx, categoryHint = '') {
  const normalized = parsed?.titleNormalized || normalizeText(fallbackName);
  const category = ctx?.categoryOverride || categoryHint || 'comic';
  return makeSeriesId(category === 'comic' ? normalized : `${category}:${normalized}`);
}

function preserveSeriesId(parsed, name, ctx, category, previous, sourcePaths) {
  const paths = new Set(sourcePaths);
  const ids = new Set(Object.values(previous).filter(resource => paths.has(resource.sourcePath))
    .map(resource => resource.seriesId).filter(Boolean));
  if (ids.size === 1) return [...ids][0];
  const localId = makeScopedSeriesId(parsed, name, ctx, category);
  if (!ids.size) {
    const siblings = new Set(Object.values(previous).filter(resource => resource.sourceId === ctx.sourceId &&
      sourcePaths.some(sourcePath => path.dirname(sourcePath) === path.dirname(resource.sourcePath)) &&
      makeScopedSeriesId(parseName(path.basename(resource.sourcePath)), '', ctx, resource.category) === localId)
      .map(resource => resource.seriesId).filter(Boolean));
    if (siblings.size === 1) return [...siblings][0];
  }
  return localId;
}

function extensionType(name) {
  return RESOURCE_EXTS.get(path.extname(name || '').toLowerCase()) || '';
}

function singleFileResourceType(name) {
  return extensionType(name) || (IMAGE_RESOURCE_EXTS.has(path.extname(name || '').toLowerCase()) ? 'image' : '');
}

function parseScanName(name, context) {
  const local = parseName(name);
  if (context.kind !== 'series_directory' && !local.volumeRange && !local.chapterRange) {
    const parent = normalizeText(context.parentName || '');
    const kind = /单行本|單行本|tankobon|vol(?:ume)?|卷|冊|册/i.test(parent) ? 'volume'
      : /默认|默認|default|chap(?:ter)?|单话|單話|章节|章節|话|話/i.test(parent) ? 'chapter' : '';
    if (kind) { local.contentType = kind; local.detectedNumberType = kind; }
  }
  return local;
}

function cleanResourceDisplayName(name) {
  const value = String(name || '').trim();
  const ext = path.extname(value).toLowerCase();
  const base = RESOURCE_EXTS.has(ext) || IMAGE_RESOURCE_EXTS.has(ext)
    ? path.basename(value, ext)
    : path.basename(value);
  return String(base || value).trim();
}

function originalResourceTitle(parsed) {
  const base = cleanResourceDisplayName(parsed?.originalName || parsed?.title || '');
  const withoutOrderPrefix = base.replace(/^\d+(?:\.\d+)?\s+(.+)$/, '$1').trim();
  return withoutOrderPrefix || parsed?.title || base;
}

function looksLikeResourceDirectory(name) {
  const parsed = parseName(name);
  if (parsed.detectedNumberType) return true;
  return /(?:vol(?:ume)?|chap(?:ter)?|第|卷|冊|册|话|話)/i.test(name) ||
    /^\d{1,3}(?:\s*[-~～至到]\s*\d{1,3})?(?:\s*(?:完|未完))?$/.test(String(name || '').trim());
}

function relativePathParts(relativePath) {
  const parts = String(relativePath || '').split(/[\\/]/).filter(Boolean);
  while (parts.length > 1 && looksLikeLibraryMountSegment(parts[0])) {
    parts.shift();
  }
  return parts;
}

function resourceGroupFromRelativePath(relativePath) {
  const parts = relativePathParts(relativePath);
  if (parts.length < 3) return null;
  const groupName = parts[parts.length - 2];
  if (!groupName || shouldIgnoreEntry(groupName)) return null;
  return {
    groupKey: normalizeText(groupName) || groupName,
    groupName,
  };
}

function applyResourceGroup(resource) {
  const group = resourceGroupFromRelativePath(resource?.relativePath || '');
  if (!group) return resource;
  resource.groupKey = group.groupKey;
  resource.groupName = group.groupName;
  return resource;
}

function looksLikeLibraryMountName(name) {
  return looksLikeLibraryMountSegment(name);
}

function formatVolumeTitle(number) {
  const numeric = Number(number || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  const [integerPart, fractionPart] = String(numeric).split('.');
  const padded = integerPart.padStart(2, '0');
  return fractionPart ? `Vol.${padded}.${fractionPart}` : `Vol.${padded}`;
}

function applyResourceKind(resource, kind, number = null, numberEnd = null) {
  if (!resource || !kind) return resource;
  const safeNumber = Number(number || 0) || null;
  const safeNumberEnd = Number(numberEnd || 0) || safeNumber;
  resource.contentType = kind;
  resource.detectedNumberType = kind;
  if (safeNumber) resource.detectedNumber = safeNumber;
  if (safeNumberEnd) resource.detectedNumberEnd = safeNumberEnd;
  resource.volumeNumber = kind === 'volume' ? (safeNumber || null) : null;
  resource.chapterNumber = kind === 'chapter' ? (safeNumber || null) : null;
  if (kind === 'volume' && safeNumber) {
    resource.title = formatVolumeTitle(safeNumber);
  } else if (kind === 'chapter' && safeNumber) {
    resource.title = resource.originalTitle || resource.title ||
      `Chap.${safeNumber}${safeNumberEnd && safeNumberEnd !== safeNumber ? `-${safeNumberEnd}` : ''}`;
  }
  return resource;
}

function inferEpubVolumeNumberFromName(name) {
  const base = cleanResourceDisplayName(name);
  const match = base.match(/(?:系列|シリーズ|series)\s*0*([1-9]\d{0,2})(?=[\].\s_-]|$)/i);
  return match ? Number(match[1]) : null;
}

function applyEpubVolumeNumberHint(resource, entry) {
  if (resource?.parseHints?.provider === 'ai') return resource;
  if (!resource || resource.type !== 'epub' || resource.detectedNumber) return resource;
  const number = inferEpubVolumeNumberFromName(entry);
  if (!number) return resource;
  resource.detectedNumber = number;
  resource.detectedNumberEnd = number;
  resource.detectedNumberType = 'volume';
  resource.contentType = 'volume';
  resource.volumeNumber = number;
  resource.chapterNumber = null;
  return resource;
}

function isNovelBookResource(resource) {
  return resource?.type === 'epub' || resource?.category === 'novel';
}

function applyNovelBookVolumeDefaults(resource) {
  if (resource?.parseHints?.provider === 'ai' && resource.contentType !== 'unknown') return resource;
  if (!isNovelBookResource(resource)) return resource;
  const number = Number(resource.detectedNumber || 0) || null;
  resource.contentType = 'volume';
  resource.detectedNumberType = 'volume';
  resource.volumeNumber = number;
  resource.chapterNumber = null;
  if (number) resource.title = formatVolumeTitle(number);
  return resource;
}

function shouldDefaultFileResourceToVolume(resource, parsed) {
  if (parsed?.parseHints?.provider === 'ai') return parsed.contentType === 'unknown' && SINGLE_FILE_VOLUME_TYPES.has(resource?.type);
  if (!SINGLE_FILE_VOLUME_TYPES.has(resource?.type)) return false;
  if (isNovelBookResource(resource)) return true;
  if (parsed?.contentType === 'mixed_bundle') return false;
  return !parsed?.chapterRange && parsed?.detectedNumberType !== 'chapter';
}

async function applyStructureKindIfAmbiguous(resource, parsed) {
  const probe = await probeReadable(resource);
  if (shouldDefaultFileResourceToVolume(resource, parsed)) {
    applyResourceKind(resource, 'volume', resource.detectedNumber, resource.detectedNumberEnd);
  } else if (parsed.parseHints?.provider !== 'ai' && !parsed.volumeRange && !parsed.chapterRange && !parsed.detectedNumberType && probe.structureType) {
    applyResourceKind(resource, probe.structureType, resource.detectedNumber, resource.detectedNumberEnd);
  }
  return { resource, probe };
}

async function applyProbeResult(resource, probe) {
  resource.pageCount = Number(probe?.pageCount || 0);
  resource.readable = probe?.readable !== false;
  resource.readError = probe?.error || '';
  if (resource.pageCount > 0 || (resource.type === 'epub' && await hasEpubCover(resource))) {
    resource.coverCandidate = `/api/resources/${encodeURIComponent(resource.resourceId)}/cover`;
  }
  return resource;
}

async function refreshProbeResultIfNeeded(resource, parsed) {
  const hasUsablePageCount = Number(resource.pageCount || 0) > 0 && resource.readable !== false;
  const shouldRefresh =
    !hasUsablePageCount ||
    (!parsed.volumeRange && !parsed.chapterRange);
  if (!shouldRefresh) return resource;
  const result = await applyStructureKindIfAmbiguous(resource, parsed).catch(() => null);
  if (result?.probe && !hasUsablePageCount) await applyProbeResult(resource, result.probe);
  return resource;
}

function applyFastResourceDefaults(resource, parsed) {
  if (shouldDefaultFileResourceToVolume(resource, parsed)) {
    applyResourceKind(resource, 'volume', resource.detectedNumber, resource.detectedNumberEnd);
  }
  resource.readable = true;
  resource.readError = '';
  resource.pageCount = resource.type === 'image' ? 1 : Number(resource.pageCount || 0);
  resource.coverCandidate = `/api/resources/${encodeURIComponent(resource.resourceId)}/cover`;
  return resource;
}

async function inferDirectoryResourceKind(absPath) {
  const entries = await listDirSafe(absPath);
  const directImages = entries.filter(entry => isImageFile(entry) && !isCoverFile(entry)).length;
  if (directImages > 0) return 'chapter';

  for (const entry of entries) {
    if (shouldIgnoreEntry(entry)) continue;
    const fp = path.join(absPath, entry);
    const stat = await statSafe(fp);
    if (!stat?.isDirectory()) continue;
    const images = await walkImages(fp, true);
    if (images.length > 0) return 'volume';
  }
  return '';
}

async function shouldScanAsLibraryMount(entry, absPath) {
  if (!looksLikeLibraryMountName(path.basename(entry))) return false;
  const childEntries = await listDirSafe(absPath);
  if (childEntries.some(child => isImageFile(child))) return false;
  return childEntries.some(child => !shouldIgnoreEntry(child));
}

async function fastFileHash(filePath, stat) {
  return hashString(`${filePath}|${stat?.size || 0}|${stat?.mtimeMs || 0}`, 24);
}

function baseResource(relativePath, sourcePath, stat, parsed, type, seriesId, ctx = null) {
  const resourceId = hashString(`${resourceIdScopePrefix(ctx)}${type}:${relativePath}`, 24);
  const indexedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    resourceId,
    sourceId: ctx?.sourceId || '',
    seriesRelativePath: ctx?.seriesRelativePath ?? path.dirname(relativePath),
    seriesId,
    type,
    category: categoryForResource(type, ctx),
    contentType: parsed.contentType,
    sourcePath,
    relativePath,
    fileHash: hashString(`${relativePath}|${stat?.size || 0}|${stat?.mtimeMs || 0}`, 24),
    fileSize: stat?.isFile?.() ? Number(stat.size || 0) : null,
    modifiedTime: stat ? new Date(stat.mtimeMs).toISOString() : '',
    firstIndexedAt: indexedAt,
    detectedNumber: parsed.detectedNumber,
    detectedNumberEnd: parsed.detectedNumberEnd,
    detectedNumberType: parsed.detectedNumberType,
    originalTitle: originalResourceTitle(parsed),
    title: parsed.detectedNumberType === 'volume' && parsed.detectedNumber
      ? formatVolumeTitle(parsed.detectedNumber)
      : (parsed.detectedNumberType === 'chapter' && parsed.detectedNumber
          ? originalResourceTitle(parsed)
          : parsed.title),
    volumeNumber: parsed.detectedNumberType === 'volume' ? parsed.detectedNumber : null,
    chapterNumber: parsed.detectedNumberType === 'chapter' ? parsed.detectedNumber : null,
    pageCount: 0,
    coverCandidate: '',
    parseHints: parsed.parseHints,
    readable: true,
    readError: '',
    lastIndexedAt: indexedAt,
  };
}

async function totalFileSize(filePaths = []) {
  let total = 0;
  for (const filePath of filePaths) {
    const stat = await statSafe(filePath);
    if (stat?.isFile()) total += Number(stat.size || 0);
  }
  return total;
}

async function applyDirectoryFingerprint(resource, images) {
  const rows = [];
  for (const file of images) {
    const stat = await statSafe(file);
    rows.push([path.relative(resource.sourcePath, file), stat?.size || 0, stat?.mtimeMs || 0]);
  }
  resource.fileSize = rows.reduce((total, row) => total + row[1], 0);
  resource.contentFingerprint = hashString(JSON.stringify(rows), 24);
}

function addSeriesResource(seriesMap, parsed, resource, onSeriesDiscovered = null) {
  const seriesId = resource.seriesId;
  if (!seriesMap.has(seriesId)) {
    seriesMap.set(seriesId, {
      series: {
        schemaVersion: 1,
        seriesId,
        title: parsed.title,
        titleNormalized: parsed.titleNormalized,
        alternateTitles: parsed.alternateTitles || [],
        authors: parsed.authors || [],
        publishers: parsed.publishers || [],
        language: '',
        category: resource.category || 'comic',
        contentMode: parsed.contentType,
        status: parsed.status || '',
        tags: unique(parsed.tags || []),
        cover: '',
        bangumiSubjectId: null,
        hasVolumes: false,
        hasChapters: false,
        hasMixedResources: false,
        source: 'resource',
        lastScannedAt: new Date().toISOString(),
        lastMatchedAt: '',
        lastUpdatedAt: new Date().toISOString(),
        latestAddedAt: '',
      },
      resources: [],
    });
    if (typeof onSeriesDiscovered === 'function') onSeriesDiscovered(seriesId);
  }

  const item = seriesMap.get(seriesId);
  item.resources.push(resource);
  item.series.alternateTitles = unique([
    ...(item.series.alternateTitles || []),
    ...(parsed.alternateTitles || []),
  ]);
  item.series.authors = unique([...(item.series.authors || []), ...(parsed.authors || [])]);
  item.series.publishers = unique([...(item.series.publishers || []), ...(parsed.publishers || [])]);
  item.series.tags = unique([...(item.series.tags || []), ...(parsed.tags || [])]);
  if (parsed.status && !item.series.status) item.series.status = parsed.status;
  if (resource.category) {
    item.series.category = mergeSeriesCategory(item.series.category, resource.category);
  }
  if (resource.contentType === 'volume') item.series.hasVolumes = true;
  if (resource.contentType === 'chapter') item.series.hasChapters = true;
  if (resource.contentType === 'mixed_bundle') item.series.hasMixedResources = true;
  const modified = resource.modifiedTime || '';
  if (modified && modified > (item.series.latestAddedAt || '')) item.series.latestAddedAt = modified;
}

function previousResourceIfUnchanged(resource, previousResourceIndex) {
  const previous = previousResourceIndex?.[resource.resourceId];
  if (!previous) return null;
  if (previous.fileHash !== resource.fileHash) return null;
  if (previous.type !== resource.type) return null;
  if (previous.sourcePath !== resource.sourcePath) return null;
  return {
    ...resource,
    fileSize: previous.fileSize !== null && previous.fileSize !== undefined && previous.fileSize !== '' &&
      Number.isFinite(Number(previous.fileSize))
      ? Number(previous.fileSize)
      : resource.fileSize,
    firstIndexedAt: previous.firstIndexedAt || previous.modifiedTime || resource.firstIndexedAt,
    pageCount: Number(previous.pageCount || 0),
    coverCandidate: previous.coverCandidate || (
      Number(previous.pageCount || 0) > 0
        ? `/api/resources/${encodeURIComponent(resource.resourceId)}/cover`
        : ''
    ),
    readable: previous.readable !== false,
    readError: previous.readError || '',
  };
}

function inheritFirstIndexedAt(resource, previousResourceIndex) {
  const previous = previousResourceIndex?.[resource?.resourceId];
  if (!previous || previous.type !== resource?.type || previous.sourcePath !== resource?.sourcePath) return resource;
  resource.firstIndexedAt = previous.firstIndexedAt || previous.modifiedTime || resource.firstIndexedAt;
  return resource;
}

async function resourceFromFile(entry, absPath, stat, seriesMap, onSeriesDiscovered = null, previousResourceIndex = {}, ctx = makeScanContext()) {
  const type = singleFileResourceType(entry);
  if (!type) return;
  const parsed = await parseScanName(entry, { kind: 'file', type, category: categoryForResource(type, ctx) });
  const seriesId = preserveSeriesId(parsed, entry, ctx, categoryForResource(type, ctx), previousResourceIndex, [absPath]);
  const relativePath = relativeToContext(ctx, absPath);
  let resource = applyEpubVolumeNumberHint(
    baseResource(relativePath, absPath, stat, parsed, type, seriesId, ctx),
    entry
  );
  inheritFirstIndexedAt(resource, previousResourceIndex);
  applyNovelBookVolumeDefaults(resource);
  resource.fileHash = await fastFileHash(absPath, stat);
  const previous = previousResourceIfUnchanged(resource, previousResourceIndex);
  if (previous) {
    resource = previous;
    resource.category = resource.category || categoryForResource(type, ctx);
    applyEpubVolumeNumberHint(resource, entry);
    applyNovelBookVolumeDefaults(resource);
    if (!ctx.fastScan) await refreshProbeResultIfNeeded(resource, parsed);
    if (ctx.fastScan) applyFastResourceDefaults(resource, parsed);
  } else if (ctx.fastScan) {
    applyFastResourceDefaults(resource, parsed);
  } else {
    const { probe } = await applyStructureKindIfAmbiguous(resource, parsed);
    await applyProbeResult(resource, probe);
  }
  addSeriesResource(seriesMap, parsed, resource, onSeriesDiscovered);
}

async function resourceFromNestedFile(entry, absPath, stat, seriesParsed, seriesId, seriesMap, onSeriesDiscovered = null, previousResourceIndex = {}, ctx = makeScanContext()) {
  const type = extensionType(entry);
  if (!type) return;
  const parsed = await parseScanName(entry, { kind: 'file', type, seriesTitle: seriesParsed.title,
    parentName: path.basename(path.dirname(absPath)), category: categoryForResource(type, ctx) });
  parsed.parseHints.seriesName = seriesParsed.parseHints?.aiName;
  const relativePath = relativeToContext(ctx, absPath);
  let resource = applyEpubVolumeNumberHint(
    baseResource(relativePath, absPath, stat, parsed, type, seriesId, ctx),
    entry
  );
  inheritFirstIndexedAt(resource, previousResourceIndex);
  applyNovelBookVolumeDefaults(resource);
  applyResourceGroup(resource);
  resource.fileHash = await fastFileHash(absPath, stat);
  const previous = previousResourceIfUnchanged(resource, previousResourceIndex);
  if (previous) {
    resource = previous;
    resource.category = resource.category || categoryForResource(type, ctx);
    applyEpubVolumeNumberHint(resource, entry);
    applyNovelBookVolumeDefaults(resource);
    if (!ctx.fastScan) await refreshProbeResultIfNeeded(resource, parsed);
    if (ctx.fastScan) applyFastResourceDefaults(resource, parsed);
  } else if (ctx.fastScan) {
    applyFastResourceDefaults(resource, parsed);
  } else {
    const { probe } = await applyStructureKindIfAmbiguous(resource, parsed);
    await applyProbeResult(resource, probe);
  }
  addSeriesResource(seriesMap, seriesParsed, resource, onSeriesDiscovered);
}

async function resourceFromPlainDirectory(entry, absPath, stat, seriesMap, onSeriesDiscovered = null, previousResourceIndex = {}, ctx = makeScanContext()) {
  const images = await walkImages(absPath, true);
  if (images.length === 0) return;
  const parsed = await parseScanName(entry, { kind: 'directory', category: categoryForResource('directory', ctx) });
  const seriesId = preserveSeriesId(parsed, entry, ctx, categoryForResource('directory', ctx), previousResourceIndex, [absPath]);
  const relativePath = relativeToContext(ctx, absPath);
  const resource = baseResource(relativePath, absPath, stat, parsed, 'directory', seriesId, ctx);
  inheritFirstIndexedAt(resource, previousResourceIndex);
  resource.recursive = true;
  if (parsed.parseHints?.provider !== 'ai' && !parsed.volumeRange && !parsed.chapterRange) {
    applyResourceKind(resource, await inferDirectoryResourceKind(absPath), resource.detectedNumber, resource.detectedNumberEnd);
  }
  resource.pageCount = images.length;
  await applyDirectoryFingerprint(resource, images);
  resource.coverCandidate = `/api/resources/${encodeURIComponent(resource.resourceId)}/cover`;
  addSeriesResource(seriesMap, parsed, resource, onSeriesDiscovered);
}

async function resourceFromNestedDirectory(entry, absPath, stat, seriesParsed, seriesId, seriesMap, onSeriesDiscovered = null, previousResourceIndex = {}, ctx = makeScanContext()) {
  const images = await walkImages(absPath, true);
  if (images.length === 0) return;
  const parsed = await parseScanName(entry, { kind: 'directory', seriesTitle: seriesParsed.title,
    parentName: path.basename(path.dirname(absPath)), category: categoryForResource('directory', ctx) });
  parsed.parseHints.seriesName = seriesParsed.parseHints?.aiName;
  const relativePath = relativeToContext(ctx, absPath);
  const resource = baseResource(relativePath, absPath, stat, parsed, 'directory', seriesId, ctx);
  inheritFirstIndexedAt(resource, previousResourceIndex);
  applyResourceGroup(resource);
  const parentName = path.basename(path.dirname(relativePath));
  const parentNormalized = normalizeText(parentName);
  const parentIsVolume = /单行本|單行本|tankobon|volume|vol|卷|冊|册/.test(parentNormalized);
  const parentIsChapter = /默认|默認|default|chapter|chap|话|話/.test(parentNormalized);
  if (parsed.parseHints?.provider !== 'ai' && (parentIsVolume || parentIsChapter)) {
    const number = parentIsVolume
      ? (parsed.volumeRange?.start || parsed.detectedNumber)
      : (parsed.chapterRange?.start || parsed.detectedNumber);
    applyResourceKind(resource, parentIsVolume ? 'volume' : 'chapter', number || resource.detectedNumber, number || resource.detectedNumberEnd);
  }
  resource.recursive = true;
  if (parsed.parseHints?.provider !== 'ai' && !parentIsVolume && !parentIsChapter && !parsed.volumeRange && !parsed.chapterRange) {
    applyResourceKind(resource, await inferDirectoryResourceKind(absPath), resource.detectedNumber, resource.detectedNumberEnd);
  }
  resource.pageCount = images.length;
  await applyDirectoryFingerprint(resource, images);
  resource.coverCandidate = `/api/resources/${encodeURIComponent(resource.resourceId)}/cover`;
  addSeriesResource(seriesMap, seriesParsed, resource, onSeriesDiscovered);
}

async function collectNestedArchiveFiles(rootDir, maxDepth = 4) {
  const out = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    const entries = await listDirSafe(dir);
    for (const entry of entries.sort(naturalCompare)) {
      if (shouldIgnoreEntry(entry)) continue;
      const fp = path.join(dir, entry);
      const stat = await statSafe(fp);
      if (!stat) continue;
      if (stat.isFile() && extensionType(entry)) {
        out.push({ entry, absPath: fp, stat });
      } else if (stat.isDirectory()) {
        await walk(fp, depth + 1);
      }
    }
  }

  await walk(rootDir, 0);
  return out;
}

async function collectNestedImageDirs(rootDir, maxDepth = 3) {
  const out = [];

  async function walk(dir, depth) {
    if (depth >= maxDepth) return;
    const entries = await listDirSafe(dir);
    for (const entry of entries.sort(naturalCompare)) {
      if (shouldIgnoreEntry(entry)) continue;
      const fp = path.join(dir, entry);
      const stat = await statSafe(fp);
      if (!stat?.isDirectory()) continue;

      const childEntries = await listDirSafe(fp);
      const isGroup = /^(?:单行本|單行本|tankobon|volumes?|vol|chapters?|chap|默认|默認|default|单话|單話|章节|章節)$/i.test(entry);
      if (isGroup && !childEntries.some(isImageFile)) {
        await walk(fp, depth + 1);
        continue;
      }
      const hasArchive = childEntries.some(child => !shouldIgnoreEntry(child) && extensionType(child));
      if (hasArchive) {
        await walk(fp, depth + 1);
        continue;
      }

      const images = await walkImages(fp, true);
      if (images.length > 0 && looksLikeResourceDirectory(entry)) {
        out.push({ entry, absPath: fp, stat });
        continue;
      }
      await walk(fp, depth + 1);
    }
  }

  await walk(rootDir, 0);
  return out;
}

async function scanResourceSeriesDirectory(entry, absPath, stat, seriesMap, onSeriesDiscovered = null, previousResourceIndex = {}, ctx = makeScanContext()) {
  const archiveFiles = await collectNestedArchiveFiles(absPath);
  const imageDirs = await collectNestedImageDirs(absPath);
  const categoryHint = ctx.categoryOverride ||
    (archiveFiles.length > 0 && imageDirs.length === 0 && archiveFiles.every(file => extensionType(file.entry) === 'epub')
      ? 'novel'
      : 'comic');
  if (archiveFiles.length === 0 && imageDirs.length === 0) return false;
  const seriesParsed = await parseScanName(entry, { kind: 'series_directory', category: categoryHint });
  const seriesId = preserveSeriesId(seriesParsed, entry, ctx, categoryHint, previousResourceIndex,
    [...archiveFiles, ...imageDirs].map(item => item.absPath));

  for (const file of archiveFiles) {
    await resourceFromNestedFile(
      file.entry,
      file.absPath,
      file.stat,
      seriesParsed,
      seriesId,
      seriesMap,
      onSeriesDiscovered,
      previousResourceIndex,
      ctx
    );
  }
  for (const dir of imageDirs) {
    await resourceFromNestedDirectory(
      dir.entry,
      dir.absPath,
      dir.stat,
      seriesParsed,
      seriesId,
      seriesMap,
      onSeriesDiscovered,
      previousResourceIndex,
      ctx
    );
  }

  const item = seriesMap.get(seriesId);
  if (item) {
    item.series.category = categoryForResources(item.resources, ctx);
    item.series.cover = await directoryMetadataCover(seriesId, absPath, item.resources);
  }

  return true;
}

function legacyAuthorNames(author) {
  return (author || []).map(item => item?.name || item).filter(Boolean);
}

function comicCoverApiPath(comicId, filename) {
  return `/api/comics/${encodeURIComponent(comicId)}/cover/${encodeURIComponent(filename)}`;
}

function chapterImageApiPath(comicId, groupName, chapterDir, filename) {
  return `/api/comics/${encodeURIComponent(comicId)}/${encodeURIComponent(groupName)}/${encodeURIComponent(chapterDir)}/image/${encodeURIComponent(filename)}`;
}

async function firstNestedImageCover(absPath, comicId) {
  const groups = (await listDirSafe(absPath)).sort(naturalCompare);
  for (const groupName of groups) {
    if (shouldIgnoreEntry(groupName)) continue;
    const groupPath = safePath(absPath, groupName);
    const groupStat = await statSafe(groupPath);
    if (!groupStat?.isDirectory()) continue;

    const chapters = (await listDirSafe(groupPath)).sort(naturalCompare);
    for (const chapterDir of chapters) {
      if (shouldIgnoreEntry(chapterDir)) continue;
      const chapterPath = path.join(groupPath, chapterDir);
      const chapterStat = await statSafe(chapterPath);
      if (!chapterStat?.isDirectory()) continue;

      const images = (await listDirSafe(chapterPath))
        .filter(isImageFile)
        .sort(naturalCompare);
      if (images.length > 0) {
        return chapterImageApiPath(comicId, groupName, chapterDir, images[0]);
      }
    }
  }
  return '';
}

async function directoryMetadataCover(entry, absPath, resources = []) {
  const files = (await listDirSafe(absPath)).sort(naturalCompare);
  const coverFile = files.find(isCoverFile);
  if (coverFile) return comicCoverApiPath(entry, coverFile);

  const metadataPath = path.join(absPath, '元数据.json');
  const raw = (await statOptional(metadataPath))?.isFile() ? await readJson(metadataPath, null) : null;
  const metadataCover = String(raw?.comic?.cover || '').trim();
  if (metadataCover) return metadataCover;

  const firstImage = await firstNestedImageCover(absPath, entry);
  if (firstImage) return firstImage;

  return (resources || []).find(resource => resource.coverCandidate)?.coverCandidate || '';
}

async function scanLegacyComic(entry, absPath, stat, seriesMap, onSeriesDiscovered = null, previousResourceIndex = {}, ctx = makeScanContext()) {
  const metaPath = path.join(absPath, '元数据.json');
  let raw;
  try {
    if (!(await statOptional(metaPath))?.isFile()) return false;
    raw = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    recordScanIoError(metaPath, error);
    return true;
  }
  if (!raw?.comic) return false;
  const c = raw.comic;
  const seriesId = `legacy-${hashString(`${ctx.sourceId}:${entry}`, 24)}`;
  const authors = legacyAuthorNames(c.author);
  const tags = unique([
    ...(Array.isArray(c.theme) ? c.theme.map(t => t.name || t) : []),
    c.region?.display,
    c.status?.display,
  ].filter(Boolean));

  const allFiles = await listDirSafe(absPath);
  const coverFile = allFiles.sort(naturalCompare).find(isCoverFile);
  const item = {
    series: {
      schemaVersion: 1,
      seriesId,
      title: c.name || entry,
      titleNormalized: normalizeText(c.name || entry),
      alternateTitles: unique([c.alias].filter(Boolean)),
      authors,
      publishers: [],
      language: '',
      category: categoryForResource('directory', ctx),
      contentMode: 'legacy',
      status: c.status?.display || '',
      tags,
      cover: coverFile ? comicCoverApiPath(seriesId, coverFile) : (c.cover || ''),
      bangumiSubjectId: null,
      hasVolumes: false,
      hasChapters: false,
      hasMixedResources: false,
      source: 'legacy',
      brief: c.brief || '',
      latestAddedAt: stat ? new Date(stat.mtimeMs).toISOString() : '',
      lastScannedAt: new Date().toISOString(),
      lastMatchedAt: '',
      lastUpdatedAt: c.datetime_updated || new Date().toISOString(),
      legacy: {
        comicId: seriesId,
        sourceId: ctx.sourceId,
        relativeDirectory: entry,
      },
    },
    resources: [],
  };

  const groups = c.groups || {};
  for (const [groupKey, chapters] of Object.entries(groups)) {
    const groupName = (chapters?.[0]?.groupName) || groupKey;
    const groupPath = safePath(absPath, groupName);
    // 旧版元数据可能仍引用已经删除或未迁移的分组目录。这里的 ENOENT
    // 表示该分组当前不存在，不代表整个书库离线；真实权限和 I/O 错误仍会记录。
    const groupStat = await statOptional(groupPath);
    if (!groupStat?.isDirectory()) continue;
    const localChapterDirs = await listDirSafe(groupPath);
    for (const chapter of chapters || []) {
      const order = chapter.order;
      const orderStr = Number.isInteger(order) ? String(Math.floor(order)) : String(order);
      const chapterDir = `${orderStr} ${chapter.chapterTitle}`;
      if (!localChapterDirs.includes(chapterDir)) continue;
      const chapterPath = path.join(groupPath, chapterDir);
      const chapterStat = await statSafe(chapterPath);
      if (!chapterStat?.isDirectory()) continue;
      const imageNames = (await listDirSafe(chapterPath))
        .filter(isImageFile)
        .sort(naturalCompare);
      if (imageNames.length === 0) continue;

      const resourceId = hashString(`${ctx.sourceId}:directory:${path.relative(ctx.rootDir, chapterPath)}`, 24);
      const isVolume = /单行本|單行本|tankobon|volume|vol|卷/i.test(groupName);
      const resource = {
        schemaVersion: 1,
        resourceId,
        sourceId: ctx.sourceId,
        seriesRelativePath: entry,
        seriesId,
        type: 'directory',
        category: categoryForResource('directory', ctx),
        contentType: isVolume ? 'volume' : 'chapter',
        sourcePath: chapterPath,
        relativePath: path.relative(ctx.rootDir, chapterPath),
        fileHash: hashString(`${chapterPath}|${chapterStat.mtimeMs}|${imageNames.length}`, 24),
        fileSize: await totalFileSize(imageNames.map(name => path.join(chapterPath, name))),
        modifiedTime: new Date(chapterStat.mtimeMs).toISOString(),
        firstIndexedAt: new Date().toISOString(),
        detectedNumber: Number(order) || null,
        detectedNumberEnd: Number(order) || null,
        detectedNumberType: isVolume ? 'volume' : 'chapter',
        title: chapter.chapterTitle,
        volumeNumber: isVolume ? Number(order) || null : null,
        chapterNumber: isVolume ? null : Number(order) || null,
        pageCount: imageNames.length,
        coverCandidate: `/api/resources/${encodeURIComponent(resourceId)}/cover`,
        parseHints: { legacyGroupKey: groupKey, groupName, chapterDir },
        readable: true,
        readError: '',
        recursive: false,
        legacy: {
          comicId: seriesId,
          groupKey,
          groupName,
          chapterDir,
          chapterUuid: chapter.chapterUuid,
          order: chapter.order,
          chapterTitle: chapter.chapterTitle,
        },
        lastIndexedAt: new Date().toISOString(),
      };
      inheritFirstIndexedAt(resource, previousResourceIndex);
      item.resources.push(resource);
      if (isVolume) item.series.hasVolumes = true;
      else item.series.hasChapters = true;
      if (resource.modifiedTime > item.series.latestAddedAt) item.series.latestAddedAt = resource.modifiedTime;
    }
  }

  if (item.resources.length === 0) return false;

  const isNewSeries = !seriesMap.has(seriesId);
  seriesMap.set(seriesId, item);
  if (isNewSeries && typeof onSeriesDiscovered === 'function') onSeriesDiscovered(seriesId);
  return true;
}

function prepareScanItem(item, incremental) {
  item.resources.sort((a, b) => {
    const an = a.detectedNumber ?? 999999;
    const bn = b.detectedNumber ?? 999999;
    if (an !== bn) return an - bn;
    return naturalCompare(a.title, b.title);
  });
  if (incremental) {
    item.series.latestAddedAt = item.resources.reduce((latest, resource) =>
      resource.modifiedTime > latest ? resource.modifiedTime : latest, '');
    const coverId = item.series.cover?.match(/^\/api\/resources\/([^/]+)\/cover/)?.[1];
    if (coverId && !item.resources.some(resource => resource.resourceId === decodeURIComponent(coverId))) item.series.cover = '';
  }
  if (!item.series.cover) {
    const coverResource = item.resources.find(r => r.coverCandidate);
    item.series.cover = coverResource?.coverCandidate || '';
  }
  const modes = new Set(item.resources.map(r => r.contentType));
  item.series.hasVolumes = item.resources.some(r => r.contentType === 'volume');
  item.series.hasChapters = item.resources.some(r => r.contentType === 'chapter');
  item.series.hasMixedResources = modes.size > 1 || item.resources.some(r => r.contentType === 'mixed_bundle');
  item.series.category = categoryForResources(item.resources, {
    categoryOverride: isPathBoundCategory(item.series.category) ? item.series.category : '',
  });
  item.series.contentMode = item.series.hasMixedResources
    ? 'mixed'
    : (item.series.hasVolumes ? 'volume' : 'chapter');
}

async function scanLibrary(options = {}) {
  const run = scanOperationChain.then(async () => {
    const scanErrors = [];
    return scanErrorStorage.run(scanErrors, () => scanLibraryWithContext(options, scanErrors));
  }, async () => {
    const scanErrors = [];
    return scanErrorStorage.run(scanErrors, () => scanLibraryWithContext(options, scanErrors));
  });
  scanOperationChain = run.then(() => undefined, () => undefined);
  return run;
}

async function scanLibraryWithContext(options, scanErrors) {
  const fast = options.fast === true;
  const incremental = Array.isArray(options.changedPaths);
  const changedPaths = incremental ? unique(options.changedPaths
    .filter(target => typeof target === 'string' && path.isAbsolute(target))
    .map(target => path.resolve(target))) : [];
  const concurrency = Math.max(1, Number(options.concurrency || (fast ? config.SCAN_LIBRARY_CONCURRENCY : 1) || 1));
  const sources = config.LIBRARY_SOURCES.filter(source => !incremental ||
    changedPaths.some(target => settingsStore.contains(source.path, target)));
  const statuses = await Promise.all(sources.map(settingsStore.sourceStatus));
  const offlineIds = new Set(statuses.filter(s => !s.available).map(s => s.id));
  const contexts = sources.filter(s => !offlineIds.has(s.id)).map(source =>
    makeScanContext(source.path, {
      sourceId: source.id, source,
      categoryOverride: source.mode === 'fixed' ? source.categoryId : '',
      idScope: source.id, allowMountExpansion: true, fast,
    })
  );
  const {
    seriesIndex: previousSeriesIndex,
    resourceIndex: previousResourceIndex,
  } = await readLibraryIndexes();
  const previousSeriesIds = new Set(
    (Array.isArray(previousSeriesIndex) ? previousSeriesIndex : [])
      .map(series => series?.seriesId)
      .filter(Boolean)
  );
  const seriesMap = new Map();
  const scopes = new Map();
  const previousResources = Object.values(previousResourceIndex || {});
  const resourceInScope = resource => (scopes.get(resource.sourceId) || [])
    .some(target => resource.sourcePath && settingsStore.contains(target, resource.sourcePath));
  const discoveredSeriesIds = [];
  const completedRoots = new Set();
  const seenDiscoveredSeriesIds = new Set();
  const onSeriesDiscovered = typeof options.onSeriesDiscovered === 'function'
    ? options.onSeriesDiscovered
    : null;

  function markSeriesDiscovered(seriesId) {
    if (!seriesId || seenDiscoveredSeriesIds.has(seriesId)) return;
    seenDiscoveredSeriesIds.add(seriesId);
    discoveredSeriesIds.push(seriesId);
  }

  function resourceCompleted(resource) {
    let target = resource.sourcePath;
    while (target) {
      if (completedRoots.has(target)) return true;
      const parent = path.dirname(target);
      if (parent === target) break;
      target = parent;
    }
    return false;
  }

  async function flushDiscoveredSeries() {
    if (discoveredSeriesIds.length === 0) return;
    const pendingIds = discoveredSeriesIds.splice(0);
    const ready = new Map();
    for (const seriesId of pendingIds) {
      const item = seriesMap.get(seriesId);
      if (!item) continue;
      const isNewSeries = !previousSeriesIds.has(seriesId);

      // 已有系列在扫描结束时随完整快照一次性持久化，避免把部分扫描结果
      // 逐本发布为“新增”，从而反复更新时间和改变列表顺序。
      if (!isNewSeries) continue;
      if (!item.resources.length || !item.resources.every(resourceCompleted)) {
        discoveredSeriesIds.push(seriesId);
        continue;
      }
      const snapshot = structuredClone(item);
      prepareScanItem(snapshot, incremental);
      ready.set(seriesId, snapshot);
    }
    if (!ready.size) return;
    // Add complete new discoveries without replacing old works or applying any
    // removals. The full scan remains responsible for authoritative reconciliation.
    await persistLibraryChanges(ready);
    if (onSeriesDiscovered) {
      for (const [seriesId, item] of ready) {
        try {
          await onSeriesDiscovered({
            seriesId,
            series: item.series,
            resources: item.resources,
            isNew: true,
          });
        } catch (error) {
          console.warn(`[scan] onSeriesDiscovered 回调失败 ${seriesId}: ${error.message}`);
        }
      }
    }
  }

  let flushChain = Promise.resolve();
  function requestFlush() {
    flushChain = flushChain.then(() => flushDiscoveredSeries());
    return flushChain;
  }

  async function scanEntryAndPublish(entry, allowMountExpansion, ctx) {
    await scanTopLevelEntry(entry, allowMountExpansion, ctx);
    const root = safePath(ctx.rootDir, entry);
    if (!scanErrors.some(item => settingsStore.contains(root, item.path) || settingsStore.contains(item.path, root))) {
      completedRoots.add(root);
    }
    await requestFlush();
  }

  async function scanTopLevelEntry(entry, allowMountExpansion = false, ctx = makeScanContext()) {
    if (shouldIgnoreEntry(entry)) return;
    const absPath = safePath(ctx.rootDir, entry);
    // Removed watcher targets are expected; traversal errors inside an existing target still fail.
    const stat = await (incremental ? statOptional(absPath) : statSafe(absPath));
    if (!stat) return;

    if (stat.isDirectory()) {
      if (allowMountExpansion && await shouldScanAsLibraryMount(entry, absPath)) {
        const childEntries = (await listDirSafe(absPath))
          .filter(child => !shouldIgnoreEntry(child))
          .sort(naturalCompare);
        await mapLimit(childEntries, concurrency, async child => {
          await scanEntryAndPublish(path.join(entry, child), false, ctx);
        });
        return;
      }

      ctx = { ...ctx, seriesRelativePath: entry };
      const legacy = await scanLegacyComic(entry, absPath, stat, seriesMap, markSeriesDiscovered, previousResourceIndex, ctx);
      if (legacy) return;

      const nested = await scanResourceSeriesDirectory(
        entry,
        absPath,
        stat,
        seriesMap,
        markSeriesDiscovered,
        previousResourceIndex,
        ctx
      );
      if (!nested) {
        await resourceFromPlainDirectory(
          entry,
          absPath,
          stat,
          seriesMap,
          markSeriesDiscovered,
          previousResourceIndex,
          ctx
        );
      }
    } else if (stat.isFile() && singleFileResourceType(entry)) {
      await resourceFromFile(entry, absPath, stat, seriesMap, markSeriesDiscovered, previousResourceIndex, ctx);
    }
  }

  for (const ctx of contexts) {
    let entries;
    try {
      if (incremental) {
        const targets = new Set();
        const mountStates = new Map();
        for (const target of changedPaths.filter(target => settingsStore.contains(ctx.rootDir, target))) {
          const relative = path.relative(ctx.rootDir, target);
          if (!relative) { targets.add(''); continue; }
          const parts = relative.split(path.sep);
          if (parts.some(shouldIgnoreEntry)) continue;
          const top = parts[0];
          if (parts.length > 1 && looksLikeLibraryMountName(top)) {
            if (!mountStates.has(top)) {
              const topPath = safePath(ctx.rootDir, top);
              const stat = await statOptional(topPath);
              const wasSeries = previousResources.some(resource => resource.sourceId === ctx.sourceId &&
                resource.seriesRelativePath === top);
              mountStates.set(top, !wasSeries && stat?.isDirectory() && await shouldScanAsLibraryMount(top, topPath));
            }
            targets.add(mountStates.get(top) ? path.join(top, parts[1]) : top);
          } else targets.add(top);
        }
        // A directory event subsumes its children, including rename/copy bursts.
        const paths = [...targets].map(entry => safePath(ctx.rootDir, entry));
        const roots = paths.filter(target => !paths.some(other => other !== target && settingsStore.contains(other, target)));
        scopes.set(ctx.sourceId, roots);
        entries = roots.includes(ctx.rootDir) ? await fs.readdir(ctx.rootDir)
          : roots.map(target => path.relative(ctx.rootDir, target));
        entries.sort(naturalCompare);
      } else entries = (await fs.readdir(ctx.rootDir)).sort(naturalCompare);
    } catch (error) {
      scanErrors.push({ path: ctx.rootDir, error });
      if (!entries) continue;
    }
    await mapLimit(entries, concurrency, async entry => {
      await scanEntryAndPublish(entry, ctx.allowMountExpansion && !entry.includes(path.sep), ctx);
    });
  }

  await requestFlush();
  await flushChain;

  if (incremental) {
    // A disconnect during reconciliation must not turn into a mass deletion.
    for (const ctx of contexts) {
      const status = await settingsStore.sourceStatus(ctx.source);
      if (!status.available) recordScanIoError(ctx.rootDir, Object.assign(new Error('来源目录不可访问'), { code: 'SOURCE_OFFLINE' }));
    }
  }

  if (scanErrors.length > 0) {
    const uniqueErrors = [];
    const seenErrors = new Set();
    for (const item of scanErrors) {
      const code = item.error?.code || item.error?.name || 'ERROR';
      const key = `${code}:${item.path}`;
      if (seenErrors.has(key)) continue;
      seenErrors.add(key);
      uniqueErrors.push(item);
    }
    const sample = uniqueErrors.slice(0, 3)
      .map(item => `${item.error?.code || item.error?.name || 'ERROR'} ${item.path}`)
      .join('; ');
    const error = new Error(`扫描读取失败，保留现有书库索引：${sample}`);
    error.code = 'SCAN_INCOMPLETE';
    error.paths = uniqueErrors.map(item => item.path);
    error.details = uniqueErrors.map(item => ({
      path: item.path,
      code: item.error?.code || item.error?.name || 'ERROR',
      syscall: item.error?.syscall || '',
      message: item.error?.message || '',
    }));
    throw error;
  }

  if (incremental) {
    const affectedIds = new Set([...seriesMap.keys(), ...previousResources.filter(resourceInScope).map(resource => resource.seriesId)]);
    for (const seriesId of affectedIds) {
      const bundle = await readSeriesBundle(seriesId);
      if (!bundle) continue;
      const retained = bundle.resources.filter(resource => !resourceInScope(resource));
      const item = seriesMap.get(seriesId);
      if (!item) seriesMap.set(seriesId, { series: { ...bundle.series }, resources: retained });
      else {
        item.resources.push(...retained);
        if (retained.length) {
          for (const field of ['alternateTitles', 'authors', 'publishers', 'tags']) {
            item.series[field] = unique([...(bundle.series[field] || []), ...(item.series[field] || [])]);
          }
          if (!item.series.cover) item.series.cover = bundle.series.cover;
        }
      }
    }
  } else {
    // Offline sources retain their last complete snapshot; disabled/deleted sources do not.
    for (const previous of previousSeriesIndex || []) {
      const bundle = await readSeriesBundle(previous.seriesId);
      const retained = (bundle?.resources || []).filter(resource => offlineIds.has(resource.sourceId));
      if (!retained.length) continue;
      const item = seriesMap.get(previous.seriesId);
      if (item) item.resources.push(...retained);
      else seriesMap.set(previous.seriesId, { series: { ...bundle.series }, resources: retained });
    }
  }

  for (const item of seriesMap.values()) prepareScanItem(item, incremental);

  const result = await (incremental ? persistLibraryChanges(seriesMap) : persistLibrary(seriesMap));
  if (options.confirmSettings === true) await settingsStore.markScanned();
  const previousResourceIds = new Set(Object.keys(previousResourceIndex || {}));
  const addedResources = (result.resourceList || [])
    .filter(resource => resource?.resourceId && !previousResourceIds.has(resource.resourceId));
  const addedVolumeResources = addedResources.filter(resource =>
    resource.contentType === 'volume' && previousSeriesIds.has(resource.seriesId)
  );
  return {
    ...result,
    offlineSourceIds: [...offlineIds],
    addedResources,
    addedVolumeResources,
  };
}

async function buildComicList() {
  const { seriesList } = await scanLibrary();
  const comics = [];
  for (const series of seriesList) {
    const bundle = await readSeriesBundle(series.seriesId);
    const bangumi = bundle?.bangumi || {};
    comics.push({
      id: series.seriesId,
      name: series.title,
      alias: (series.alternateTitles || []).join(', '),
      author: (series.authors || []).join(', '),
      brief: bangumi.translatedSummary || bangumi.summary || series.brief || '',
      cover: series.cover || '',
      status: series.status || '',
      lastChapter: bundle?.resources?.[bundle.resources.length - 1]?.title || '',
      updatedAt: series.lastUpdatedAt || '',
      latestAddedAt: series.latestAddedAt || '',
      tags: series.tags || [],
      publishers: series.publishers || [],
      bangumiSubjectId: series.bangumiSubjectId || null,
      category: series.category || 'comic',
      contentMode: series.contentMode || '',
      source: series.source || '',
    });
  }
  return comics;
}

module.exports = {
  buildComicList,
  extensionType,
  scanLibrary,
};
