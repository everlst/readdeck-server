const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const config = require('./config');
const { ensureDir, hashString, statSafe } = require('./utils');

const STREAM_CACHE_VERSION = 'stream-4k-v1';
const COVER_CACHE_VERSION = 'cover-webp-v1';
const PERSISTENT_COVER_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const WEBP_QUALITY = 86;
const SHARP_INPUT_OPTIONS = { failOn: 'none', limitInputPixels: false };

function imageContentType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return {
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  }[ext] || '';
}

function maxImageDimension() {
  return Math.max(1, Number(config.IMAGE_MAX_DIMENSION || 4096));
}

function needsResize(metadata, maxDimension = maxImageDimension()) {
  const width = Number(metadata?.width || 0);
  const height = Number(metadata?.height || 0);
  return width > maxDimension || height > maxDimension;
}

async function readImageMetadata(filePathOrBuffer) {
  return sharp(filePathOrBuffer, SHARP_INPUT_OPTIONS).metadata();
}

async function resizeToWebpFile(input, targetPath, maxDimension = maxImageDimension()) {
  await ensureDir(path.dirname(targetPath));
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.rm(tmpPath, { force: true }).catch(() => {});
  try {
    await sharp(input, SHARP_INPUT_OPTIONS)
      .rotate()
      .resize({
        width: maxDimension,
        height: maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY, effort: 4 })
      .toFile(tmpPath);
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function streamableImage(filePath, options = {}) {
  const originalContentType = imageContentType(filePath);
  if (!originalContentType) return { filePath, contentType: '', resized: false };

  const maxDimension = Math.max(1, Number(options.maxDimension || maxImageDimension()));
  let metadata = null;
  try {
    metadata = await readImageMetadata(filePath);
  } catch (error) {
    console.warn(`[image] 无法读取图片元数据，发送原图: ${filePath}: ${error.message}`);
    return { filePath, contentType: originalContentType, resized: false };
  }

  if (!needsResize(metadata, maxDimension)) {
    return { filePath, contentType: originalContentType, resized: false, metadata };
  }

  const stat = await statSafe(filePath);
  const cacheKey = hashString([
    STREAM_CACHE_VERSION,
    path.resolve(filePath),
    stat?.size || 0,
    stat?.mtimeMs || 0,
    metadata.width || 0,
    metadata.height || 0,
    maxDimension,
  ].join('|'), 32);
  const targetPath = path.join(config.THUMBNAIL_CACHE_DIR, 'stream-4k', `${cacheKey}.webp`);
  const cached = await statSafe(targetPath);
  if (!cached?.isFile() || cached.size <= 0) {
    await resizeToWebpFile(filePath, targetPath, maxDimension);
  }
  return {
    filePath: targetPath,
    contentType: 'image/webp',
    resized: true,
    metadata,
  };
}

async function persistentCoverFromBuffer(buffer, fallbackExt = '.jpg') {
  const safeFallbackExt = String(fallbackExt || '.jpg').toLowerCase();
  const metadata = await readImageMetadata(buffer);
  const canPersistOriginal = PERSISTENT_COVER_EXTS.has(safeFallbackExt);
  if (!needsResize(metadata) && canPersistOriginal) {
    return {
      buffer,
      ext: safeFallbackExt,
      resized: false,
      metadata,
    };
  }

  let pipeline = sharp(buffer, SHARP_INPUT_OPTIONS).rotate();
  if (needsResize(metadata)) {
    pipeline = pipeline.resize({
      width: maxImageDimension(),
      height: maxImageDimension(),
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  const resized = await pipeline.webp({ quality: WEBP_QUALITY, effort: 4 }).toBuffer();
  return {
    buffer: resized,
    ext: '.webp',
    resized: true,
    metadata,
  };
}

async function persistentCoverFromFile(sourcePath) {
  const image = await streamableImage(sourcePath);
  if (!image.resized) {
    const ext = path.extname(sourcePath).toLowerCase() || '.jpg';
    if (!PERSISTENT_COVER_EXTS.has(ext)) {
      const stat = await statSafe(sourcePath);
      const cacheKey = hashString([
        COVER_CACHE_VERSION,
        path.resolve(sourcePath),
        stat?.size || 0,
        stat?.mtimeMs || 0,
        image.metadata?.width || 0,
        image.metadata?.height || 0,
        maxImageDimension(),
      ].join('|'), 32);
      const targetPath = path.join(config.THUMBNAIL_CACHE_DIR, 'cover-webp', `${cacheKey}.webp`);
      const cached = await statSafe(targetPath);
      if (!cached?.isFile() || cached.size <= 0) {
        await resizeToWebpFile(sourcePath, targetPath, maxImageDimension());
      }
      return {
        filePath: targetPath,
        ext: '.webp',
        resized: true,
        metadata: image.metadata,
      };
    }
    return {
      filePath: sourcePath,
      ext,
      resized: false,
      metadata: image.metadata,
    };
  }
  return {
    filePath: image.filePath,
    ext: '.webp',
    resized: true,
    metadata: image.metadata,
  };
}

module.exports = {
  imageContentType,
  maxImageDimension,
  needsResize,
  persistentCoverFromBuffer,
  persistentCoverFromFile,
  readImageMetadata,
  streamableImage,
};
