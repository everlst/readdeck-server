const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { isIgnoredLibraryEntry } = require('./libraryIgnore');

const IMAGE_RE = /\.(avif|bmp|gif|jpe?g|png|webp)$/i;
const COVER_IMAGE_RE = /^cover.*\.(?:gif|jpe?g|png|webp)$/i;

function hashString(value, length = 16) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, length);
}

function safePath(base, ...segments) {
  const basePath = path.resolve(base);
  const resolved = path.resolve(basePath, ...segments);
  if (resolved !== basePath && !resolved.startsWith(basePath + path.sep)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (e) {
    return false;
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch (e) {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmp, filePath);
}

async function listDirSafe(dir) {
  try {
    return await fs.readdir(dir);
  } catch (e) {
    return [];
  }
}

async function statSafe(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (e) {
    return null;
  }
}

function isImageFile(name) {
  return IMAGE_RE.test(name || '');
}

function isCoverFile(name) {
  return COVER_IMAGE_RE.test(path.basename(String(name || '')));
}

function imageExt(name) {
  const ext = path.extname(name || '').toLowerCase();
  return ext || '.jpg';
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[［【]/g, '[')
    .replace(/[］】]/g, ']')
    .replace(/[：]/g, ':')
    .replace(/巻/g, '卷')
    .replace(/[\s._\-–—~～·・/\\]+/g, '')
    .trim();
}

function parseVolumeNumberFromText(value) {
  const text = String(value || '').normalize('NFKC');
  const numberPattern = '0*([0-9]{1,3}(?:\\s*\\.\\s*[0-9]{1,2})?)';
  const patterns = [
    new RegExp(`[<〈《（(]\\s*${numberPattern}\\s*[>〉》）)]`),
    new RegExp(`(?:vol\\.?|volume)\\s*${numberPattern}\\s*(?:卷|巻|冊|册)?`, 'i'),
    new RegExp(`第\\s*${numberPattern}\\s*(?:卷|巻|冊|册)`, 'i'),
    new RegExp(`${numberPattern}\\s*(?:卷|巻|冊|册)`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const number = Number(match[1].replace(/\s+/g, ''));
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function looksLikeLibraryMountSegment(name) {
  return /^(?:\d+|library\d*|comics\d*|manga\d*|漫画\d*|漫畫\d*)$/i
    .test(String(name || '').trim());
}

function resourceRootFromRelativePath(relativePath) {
  const parts = String(relativePath || '').split(/[\\/]/).filter(Boolean);
  while (parts.length > 1 && looksLikeLibraryMountSegment(parts[0])) {
    parts.shift();
  }
  return parts[0] || '';
}

function resourceSeriesRootRelativePath(relativePath) {
  const parts = String(relativePath || '').split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length > 1 && looksLikeLibraryMountSegment(parts[0])) {
    return path.join(parts[0], parts[1]);
  }
  return parts[0];
}

function naturalCompare(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'zh-Hans-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = String(value || '').trim();
    const key = normalizeText(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function hasChinese(text) {
  return /[\u3400-\u9fff]/.test(text || '');
}

function hasJapanese(text) {
  return /[\u3040-\u30ff]/.test(text || '');
}

function commandExists(command) {
  return new Promise(resolve => {
    execFile('which', [command], (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
      timeout: options.timeout || 120000,
      cwd: options.cwd,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function streamCommandToFile(command, args, outputFile, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd });
    const out = fss.createWriteStream(outputFile);
    let stderr = '';
    let exitCode = null;
    let outputFinished = false;
    let settled = false;

    function finishIfReady() {
      if (settled || exitCode === null || !outputFinished) return;
      settled = true;
      if (exitCode === 0) resolve();
      else reject(new Error(`${command} exited with ${exitCode}: ${stderr}`));
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      reject(error);
    }

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      outputFinished = true;
      finishIfReady();
    });
    child.stdout.pipe(out);

    child.on('close', code => {
      exitCode = code;
      finishIfReady();
    });
  });
}

async function walkImages(rootDir, recursive = true) {
  const out = [];

  async function walk(dir) {
    const entries = await listDirSafe(dir);
    for (const entry of entries.sort(naturalCompare)) {
      if (isIgnoredLibraryEntry(entry)) continue;
      const fp = path.join(dir, entry);
      const stat = await fs.lstat(fp).catch(() => null);
      if (!stat) continue;
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory() && recursive) {
        await walk(fp);
      } else if (stat.isFile() && isImageFile(entry)) {
        out.push(fp);
      }
    }
  }

  await walk(rootDir);
  return out;
}

async function dirSize(dir) {
  let total = 0;
  const entries = await listDirSafe(dir);
  for (const entry of entries) {
    const fp = path.join(dir, entry);
    const stat = await statSafe(fp);
    if (!stat) continue;
    if (stat.isDirectory()) total += await dirSize(fp);
    else total += stat.size;
  }
  return total;
}

module.exports = {
  IMAGE_RE,
  commandExists,
  dirSize,
  ensureDir,
  hasChinese,
  hasJapanese,
  hashString,
  imageExt,
  isCoverFile,
  isImageFile,
  listDirSafe,
  looksLikeLibraryMountSegment,
  naturalCompare,
  normalizeText,
  parseVolumeNumberFromText,
  pathExists,
  readJson,
  resourceRootFromRelativePath,
  resourceSeriesRootRelativePath,
  runCommand,
  safePath,
  statSafe,
  streamCommandToFile,
  unique,
  walkImages,
  writeJson,
};
