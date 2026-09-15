const express = require('express');
const access = require('./lib/access');
const users = require('./lib/userStore');
const progressStore = require('./lib/progressStore');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer');
const config = require('./lib/config');
const settingsStore = require('./lib/settingsStore');
const { hasResult: hasScrapeResult } = require('./lib/scrapeProtection');
const { verifyToken, login: loginAccount } = require('./lib/auth');
const resourcePaths = require('./lib/resourcePaths');
const { createLibraryWatcher } = require('./lib/libraryWatcher');
const { resolveLocalRelations, metadataIdentity, sourceUrlOf, subjectIdOf, hasWebScrapeResult } = require('./lib/relatedLibrary');
const { installSettingsApi } = require('./lib/settingsApi');
const {
  emptyBangumi,
  getResource,
  readIndex,
  readLibraryIndexes,
  readSeriesBundle,
  readVolumeDetails,
  seriesStorageDir,
  upsertSeriesIndexes,
  upsertVolumeDetail,
  withSeriesOperation,
  writeSeriesBundle,
} = require('./lib/metadataStore');
const { cleanupCache, getPageFile, getPages, listArchiveEntries, markResourceCacheActive, probeReadable } = require('./lib/readerProvider');
const {
  contentTypeForEpubAsset,
  getCompatibleEpubFile,
  getEpubAssetFile,
  getEpubBrief,
  getEpubChapter,
  getEpubCoverFile,
  getEpubManifest,
} = require('./lib/epubProvider');
const {
  enqueueTask,
  getTaskVersion,
  onTasksChanged,
  restoreTaskIds,
  snapshot: taskSnapshot,
  waitForTask,
} = require('./lib/taskQueue');
const {
  isCoverFile,
  isImageFile,
  naturalCompare,
  parseVolumeNumberFromText,
  normalizeText,
  resourceRootFromRelativePath,
  resourceSeriesRootRelativePath,
  unique,
  walkImages,
} = require('./lib/utils');
const {
  fallbackBangumiToLocalMode,
  getApiJson,
  inheritLocalizedMetadataNames,
  maybeSimplifyChinese,
  maybeTranslate,
  normalizeVolumeDisplayTitle,
  pickImage,
} = require('./lib/archiveSource');
const { sourceAliasForRelativePath, sourceSegmentFromRelativePath } = require('./lib/sourceAliases');
const { getLibraryVersion, onLibraryChanged } = require('./lib/libraryEvents');
const {
  clearManualSplit,
  effectiveGroupForResource,
  readWorkRegistry,
  readWorkState,
  resolveWorkIdForBundle,
  seriesIdsForWork,
  setManualSplit,
  updateWorkOverrides,
  workIdFor,
  workIdForBundle,
} = require('./lib/workStore');
const {
  imageContentType,
  persistentCoverFromBuffer,
  persistentCoverFromFile,
  streamableImage,
} = require('./lib/imageProcessor');

const app = express();
const PORT = process.env.PORT || 13000;

// ─── 配置 ───
const DATA_DIR = config.DATA_DIR;
const localMetadata = require('./lib/localMetadata').createLocalMetadataService({
  resolve: require('./lib/archiveSource').resolveMetadataOnly,
  runAsUser: (id, operation) => {
    const user = users.get(id);
    if (!user?.enabled || user.mustChangePassword) throw new Error('账号不可用，请重新登录后重试');
    return access.context.run(user, operation);
  },
});
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(config.ROOT_DIR, 'public')));

// 认证中间件
function authMiddleware(req, res, next) {
  if (req.path === '/api/login' || req.path === '/api/server' || req.path === '/health') return next();
  if (!req.path.startsWith('/api/')) return next();

  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Token expired or invalid' });
  req.user = payload;
  res.set('Vary', 'Authorization');
  res.set('Cache-Control', 'private, no-cache');
  if (payload.mustChangePassword && !['/api/verify', '/api/account'].includes(req.path)) {
    return res.status(403).json({ error: '请先修改默认密码', code: 'PASSWORD_CHANGE_REQUIRED' });
  }
  // 首次鉴权后再启动批量刮削，避免冷启动时影响登录体验。
  if (payload.role === 'reader') {
    const path = req.path;
    const account = path === '/api/account' || path === '/api/me' || path === '/api/me/preferences';
    const progress = path.startsWith('/api/progress');
    const downloads = path === '/api/downloads' || path.startsWith('/api/downloads/');
    const localScrape = req.method === 'POST' && path === '/api/local-metadata';
    if ((!['GET', 'HEAD'].includes(req.method) && !account && !progress && !downloads && !localScrape)
      || ['/api/settings', '/api/users', '/api/tasks'].some(prefix => path === prefix || path.startsWith(prefix + '/'))) {
      return res.status(403).json({ error: '需要管理员权限' });
    }
    const json = res.json.bind(res);
    res.json = value => {
      const clean = v => Array.isArray(v) ? v.map(clean) : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).filter(([k]) => !['sourcePath', 'relativePath', 'seriesRelativePath', 'legacy'].includes(k)).map(([k,v]) => [k,clean(v)])) : v;
      return json(clean(value));
    };
  }
  access.context.run(payload, () => { if (payload.role === 'admin') scheduleStartupScrape(); next(); });
}
app.use(authMiddleware);

app.post('/api/local-metadata', async (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: '此接口只接受书籍描述 JSON，不接收资源文件' });
  try {
    const job = await localMetadata.submit(req.user.id, req.body, { force: req.query.force === 'true' });
    res.status(job.status === 'success' ? 200 : 202).json(job);
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '无法创建元数据任务' }); }
});
app.get('/api/local-metadata/:id', (req, res) => {
  const job = localMetadata.get(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: '元数据任务不存在' });
  res.json(job);
});

// ─── 数据目录 & 阅读进度工具 ───
async function getProgressFile() {
  const progress = await progressStore.read();
  if (!access.isReader()) return progress;
  const indexes = await readLibraryIndexes();
  const visible = new Set(indexes.seriesIndex.map(s => s.seriesId));
  return Object.fromEntries(Object.entries(progress).filter(([id]) => visible.has(id)).map(([id, value]) => {
    const chapters = Object.fromEntries(Object.entries(value.chapters || {}).filter(([, p]) => !!indexes.resourceIndex[p.resourceId]));
    if (indexes.resourceIndex[value.lastResourceId]) return [id, { ...value, chapters }];
    const latest = Object.entries(chapters).sort((a, b) => progressStore.order(b[1], a[1]))[0];
    if (!latest) return [id, { chapters }];
    const [chapter, p] = latest;
    return [id, { chapters, lastChapterUuid: chapter, lastResourceId: p.resourceId, lastResourceType: p.resourceType,
      lastPage: p.page, lastCfi: p.cfi, lastScrollPercent: p.scrollPercent,
      readAt: p.readAt, updatedAt: p.readAt, deviceId: p.deviceId, sequence: p.sequence }];
  }));
}

// multer: 封面上传
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed'));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

async function resolveSeriesPath(comicId, ...segments) {
  const bundle = await readSeriesBundle(comicId);
  if (!bundle) throw Object.assign(new Error('作品不存在'), { status: 404 });
  return segments.length ? resourcePaths.seriesPath(bundle, ...segments) : resourcePaths.seriesDirectory(bundle);
}
const configuredResourcePath = resourcePaths.resourcePath;

function customCoverApiPath(seriesId) {
  return `/api/series/${encodeURIComponent(seriesId)}/custom-cover`;
}

function isCustomCoverPath(seriesId, coverPath) {
  return String(coverPath || '').startsWith(customCoverApiPath(seriesId));
}

function comicCoverApiPath(comicId, filename) {
  return `/api/comics/${encodeURIComponent(comicId)}/cover/${encodeURIComponent(filename)}`;
}

function chapterImageApiPath(comicId, groupName, chapterDir, filename) {
  return `/api/comics/${encodeURIComponent(comicId)}/${encodeURIComponent(groupName)}/${encodeURIComponent(chapterDir)}/image/${encodeURIComponent(filename)}`;
}

function sanitizeCoverExt(ext) {
  const text = String(ext || '').toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(text) ? text : '.jpg';
}

function contentTypeForImageFile(filePath) {
  return imageContentType(filePath);
}

function isMissingFileError(error) {
  return ['ENOENT', 'ENOTDIR'].includes(error?.code);
}

function sendFileAsync(res, filePath) {
  return new Promise((resolve, reject) => {
    res.sendFile(filePath, error => {
      if (!error) {
        resolve();
        return;
      }
      if (res.headersSent) {
        console.warn(`[image] 发送图片中断: ${filePath}: ${error.message}`);
        resolve();
        return;
      }
      reject(error);
    });
  });
}

async function sendCachedImage(res, filePath, options = {}) {
  const seconds = options.seconds || 7 * 24 * 3600;
  const cacheControl = access.user() ? 'private, no-cache' : (options.cacheControl ||
    `private, max-age=${seconds}${options.immutable ? ', immutable' : ''}`);
  res.set('Cache-Control', cacheControl);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const image = options.resize === false
        ? { filePath, contentType: contentTypeForImageFile(filePath) }
        : await streamableImage(filePath);
      const contentType = image.contentType || contentTypeForImageFile(image.filePath);
      if (contentType) res.type(contentType);
      await sendFileAsync(res, image.filePath);
      return;
    } catch (error) {
      lastError = error;
      if (res.headersSent || options.resize === false || !isMissingFileError(error) || attempt > 0) throw error;
      console.warn(`[image] 缓存图片发送时丢失，重新生成: ${filePath}: ${error.message}`);
    }
  }
  throw lastError;
}

async function sendResourcePageImage(res, resourceId, pageNumber, pageOptions = {}, imageOptions = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const filePath = await getPageFile(resourceId, pageNumber, {
        ...pageOptions,
        forceRefresh: pageOptions.forceRefresh === true || attempt > 0,
      });
      await sendCachedImage(res, filePath, imageOptions);
      return;
    } catch (error) {
      lastError = error;
      if (res.headersSent || !isMissingFileError(error) || attempt > 0) throw error;
      console.warn(`[reader] 缓存页发送时丢失，重新生成: ${resourceId}#${pageNumber}: ${error.message}`);
    }
  }
  throw lastError;
}

function coverExtFromUpload(file) {
  if (!file) return '.jpg';
  if (/image\/png/.test(file.mimetype)) return '.png';
  if (/image\/gif/.test(file.mimetype)) return '.gif';
  if (/image\/webp/.test(file.mimetype)) return '.webp';
  if (/image\/jpe?g/.test(file.mimetype)) return '.jpg';
  return sanitizeCoverExt(path.extname(file.originalname));
}

function coverExtFromContentType(contentType) {
  const text = String(contentType || '').toLowerCase();
  if (text.includes('image/png')) return '.png';
  if (text.includes('image/gif')) return '.gif';
  if (text.includes('image/webp')) return '.webp';
  if (text.includes('image/avif')) return '.avif';
  if (text.includes('image/bmp')) return '.bmp';
  if (text.includes('image/svg')) return '.svg';
  if (text.includes('image/jpeg') || text.includes('image/jpg')) return '.jpg';
  return '';
}

function coverExtFromFilePath(filePath) {
  return path.extname(String(filePath || '')).toLowerCase();
}

async function listCustomCoverFiles(seriesId) {
  const dir = seriesStorageDir(seriesId);
  const files = await fs.readdir(dir).catch(() => []);
  return files
    .filter(file => /^custom_cover\.(jpg|jpeg|png|gif|webp)$/i.test(file))
    .map(file => path.join(dir, file));
}

async function clearCustomCoverFiles(seriesId) {
  const files = await listCustomCoverFiles(seriesId);
  for (const filePath of files) {
    await fs.unlink(filePath).catch(() => {});
  }
}

async function findCustomCoverFile(seriesId) {
  const files = await listCustomCoverFiles(seriesId);
  return files[0] || '';
}

async function saveCustomCoverBuffer(seriesId, buffer, ext) {
  const dir = seriesStorageDir(seriesId);
  await fs.mkdir(dir, { recursive: true });
  await clearCustomCoverFiles(seriesId);
  const cover = await persistentCoverFromBuffer(buffer, ext);
  const target = path.join(dir, `custom_cover${sanitizeCoverExt(cover.ext)}`);
  await fs.writeFile(target, cover.buffer);
  return target;
}

async function saveCustomCoverFromFile(seriesId, sourcePath) {
  const cover = await persistentCoverFromFile(sourcePath);
  const ext = sanitizeCoverExt(cover.ext || path.extname(cover.filePath || sourcePath));
  const dir = seriesStorageDir(seriesId);
  await fs.mkdir(dir, { recursive: true });
  await clearCustomCoverFiles(seriesId);
  const target = path.join(dir, `custom_cover${ext}`);
  await fs.copyFile(cover.filePath || sourcePath, target);
  return target;
}

async function updateSeriesCover(seriesId, coverPath) {
  return withSeriesOperation(seriesId, async () => {
    const bundle = await readSeriesBundle(seriesId);
    if (!bundle) throw new Error('Comic not found');
    const nextSeries = {
      ...bundle.series,
      cover: coverPath,
      lastUpdatedAt: new Date().toISOString(),
    };
    const writtenSeries = await writeSeriesBundle(nextSeries, bundle.resources, {
      bangumi: bundle.bangumi,
      relations: bundle.relations,
      persons: bundle.persons,
      characters: bundle.characters,
      translations: bundle.translations,
      volumeDetails: bundle.volumeDetails,
    });
    await upsertSeriesIndexes(writtenSeries, bundle.resources);
    return writtenSeries.cover;
  });
}

async function syncLogicalWorkCover(comicId, coverPath) {
  const context = await loadLogicalWorkContext(comicId).catch(() => null);
  if (!context) return;
  await updateWorkOverrides(context.workId, { cover: coverPath });
  for (const seriesId of context.seriesIds) {
    if (seriesId === comicId) continue;
    await updateSeriesCover(seriesId, coverPath);
  }
}

async function clearLogicalWorkCover(comicId) {
  const context = await loadLogicalWorkContext(comicId).catch(() => null);
  if (!context) return;
  await updateWorkOverrides(context.workId, { cover: undefined });
  for (const bundle of context.bundles) {
    if (bundle.series.seriesId === comicId) continue;
    await updateSeriesCover(bundle.series.seriesId, await defaultCoverForSeries(bundle));
  }
}

async function resolveSeriesCover(seriesId, fallbackCover) {
  const customFile = await findCustomCoverFile(seriesId);
  if (customFile) return customCoverApiPath(seriesId);
  if (/^\/api\/series\/[^/]+\/custom-cover(?:\?|$)/.test(fallbackCover || '')) return fallbackCover;
  const bangumi = await fs.readFile(path.join(seriesStorageDir(seriesId), 'bangumi.json'), 'utf8')
    .then(JSON.parse).catch(() => null);
  return preferLargeBangumiImage(bangumi?.image || bangumi?.cover || '') || fallbackCover || '';
}

async function firstNestedImageCover(absPath, comicId) {
  const groups = (await fs.readdir(absPath).catch(() => [])).sort(naturalCompare);
  for (const groupName of groups) {
    const groupPath = await resolveSeriesPath(comicId, groupName).catch(() => null);
    if (!groupPath) continue;
    const groupStat = await fs.stat(groupPath).catch(() => null);
    if (!groupStat?.isDirectory()) continue;

    const chapters = (await fs.readdir(groupPath).catch(() => [])).sort(naturalCompare);
    for (const chapterDir of chapters) {
      const chapterPath = await resolveSeriesPath(comicId, groupName, chapterDir).catch(() => null);
      if (!chapterPath) continue;
      const chapterStat = await fs.stat(chapterPath).catch(() => null);
      if (!chapterStat?.isDirectory()) continue;

      const images = (await fs.readdir(chapterPath).catch(() => []))
        .filter(isImageFile)
        .sort(naturalCompare);
      if (images.length > 0) {
        return chapterImageApiPath(comicId, groupName, chapterDir, images[0]);
      }
    }
  }
  return '';
}

async function directoryDefaultCover(comicId, resources = []) {
  if (!comicId) return '';
  const comicPath = await resolveSeriesPath(comicId).catch(() => null);
  if (!comicPath) return (resources || []).find(r => r.coverCandidate)?.coverCandidate || '';
  const files = (await fs.readdir(comicPath).catch(() => [])).sort(naturalCompare);
  const coverFile = files.find(isCoverFile);
  if (coverFile) return comicCoverApiPath(comicId, coverFile);

  const metaPath = await resolveSeriesPath(comicId, '元数据.json').catch(() => null);
  const raw = await (metaPath ? fs.readFile(metaPath, 'utf-8') : Promise.reject(new Error('No metadata')))
    .then(text => JSON.parse(text))
    .catch(() => null);
  const metadataCover = String(raw?.comic?.cover || '').trim();
  if (metadataCover) return metadataCover;

  const firstImage = await firstNestedImageCover(comicPath, comicId);
  if (firstImage) return firstImage;

  return (resources || []).find(resource => resource.coverCandidate)?.coverCandidate || '';
}

async function defaultCoverForSeries(bundle) {
  const seriesId = bundle?.series?.seriesId;
  if (!seriesId) return '';
  const bangumiCover = preferLargeBangumiImage(bundle.bangumi?.image || bundle.bangumi?.cover || '');
  if (bangumiCover) return bangumiCover;
  const currentCover = String(bundle.series.cover || '');
  if (currentCover && !isCustomCoverPath(seriesId, currentCover)) {
    return currentCover;
  }

  const legacyComicId = bundle.series.legacy?.comicId;
  if (legacyComicId) {
    const legacyCover = await directoryDefaultCover(legacyComicId, bundle.resources);
    if (legacyCover) return legacyCover;
  }

  const rootFromResource = resourceSeriesRootRelativePath((bundle.resources || [])[0]?.relativePath || '');
  if (rootFromResource) {
    const rootCover = await directoryDefaultCover(seriesId, bundle.resources);
    if (rootCover) return rootCover;
  }

  const fromResource = (bundle.resources || []).find(resource => resource.coverCandidate)?.coverCandidate;
  return fromResource || '';
}

// ─── 漫画列表缓存（2分钟 TTL）───
let comicsCache = { data: null, expiry: 0, version: 0 };
const CACHE_TTL = 2 * 60 * 1000; // 2分钟
let startupScrapeScheduled = false;

function invalidateComicsCache() {
  comicsCache.data = null;
  comicsCache.expiry = 0;
  comicsCache.version = 0;
}

const realtimeClients = new Set();

function writeRealtimeEvent(res, eventName, data) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastRealtimeEvent(eventName, data) {
  for (const res of realtimeClients) {
    try {
      if (!verifyToken(res.readdeckToken)) { res.end(); realtimeClients.delete(res); continue; }
      if (res.readdeckUser.role === 'reader') {
        if (eventName !== 'library_changed') continue;
        writeRealtimeEvent(res, eventName, { version: data.version, reason: 'library_changed' });
      } else writeRealtimeEvent(res, eventName, data);
    } catch (error) {
      realtimeClients.delete(res);
    }
  }
}

onLibraryChanged(event => {
  invalidateComicsCache();
  broadcastRealtimeEvent('library_changed', event);
});
onTasksChanged(event => broadcastRealtimeEvent('tasks_changed', event));

setInterval(() => {
  for (const res of realtimeClients) {
    try {
      if (!verifyToken(res.readdeckToken)) { res.end(); realtimeClients.delete(res); continue; }
      res.write(': heartbeat\n\n');
    } catch (error) {
      realtimeClients.delete(res);
    }
  }
}, 25000).unref();

app.get('/api/events', (req, res) => {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  res.readdeckUser = req.user;
  res.readdeckToken = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  realtimeClients.add(res);
  writeRealtimeEvent(res, 'ready', {
    libraryVersion: getLibraryVersion(),
    taskVersion: getTaskVersion(),
    tasks: req.user.role === 'admin' ? taskSnapshot() : [],
    connectedAt: new Date().toISOString(),
  });

  req.on('close', () => {
    realtimeClients.delete(res);
  });
});

function automaticReady() {
  const settings = settingsStore.snapshot();
  return settings.libraryConfirmed && !settings.scanRequired && !settingsStore.secrets().account?.mustChangePassword;
}
function enqueueStartupScan(reason = 'startup') {
  const settings = settingsStore.snapshot();
  if (!automaticReady() || !settings.scanning.onStart) return;
  enqueueTask(settings.scanning.autoScrapeOnStart ? 'scanAndScrape' : 'scanLibrary', { reason, automatic: true, force: false, fastScan: true }).catch(err => {
    console.warn('[tasks] 启动自动扫描入队失败:', err.message);
  });
}

async function enqueueScanAndWait(reason) {
  if (access.isReader()) return null;
  if (!settingsStore.snapshot().libraryConfirmed || settingsStore.snapshot().scanRequired) return null;
  const task = await enqueueTask('scanLibrary', { reason, force: false });
  await waitForTask(task);
  invalidateComicsCache();
  return task;
}

function dateOnly(value) {
  if (!value) return '';
  const text = String(value);
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString().slice(0, 10);
}

function relationVolumeNumber(relation) {
  const text = [relation?.name_cn, relation?.name].filter(Boolean).join(' ');
  return parseVolumeNumberFromText(text);
}

function isOffprintRelation(relation) {
  const relationType = String(relation?.relationType || '').trim().toLowerCase();
  if (!relationType) return false;
  if (relationType === '1003') return true;
  return /单行本|單行本|offprint|volume/.test(relationType);
}

function preferLargeBangumiImage(url) {
  const text = String(url || '');
  if (!text.includes('bgm.tv/') && !text.includes('bangumi.tv/')) return text;
  return text
    // strip CDN resize prefix /r/N/ and force l size (covers /r/400/pic/cover/l/ etc.)
    .replace(/\/r\/\d+\/pic\/(cover|crt)\/[gsml]\//, '/pic/$1/l/')
    .replace(/\/pic\/(cover|crt)\/[gsm]\//, '/pic/$1/l/');
}

async function fetchBangumiCover(subjectId) {
  if (!Number.isInteger(subjectId) || subjectId <= 0) {
    throw new Error('Invalid Bangumi subject id');
  }

  const detail = await getApiJson(`/v0/subjects/${subjectId}`);
  const coverUrl = preferLargeBangumiImage(detail?.images ? pickImage(detail.images) : '');
  if (!coverUrl) throw new Error('Bangumi cover not found');
  if (typeof fetch !== 'function') throw new Error('Fetch API unavailable');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(coverUrl, {
      headers: {
        'User-Agent': config.BANGUMI_USER_AGENT,
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: `https://bangumi.tv/subject/${subjectId}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Bangumi cover download failed: HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') || '';
    if (contentType && !/^image\//i.test(contentType)) {
      throw new Error(`Bangumi cover is not an image: ${contentType}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) throw new Error('Bangumi cover is empty');
    if (buffer.length > 20 * 1024 * 1024) throw new Error('Bangumi cover is too large');

    return {
      buffer,
      ext: coverExtFromContentType(contentType) || coverExtFromFilePath(new URL(coverUrl).pathname),
      sourceUrl: coverUrl,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildVolumeCoverMap(relations) {
  const offprints = (relations || []).filter(isOffprintRelation);
  const out = new Map();
  let hasExplicit = false;
  for (const relation of offprints) {
    const volumeNumber = relationVolumeNumber(relation);
    const image = preferLargeBangumiImage(relation.image);
    if (volumeNumber && image && !out.has(volumeNumber)) {
      out.set(volumeNumber, image);
      hasExplicit = true;
    }
  }
  if (!hasExplicit) {
    const sorted = [...offprints].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    sorted.forEach((relation, index) => {
      const image = preferLargeBangumiImage(relation.image);
      if (!image) return;
      const volumeNumber = index + 1;
      if (!out.has(volumeNumber)) out.set(volumeNumber, image);
    });
  }
  return out;
}

function buildVolumeSubjectIdMap(relations) {
  const offprints = (relations || []).filter(isOffprintRelation);
  const out = new Map();
  let hasExplicit = false;
  for (const relation of offprints) {
    const volumeNumber = relationVolumeNumber(relation);
    if (volumeNumber && relation.subjectId && !out.has(volumeNumber)) {
      out.set(volumeNumber, Number(relation.subjectId));
      hasExplicit = true;
    }
  }
  if (!hasExplicit) {
    const sorted = [...offprints].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    sorted.forEach((relation, index) => {
      if (!relation.subjectId) return;
      const volumeNumber = index + 1;
      if (!out.has(volumeNumber)) out.set(volumeNumber, Number(relation.subjectId));
    });
  }
  return out;
}

function buildVolumeSubjectCoverMap(relations) {
  const out = new Map();
  for (const relation of relations || []) {
    const subjectId = Number(relation.subjectId || 0);
    const image = preferLargeBangumiImage(relation.image);
    if (!subjectId || !image || out.has(subjectId)) continue;
    out.set(subjectId, image);
  }
  return out;
}

function buildVolumeSubjectOrderMap(relations) {
  const out = new Map();
  const offprints = (relations || [])
    .filter(isOffprintRelation)
    .map((relation, index) => ({
      relation,
      index,
      order: Number(relation.order || 0),
    }))
    .sort((a, b) => (a.order || a.index + 1) - (b.order || b.index + 1));

  offprints.forEach(({ relation, order }, index) => {
    const subjectId = Number(relation.subjectId || 0);
    if (!subjectId || out.has(subjectId)) return;
    out.set(subjectId, order || index + 1);
  });
  return out;
}

function hasVolumeMatches(bundle) {
  return Array.isArray(bundle?.bangumi?.volumeMatches) && bundle.bangumi.volumeMatches.length > 0;
}

function volumeMatchKeys(resource) {
  return [
    resource?.resourceId,
    resource?.relativePath,
    resource?.originalTitle,
    resource?.title,
  ].filter(Boolean).map(String);
}

function findVolumeMatch(bundle, resource) {
  const matches = Array.isArray(bundle?.bangumi?.volumeMatches) ? bundle.bangumi.volumeMatches : [];
  if (matches.length === 0 || !resource) return null;
  const exact = matches.find(match => String(match.resourceId || '') === String(resource.resourceId || ''));
  if (exact) return exact;
  // New scrape contracts identify resources strictly by the original resource ID.
  if (hasWebScrapeResult(bundle)) return null;
  const keys = new Set(volumeMatchKeys(resource));
  return matches.find(match =>
    (match.resourceId && keys.has(String(match.resourceId))) ||
    (match.resourceKey && keys.has(String(match.resourceKey))) ||
    (match.originalTitle && keys.has(String(match.originalTitle)))
  ) || null;
}

function confirmedVolumeSubjectId(match) {
  if (!match || match.matched === false) return null;
  return subjectIdOf(match);
}

function confirmedVolumeDetailKey(match) {
  // A localized fallback can have saved details even when no online match was found.
  if (!match) return '';
  return String(match.detailKey || match.metadataKey || confirmedVolumeSubjectId(match) || '');
}

function storedVolumeDetail(bundle, match) {
  const key = confirmedVolumeDetailKey(match);
  const subjectId = confirmedVolumeSubjectId(match);
  return (key && bundle?.volumeDetails?.[key]) ||
    (subjectId && bundle?.volumeDetails?.[String(subjectId)]) || null;
}

function metadataSourceFields(value = {}, fallback = {}) {
  return {
    metadataKey: value?.metadataKey || fallback?.metadataKey || '',
    sourceUrl: sourceUrlOf(value) || sourceUrlOf(fallback),
    externalLinks: Array.isArray(value?.externalLinks) ? value.externalLinks : (fallback?.externalLinks || []),
    sources: Array.isArray(value?.sources) ? value.sources : (fallback?.sources || []),
  };
}

function presentedPerson(value, kind) {
  return { ...value, sourceUrl: sourceUrlOf(value, kind), url: sourceUrlOf(value, kind),
    image: preferLargeBangumiImage(value.image),
    ...(Array.isArray(value.actors) ? { actors: value.actors.map(actor => presentedPerson(actor, 'person')) } : {}) };
}

function presentedVolumeDetail(base, persisted, cachedLocalSummary, finalWebResult) {
  const local = finalWebResult ? null : cachedLocalSummary;
  return {
    ...base,
    ...metadataSourceFields(persisted, base),
    detailKey: persisted?.detailKey || base.detailKey || '',
    cover: persisted?.cover || base.cover,
    nameJa: persisted?.nameJa || '',
    nameCn: persisted?.nameCn || base.nameCn,
    summary: local?.summary || persisted?.summary || (finalWebResult ? '' : base.summary) || '',
    translatedSummary: local?.translatedSummary || persisted?.translatedSummary || (finalWebResult ? '' : base.translatedSummary) || '',
    date: persisted?.date || '',
  };
}

function volumeDisplayTitle(resource, match) {
  return String(match?.displayTitle || resource?.title || resource?.originalTitle || '').trim();
}

function volumeDisplayTitleForCategory(resource, match, category = '', series = {}) {
  const title = volumeDisplayTitle(resource, match);
  if (match?.displayTitleSource === 'ai' || match?.source === 'ai_web_scrape' || match?.detailKey) return title;
  return normalizeVolumeDisplayTitle(title, resource, series) || title;
}

function relatedSectionTitle(relationType) {
  const value = String(relationType || '').trim();
  if (!value) return '关联资源';
  return value
    .replace(/單行本/g, '单行本')
    .replace(/畫集/g, '画集')
    .replace(/設定集/g, '设定集')
    .replace(/外傳/g, '外传');
}

function inferredVolumeMatch(bundle, resource) {
  const match = findVolumeMatch(bundle, resource);
  if (!match) return null;
  const detailKey = confirmedVolumeDetailKey(match);
  const relation = (bundle.relations || bundle.bangumi?.relatedSubjects || [])
    .find(item => metadataIdentity(item) && metadataIdentity(item) === metadataIdentity(match)) || null;
  const relationType = String(match.relationType || relation?.relationType || '');
  let matchKind = String(match.matchKind || '');
  if (!matchKind) {
    if (!detailKey || match.matched === false) matchKind = 'local';
    else if (!relationType || isOffprintRelation({ relationType })) matchKind = 'offprint';
    else matchKind = 'related';
  }
  return {
    ...match,
    matchKind,
    relationType,
    sectionTitle: match.sectionTitle || (matchKind === 'related' ? relatedSectionTitle(relationType) : ''),
  };
}

async function loadLogicalWorkContext(comicId) {
  const baseBundle = await readSeriesBundle(comicId);
  if (!baseBundle) return null;
  const category = baseBundle.series?.category || 'comic';
  const subjectId = subjectIdOf(baseBundle.bangumi) || subjectIdOf(baseBundle.series);
  const metadataKey = baseBundle.bangumi?.metadataKey || baseBundle.series?.metadataKey || '';
  const workId = subjectId > 0 ? workIdForBundle(baseBundle) : await resolveWorkIdForBundle(baseBundle);
  const seriesIndex = await readIndex('series-index.json', []);
  let seriesIds;
  if (subjectId > 0) {
    seriesIds = (seriesIndex || [])
      .filter(item => Number(item.bangumiSubjectId || 0) === subjectId && (item.category || 'comic') === category)
      .map(item => item.seriesId);
  } else if (metadataKey) {
    seriesIds = (seriesIndex || [])
      .filter(item => item.metadataKey === metadataKey && (item.category || 'comic') === category)
      .map(item => item.seriesId);
  } else {
    seriesIds = await seriesIdsForWork(workId, [comicId]);
  }
  seriesIds = unique([comicId, ...(seriesIds || [])]);
  const bundles = (await Promise.all(seriesIds.map(seriesId =>
    seriesId === comicId ? baseBundle : readSeriesBundle(seriesId).catch(() => null)
  ))).filter(bundle => {
    if (!bundle?.series?.seriesId) return false;
    if ((bundle.series.category || 'comic') !== category) return false;
    if (subjectId > 0) {
      return Number(bundle.bangumi?.subjectId || bundle.series?.bangumiSubjectId || 0) === subjectId;
    }
    if (metadataKey) return workIdForBundle(bundle) === workId;
    return !subjectIdOf(bundle.bangumi) && !subjectIdOf(bundle.series) &&
      !bundle.bangumi?.metadataKey && !bundle.series?.metadataKey;
  });
  bundles.sort((a, b) => Number(b.series.seriesId === comicId) - Number(a.series.seriesId === comicId));
  const workState = await readWorkState(workId);
  return {
    workId,
    workState,
    baseBundle,
    bundles,
    seriesIds: bundles.map(bundle => bundle.series.seriesId),
    category,
    subjectId,
    metadataKey,
  };
}

function mergeWorkProgress(progress, seriesIds = []) {
  const rows = (seriesIds || [])
    .map(seriesId => ({ seriesId, value: progress?.[seriesId] || null }))
    .filter(row => row.value);
  if (rows.length === 0) return {};
  rows.sort((a, b) => progressStore.order(b.value, a.value));
  const latest = rows[0];
  const chapters = {};
  for (const row of rows) {
    for (const [chapterUuid, chapter] of Object.entries(row.value.chapters || {})) {
      const current = chapters[chapterUuid];
      if (!current || progressStore.order(chapter, current) > 0) {
        chapters[chapterUuid] = { ...chapter, seriesId: chapter?.seriesId || row.seriesId };
      }
    }
  }
  return {
    ...latest.value,
    seriesId: latest.seriesId,
    seriesIds: rows.map(row => row.seriesId),
    chapters,
  };
}

function resourceLastReadAt(progress, resource) {
  const seriesProgress = progress?.[resource?.seriesId] || {};
  let value = seriesProgress.lastResourceId === resource?.resourceId
    ? String(seriesProgress.updatedAt || '')
    : '';
  for (const chapter of Object.values(seriesProgress.chapters || {})) {
    if (chapter?.resourceId !== resource?.resourceId) continue;
    if (String(chapter.updatedAt || '') > value) value = String(chapter.updatedAt || '');
  }
  return value;
}

function compareResourceVersions(a, b, progress = {}) {
  const aReadAt = resourceLastReadAt(progress, a);
  const bReadAt = resourceLastReadAt(progress, b);
  if (aReadAt !== bReadAt) return bReadAt.localeCompare(aReadAt);
  const readableSort = Number(b.readable !== false) - Number(a.readable !== false);
  if (readableSort) return readableSort;
  const aAdded = String(a.firstIndexedAt || a.modifiedTime || '');
  const bAdded = String(b.firstIndexedAt || b.modifiedTime || '');
  if (aAdded !== bAdded) return bAdded.localeCompare(aAdded);
  return naturalCompare(a.relativePath || a.resourceId || '', b.relativePath || b.resourceId || '');
}

function publicResource(resource) {
  if (!resource) return null;
  const { sourcePath, ...safeResource } = resource;
  return safeResource;
}

function versionSummary(resource, workState, progress = {}, options = {}) {
  const lastReadAt = resourceLastReadAt(progress, resource);
  const sourceAlias = sourceAliasForRelativePath(resource.relativePath || '', {
    category: resource.category || 'comic',
    sourcePath: resource.sourcePath || '',
    sourceId: resource.sourceId || '',
  });
  const out = {
    resourceId: resource.resourceId,
    seriesId: resource.seriesId,
    sourceAlias,
    sourceTitle: resourceRootFromRelativePath(resource.relativePath || '') || resource.originalTitle || resource.title || '',
    format: String(resource.type || '').toUpperCase(),
    type: resource.type || '',
    fileSize: Number.isFinite(Number(resource.fileSize)) ? Number(resource.fileSize) : null,
    pageCount: Number(resource.pageCount || 0),
    firstIndexedAt: resource.firstIndexedAt || resource.modifiedTime || '',
    modifiedTime: resource.modifiedTime || '',
    readable: resource.readable !== false,
    lastReadAt,
    recentlyRead: !!lastReadAt,
    manualSplit: !!workState?.manualSplits?.[resource.resourceId],
  };
  if (options.includePath) out.sourcePath = resource.sourcePath || '';
  return out;
}

function bookFallbackGroupKey(workState, resource, subjectId, detailKey = '') {
  const split = workState?.manualSplits?.[resource.resourceId];
  if (split?.groupKey) return split.groupKey;
  if (subjectId) return `subject:${subjectId}`;
  if (detailKey) return `detail:${detailKey}`;
  return effectiveGroupForResource(workState, resource.resourceId, `resource:${resource.resourceId}`);
}

function chapterFallbackGroupKey(workState, resource, groupKey) {
  const split = workState?.manualSplits?.[resource.resourceId];
  if (split?.groupKey) return split.groupKey;
  const number = Number(resource.detectedNumber || 0);
  if (number) {
    const title = normalizeText(resource.originalTitle || resource.title || '');
    return `chapter:${normalizeText(groupKey)}:${number}:${title}`;
  }
  return effectiveGroupForResource(workState, resource.resourceId, `resource:${resource.resourceId}`);
}

function buildBookPresentation(context, progress = {}) {
  const relationByIdentity = new Map();
  const volumeDetailsByKey = new Map();
  for (const bundle of context.bundles) {
    for (const relation of bundle.relations || bundle.bangumi?.relatedSubjects || []) {
      const key = metadataIdentity(relation);
      if (key && !relationByIdentity.has(key)) relationByIdentity.set(key, relation);
    }
    for (const [storedKey, detail] of Object.entries(bundle.volumeDetails || {})) {
      for (const key of unique([storedKey, detail.detailKey, detail.metadataKey].filter(Boolean).map(String))) {
        if (!volumeDetailsByKey.has(key)) volumeDetailsByKey.set(key, detail);
      }
    }
  }

  const records = new Map();
  const resourceContexts = new Map();
  for (const bundle of context.bundles) {
    for (const rawResource of bundle.resources || []) {
      if (rawResource.contentType !== 'volume') continue;
      const resource = { ...rawResource, seriesId: bundle.series.seriesId };
      const match = inferredVolumeMatch(bundle, resource);
      const subjectId = confirmedVolumeSubjectId(match);
      const detailKey = confirmedVolumeDetailKey(match);
      const relation = relationByIdentity.get(metadataIdentity(match));
      const relationType = String(match?.relationType || relation?.relationType || '');
      const matchKind = match?.matchKind || (detailKey ? 'offprint' : 'local');
      const bookKey = bookFallbackGroupKey(context.workState, resource, subjectId, detailKey);
      if (!records.has(bookKey)) {
        records.set(bookKey, {
          bookKey,
          versions: [],
          subjectId: subjectId || null,
          detailKey,
          relationType,
          matchKind,
        });
      }
      const record = records.get(bookKey);
      record.versions.push(resource);
      if (!record.subjectId && subjectId) record.subjectId = subjectId;
      if (!record.detailKey && detailKey) record.detailKey = detailKey;
      if (!record.relationType && relationType) record.relationType = relationType;
      if (record.matchKind === 'local' && matchKind !== 'local') record.matchKind = matchKind;
      resourceContexts.set(resource.resourceId, { bundle, resource, match, bookKey });
    }
  }

  const books = [];
  for (const record of records.values()) {
    record.versions.sort((a, b) => compareResourceVersions(a, b, progress));
    const representative = record.versions[0];
    const representativeContext = resourceContexts.get(representative.resourceId);
    const match = representativeContext?.match || null;
    const subjectId = Number(record.subjectId || 0) || null;
    const relation = relationByIdentity.get(metadataIdentity(match));
    const detail = storedVolumeDetail(representativeContext?.bundle, match) ||
      volumeDetailsByKey.get(record.detailKey) || (subjectId ? volumeDetailsByKey.get(String(subjectId)) : null);
    const modelTitle = context.workState?.modelGroups?.[representative.resourceId]?.title || '';
    const title = (record.matchKind === 'related'
      ? volumeDisplayTitle(representative, match)
      : volumeDisplayTitleForCategory(
          representative,
          match,
          context.category,
          representativeContext?.bundle?.series || context.baseBundle.series
        )) || modelTitle || detail?.nameCn || detail?.nameJa || representative.originalTitle || representative.title;
    const sectionTitle = record.matchKind === 'offprint'
      ? (context.category === 'novel' ? '卷册' : '单行本')
      : (record.matchKind === 'related'
          ? relatedSectionTitle(record.relationType || match?.sectionTitle)
          : '本地书本');
    const relationCover = preferLargeBangumiImage(relation?.image || '');
    const cover = detail?.cover || relationCover || representative.coverCandidate ||
      `/api/resources/${encodeURIComponent(representative.resourceId)}/cover`;
    const order = Number(match?.bangumiOrder || relation?.order || representative.detectedNumber || 0);
    const book = {
      bookKey: record.bookKey,
      subjectId,
      bangumiSubjectId: subjectId,
      detailKey: record.detailKey,
      ...metadataSourceFields(detail, match),
      relationType: record.relationType,
      matchKind: record.matchKind,
      sectionTitle,
      title,
      cover,
      order: order || null,
      versionCount: record.versions.length,
      representativeResourceId: representative.resourceId,
      representativeSeriesId: representative.seriesId,
      pageCount: Number(representative.pageCount || 0),
      type: representative.type || '',
      category: representative.category || context.category,
      manualGrouping: record.versions.some(resource => !!context.workState?.manualSplits?.[resource.resourceId]),
      _versions: record.versions,
    };
    books.push(book);
    for (const resource of record.versions) {
      const item = resourceContexts.get(resource.resourceId);
      if (item) item.book = book;
    }
  }

  const kindRank = { offprint: 0, related: 1, local: 2 };
  books.sort((a, b) =>
    (kindRank[a.matchKind] ?? 3) - (kindRank[b.matchKind] ?? 3) ||
    (Number(a.order || Number.MAX_SAFE_INTEGER) - Number(b.order || Number.MAX_SAFE_INTEGER)) ||
    naturalCompare(a.title, b.title)
  );
  const sectionMap = new Map();
  for (const book of books) {
    const key = `${book.matchKind}:${book.sectionTitle}`;
    if (!sectionMap.has(key)) {
      sectionMap.set(key, {
        key,
        title: book.sectionTitle,
        relationType: book.matchKind === 'related' ? book.relationType : '',
        matchKind: book.matchKind,
        items: [],
      });
    }
    const { _versions, ...publicBook } = book;
    sectionMap.get(key).items.push(publicBook);
  }

  const consumedSubjectIds = new Set(books.map(book => Number(book.subjectId || 0)).filter(Boolean));
  const consumedMetadataKeys = new Set(books.flatMap(book => [book.detailKey, book.metadataKey]).filter(Boolean));
  const localVolumes = books.map(book => ({
    resourceId: book.representativeResourceId,
    seriesId: book.representativeSeriesId,
    bookKey: book.bookKey,
    title: book.title,
    order: book.order,
    pageCount: book.pageCount,
    type: book.type,
    category: book.category,
    cover: book.cover,
    bangumiSubjectId: book.subjectId,
    detailKey: book.detailKey,
    ...metadataSourceFields(book),
    relationType: book.relationType,
    matchKind: book.matchKind,
    versionCount: book.versionCount,
  }));

  return {
    bookSections: Array.from(sectionMap.values()),
    books,
    consumedSubjectIds,
    consumedMetadataKeys,
    localVolumes,
    resourceContexts,
  };
}

function buildChapterPresentation(context, progress = {}, bookPresentation = null) {
  const records = new Map();
  for (const bundle of context.bundles) {
    for (const rawResource of bundle.resources || []) {
      if (rawResource.contentType === 'volume') continue;
      const resource = { ...rawResource, seriesId: bundle.series.seriesId };
      const legacy = resource.legacy || {};
      const tabKey = legacy.groupKey || resource.groupKey ||
        (resource.contentType === 'mixed_bundle' ? 'mixed' : 'chapters');
      const groupName = legacy.groupName || resource.groupName ||
        (resource.contentType === 'mixed_bundle' ? '混合资源' : '章节');
      const logicalKey = chapterFallbackGroupKey(context.workState, resource, tabKey);
      if (!records.has(logicalKey)) records.set(logicalKey, { logicalKey, tabKey, groupName, versions: [] });
      records.get(logicalKey).versions.push(resource);
    }
  }

  const chapterGroups = {};
  for (const record of records.values()) {
    record.versions.sort((a, b) => compareResourceVersions(a, b, progress));
    const representative = record.versions[0];
    const legacy = representative.legacy || {};
    const title = legacy.chapterTitle || representative.title || representative.originalTitle || record.groupName;
    const versionRows = record.versions.map(resource => ({
      ...versionSummary(resource, context.workState, progress),
      title: resource.title || resource.originalTitle || title,
      pageCount: Number(resource.pageCount || 0),
    }));
    const chapter = {
      chapterUuid: legacy.chapterUuid || representative.resourceId,
      chapterTitle: title,
      groupName: record.groupName,
      order: representative.detectedNumber ?? 0,
      resourceId: representative.resourceId,
      seriesId: representative.seriesId,
      resourceType: representative.type,
      contentType: representative.contentType,
      pageCount: Number(representative.pageCount || 0),
      readable: representative.readable !== false,
      readError: representative.readError || '',
      category: representative.category || context.category,
      cover: representative.coverCandidate || `/api/resources/${encodeURIComponent(representative.resourceId)}/cover`,
      versionCount: record.versions.length,
      versions: versionRows,
      manualGrouping: record.versions.some(resource => !!context.workState?.manualSplits?.[resource.resourceId]),
    };
    if (!chapterGroups[record.tabKey]) chapterGroups[record.tabKey] = [];
    chapterGroups[record.tabKey].push(chapter);
  }
  for (const chapters of Object.values(chapterGroups)) {
    chapters.sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || naturalCompare(a.chapterTitle, b.chapterTitle));
  }

  const groups = { ...chapterGroups };
  const physicalVolumes = [];
  for (const book of bookPresentation?.books || []) {
    for (const resource of book._versions || []) {
      physicalVolumes.push({
        chapterUuid: resource.resourceId,
        chapterTitle: book.title || resource.title || resource.originalTitle || '',
        groupName: context.category === 'novel' ? '卷册' : '单行本',
        order: book.order || resource.detectedNumber || 0,
        resourceId: resource.resourceId,
        seriesId: resource.seriesId,
        resourceType: resource.type,
        contentType: 'volume',
        detailKey: book.detailKey,
        ...metadataSourceFields(book),
        pageCount: Number(resource.pageCount || 0),
        readable: resource.readable !== false,
        readError: resource.readError || '',
        category: resource.category || context.category,
        cover: resource.coverCandidate || `/api/resources/${encodeURIComponent(resource.resourceId)}/cover`,
      });
    }
  }
  if (physicalVolumes.length > 0) groups.volumes = physicalVolumes;
  return { groups, chapterGroups };
}

async function getLocalEpubBrief(resources = []) {
  const epubResources = (resources || [])
    .filter(resource => resource.type === 'epub' && resource.readable !== false)
    .sort((a, b) => (a.detectedNumber || 0) - (b.detectedNumber || 0) || naturalCompare(a.title, b.title));

  for (const resource of epubResources) {
    const description = await getLocalEpubResourceBrief(resource);
    if (description) return description;
  }
  return '';
}

function cachedLocalEpubBriefFromBundle(bundle) {
  const matches = Array.isArray(bundle?.bangumi?.volumeMatches) ? bundle.bangumi.volumeMatches : [];
  for (const match of matches) {
    const localSummary = localSummaryFromVolumeMatch(match);
    const displayText = localSummary?.translatedSummary || localSummary?.summary || '';
    if (displayText) return displayText;
  }
  return '';
}

function fallbackSummaryResult(text) {
  const sourceText = String(text || '').trim();
  return {
    summary: sourceText,
    translatedSummary: '',
    translation: null,
  };
}

function localSummaryFromVolumeMatch(match) {
  const localSummary = match?.localSummary || null;
  if (!localSummary) return null;
  const summary = String(localSummary.summary || '').trim();
  const translatedSummary = String(localSummary.translatedSummary || '').trim();
  if (!summary && !translatedSummary) return null;
  return {
    summary,
    translatedSummary,
    translation: localSummary.translation || null,
  };
}

async function getRawLocalEpubResourceSummary(resource) {
  if (!resource || resource.type !== 'epub') return null;
  const rawSummary = String(await getEpubBrief(resource).catch(() => '') || '').trim();
  if (!rawSummary) return null;
  return fallbackSummaryResult(rawSummary);
}

async function getLocalEpubResourceBrief(resource) {
  const localSummary = await getRawLocalEpubResourceSummary(resource);
  return localSummary?.summary || '';
}

const DETAIL_PAGE_COUNT_RESOURCE_TYPES = new Set(['image', 'directory', 'zip', 'cbz', 'rar', 'pdf']);

function shouldResolveDetailPageCount(resource) {
  return DETAIL_PAGE_COUNT_RESOURCE_TYPES.has(resource?.type) && Number(resource.pageCount || 0) <= 0;
}

async function persistResourcePageCount(bundle, nextResource) {
  const seriesId = bundle?.series?.seriesId;
  await withSeriesOperation(seriesId, async () => {
    const latest = await readSeriesBundle(seriesId);
    if (!latest) return;
    const nextResources = (latest.resources || []).map(resource =>
      resource.resourceId === nextResource.resourceId
        ? {
            ...resource,
            pageCount: nextResource.pageCount,
            readable: nextResource.readable,
            readError: nextResource.readError,
            coverCandidate: nextResource.coverCandidate,
          }
        : resource
    );
    const writtenSeries = await writeSeriesBundle(latest.series, nextResources, {
      bangumi: latest.bangumi,
      relations: latest.relations,
      persons: latest.persons,
      characters: latest.characters,
      translations: latest.translations,
      volumeDetails: latest.volumeDetails,
    });
    await upsertSeriesIndexes(writtenSeries, nextResources);
    bundle.series = writtenSeries;
    bundle.resources = nextResources;
  });
  invalidateComicsCache();
}

async function resolveDetailPageCount(bundle, resource) {
  if (!shouldResolveDetailPageCount(resource)) return resource;

  const probe = await probeReadable(resource);
  const pageCount = Number(probe?.pageCount || 0);
  const nextResource = {
    ...resource,
    pageCount,
    readable: probe?.readable !== false,
    readError: probe?.error || '',
    coverCandidate: pageCount > 0
      ? `/api/resources/${encodeURIComponent(resource.resourceId)}/cover`
      : (resource.coverCandidate || ''),
  };
  const changed =
    Number(resource.pageCount || 0) !== nextResource.pageCount ||
    resource.readable !== nextResource.readable ||
    String(resource.readError || '') !== String(nextResource.readError || '') ||
    String(resource.coverCandidate || '') !== String(nextResource.coverCandidate || '');

  if (changed) await persistResourcePageCount(bundle, nextResource);
  return nextResource;
}

async function buildVolumeSubChapters(resource) {
  if (!resource || !resource.sourcePath || resource.type === 'pdf') return [];

  if (resource.type === 'epub') {
    try {
      const manifest = await getEpubManifest(resource);
      // Prefer the real "目录" (book TOC) from nav.xhtml/NCX, fall back to spine chapters.
      const tocFlat = Array.isArray(manifest.tocFlat) ? manifest.tocFlat : [];
      if (tocFlat.length > 0) {
        return tocFlat
          .filter(item => item && (item.title || item.href))
          .map((item, index) => {
            // chapterIndex maps to spine position (used as "page" in reader); fallback 0.
            const chapterIndex = Number.isInteger(item.chapterIndex) ? item.chapterIndex : 0;
            return {
              title: item.title || `章节 ${index + 1}`,
              startPage: chapterIndex + 1,
              pageCount: 1,
              chapterIndex,
              depth: Number.isInteger(item.depth) ? item.depth : 0,
              href: item.href || '',
            };
          });
      }
      return (manifest.chapters || []).map((chapter, index) => ({
        title: chapter.title || `章节 ${index + 1}`,
        startPage: index + 1,
        pageCount: 1,
        chapterIndex: index,
      }));
    } catch (error) {
      console.warn(`[volume-detail] failed to parse epub chapters for ${resource.resourceId}: ${error.message}`);
      return [];
    }
  }

  function splitPathParts(input) {
    return String(input || '').split(/[\\/]+/).filter(Boolean);
  }

  function chapterListFromRelativePaths(relativePaths) {
    if (!Array.isArray(relativePaths) || relativePaths.length === 0) return [];

    const directoryParts = relativePaths
      .map(splitPathParts)
      .filter(parts => parts.length >= 2)
      .map(parts => parts.slice(0, -1));
    if (directoryParts.length === 0) return [];

    let commonPrefix = directoryParts[0].slice();
    for (const dirs of directoryParts.slice(1)) {
      const limit = Math.min(commonPrefix.length, dirs.length);
      let index = 0;
      while (index < limit && commonPrefix[index] === dirs[index]) index += 1;
      commonPrefix = commonPrefix.slice(0, index);
      if (commonPrefix.length === 0) break;
    }

    const chapterMap = new Map();
    for (let pageIndex = 0; pageIndex < relativePaths.length; pageIndex += 1) {
      const parts = splitPathParts(relativePaths[pageIndex]);
      if (parts.length < 2) continue;

      let dirs = parts.slice(0, -1);
      if (commonPrefix.length > 0) dirs = dirs.slice(commonPrefix.length);
      if (dirs.length === 0) continue;

      // Prefer actual chapter directory when archives are wrapped by a 普通版 folder.
      if (/^[\[【(（]?普通版[\]】)）]?$/i.test(dirs[0])) {
        dirs = dirs.slice(1);
      }
      if (dirs.length === 0) continue;

      const chapterTitle = dirs[0];
      const existing = chapterMap.get(chapterTitle);
      if (existing) {
        existing.pageCount += 1;
      } else {
        chapterMap.set(chapterTitle, {
          title: chapterTitle,
          startPage: pageIndex + 1,
          pageCount: 1,
        });
      }
    }

    return Array.from(chapterMap.values())
      .sort((a, b) => (a.startPage - b.startPage) || naturalCompare(a.title, b.title));
  }

  if (resource.type === 'directory') {
    resource = await resourcePaths.validateResource(resource);
    const images = await walkImages(resource.sourcePath, true);
    if (images.length === 0) return [];
    const relativePaths = images.map(imagePath => path.relative(resource.sourcePath, imagePath));
    return chapterListFromRelativePaths(relativePaths);
  }

  try {
    const entries = await listArchiveEntries(resource);
    return chapterListFromRelativePaths(entries);
  } catch (error) {
    console.warn(`[volume-detail] failed to parse archive subchapters for ${resource.resourceId}: ${error.message}`);
    return [];
  }
}

async function getCachedComicList(forceRefresh = false, options = {}) {
  const useMemoryCache = !access.isReader() && options.useMemoryCache !== false;
  const currentVersion = getLibraryVersion();
  if (
    useMemoryCache &&
    !forceRefresh &&
    comicsCache.data &&
    comicsCache.version === currentVersion &&
    Date.now() < comicsCache.expiry
  ) {
    const progress = await getProgressFile();
    return await aggregateComicList(comicsCache.data, progress);
  }

  if (forceRefresh) await enqueueScanAndWait('api_refresh');

  const indexes = await readLibraryIndexes();
  const seriesIndex = indexes.seriesIndex;
  const resourceIndex = indexes.resourceIndex;
  const sourceList = (Array.isArray(seriesIndex) ? seriesIndex : []).map(series => ({
    id: series.seriesId,
    name: series.title,
    alias: (series.alternateTitles || []).join(', '),
    author: (series.authors || []).join(', '),
    brief: series.brief || '',
    cover: series.cover || '',
    status: series.status || '',
    lastChapter: '',
    updatedAt: series.updatedAt || '',
    latestAddedAt: series.latestAddedAt || '',
    tags: series.tags || [],
    publishers: series.publishers || [],
    bangumiSubjectId: series.bangumiSubjectId || null,
    ...metadataSourceFields(series),
    category: series.category || 'comic',
    contentMode: series.contentMode || '',
    source: series.source || '',
  }));

  const resourceStats = {};
  for (const resource of Object.values(resourceIndex || {})) {
    if (!resource?.seriesId) continue;
    if (!resourceStats[resource.seriesId]) resourceStats[resource.seriesId] = { resourceCount: 0, pageCount: 0 };
    resourceStats[resource.seriesId].resourceCount += 1;
    resourceStats[resource.seriesId].pageCount += Number(resource.pageCount || 0);
  }

  const comics = await Promise.all(sourceList.map(async comic => ({
    ...comic,
    resourceCount: resourceStats[comic.id]?.resourceCount || 0,
    totalPageCount: resourceStats[comic.id]?.pageCount || 0,
    cover: await resolveSeriesCover(comic.id, comic.cover),
    category: comic.category || 'comic',
    updatedAt: dateOnly(comic.updatedAt),
    latestAddedAt: dateOnly(comic.latestAddedAt),
  })));
  const progress = await getProgressFile();
  const aggregated = await aggregateComicList(comics, progress);
  const builtVersion = getLibraryVersion();
  if (!access.isReader() && builtVersion === currentVersion) {
    comicsCache.data = comics;
    comicsCache.expiry = Date.now() + CACHE_TTL;
    comicsCache.version = builtVersion;
  } else {
    invalidateComicsCache();
  }
  return aggregated;
}

async function aggregateComicList(comics, progress = {}) {
  const out = [];
  const grouped = new Map();
  const registry = await readWorkRegistry();
  for (const comic of comics || []) {
    const subjectId = Number(comic.bangumiSubjectId || 0);
    const registeredWorkId = String(registry.seriesWorkIds?.[comic.id] || '');
    const workId = subjectId || comic.metadataKey
      ? workIdFor({ category: comic.category, subjectId, metadataKey: comic.metadataKey })
      : registeredWorkId;
    if (!workId) {
      out.push(comic);
      continue;
    }
    const key = `${comic.category || 'comic'}:${workId}`;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { workId, representative: comic, members: [comic] });
      continue;
    }
    current.members.push(comic);
    if (preferComicListRepresentative(comic, current.representative, progress)) {
      current.representative = comic;
    }
  }
  out.push(...Array.from(grouped.values()).map(group => ({
    ...group.representative,
    workId: group.workId,
    seriesIds: group.members.map(member => member.id),
    resourceCount: group.members.reduce((sum, member) => sum + Number(member.resourceCount || 0), 0),
    totalPageCount: group.members.reduce((sum, member) => sum + Number(member.totalPageCount || 0), 0),
  })));
  return out;
}

function configuredLibraryCategories() {
  return (config.LIBRARY_CATEGORIES || []).filter(category => category.visible).map(category => ({
    key: category.key,
    label: category.label || category.key,
    builtin: category.builtin === true,
    pathBound: category.pathBound === true,
    pathCount: Array.isArray(category.paths) ? category.paths.length : 0,
  }));
}

function preferComicListRepresentative(candidate, current, progress = {}) {
  const candidateReadAt = String(progress?.[candidate.id]?.updatedAt || '');
  const currentReadAt = String(progress?.[current.id]?.updatedAt || '');
  if (candidateReadAt && !currentReadAt) return true;
  if (!candidateReadAt && currentReadAt) return false;
  if (candidateReadAt && currentReadAt && candidateReadAt !== currentReadAt) {
    return candidateReadAt > currentReadAt;
  }

  const cResources = Number(candidate.resourceCount || 0);
  const nResources = Number(current.resourceCount || 0);
  if (cResources !== nResources) return cResources > nResources;
  const cPages = Number(candidate.totalPageCount || 0);
  const nPages = Number(current.totalPageCount || 0);
  if (cPages !== nPages) return cPages > nPages;
  return String(candidate.latestAddedAt || '') > String(current.latestAddedAt || '');
}

function scheduleStartupScrape() {
  if (startupScrapeScheduled || settingsStore.secrets().account?.mustChangePassword) return;
  startupScrapeScheduled = true;
  // Consider startup once. Saving settings later must not implicitly start a full scan.
  if (!automaticReady() || !settingsStore.snapshot().scanning.onStart) return;
  setImmediate(() => enqueueStartupScan('startup'));
}
const libraryWatcher = createLibraryWatcher({
  enqueueTask, invalidate: invalidateComicsCache,
  notify: () => broadcastRealtimeEvent('settings_changed', { revision: settingsStore.snapshot().revision }),
});
settingsStore.onChanged(event => {
  invalidateComicsCache();
  broadcastRealtimeEvent('settings_changed', event);
  if (event.reason === 'account_changed') {
    for (const response of realtimeClients) response.end();
    realtimeClients.clear();
  }
  libraryWatcher.rebuild().catch(error => console.warn('[watcher] 重建失败:', error.message));
});
installSettingsApi(app, { watcher: libraryWatcher, cleanupCache });


// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── 登录 ───
const loginAttempts = new Map();
app.post('/api/login', async (req, res) => {
  const client = req.ip;
  const previous = loginAttempts.get(client);
  if (previous && previous.until > Date.now() && previous.count >= 10) return res.status(429).json({ error: '尝试次数过多，请稍后再试' });
  try {
    const result = await loginAccount(req.body?.username, req.body?.password);
    if (!result) {
      if (loginAttempts.size > 1000) loginAttempts.clear();
      loginAttempts.set(client, { count: previous?.until > Date.now() ? previous.count + 1 : 1, until: Date.now() + 60000 });
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    loginAttempts.delete(client);
    res.set('Cache-Control', 'no-store').json(result);
  } catch { res.status(500).json({ error: '登录配置不可用' }); }
});
app.get('/api/verify', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ valid: true, ...users.publicUser(users.get(req.user.id)) });
});

app.get('/api/server', (req, res) => res.set('Cache-Control', 'no-store').json({
  name: 'ReadDeck', instanceId: users.instanceId(), apiVersion: 1,
  capabilities: ['users', 'source-permissions', 'downloads', 'progress-sync', 'user-preferences'], serverTime: new Date().toISOString(),
}));
app.get('/api/me', (req, res) => res.json(users.publicUser(users.get(req.user.id))));
const userPreferences = require('./lib/userPreferences');
app.get('/api/me/preferences', async (req, res) => {
  try { res.json(await userPreferences.read(req.user.id)); }
  catch { res.status(500).json({ error: '无法读取个人显示设置' }); }
});
app.put('/api/me/preferences', async (req, res) => {
  try { res.json(await userPreferences.save(req.user.id, req.body)); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '无法保存个人显示设置' }); }
});
userPreferences.onChanged((userId, revision) => {
  for (const res of realtimeClients) {
    if (res.readdeckUser?.id !== userId) continue;
    try {
      if (!verifyToken(res.readdeckToken)) { res.end(); realtimeClients.delete(res); continue; }
      writeRealtimeEvent(res, 'preferences_changed', { revision });
    } catch { realtimeClients.delete(res); }
  }
});
app.get('/api/users', (req, res) => res.json(users.all().map(users.publicUser)));
const saveUser = async (req, res) => {
  try { res.json(await users.save(req.params.id || null, req.body || {})); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};
app.post('/api/users', saveUser);
app.put('/api/users/:id', saveUser);
users.onChanged(id => {
  for (const res of realtimeClients) if (res.readdeckUser?.id === id) { res.end(); realtimeClients.delete(res); }
});
require('./lib/downloads').install(app);

// ─── 阅读进度 ───
app.get('/api/progress', async (req, res) => {
  try { res.json(await getProgressFile()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/progress/:comicId', async (req, res) => {
  try {
    const progress = await getProgressFile();
    const context = await loadLogicalWorkContext(req.params.comicId).catch(() => null);
    res.json(context
      ? mergeWorkProgress(progress, context.seriesIds)
      : (progress[req.params.comicId] || {}));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/progress/:comicId', async (req, res) => {
  try {
    const body = req.body || {};
    const resource = body.resourceId ? await getResource(body.resourceId) : null;
    const bundle = await readSeriesBundle(req.params.comicId);
    if ((body.resourceId && !resource) || !bundle) return res.status(404).json({ error: '资源不存在' });
    if (resource && resource.seriesId !== req.params.comicId) {
      const context = await loadLogicalWorkContext(req.params.comicId);
      if (!context?.seriesIds.includes(resource.seriesId)) return res.status(400).json({ error: '资源与作品不匹配' });
    }
    res.json(await progressStore.save(req.user.id, resource?.seriesId || req.params.comicId, body));
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

// ─── 漫画列表 ───
app.get('/api/comics', async (req, res) => {
  try {
    // ?refresh=1 强制刷新缓存
    const forceRefresh = req.query.refresh === '1';
    let list = await getCachedComicList(forceRefresh, {
      useMemoryCache: req.query.cache !== '0',
    });
    const category = String(req.query.category || '').trim();
    if (category) list = list.filter(item => (item.category || 'comic') === category);
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/library', async (req, res) => {
  try {
    let list = await getCachedComicList(req.query.refresh === '1', {
      useMemoryCache: req.query.cache !== '0',
    });
    const category = String(req.query.category || '').trim();
    if (category) list = list.filter(item => (item.category || 'comic') === category);
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    let categories = configuredLibraryCategories();
    if (access.isReader()) {
      const { resourceIndex } = await readLibraryIndexes();
      const resources = Object.values(resourceIndex);
      categories = categories.map(category => ({ ...category,
        pathCount: new Set(resources.filter(r => (r.category || 'comic') === category.key).map(r => r.sourceId)).size
      })).filter(category => category.pathCount > 0);
    }
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 漫画搜索 ───
app.get('/api/comics/search', async (req, res) => {
  try {
    const keyword = (req.query.q || '').trim().toLowerCase();
    if (!keyword) return res.json([]);

    // 构建模糊匹配正则：将每个字符之间插入 .* 实现模糊匹配
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fuzzyPattern = escaped.split('').join('.*');
    let fuzzyRegex;
    try {
      fuzzyRegex = new RegExp(fuzzyPattern, 'i');
    } catch (e) {
      fuzzyRegex = null;
    }

    const isMatch = (text) => {
      if (!text) return false;
      const lower = text.toLowerCase();
      if (lower.includes(keyword)) return true;
      if (fuzzyRegex && fuzzyRegex.test(lower)) return true;
      return false;
    };

    const getScore = (text) => {
      if (!text) return 0;
      const lower = text.toLowerCase();
      if (lower === keyword) return 100;
      if (lower.startsWith(keyword)) return 80;
      if (lower.includes(keyword)) return 60;
      if (fuzzyRegex && fuzzyRegex.test(lower)) return 30;
      return 0;
    };

    // 优先从缓存读取漫画列表以复用 latestAddedAt 和元数据仓计算结果
    let allComics = await getCachedComicList(false);
    const category = String(req.query.category || '').trim();
    if (category) allComics = allComics.filter(comic => (comic.category || 'comic') === category);

    const results = [];
    for (const comic of allComics) {
      const nameMatch = isMatch(comic.name);
      const aliasMatch = isMatch(comic.alias || '');
      const authorMatch = isMatch(comic.author);
      const tagMatch = isMatch((comic.tags || []).join(' '));
      const publisherMatch = isMatch((comic.publishers || []).join(' '));
      const briefMatch = isMatch(comic.brief || '');

      if (!nameMatch && !aliasMatch && !authorMatch && !tagMatch && !publisherMatch && !briefMatch) continue;

      const score = Math.max(
        getScore(comic.name),
        getScore(comic.alias || ''),
        getScore(comic.author),
        getScore((comic.tags || []).join(' ')),
        getScore((comic.publishers || []).join(' ')),
        getScore(comic.brief || '')
      );

      results.push({
        ...comic,
        _score: score,
        _matchFields: [
          nameMatch ? 'name' : null,
          aliasMatch ? 'alias' : null,
          authorMatch ? 'author' : null,
          tagMatch ? 'tag' : null,
          publisherMatch ? 'publisher' : null,
          briefMatch ? 'brief' : null
        ].filter(Boolean)
      });
    }

    // 默认按匹配分数降序排列
    results.sort((a, b) => b._score - a._score);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/library/search', async (req, res) => {
  req.url = `/api/comics/search?q=${encodeURIComponent(req.query.q || '')}`;
  app._router.handle(req, res);
});

app.get('/api/tags', async (req, res) => {
  try {
    let tags = await readIndex('tag-index.json', []);
    if (req.query.refresh === '1') {
      await enqueueScanAndWait('tags_refresh');
      tags = await readIndex('tag-index.json', []);
    }
    res.json(tags);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 旧详情响应（仅作为聚合层的兼容回退） ───
async function sendLegacyComicDetail(req, res) {
  try {
    let bundle = await readSeriesBundle(req.params.comicId);
    if (!bundle) {
      await enqueueScanAndWait('missing_series');
      bundle = await readSeriesBundle(req.params.comicId);
    }
    if (!bundle) return res.status(404).json({ error: 'Comic not found' });

    const { series, resources, bangumi, relations, persons, characters, translations } = bundle;
    const finalWebResult = hasWebScrapeResult(bundle);
    const currentCategory = series.category || 'comic';
    const translatedSummary = translations.find(t => t.fieldName === 'summary' && t.translatedText)?.translatedText;
    const localEpubBrief = !finalWebResult && currentCategory === 'novel'
      ? (cachedLocalEpubBriefFromBundle(bundle) || await getLocalEpubBrief(resources))
      : '';
    const bangumiBrief = finalWebResult ? (bangumi?.translatedSummary || bangumi?.summary || '')
      : (bangumi?.translatedSummary || translatedSummary || bangumi?.summary || '');
    const fallbackBrief = series.brief || '';
    const subjectIndex = await readIndex('subject-index.json', []);
    // Build image fallback from bangumi.relatedSubjects for when relations.json entries lack images
    const bangumiRelationImageMap = new Map(
      (bangumi?.relatedSubjects || [])
        .filter(r => r.subjectId && r.image)
        .map(r => [Number(r.subjectId), preferLargeBangumiImage(r.image)])
    );
    const resolvedRelations = await resolveLocalRelations((relations || bangumi?.relatedSubjects || []).map(relation => ({
      ...relation,
      image: preferLargeBangumiImage(relation.image) || bangumiRelationImageMap.get(Number(relation.subjectId)) || '',
    })), { seriesIds: [series.seriesId], subjectIds: [bangumi?.subjectId],
      metadataKeys: [bangumi?.metadataKey || series.metadataKey], sourceUrls: [sourceUrlOf(bangumi) || series.sourceUrl],
      category: currentCategory, allowRemote: !finalWebResult });
    const volumeCoverMap = buildVolumeCoverMap(resolvedRelations);
    const volumeSubjectIdMap = buildVolumeSubjectIdMap(resolvedRelations);
    const volumeSubjectCoverMap = buildVolumeSubjectCoverMap(resolvedRelations);
    const volumeSubjectOrderMap = buildVolumeSubjectOrderMap(resolvedRelations);
    const useVolumeMatches = hasVolumeMatches(bundle);
    const groups = {};

    for (const resource of resources) {
      const legacy = resource.legacy || {};
      const groupKey = legacy.groupKey ||
        resource.groupKey ||
        (resource.contentType === 'volume' ? 'volumes' : (resource.contentType === 'mixed_bundle' ? 'mixed' : 'chapters'));
      const groupName = legacy.groupName ||
        resource.groupName ||
        (resource.contentType === 'volume' ? '单行本' : (resource.contentType === 'mixed_bundle' ? '混合资源' : '章节'));
      if (!groups[groupKey]) groups[groupKey] = [];
      const order = resource.detectedNumber ?? groups[groupKey].length + 1;
      const volumeMatch = resource.contentType === 'volume' ? findVolumeMatch(bundle, resource) : null;
      const matchedSubjectId = confirmedVolumeSubjectId(volumeMatch);
      const legacySubjectId = resource.contentType === 'volume' && !useVolumeMatches
        ? (volumeSubjectIdMap.get(Number(resource.detectedNumber || 0)) || null)
        : null;
      const bangumiSubjectId = matchedSubjectId || legacySubjectId || null;
      const bangumiOrder = Number(volumeMatch?.bangumiOrder || 0) ||
        (bangumiSubjectId ? volumeSubjectOrderMap.get(Number(bangumiSubjectId)) : 0) ||
        Number.MAX_SAFE_INTEGER;
      const displayTitle = resource.contentType === 'volume'
        ? volumeDisplayTitleForCategory(resource, volumeMatch, currentCategory, series)
        : (resource.title || `${groupName} ${order}`);
      groups[groupKey].push({
        chapterUuid: legacy.chapterUuid || resource.resourceId,
        chapterTitle: legacy.chapterTitle || displayTitle,
        groupName,
        order,
        resourceId: resource.resourceId,
        resourceType: resource.type,
        contentType: resource.contentType,
        pageCount: resource.pageCount || 0,
        readable: resource.readable !== false,
        readError: resource.readError || '',
        category: resource.category || currentCategory,
        cover: resource.coverCandidate || `/api/resources/${encodeURIComponent(resource.resourceId)}/cover`,
        _sortMatched: resource.contentType === 'volume' && !!bangumiSubjectId,
        _sortBangumiOrder: bangumiOrder,
        _sortLocalOrder: Number(resource.detectedNumber || 0) || Number.MAX_SAFE_INTEGER,
      });
    }
    for (const chapters of Object.values(groups)) {
      chapters.sort((a, b) => {
        if (a.contentType === 'volume' || b.contentType === 'volume') {
          const volumeSort = Number(b._sortMatched) - Number(a._sortMatched) ||
            (a._sortBangumiOrder - b._sortBangumiOrder) ||
            (a._sortLocalOrder - b._sortLocalOrder);
          if (volumeSort) return volumeSort;
        }
        return (a.order || 0) - (b.order || 0) || naturalCompare(a.chapterTitle, b.chapterTitle);
      });
      chapters.forEach(chapter => {
        delete chapter._sortMatched;
        delete chapter._sortBangumiOrder;
        delete chapter._sortLocalOrder;
      });
    }
    const localVolumes = resources
      .filter(resource => resource.contentType === 'volume')
      .map(resource => {
        const match = findVolumeMatch(bundle, resource);
        const matchedSubjectId = confirmedVolumeSubjectId(match);
        const legacySubjectId = useVolumeMatches
          ? null
          : (volumeSubjectIdMap.get(Number(resource.detectedNumber || 0)) || null);
        const bangumiSubjectId = matchedSubjectId || legacySubjectId || null;
        const relationCover = bangumiSubjectId
          ? volumeSubjectCoverMap.get(Number(bangumiSubjectId))
          : '';
        const legacyCover = useVolumeMatches
          ? ''
          : volumeCoverMap.get(Number(resource.detectedNumber || 0));
        const localOrder = Number(resource.detectedNumber || 0);
        return {
          resourceId: resource.resourceId,
          title: volumeDisplayTitleForCategory(resource, match, currentCategory, series),
          order: resource.detectedNumber || null,
          pageCount: resource.pageCount || 0,
          type: resource.type,
          category: resource.category || currentCategory,
          cover: relationCover || legacyCover ||
            resource.coverCandidate ||
            `/api/resources/${encodeURIComponent(resource.resourceId)}/cover`,
          bangumiSubjectId,
          volumeMatch: match || null,
          _sortMatched: !!bangumiSubjectId,
          _sortBangumiOrder: bangumiSubjectId
            ? (Number(match?.bangumiOrder || 0) ||
              volumeSubjectOrderMap.get(Number(bangumiSubjectId)) ||
              Number.MAX_SAFE_INTEGER)
            : Number.MAX_SAFE_INTEGER,
          _sortLocalOrder: Number.isFinite(localOrder) && localOrder > 0 ? localOrder : Number.MAX_SAFE_INTEGER,
        };
      })
      .sort((a, b) => Number(b._sortMatched) - Number(a._sortMatched) ||
        (a._sortBangumiOrder - b._sortBangumiOrder) ||
        (a._sortLocalOrder - b._sortLocalOrder) ||
        naturalCompare(a.title, b.title))
      .map(({ _sortMatched, _sortBangumiOrder, _sortLocalOrder, ...volume }) => volume);
    const localVolumeNumbers = new Set(localVolumes.map(volume => Number(volume.order)).filter(Boolean));
    const visibleRelations = resolvedRelations.filter(relation => {
      if (relation.localSeriesId === series.seriesId) return false;
      if (relation.localSeriesId) return true;
      if (isOffprintRelation(relation)) return false;
      const volumeNumber = relationVolumeNumber(relation);
      return !(volumeNumber && localVolumeNumbers.has(volumeNumber));
    });
    const cover = await resolveSeriesCover(series.seriesId, series.cover);
    const seriesIndex = await readIndex('series-index.json', []);
    const seriesIndexById = new Map((Array.isArray(seriesIndex) ? seriesIndex : [])
      .map(item => [item.seriesId, item]));
    const currentSubjectId = Number(series.bangumiSubjectId || bangumi?.subjectId || 0);
    const versionRows = currentSubjectId
      ? subjectIndex.filter(item =>
          Number(item.subjectId) === currentSubjectId &&
          (item.category || 'comic') === currentCategory
        )
      : [];
    const seenVersionIds = new Set();
    const versionContexts = await Promise.all(versionRows
      .filter(item => {
        if (!item.seriesId || seenVersionIds.has(item.seriesId)) return false;
        seenVersionIds.add(item.seriesId);
        return true;
      })
      .map(async item => {
        const indexed = seriesIndexById.get(item.seriesId) || {};
        const versionBundle = await readSeriesBundle(item.seriesId).catch(() => null);
        const firstResource = versionBundle?.resources?.[0] || null;
        const localRoot = resourceRootFromRelativePath(firstResource?.relativePath || '');
        const firstSegment = sourceSegmentFromRelativePath(firstResource?.relativePath || '');
        const sourceAlias = sourceAliasForRelativePath(firstResource?.relativePath || '', {
          category: firstResource?.category || indexed.category || currentCategory,
          sourcePath: firstResource?.sourcePath || '',
          sourceId: firstResource?.sourceId || '',
        });
        const readableResources = (versionBundle?.resources || [])
          .filter(resource => resource.readable !== false && Number(resource.pageCount || 0) > 0)
          .map(resource => ({
            ...resource,
            versionSeriesId: item.seriesId,
            sourceAlias: sourceAliasForRelativePath(resource.relativePath || '', {
              category: resource.category || indexed.category || currentCategory,
              sourcePath: resource.sourcePath || '',
              sourceId: resource.sourceId || '',
            }),
            sourceSegment: sourceSegmentFromRelativePath(resource.relativePath || ''),
            sourceTitle: resourceRootFromRelativePath(resource.relativePath || '') || indexed.title || item.title || '',
          }));
        return {
          versionBundle,
          readableResources,
          version: {
            seriesId: item.seriesId,
            title: localRoot || indexed.title || item.title || '',
            sourceAlias,
            sourceSegment: firstSegment,
            source: indexed.source || '',
            contentMode: indexed.contentMode || '',
            resourceCount: versionBundle?.resources?.length || 0,
            latestAddedAt: dateOnly(indexed.latestAddedAt || ''),
            cover: await resolveSeriesCover(item.seriesId, indexed.cover || ''),
            category: indexed.category || currentCategory,
            current: item.seriesId === series.seriesId,
          },
        };
      }));
    const resourceVersions = versionContexts.map(context => context.version);
    const coverResources = versionContexts.flatMap(context => context.readableResources);
    const sharedVersionBundles = [
      bundle,
      ...versionContexts.map(context => context.versionBundle).filter(Boolean),
    ];
    const localizedPresentationMetadata = finalWebResult ? { persons: persons || [], characters: characters || [] } : inheritLocalizedMetadataNames(
      persons || [],
      characters || [],
      {
        persons: sharedVersionBundles.flatMap(versionBundle => [
          ...(versionBundle?.persons || []),
          ...(versionBundle?.bangumi?.persons || []),
        ]),
        characters: sharedVersionBundles.flatMap(versionBundle => [
          ...(versionBundle?.characters || []),
          ...(versionBundle?.bangumi?.characters || []),
        ]),
      }
    );
    const localizedAuthorBundle = !finalWebResult && sharedVersionBundles.find(versionBundle =>
      versionBundle?.bangumi?.namesLocalizationProvider === 'deepseek' &&
      ((versionBundle.bangumi.authors || []).length > 0 ||
        (versionBundle.series?.authors || []).length > 0)
    );
    const presentationAuthors = localizedAuthorBundle
      ? ((localizedAuthorBundle.bangumi.authors || []).length > 0
        ? localizedAuthorBundle.bangumi.authors
        : (localizedAuthorBundle.series?.authors || []))
      : (series.authors || []);

    res.json({
      comic: {
        id: series.seriesId,
        name: series.title,
        alias: (series.alternateTitles || []).join(', '),
        author: presentationAuthors.map(name => ({ name, alias: null, path_word: '' })),
        theme: (series.tags || []).map(name => ({ name })),
        tags: series.tags || [],
        publishers: series.publishers || [],
        brief: localEpubBrief || bangumiBrief || fallbackBrief,
        originalBrief: bangumi?.summary || (!bangumiBrief && !localEpubBrief ? fallbackBrief : ''),
        cover,
        status: { display: series.status || '' },
        region: { display: series.language || '' },
        updatedAt: dateOnly(series.lastUpdatedAt || ''),
        bangumiSubjectId: series.bangumiSubjectId || bangumi?.subjectId || null,
        ...metadataSourceFields(bangumi, series),
        category: currentCategory,
        contentMode: series.contentMode || '',
        source: series.source || '',
      },
      groups,
      resources,
      coverResources: coverResources.length > 0 ? coverResources : resources,
      localVolumes,
      resourceVersions,
      bangumi: bangumi || emptyBangumi(),
      relations: visibleRelations,
      persons: localizedPresentationMetadata.persons
        .map(person => presentedPerson(person, 'person')),
      characters: localizedPresentationMetadata.characters
        .map(character => presentedPerson(character, 'character')),
      translations: translations || [],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ─── 逻辑作品聚合详情 ───
app.get('/api/comics/:comicId', async (req, res) => {
  try {
    let context = await loadLogicalWorkContext(req.params.comicId);
    if (!context) {
      await enqueueScanAndWait('missing_series');
      context = await loadLogicalWorkContext(req.params.comicId);
    }
    if (!context) return sendLegacyComicDetail(req, res);

    const progressFile = await getProgressFile();
    const workProgress = mergeWorkProgress(progressFile, context.seriesIds);
    const bookPresentation = buildBookPresentation(context, progressFile);
    const chapterPresentation = buildChapterPresentation(context, progressFile, bookPresentation);
    const baseBundle = context.baseBundle;
    const metadataBundle = context.bundles.find(hasWebScrapeResult) || context.bundles.find(bundle =>
      (bundle.bangumi?.subjectId || bundle.bangumi?.metadataKey) && (bundle.bangumi?.name_cn || bundle.bangumi?.name)
    ) || baseBundle;
    const finalWebResult = hasWebScrapeResult(metadataBundle);
    const bangumi = metadataBundle.bangumi || emptyBangumi();
    const series = metadataBundle.series || baseBundle.series;
    const overrides = context.workState?.overrides || {};

    const relationMap = new Map();
    for (const bundle of context.bundles) {
      const imageFallback = new Map((bundle.bangumi?.relatedSubjects || [])
        .filter(relation => relation.subjectId && relation.image)
        .map(relation => [Number(relation.subjectId), preferLargeBangumiImage(relation.image)]));
      for (const relation of bundle.relations || bundle.bangumi?.relatedSubjects || []) {
        const subjectId = Number(relation.subjectId || 0);
        const key = metadataIdentity(relation) || `${relation.relationType || ''}:${relation.name_cn || relation.name || ''}`;
        if (!relationMap.has(key)) {
          relationMap.set(key, {
            ...relation,
            image: preferLargeBangumiImage(relation.image) || imageFallback.get(subjectId) || '',
          });
        }
      }
    }
    const resolvedRelations = await resolveLocalRelations(Array.from(relationMap.values()), {
      seriesIds: context.seriesIds, subjectIds: context.bundles.map(bundle => bundle.bangumi?.subjectId), category: context.category,
      metadataKeys: context.bundles.map(bundle => bundle.bangumi?.metadataKey || bundle.series?.metadataKey),
      sourceUrls: context.bundles.map(bundle => sourceUrlOf(bundle.bangumi) || bundle.series?.sourceUrl),
      allowRemote: !context.bundles.some(hasWebScrapeResult),
    });
    const visibleRelations = resolvedRelations.filter(relation => {
      const subjectId = Number(relation.subjectId || 0);
      if (relation.localSeriesId && context.seriesIds.includes(relation.localSeriesId)) return false;
      if (relation.localSeriesId) return true;
      if (isOffprintRelation(relation)) return false;
      return !bookPresentation.consumedSubjectIds.has(subjectId) &&
        !bookPresentation.consumedMetadataKeys.has(relation.metadataKey || relation.detailKey);
    });

    const allResources = context.bundles.flatMap(bundle => (bundle.resources || []).map(resource => ({
      ...resource,
      seriesId: bundle.series.seriesId,
    })));
    const resourceVersions = await Promise.all(context.bundles.map(async bundle => {
      const firstResource = bundle.resources?.[0] || null;
      return {
        seriesId: bundle.series.seriesId,
        title: resourceRootFromRelativePath(firstResource?.relativePath || '') || bundle.series.title || '',
        sourceAlias: sourceAliasForRelativePath(firstResource?.relativePath || '', {
          category: firstResource?.category || bundle.series.category || context.category,
          sourcePath: firstResource?.sourcePath || '',
          sourceId: firstResource?.sourceId || '',
        }),
        sourceSegment: sourceSegmentFromRelativePath(firstResource?.relativePath || ''),
        source: bundle.series.source || '',
        contentMode: bundle.series.contentMode || '',
        resourceCount: bundle.resources?.length || 0,
        latestAddedAt: dateOnly(bundle.series.latestAddedAt || ''),
        cover: await resolveSeriesCover(bundle.series.seriesId, bundle.series.cover || ''),
        category: bundle.series.category || context.category,
        current: bundle.series.seriesId === req.params.comicId,
      };
    }));
    const coverResources = allResources
      .filter(resource => resource.readable !== false && Number(resource.pageCount || 0) > 0)
      .map(resource => ({
        ...publicResource(resource),
        versionSeriesId: resource.seriesId,
        sourceAlias: sourceAliasForRelativePath(resource.relativePath || '', {
          category: resource.category || context.category,
          sourcePath: resource.sourcePath || '',
          sourceId: resource.sourceId || '',
        }),
        sourceSegment: sourceSegmentFromRelativePath(resource.relativePath || ''),
        sourceTitle: resourceRootFromRelativePath(resource.relativePath || '') || '',
      }));

    const persons = context.bundles.flatMap(bundle => bundle.persons || bundle.bangumi?.persons || []);
    const characters = context.bundles.flatMap(bundle => bundle.characters || bundle.bangumi?.characters || []);
    const localizedPresentationMetadata = finalWebResult ? {
      persons: metadataBundle.persons || bangumi.persons || [],
      characters: metadataBundle.characters || bangumi.characters || [],
    } : inheritLocalizedMetadataNames(
      metadataBundle.persons || metadataBundle.bangumi?.persons || [],
      metadataBundle.characters || metadataBundle.bangumi?.characters || [],
      { persons, characters }
    );
    const localizedAuthorBundle = !finalWebResult && context.bundles.find(bundle =>
      bundle.bangumi?.namesLocalizationProvider === 'deepseek' &&
      ((bundle.bangumi.authors || []).length > 0 || (bundle.series?.authors || []).length > 0)
    );
    const defaultAuthors = localizedAuthorBundle
      ? ((localizedAuthorBundle.bangumi.authors || []).length > 0
          ? localizedAuthorBundle.bangumi.authors
          : localizedAuthorBundle.series.authors)
      : (series.authors || []);
    const presentationAuthors = Array.isArray(overrides.authors) ? overrides.authors : defaultAuthors;
    const aliases = Array.isArray(overrides.alternateTitles)
      ? overrides.alternateTitles
      : (series.alternateTitles || []);
    const translations = context.bundles.flatMap(bundle => bundle.translations || []);
    const translatedSummary = translations.find(item => item.fieldName === 'summary' && item.translatedText)?.translatedText || '';
    const localEpubBrief = !finalWebResult && context.category === 'novel'
      ? (context.bundles.map(cachedLocalEpubBriefFromBundle).find(Boolean) || await getLocalEpubBrief(allResources))
      : '';
    const bangumiBrief = finalWebResult ? (bangumi.translatedSummary || bangumi.summary || '')
      : (bangumi.translatedSummary || translatedSummary || bangumi.summary || '');
    const fallbackBrief = series.brief || '';
    const cover = overrides.cover || await resolveSeriesCover(baseBundle.series.seriesId, baseBundle.series.cover || '');
    const updatedAt = context.bundles
      .map(bundle => String(bundle.series?.lastUpdatedAt || ''))
      .sort()
      .pop() || '';

    res.json({
      workId: context.workId,
      comic: {
        id: req.params.comicId,
        workId: context.workId,
        name: overrides.name || series.title,
        alias: aliases.join(', '),
        author: presentationAuthors.map(name => ({ name, alias: null, path_word: '' })),
        theme: (series.tags || []).map(name => ({ name })),
        tags: series.tags || [],
        publishers: series.publishers || [],
        brief: overrides.brief !== undefined ? String(overrides.brief || '') : (localEpubBrief || bangumiBrief || fallbackBrief),
        originalBrief: bangumi.summary || (!bangumiBrief && !localEpubBrief ? fallbackBrief : ''),
        cover,
        status: { display: overrides.status !== undefined ? String(overrides.status || '') : (series.status || '') },
        region: { display: series.language || '' },
        updatedAt: dateOnly(updatedAt),
        bangumiSubjectId: context.subjectId || null,
        ...metadataSourceFields(bangumi, series),
        category: context.category,
        contentMode: series.contentMode || '',
        source: series.source || '',
      },
      groups: chapterPresentation.groups,
      chapterGroups: chapterPresentation.chapterGroups,
      aggregatedChapterGroups: chapterPresentation.chapterGroups,
      resources: allResources.map(publicResource),
      coverResources: coverResources.length > 0 ? coverResources : allResources.map(publicResource),
      localVolumes: bookPresentation.localVolumes,
      bookSections: bookPresentation.bookSections,
      resourceVersions,
      workProgress,
      grouping: {
        manualSplitResourceIds: Object.keys(context.workState?.manualSplits || {}).filter(id => allResources.some(r => r.resourceId === id)),
        modelGroupedResourceIds: Object.keys(context.workState?.modelGroups || {}).filter(id => allResources.some(r => r.resourceId === id)),
      },
      bangumi,
      relations: visibleRelations,
      persons: localizedPresentationMetadata.persons
        .map(person => presentedPerson(person, 'person')),
      characters: localizedPresentationMetadata.characters
        .map(character => presentedPerson(character, 'character')),
      translations,
    });
  } catch (error) {
    console.warn(`[detail] 逻辑作品聚合失败，回退旧详情: ${error.message}`);
    return sendLegacyComicDetail(req, res);
  }
});

// ─── 本地封面 ───
app.get('/api/comics/:comicId/cover/:filename', async (req, res) => {
  try {
    if (!isCoverFile(req.params.filename)) return res.status(404).json({ error: 'Cover not found' });
    const filePath = await resolveSeriesPath(req.params.comicId, req.params.filename);
    await sendCachedImage(res, filePath);
  } catch (error) {
    res.status(404).json({ error: 'Cover not found' });
  }
});

app.get('/api/series/:comicId/custom-cover', async (req, res) => {
  try {
    const filePath = await findCustomCoverFile(req.params.comicId);
    if (!filePath) return res.status(404).json({ error: 'Cover not found' });
    await sendCachedImage(res, filePath, {
      cacheControl: 'private, no-cache',
      maxAge: 0,
    });
  } catch (error) {
    res.status(404).json({ error: 'Cover not found' });
  }
});

// ─── 统一资源阅读接口 ───
app.get('/api/resources/:resourceId/pages', async (req, res) => {
  try {
    res.json(await getPages(req.params.resourceId, {
      startPage: Number(req.query.startPage),
      pageCount: Number(req.query.pageCount),
    }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/resources/:resourceId/page/:pageNumber', async (req, res) => {
  try {
    await sendResourcePageImage(res, req.params.resourceId, req.params.pageNumber, {
      forceRefresh: req.query.refresh === '1' || req.query.retry === '1',
    }, {
      immutable: true,
      seconds: 30 * 24 * 3600,
      maxAge: '30d',
    });
  } catch (error) {
    res.status(404).json({ error: error.message || 'Page not found' });
  }
});

app.get('/api/resources/:resourceId/epub/manifest', async (req, res) => {
  try {
    const resource = await getResource(req.params.resourceId);
    if (!resource || resource.type !== 'epub') return res.status(404).json({ error: 'EPUB not found' });
    await markResourceCacheActive(resource);
    res.json(await getEpubManifest(resource));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/resources/:resourceId/epub/file', async (req, res) => {
  try {
    const resource = await getResource(req.params.resourceId);
    if (!resource || resource.type !== 'epub') return res.status(404).json({ error: 'EPUB not found' });
    await markResourceCacheActive(resource);
    const filePath = await getCompatibleEpubFile(resource);
    res.set('Content-Type', 'application/epub+zip');
    res.set('Cache-Control', 'private, no-cache');
    res.set('Accept-Ranges', 'bytes');
    res.sendFile(path.resolve(filePath));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/resources/:resourceId/epub/chapter/:chapterIndex', async (req, res) => {
  try {
    const resource = await getResource(req.params.resourceId);
    if (!resource || resource.type !== 'epub') return res.status(404).json({ error: 'EPUB not found' });
    await markResourceCacheActive(resource);
    res.json(await getEpubChapter(resource, Number(req.params.chapterIndex)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/resources/:resourceId/epub/assets/*', async (req, res) => {
  try {
    const resource = await getResource(req.params.resourceId);
    if (!resource || resource.type !== 'epub') return res.status(404).json({ error: 'EPUB not found' });
    await markResourceCacheActive(resource);
    const entry = String(req.params[0] || '');
    const filePath = await getEpubAssetFile(resource, entry);
    res.set('Content-Type', contentTypeForEpubAsset(entry));
    await sendCachedImage(res, filePath, {
      immutable: true,
      seconds: 30 * 24 * 3600,
    });
  } catch (error) {
    res.status(404).json({ error: error.message || 'EPUB asset not found' });
  }
});

// ─── 旧单行本详情（聚合层回退） ───
async function sendLegacyVolumeDetail(req, res) {
  try {
    const bundle = await readSeriesBundle(req.params.comicId);
    if (!bundle) return res.status(404).json({ error: 'Comic not found' });

    let resource = (bundle.resources || []).find(r => r.resourceId === req.params.resourceId);
    if (!resource) return res.status(404).json({ error: 'Volume not found' });
    resource = await resolveDetailPageCount(bundle, resource);
    const currentCategory = bundle.series?.category || resource.category || 'comic';

    const bangumiRelImageMap = new Map(
      (bundle.bangumi?.relatedSubjects || [])
        .filter(r => r.subjectId && r.image)
        .map(r => [Number(r.subjectId), preferLargeBangumiImage(r.image)])
    );
    const allRelations = (bundle.relations || bundle.bangumi?.relatedSubjects || []).map(r => ({
      ...r,
      image: preferLargeBangumiImage(r.image) || bangumiRelImageMap.get(Number(r.subjectId)) || '',
    }));
    const volumeSubjectIdMap = buildVolumeSubjectIdMap(allRelations);
    const volumeCoverMap = buildVolumeCoverMap(allRelations);
    const volumeSubjectCoverMap = buildVolumeSubjectCoverMap(allRelations);
    const useVolumeMatches = hasVolumeMatches(bundle);
    const volumeMatch = findVolumeMatch(bundle, resource);
    const matchedSubjectId = confirmedVolumeSubjectId(volumeMatch);
    const volumeNumber = resource.detectedNumber || null;
    const legacySubjectId = useVolumeMatches
      ? null
      : (volumeNumber ? (volumeSubjectIdMap.get(Number(volumeNumber)) || null) : null);
    const bangumiSubjectId = matchedSubjectId || legacySubjectId || null;
    const detailKey = confirmedVolumeDetailKey(volumeMatch) || String(bangumiSubjectId || '');
    const finalWebResult = hasWebScrapeResult(bundle);
    const subChapters = await buildVolumeSubChapters(resource);
    const cachedLocalSummary = localSummaryFromVolumeMatch(volumeMatch);
    const displayTitle = volumeDisplayTitleForCategory(
      resource,
      volumeMatch,
      currentCategory,
      bundle.series
    );

    const localCover = (bangumiSubjectId ? volumeSubjectCoverMap.get(Number(bangumiSubjectId)) : '') ||
      (useVolumeMatches ? '' : volumeCoverMap.get(Number(volumeNumber || 0))) ||
      resource.coverCandidate ||
      `/api/resources/${encodeURIComponent(resource.resourceId)}/cover`;

    // Base response (no Bangumi data)
    const base = {
      resourceId: resource.resourceId,
      title: displayTitle,
      order: volumeNumber,
      pageCount: resource.pageCount || 0,
      type: resource.type || '',
      cover: localCover,
      bangumiSubjectId: bangumiSubjectId || null,
      bangumiUrl: bangumiSubjectId ? `https://bangumi.tv/subject/${bangumiSubjectId}` : '',
      detailKey,
      ...metadataSourceFields(volumeMatch),
      nameJa: '',
      nameCn: displayTitle,
      summary: cachedLocalSummary?.summary || '',
      translatedSummary: cachedLocalSummary?.translatedSummary || '',
      date: '',
      subChapters,
      volumeMatch: volumeMatch || null,
    };

    const persisted = storedVolumeDetail(bundle, volumeMatch) || bundle.volumeDetails?.[detailKey] || null;
    if (hasScrapeResult(bundle) || persisted) {
      return res.json(presentedVolumeDetail(base, persisted, cachedLocalSummary, finalWebResult));
    }

    if (!bangumiSubjectId) {
      if (cachedLocalSummary) return res.json(base);
      const rawLocalSummary = await getRawLocalEpubResourceSummary(resource);
      return res.json({
        ...base,
        summary: rawLocalSummary?.summary || '',
        translatedSummary: '',
      });
    }

    // Prefer persisted metadata generated by scrapeSeries
    const volumeDetails = await readVolumeDetails(req.params.comicId);
    const latestPersisted = volumeDetails[String(bangumiSubjectId)] || null;
    if (latestPersisted) return res.json(presentedVolumeDetail(base, latestPersisted, cachedLocalSummary, false));

    const fallbackLocalSummary = cachedLocalSummary || await getRawLocalEpubResourceSummary(resource);

    // Fallback: fetch online once, then persist for future requests
    const detail = await getApiJson(`/v0/subjects/${bangumiSubjectId}`);
    const summary = detail?.summary || '';
    const largeCover = detail?.images ? preferLargeBangumiImage(pickImage(detail.images)) : '';
    let translatedSummary = '';
    let translation = null;

    if (!fallbackLocalSummary && summary) {
      try {
        translation = await maybeTranslate('summary', summary);
        translatedSummary = translation?.translatedText || '';
        if (!translatedSummary && !/[\u3040-\u30ff]/.test(summary)) {
          const simplified = await maybeSimplifyChinese('summary', summary);
          if (simplified.translation) {
            translation = simplified.translation;
            translatedSummary = simplified.text;
          }
        }
      } catch (e) {
        console.warn(`[volume-detail] translation failed for ${bangumiSubjectId}: ${e.message}`);
      }
    }

    await upsertVolumeDetail(req.params.comicId, bangumiSubjectId, {
      nameJa: detail?.name || '',
      nameCn: detail?.name_cn || displayTitle,
      summary: fallbackLocalSummary?.summary || summary,
      translatedSummary: fallbackLocalSummary?.translatedSummary || translatedSummary,
      date: detail?.date || '',
      cover: largeCover || localCover,
      bangumiUrl: `https://bangumi.tv/subject/${bangumiSubjectId}`,
      translation: fallbackLocalSummary?.translation || translation,
      resourceIds: [resource.resourceId],
      volumeNumbers: volumeNumber ? [volumeNumber] : [],
    });

    res.json({
      ...base,
      cover: largeCover || localCover,
      nameJa: detail?.name || '',
      nameCn: detail?.name_cn || displayTitle,
      summary: fallbackLocalSummary?.summary || summary,
      translatedSummary: fallbackLocalSummary?.translatedSummary || translatedSummary,
      date: detail?.date || '',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ─── 聚合单本详情 ───
app.get('/api/comics/:comicId/volumes/:resourceId', async (req, res) => {
  try {
    const context = await loadLogicalWorkContext(req.params.comicId);
    if (!context) return sendLegacyVolumeDetail(req, res);
    const progressFile = await getProgressFile();
    let bookPresentation = buildBookPresentation(context, progressFile);
    let item = bookPresentation.resourceContexts.get(req.params.resourceId);
    if (!item) return res.status(404).json({ error: 'Volume not found' });

    let resource = await resolveDetailPageCount(item.bundle, item.resource);
    resource = { ...resource, seriesId: item.bundle.series.seriesId };
    if (resource.pageCount !== item.resource.pageCount) {
      bookPresentation = buildBookPresentation(context, progressFile);
      item = bookPresentation.resourceContexts.get(req.params.resourceId) || item;
    }
    const book = item.book;
    const versions = (book?._versions || [resource])
      .map(version => version.resourceId === resource.resourceId ? resource : version)
      .sort((a, b) => compareResourceVersions(a, b, progressFile));
    const versionRows = versions.map(version => ({
      ...versionSummary(version, context.workState, progressFile, { includePath: true }),
      current: version.resourceId === resource.resourceId,
    }));
    const currentVersion = versionRows.find(version => version.current) || versionRows[0] || null;
    const match = inferredVolumeMatch(item.bundle, resource);
    const subjectId = confirmedVolumeSubjectId(match);
    const detailKey = confirmedVolumeDetailKey(match);
    const finalWebResult = hasWebScrapeResult(item.bundle);
    const subChapters = await buildVolumeSubChapters(resource);
    const cachedLocalSummary = localSummaryFromVolumeMatch(match);
    const displayTitle = book?.title || volumeDisplayTitleForCategory(
      resource,
      match,
      context.category,
      item.bundle.series
    );
    const localCover = book?.cover || resource.coverCandidate ||
      `/api/resources/${encodeURIComponent(resource.resourceId)}/cover`;
    const base = {
      workId: context.workId,
      bookKey: book?.bookKey || bookFallbackGroupKey(context.workState, resource, subjectId, detailKey),
      resourceId: resource.resourceId,
      seriesId: resource.seriesId,
      title: displayTitle,
      order: resource.detectedNumber || null,
      pageCount: Number(resource.pageCount || 0),
      chapterCount: resource.type === 'epub' ? subChapters.length : 0,
      type: resource.type || '',
      fileSize: Number.isFinite(Number(resource.fileSize)) ? Number(resource.fileSize) : null,
      firstIndexedAt: resource.firstIndexedAt || resource.modifiedTime || '',
      sourcePath: resource.sourcePath || '',
      sourceId: resource.sourceId || '',
      sourceAlias: currentVersion?.sourceAlias || '',
      cover: localCover,
      bangumiSubjectId: subjectId || null,
      bangumiUrl: subjectId ? `https://bangumi.tv/subject/${subjectId}` : '',
      detailKey,
      ...metadataSourceFields(book, match),
      relationType: match?.relationType || book?.relationType || '',
      matchKind: match?.matchKind || book?.matchKind || 'local',
      nameJa: '',
      nameCn: displayTitle,
      summary: cachedLocalSummary?.summary || '',
      translatedSummary: cachedLocalSummary?.translatedSummary || '',
      date: '',
      subChapters,
      volumeMatch: match || null,
      versions: versionRows,
      currentVersion,
      preferredResourceId: versions[0]?.resourceId || resource.resourceId,
      recentlyRead: !!currentVersion?.recentlyRead,
      lastReadAt: currentVersion?.lastReadAt || '',
      manualGrouping: {
        split: !!context.workState?.manualSplits?.[resource.resourceId],
        modelGrouped: !!context.workState?.modelGroups?.[resource.resourceId],
      },
    };

    const persisted = storedVolumeDetail(item.bundle, match) ||
      context.bundles.map(bundle => storedVolumeDetail(bundle, match)).find(Boolean) || null;
    if (hasScrapeResult(item.bundle) || persisted) {
      return res.json(presentedVolumeDetail(base, persisted, cachedLocalSummary, finalWebResult));
    }

    if (!subjectId) {
      if (cachedLocalSummary) return res.json(base);
      const rawLocalSummary = await getRawLocalEpubResourceSummary(resource);
      return res.json({
        ...base,
        summary: rawLocalSummary?.summary || '',
        translatedSummary: rawLocalSummary?.translatedSummary || '',
      });
    }

    const fallbackLocalSummary = cachedLocalSummary || await getRawLocalEpubResourceSummary(resource);
    const detail = await getApiJson(`/v0/subjects/${subjectId}`);
    const summary = detail?.summary || '';
    const largeCover = detail?.images ? preferLargeBangumiImage(pickImage(detail.images)) : '';
    let translatedSummary = '';
    let translation = null;
    if (!fallbackLocalSummary && summary) {
      try {
        translation = await maybeTranslate('summary', summary);
        translatedSummary = translation?.translatedText || '';
        if (!translatedSummary && !/[\u3040-\u30ff]/.test(summary)) {
          const simplified = await maybeSimplifyChinese('summary', summary);
          if (simplified.translation) {
            translation = simplified.translation;
            translatedSummary = simplified.text;
          }
        }
      } catch (error) {
        console.warn(`[volume-detail] translation failed for ${subjectId}: ${error.message}`);
      }
    }
    await upsertVolumeDetail(resource.seriesId, subjectId, {
      nameJa: detail?.name || '',
      nameCn: detail?.name_cn || displayTitle,
      summary: fallbackLocalSummary?.summary || summary,
      translatedSummary: fallbackLocalSummary?.translatedSummary || translatedSummary,
      date: detail?.date || '',
      cover: largeCover || localCover,
      bangumiUrl: `https://bangumi.tv/subject/${subjectId}`,
      translation: fallbackLocalSummary?.translation || translation,
      resourceIds: versions.map(version => version.resourceId),
      volumeNumbers: unique(versions.map(version => Number(version.detectedNumber || 0)).filter(Boolean)),
    });
    return res.json({
      ...base,
      cover: largeCover || localCover,
      nameJa: detail?.name || '',
      nameCn: detail?.name_cn || displayTitle,
      summary: fallbackLocalSummary?.summary || summary,
      translatedSummary: fallbackLocalSummary?.translatedSummary || translatedSummary,
      date: detail?.date || '',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/resources/:resourceId/cover', async (req, res) => {
  try {
    const resource = await getResource(req.params.resourceId);
    if (resource?.type === 'epub') {
      const filePath = await getEpubCoverFile(resource);
      await sendCachedImage(res, filePath, {
        immutable: true,
        seconds: 30 * 24 * 3600,
        maxAge: '30d',
      });
      return;
    }
    await sendResourcePageImage(res, req.params.resourceId, 1, {}, {
      immutable: true,
      seconds: 30 * 24 * 3600,
      maxAge: '30d',
    });
  } catch (error) {
    res.status(404).json({ error: error.message || 'Cover not found' });
  }
});

app.delete('/api/resources/:resourceId/page/:pageNumber', async (req, res) => {
  try {
    const resource = await getResource(req.params.resourceId);
    if (!resource) return res.status(404).json({ error: '资源不存在' });
    if (resource.type !== 'directory') return res.status(400).json({ error: '仅图片目录支持删除单张图片' });
    const page = Number(req.params.pageNumber);
    if (!Number.isSafeInteger(page) || page < 1) return res.status(400).json({ error: '页码无效' });
    const target = await getPageFile(resource.resourceId, page);
    await fs.unlink(target);
    await enqueueTask('scanLibrary', { reason: 'image_deleted', fastScan: true, changedPaths: [target] });
    invalidateComicsCache(); res.json({ success: true });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

app.delete('/api/resources/:resourceId', async (req, res) => {
  try {
    const resource = await getResource(req.params.resourceId);
    if (!resource) return res.status(404).json({ error: 'Resource not found' });
    let targetPath;
    try {
      targetPath = await configuredResourcePath(resource);
    } catch (error) {
      return res.status(403).json({ error: error.message });
    }
    await fs.rm(targetPath, { recursive: true, force: false });
    const task = await enqueueTask('scanLibrary', {
      reason: 'resource_deleted',
      fastScan: true,
      changedPaths: [targetPath],
    });
    invalidateComicsCache();
    res.json({
      success: true,
      resourceId: resource.resourceId,
      seriesId: resource.seriesId,
      taskId: task.id,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 后台任务 ───
app.get('/api/tasks', (req, res) => {
  res.json(taskSnapshot());
});

app.post('/api/tasks/scan', async (req, res) => {
  try {
    if (!settingsStore.snapshot().libraryConfirmed) return res.status(409).json({ error: '请先在系统设置中确认书库来源' });
    const task = await enqueueTask(req.body?.scrape ? 'scanAndScrape' : 'scanLibrary', {
      force: req.body?.force === true,
      automatic: false, reason: 'manual', confirmSettings: true,
      fastScan: req.body?.fastScan !== false,
    });
    invalidateComicsCache();
    res.status(202).json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tasks/archive/update', async (req, res) => {
  try {
    const task = await enqueueTask('updateArchive', { force: req.body?.force === true });
    res.status(202).json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tasks/series/:seriesId/rescrape', async (req, res) => {
  try {
    const context = await loadLogicalWorkContext(req.params.seriesId);
    const seriesIds = context?.seriesIds?.length ? context.seriesIds : [req.params.seriesId];
    const tasks = [];
    for (const seriesId of seriesIds) {
      tasks.push(await enqueueTask('scrapeSeries', {
        seriesId,
        subjectId: req.body?.subjectId,
        force: true,
      }));
    }
    invalidateComicsCache();
    res.status(202).json({
      ...(tasks[0] || {}),
      workId: context?.workId || '',
      seriesIds,
      tasks,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/comics/:comicId/bangumi', async (req, res) => {
  try {
    const context = await loadLogicalWorkContext(req.params.comicId);
    if (!context) return res.status(404).json({ error: 'Comic not found' });
    for (const seriesId of context.seriesIds) {
      await fallbackBangumiToLocalMode(seriesId, { reason: 'manual_clear' });
    }

    invalidateComicsCache();
    res.json({ success: true, workId: context.workId, seriesIds: context.seriesIds });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/comics/:comicId/group-overrides/:resourceId', async (req, res) => {
  try {
    const context = await loadLogicalWorkContext(req.params.comicId);
    if (!context) return res.status(404).json({ error: 'Comic not found' });
    const resource = context.bundles
      .flatMap(bundle => bundle.resources || [])
      .find(item => item.resourceId === req.params.resourceId);
    if (!resource) return res.status(404).json({ error: 'Resource not found in logical work' });
    const kind = req.body?.kind === 'chapter' || resource.contentType !== 'volume' ? 'chapter' : 'book';
    const state = await setManualSplit(context.workId, resource.resourceId, kind);
    invalidateComicsCache();
    res.json({ success: true, workId: context.workId, resourceId: resource.resourceId, kind, state });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/comics/:comicId/group-overrides/:resourceId', async (req, res) => {
  try {
    const context = await loadLogicalWorkContext(req.params.comicId);
    if (!context) return res.status(404).json({ error: 'Comic not found' });
    const resource = context.bundles
      .flatMap(bundle => bundle.resources || [])
      .find(item => item.resourceId === req.params.resourceId);
    if (!resource) return res.status(404).json({ error: 'Resource not found in logical work' });
    const state = await clearManualSplit(context.workId, resource.resourceId);
    invalidateComicsCache();
    res.json({ success: true, workId: context.workId, resourceId: resource.resourceId, state });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 章节图片列表 ───
app.get('/api/comics/:comicId/:groupName/:chapterDir/images', async (req, res) => {
  try {
    const { comicId, groupName, chapterDir } = req.params;
    const chapterPath = await resolveSeriesPath(comicId, groupName, chapterDir);
    const files = await fs.readdir(chapterPath);
    const images = files
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)?.[0] || '0');
        const nb = parseInt(b.match(/\d+/)?.[0] || '0');
        return na - nb;
      });
    res.json({ images });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 获取图片 ───
app.get('/api/comics/:comicId/:groupName/:chapterDir/image/:filename', async (req, res) => {
  try {
    const { comicId, groupName, chapterDir, filename } = req.params;
    const imagePath = await resolveSeriesPath(comicId, groupName, chapterDir, filename);
    await sendCachedImage(res, imagePath);
  } catch (error) {
    res.status(404).json({ error: 'Image not found' });
  }
});

// ─── 更新元数据 ───
app.put('/api/comics/:comicId/metadata', async (req, res) => {
  try {
    const updates = req.body || {};
    if (updates.name !== undefined && !String(updates.name || '').trim()) {
      return res.status(400).json({ error: '名称不能为空' });
    }

    const bundle = await readSeriesBundle(req.params.comicId);
    if (!bundle) return res.status(404).json({ error: 'Comic not found' });
    const nextTitle = updates.name !== undefined
      ? String(updates.name || '').trim()
      : bundle.series.title;
    const nextAliases = updates.alias !== undefined
      ? unique(String(updates.alias || '').split(/[,，]/).map(s => s.trim()).filter(Boolean))
      : bundle.series.alternateTitles;
    const authorValues = updates.author === undefined
      ? null
      : (Array.isArray(updates.author)
        ? updates.author
        : String(updates.author || '').split(/[,，]/));
    const nextAuthorRecords = authorValues?.map(author => {
      const name = String(author?.name ?? author ?? '').trim();
      return {
        name,
        alias: author && typeof author === 'object' ? (author.alias ?? null) : null,
        path_word: author && typeof author === 'object' ? String(author.path_word || '') : '',
      };
    }).filter(author => author.name) || null;
    const nextStatus = updates.status !== undefined
      ? String(
        updates.status && typeof updates.status === 'object'
          ? (updates.status.display || '')
          : (updates.status || '')
      ).trim()
      : bundle.series.status;
    const context = await loadLogicalWorkContext(req.params.comicId);
    if (context) {
      const overridePatch = {};
      if (updates.name !== undefined) overridePatch.name = nextTitle;
      if (updates.alias !== undefined) overridePatch.alternateTitles = nextAliases;
      if (updates.author !== undefined) overridePatch.authors = nextAuthorRecords.map(author => author.name);
      if (updates.brief !== undefined) overridePatch.brief = String(updates.brief || '');
      if (updates.status !== undefined) overridePatch.status = nextStatus;
      if (Object.keys(overridePatch).length > 0) {
        await updateWorkOverrides(context.workId, overridePatch);
      }
    }
    const metaPath = await resolveSeriesPath(req.params.comicId, '元数据.json').catch(() => null);
    let raw = null;
    try {
      if (metaPath) raw = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
    } catch (e) {}

    if (raw?.comic) {
      if (updates.name !== undefined) raw.comic.name = nextTitle;
      if (updates.alias !== undefined) raw.comic.alias = nextAliases.join(', ');
      if (updates.brief !== undefined) raw.comic.brief = String(updates.brief || '');
      if (updates.author !== undefined) raw.comic.author = nextAuthorRecords;
      if (updates.status !== undefined) raw.comic.status = { display: nextStatus };

      await fs.writeFile(metaPath, JSON.stringify(raw, null, 2), 'utf-8');
    }

    const nextSeries = {
      ...bundle.series,
      title: nextTitle,
      titleNormalized: normalizeText(nextTitle),
      alternateTitles: nextAliases,
      authors: updates.author !== undefined
        ? nextAuthorRecords.map(author => author.name)
        : bundle.series.authors,
      brief: updates.brief !== undefined ? String(updates.brief || '') : bundle.series.brief,
      status: nextStatus,
      lastUpdatedAt: new Date().toISOString(),
    };
    const writtenSeries = await writeSeriesBundle(nextSeries, bundle.resources, {
      bangumi: bundle.bangumi,
      relations: bundle.relations,
      persons: bundle.persons,
      characters: bundle.characters,
      translations: bundle.translations,
      volumeDetails: bundle.volumeDetails,
    });
    await upsertSeriesIndexes(writtenSeries, bundle.resources);
    for (const memberBundle of context?.bundles || []) {
      if (memberBundle.series.seriesId === bundle.series.seriesId) continue;
      const memberSeries = {
        ...memberBundle.series,
        title: updates.name !== undefined ? nextTitle : memberBundle.series.title,
        titleNormalized: updates.name !== undefined
          ? normalizeText(nextTitle)
          : memberBundle.series.titleNormalized,
        alternateTitles: updates.alias !== undefined ? nextAliases : memberBundle.series.alternateTitles,
        authors: updates.author !== undefined
          ? nextAuthorRecords.map(author => author.name)
          : memberBundle.series.authors,
        brief: updates.brief !== undefined ? String(updates.brief || '') : memberBundle.series.brief,
        status: updates.status !== undefined ? nextStatus : memberBundle.series.status,
        lastUpdatedAt: new Date().toISOString(),
      };
      const writtenMember = await writeSeriesBundle(memberSeries, memberBundle.resources, {
        bangumi: memberBundle.bangumi,
        relations: memberBundle.relations,
        persons: memberBundle.persons,
        characters: memberBundle.characters,
        translations: memberBundle.translations,
        volumeDetails: memberBundle.volumeDetails,
      });
      await upsertSeriesIndexes(writtenMember, memberBundle.resources);
    }
    invalidateComicsCache();
    res.json({ success: true, series: writtenSeries });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 上传封面 ───
app.post('/api/comics/:comicId/cover', upload.single('cover'), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: 'No file uploaded' });
    const bundle = await readSeriesBundle(req.params.comicId);
    if (!bundle) return res.status(404).json({ error: 'Comic not found' });

    await saveCustomCoverBuffer(req.params.comicId, req.file.buffer, coverExtFromUpload(req.file));
    const coverPath = await updateSeriesCover(req.params.comicId, customCoverApiPath(req.params.comicId));
    await syncLogicalWorkCover(req.params.comicId, coverPath);

    invalidateComicsCache();
    res.json({
      success: true,
      path: coverPath,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/comics/:comicId/cover/from-page', async (req, res) => {
  try {
    const resourceId = String(req.body?.resourceId || '').trim();
    const pageNumber = Number(req.body?.pageNumber || 0);
    if (!resourceId || !Number.isInteger(pageNumber) || pageNumber < 1) {
      return res.status(400).json({ error: 'Invalid resourceId or pageNumber' });
    }

    const bundle = await readSeriesBundle(req.params.comicId);
    if (!bundle) return res.status(404).json({ error: 'Comic not found' });
    const resource = (bundle.resources || []).find(item => item.resourceId === resourceId) ||
      await getResource(resourceId);
    if (!resource) return res.status(404).json({ error: 'Resource not found' });

    const pagePath = await getPageFile(resourceId, pageNumber);
    await saveCustomCoverFromFile(req.params.comicId, pagePath);
    const coverPath = await updateSeriesCover(req.params.comicId, customCoverApiPath(req.params.comicId));
    await syncLogicalWorkCover(req.params.comicId, coverPath);

    invalidateComicsCache();
    res.json({ success: true, path: coverPath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/comics/:comicId/cover/from-bangumi', async (req, res) => {
  try {
    const bundle = await readSeriesBundle(req.params.comicId);
    if (!bundle) return res.status(404).json({ error: 'Comic not found' });

    const requestedSubjectId = Number(req.body?.subjectId || 0);
    const subjectId = Number.isInteger(requestedSubjectId) && requestedSubjectId > 0
      ? requestedSubjectId
      : Number(bundle.series?.bangumiSubjectId || bundle.bangumi?.subjectId || 0);
    if (!Number.isInteger(subjectId) || subjectId <= 0) {
      return res.status(400).json({ error: 'No Bangumi subject id available' });
    }

    const cover = await fetchBangumiCover(subjectId);
    await saveCustomCoverBuffer(req.params.comicId, cover.buffer, cover.ext);
    const coverPath = await updateSeriesCover(req.params.comicId, customCoverApiPath(req.params.comicId));
    await syncLogicalWorkCover(req.params.comicId, coverPath);

    invalidateComicsCache();
    res.json({
      success: true,
      path: coverPath,
      sourceUrl: cover.sourceUrl,
      subjectId,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 删除封面 ───
app.delete('/api/comics/:comicId/cover', async (req, res) => {
  try {
    const bundle = await readSeriesBundle(req.params.comicId);
    if (!bundle) return res.status(404).json({ error: 'Comic not found' });

    await clearCustomCoverFiles(req.params.comicId);
    const coverPath = await updateSeriesCover(req.params.comicId, await defaultCoverForSeries(bundle));
    await clearLogicalWorkCover(req.params.comicId);

    invalidateComicsCache();
    res.json({ success: true, path: coverPath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 删除章节 ───
app.delete('/api/comics/:comicId/:groupName/:chapterDir', async (req, res) => {
  try {
    const { comicId, groupName, chapterDir } = req.params;
    const chapterPath = await resolveSeriesPath(comicId, groupName, chapterDir);
    await fs.rm(chapterPath, { recursive: true, force: true });
    await enqueueTask('scanLibrary', { reason: 'resource_deleted', fastScan: true, changedPaths: [chapterPath] });
    invalidateComicsCache();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 删除漫画 ───
app.delete('/api/comics/:comicId', async (req, res) => {
  try {
    const bundle = await readSeriesBundle(req.params.comicId);
    if (!bundle) return res.status(404).json({ error: 'Comic not found' });
    const targets = [...new Set(await Promise.all((bundle.resources || []).map(configuredResourcePath)))];
    for (const target of targets) await fs.rm(target, { recursive: true, force: false });
    await enqueueTask('scanLibrary', { reason: 'resource_deleted', fastScan: true, changedPaths: targets });
    invalidateComicsCache();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 删除单张图片 ───
app.delete('/api/comics/:comicId/:groupName/:chapterDir/image/:filename', async (req, res) => {
  try {
    const { comicId, groupName, chapterDir, filename } = req.params;
    const imagePath = await resolveSeriesPath(comicId, groupName, chapterDir, filename);
    await fs.unlink(imagePath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

async function startServer() {
  await settingsStore.initialize();
  users.initialize();
  await localMetadata.initialize();
  await require('./lib/downloads').initialize();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await restoreTaskIds();
  await cleanupCache();
  const cacheTimer = setInterval(() => cleanupCache().catch(error => console.warn('[cache] 清理失败:', error.message)), 30 * 60 * 1000);
  cacheTimer.unref();
  await libraryWatcher.rebuild();
  const server = app.listen(PORT, () => console.log(`ReadDeck running on http://localhost:${PORT}`));
  const shutdown = async () => {
    clearInterval(cacheTimer);
    await libraryWatcher.close();
    for (const response of realtimeClients) response.end();
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
startServer().catch(error => { console.error('[startup]', error.message); process.exitCode = 1; });
