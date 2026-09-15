const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { validateResource, sourceFor, allowedPath } = require('./resourcePaths');
const { getResource } = require('./metadataStore');
const { getEpubManifest } = require('./epubProvider');
const {
  commandExists,
  dirSize,
  ensureDir,
  hashString,
  imageExt,
  isImageFile,
  listDirSafe,
  naturalCompare,
  pathExists,
  readJson,
  runCommand,
  safePath,
  statSafe,
  streamCommandToFile,
  walkImages,
  writeJson,
} = require('./utils');

const archiveExtractionPromises = new Map();
const activeCacheDirs = new Map();

function activeCacheGraceMs() {
  return Math.max(1, Number(config.READER_CACHE_ACTIVE_GRACE_MINUTES || 360)) * 60 * 1000;
}

function epubResourceCacheKey(resource) {
  return hashString([
    resource.resourceId,
    resource.fileHash || '',
    resource.modifiedTime || '',
    resource.sourceRevision || '',
    resource.sourcePath || '',
  ].join('|'), 24);
}

function cacheDirsForResource(resource) {
  if (!resource?.resourceId) return [];
  if (resource.type === 'pdf') return [path.join(config.PDF_CACHE_DIR, resourceCacheKey(resource))];
  if (resource.type === 'epub') return [path.join(config.READER_CACHE_DIR, `epub-${epubResourceCacheKey(resource)}`)];
  if (resource.type === 'directory' || resource.type === 'image') return [];
  return [cacheDirForResource(resource)];
}

function pruneActiveCacheDirs(now = Date.now()) {
  for (const [cacheDir, expiresAt] of activeCacheDirs.entries()) {
    if (expiresAt <= now) activeCacheDirs.delete(cacheDir);
  }
}

function protectCacheDir(cacheDir, now = Date.now()) {
  if (!cacheDir) return;
  activeCacheDirs.set(path.resolve(cacheDir), now + activeCacheGraceMs());
}

async function touchCacheIfExists(cacheDir) {
  const stat = await statSafe(cacheDir);
  if (stat?.isDirectory()) await touchCache(cacheDir).catch(() => {});
}

async function markResourceCacheActive(resourceOrId) {
  const resource = typeof resourceOrId === 'string'
    ? await getResource(resourceOrId)
    : resourceOrId;
  if (!resource) return;
  const now = Date.now();
  for (const cacheDir of cacheDirsForResource(resource)) {
    protectCacheDir(cacheDir, now);
    await touchCacheIfExists(cacheDir);
  }
}

function isCacheItemProtected(filePath, lastAccess, now, clearAll) {
  pruneActiveCacheDirs(now);
  const activeUntil = activeCacheDirs.get(path.resolve(filePath)) || 0;
  if (activeUntil > now) return true;
  return clearAll && now - lastAccess <= activeCacheGraceMs();
}

function tempPathFor(targetPath, suffix = 'tmp') {
  return `${targetPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.${suffix}`;
}

function resourceCacheKey(resource) {
  return hashString([
    resource.resourceId,
    resource.fileHash || '',
    resource.modifiedTime || '',
    resource.pageCount || '',
  ].join('|'), 24);
}

function cacheDirForResource(resource) {
  return path.join(config.READER_CACHE_DIR, resourceCacheKey(resource));
}

async function touchCache(cacheDir) {
  await ensureDir(cacheDir);
  await fs.writeFile(path.join(cacheDir, '.last-access'), new Date().toISOString(), 'utf-8');
}

function preferNormalVariant(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const normalVariant = entries.filter(entry => /(^|[\\/])[\[【(（]?普通版[\]】)）]?([\\/]|$)/i.test(entry));
  return normalVariant.length > 0 ? normalVariant : entries;
}

async function listArchiveEntries(resource) {
  resource = await validateResource(resource);
  const bsdtar = await commandExists('bsdtar');
  if (!bsdtar) throw new Error('缺少 bsdtar/libarchive，无法读取压缩包资源');
  const { stdout } = await runCommand(bsdtar, ['-tf', resource.sourcePath], {
    timeout: 180000,
    maxBuffer: 128 * 1024 * 1024,
  });
  const entries = stdout.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && isImageFile(line))
    .sort(naturalCompare);
  return preferNormalVariant(entries);
}

async function archiveManifest(resource) {
  const cacheDir = cacheDirForResource(resource);
  await ensureDir(cacheDir);
  const manifestPath = path.join(cacheDir, 'manifest.json');
  const existing = await readJson(manifestPath, null);
  if (existing?.resourceId === resource.resourceId && Array.isArray(existing.pages)) {
    await touchCache(cacheDir);
    return existing;
  }

  const entries = await listArchiveEntries(resource);
  const manifest = {
    resourceId: resource.resourceId,
    type: resource.type,
    sourcePath: resource.sourcePath,
    cacheKey: resourceCacheKey(resource),
    createdAt: new Date().toISOString(),
    pages: entries.map((entry, index) => ({
      pageNumber: index + 1,
      entry,
      ext: imageExt(entry),
      cacheFile: path.join('pages', `${String(index + 1).padStart(5, '0')}${imageExt(entry)}`),
    })),
  };
  await writeJson(manifestPath, manifest);
  await touchCache(cacheDir);
  return manifest;
}

async function directoryPages(resource) {
  resource = await validateResource(resource);
  const files = await walkImages(resource.sourcePath, resource.recursive !== false);
  return files.map((filePath, index) => ({
    pageNumber: index + 1,
    filePath,
  }));
}

async function pdfPageCount(resource) {
  resource = await validateResource(resource);
  const pdfinfo = await commandExists('pdfinfo');
  if (!pdfinfo) return resource.pageCount || 0;
  const { stdout } = await runCommand(pdfinfo, [resource.sourcePath], { timeout: 60000 });
  const match = stdout.match(/^Pages:\s+(\d+)/mi);
  return match ? Number(match[1]) : (resource.pageCount || 0);
}

async function pdfManifest(resource) {
  const cacheDir = path.join(config.PDF_CACHE_DIR, resourceCacheKey(resource));
  await ensureDir(cacheDir);
  const manifestPath = path.join(cacheDir, 'manifest.json');
  const existing = await readJson(manifestPath, null);
  if (existing?.resourceId === resource.resourceId && Array.isArray(existing.pages)) {
    await touchCache(cacheDir);
    return existing;
  }

  const pageCount = await pdfPageCount(resource);
  if (!pageCount) {
    throw new Error('缺少 pdfinfo/poppler-utils，无法读取 PDF 页数');
  }

  const manifest = {
    resourceId: resource.resourceId,
    type: 'pdf',
    sourcePath: resource.sourcePath,
    cacheKey: resourceCacheKey(resource),
    dpi: config.PDF_RENDER_DPI,
    createdAt: new Date().toISOString(),
    pages: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      cacheFile: path.join('pages', `${String(index + 1).padStart(5, '0')}.jpg`),
    })),
  };
  await writeJson(manifestPath, manifest);
  await touchCache(cacheDir);
  return manifest;
}

function normalizePageRange(total, options = {}) {
  const safeTotal = Math.max(0, Number(total) || 0);
  if (safeTotal === 0) return { start: 1, end: 0, count: 0 };

  const requestedStart = Number(options.startPage);
  const start = Number.isInteger(requestedStart) && requestedStart > 0
    ? Math.min(requestedStart, safeTotal)
    : 1;

  const requestedCount = Number(options.pageCount);
  const end = Number.isInteger(requestedCount) && requestedCount > 0
    ? Math.min(safeTotal, start + requestedCount - 1)
    : safeTotal;

  return { start, end, count: Math.max(0, end - start + 1) };
}

async function getPages(resourceId, options = {}) {
  const resource = await validateResource(await getResource(resourceId));
  if (!resource) throw new Error(`Resource not found: ${resourceId}`);
  await markResourceCacheActive(resource);

  let count = resource.pageCount || 0;
  if (resource.type === 'image') {
    count = 1;
  } else if (resource.type === 'directory') {
    const pages = await directoryPages(resource);
    count = pages.length;
  } else if (resource.type === 'pdf') {
    const manifest = await pdfManifest(resource);
    count = manifest.pages.length;
  } else {
    const manifest = await archiveManifest(resource);
    count = manifest.pages.length;
  }
  const range = normalizePageRange(count, options);

  return {
    resource: {
      resourceId: resource.resourceId,
      seriesId: resource.seriesId,
      title: resource.title,
      type: resource.type,
      contentType: resource.contentType,
      pageCount: range.count,
      sourcePageCount: count,
      startPage: range.start,
    },
    pageCount: range.count,
    sourcePageCount: count,
    startPage: range.start,
    pages: Array.from({ length: range.count }, (_, index) =>
      `/api/resources/${encodeURIComponent(resource.resourceId)}/page/${range.start + index}`
    ),
  };
}

async function extractArchivePage(resource, pageNumber, options = {}) {
  const manifest = await archiveManifest(resource);
  const page = manifest.pages[pageNumber - 1];
  if (!page) throw new Error('Page not found');

  const cacheDir = cacheDirForResource(resource);
  const outPath = path.join(cacheDir, page.cacheFile);
  const forceRefresh = options.forceRefresh === true;
  const cachedStat = await statSafe(outPath);
  if (!forceRefresh && cachedStat?.isFile() && cachedStat.size > 0) {
    await touchCache(cacheDir);
    return outPath;
  }
  if (!forceRefresh && cachedStat) await fs.rm(outPath, { force: true }).catch(() => {});

  await ensureDir(path.dirname(outPath));
  const bsdtar = await commandExists('bsdtar');
  if (!bsdtar) throw new Error('缺少 bsdtar/libarchive，无法解压压缩包页面');

  const tmpPath = tempPathFor(outPath);
  await fs.rm(tmpPath, { force: true }).catch(() => {});
  try {
    await streamCommandToFile(bsdtar, ['-xOf', resource.sourcePath, page.entry], tmpPath);
    const tmpStat = await statSafe(tmpPath);
    if (!tmpStat?.isFile() || tmpStat.size <= 0) {
      throw new Error(`压缩包页面解压为空: ${page.entry}`);
    }
    await fs.rename(tmpPath, outPath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    const extractedPath = await extractedArchivePagePath(resource, cacheDir, page.entry);
    await fs.copyFile(extractedPath, tmpPath);
    const tmpStat = await statSafe(tmpPath);
    if (!tmpStat?.isFile() || tmpStat.size <= 0) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
    await fs.rename(tmpPath, outPath);
  }
  await touchCache(cacheDir);
  return outPath;
}

async function ensureArchiveExtracted(resource, cacheDir) {
  const extractDir = path.join(cacheDir, 'extracted');
  const completePath = path.join(extractDir, '.complete');
  if (await pathExists(completePath)) return extractDir;

  if (archiveExtractionPromises.has(cacheDir)) {
    await archiveExtractionPromises.get(cacheDir);
    return extractDir;
  }

  const promise = (async () => {
    const bsdtar = await commandExists('bsdtar');
    if (!bsdtar) throw new Error('缺少 bsdtar/libarchive，无法解压压缩包页面');

    const tmpDir = path.join(cacheDir, `extracting-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await ensureDir(tmpDir);
    try {
      await runCommand(bsdtar, ['-xf', resource.sourcePath, '-C', tmpDir], {
        timeout: 180000,
        maxBuffer: 128 * 1024 * 1024,
      });
      await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      await fs.rename(tmpDir, extractDir);
      await fs.writeFile(completePath, new Date().toISOString(), 'utf-8');
    } catch (error) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  })();

  archiveExtractionPromises.set(cacheDir, promise);
  try {
    await promise;
  } finally {
    archiveExtractionPromises.delete(cacheDir);
  }
  return extractDir;
}

async function extractedArchivePagePath(resource, cacheDir, entry) {
  const extractDir = await ensureArchiveExtracted(resource, cacheDir);
  const filePath = safePath(extractDir, entry);
  if (!await pathExists(filePath)) {
    throw new Error(`压缩包页面解压失败: ${entry}`);
  }
  return filePath;
}

async function renderPdfPage(resource, pageNumber, options = {}) {
  const manifest = await pdfManifest(resource);
  const page = manifest.pages[pageNumber - 1];
  if (!page) throw new Error('Page not found');

  const cacheDir = path.join(config.PDF_CACHE_DIR, resourceCacheKey(resource));
  const outPath = path.join(cacheDir, page.cacheFile);
  const forceRefresh = options.forceRefresh === true;
  const cachedStat = await statSafe(outPath);
  if (!forceRefresh && cachedStat?.isFile() && cachedStat.size > 0) {
    await touchCache(cacheDir);
    return outPath;
  }
  if (!forceRefresh && cachedStat) await fs.rm(outPath, { force: true }).catch(() => {});

  const pdftoppm = await commandExists('pdftoppm');
  if (!pdftoppm) throw new Error('缺少 pdftoppm/poppler-utils，无法渲染 PDF 页面');
  await ensureDir(path.dirname(outPath));
  const tmpPath = tempPathFor(outPath, 'tmp.jpg');
  const prefix = path.join(path.dirname(tmpPath), path.basename(tmpPath, '.jpg'));
  await runCommand(pdftoppm, [
    '-r',
    String(config.PDF_RENDER_DPI),
    '-jpeg',
    '-singlefile',
    '-f',
    String(pageNumber),
    '-l',
    String(pageNumber),
    resource.sourcePath,
    prefix,
  ], { timeout: 180000 });

  const tmpStat = await statSafe(tmpPath);
  if (!tmpStat?.isFile() || tmpStat.size <= 0) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw new Error('PDF 页面渲染失败');
  }
  await fs.rename(tmpPath, outPath);
  await touchCache(cacheDir);
  return outPath;
}

async function getPageFile(resourceId, pageNumber, options = {}) {
  const resource = await validateResource(await getResource(resourceId));
  if (!resource) throw new Error(`Resource not found: ${resourceId}`);
  await markResourceCacheActive(resource);
  const page = Number(pageNumber);
  if (!Number.isInteger(page) || page < 1) throw new Error('Invalid page number');

  if (resource.type === 'directory') {
    const pages = await directoryPages(resource);
    const item = pages[page - 1];
    if (!item) throw new Error('Page not found');
    return allowedPath(sourceFor(resource), item.filePath);
  }
  if (resource.type === 'image') {
    if (page !== 1) throw new Error('Page not found');
    if (!isImageFile(resource.sourcePath)) throw new Error('Unsupported image resource');
    return resource.sourcePath;
  }
  if (resource.type === 'pdf') {
    return renderPdfPage(resource, page, options);
  }
  if (resource.type === 'epub') {
    throw new Error('EPUB 资源请使用小说阅读接口');
  }
  return extractArchivePage(resource, page, options);
}

async function cleanupCache({ clearAll = false } = {}) {
  const roots = [config.READER_CACHE_DIR, config.PDF_CACHE_DIR, config.THUMBNAIL_CACHE_DIR];
  const ttlMs = config.READER_CACHE_TTL_MINUTES * 60 * 1000;
  const now = Date.now();
  pruneActiveCacheDirs(now);

  for (const root of roots) {
    await ensureDir(root);
    const entries = await listDirSafe(root);
    const cacheItems = [];
    for (const entry of entries) {
      const fp = path.join(root, entry);
      const stat = await statSafe(fp);
      if (!stat?.isDirectory()) continue;
      const accessFile = path.join(fp, '.last-access');
      const accessStat = await statSafe(accessFile);
      const lastAccess = accessStat?.mtimeMs || stat.mtimeMs;
      const size = await dirSize(fp).catch(() => 0);
      const protectedItem = isCacheItemProtected(fp, lastAccess, now, clearAll);
      cacheItems.push({ fp, lastAccess, size, protectedItem });
      if (!protectedItem && (clearAll || now - lastAccess > ttlMs)) {
        await fs.rm(fp, { recursive: true, force: true });
      }
    }

    const fresh = [];
    for (const item of cacheItems) {
      if (fss.existsSync(item.fp)) fresh.push(item);
    }
    let totalSize = fresh.reduce((sum, item) => sum + item.size, 0);
    const maxSize = config.READER_CACHE_MAX_SIZE_MB * 1024 * 1024;
    fresh.sort((a, b) => a.lastAccess - b.lastAccess);
    while (fresh.length > config.READER_CACHE_MAX_RESOURCES || totalSize > maxSize) {
      const index = fresh.findIndex(item => !item.protectedItem);
      if (index < 0) break;
      const [item] = fresh.splice(index, 1);
      await fs.rm(item.fp, { recursive: true, force: true });
      totalSize -= item.size;
    }
  }
}

async function probeReadable(resource) {
  try {
    if (resource.type === 'image') {
      const stat = await statSafe(resource.sourcePath);
      const readable = !!stat?.isFile() && stat.size > 0 && isImageFile(resource.sourcePath);
      return { readable, pageCount: readable ? 1 : 0, error: readable ? '' : '图片文件不可读' };
    }
    if (resource.type === 'directory') {
      const pages = await directoryPages(resource);
      return { readable: pages.length > 0, pageCount: pages.length, error: '' };
    }
    if (resource.type === 'pdf') {
      const pageCount = await pdfPageCount(resource);
      return {
        readable: pageCount > 0 || !!await commandExists('pdftoppm'),
        pageCount,
        error: pageCount ? '' : '缺少 pdfinfo/poppler-utils，页数将在打开时检测',
      };
    }
    if (resource.type === 'epub') {
      const manifest = await getEpubManifest(resource);
      return {
        readable: manifest.chapters.length > 0,
        pageCount: manifest.chapters.length,
        error: '',
        structureType: 'volume',
      };
    }
    const pages = await listArchiveEntries(resource);
    return {
      readable: pages.length > 0,
      pageCount: pages.length,
      error: '',
      structureType: inferImagePathStructure(pages),
    };
  } catch (error) {
    return { readable: false, pageCount: 0, error: error.message };
  }
}

function inferImagePathStructure(entries) {
  const paths = (entries || []).map(entry =>
    String(entry || '').split(/[\\/]/).filter(Boolean)
  );
  if (paths.length === 0) return '';

  const directImages = paths.filter(parts => parts.length <= 1).length;
  if (directImages > 0 && directImages >= paths.length * 0.5) return 'chapter';

  const withoutCommonRoot = stripCommonRoot(paths);
  const nestedImages = withoutCommonRoot.filter(parts => parts.length > 1).length;
  if (nestedImages > 0 && nestedImages >= withoutCommonRoot.length * 0.5) return 'volume';
  return 'chapter';
}

function stripCommonRoot(paths) {
  if (paths.length < 2) return paths;
  const first = paths[0]?.[0];
  if (!first) return paths;
  if (!paths.every(parts => parts[0] === first && parts.length > 1)) return paths;
  return paths.map(parts => parts.slice(1));
}

module.exports = {
  cleanupCache,
  getPageFile,
  getPages,
  listArchiveEntries,
  markResourceCacheActive,
  probeReadable,
  resourceCacheKey,
};
