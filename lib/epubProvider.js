const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const { validateResource } = require('./resourcePaths');
const {
  commandExists,
  ensureDir,
  hashString,
  imageExt,
  pathExists,
  runCommand,
  safePath,
  statSafe,
  streamCommandToFile,
} = require('./utils');

const manifestCache = new Map();
const IMAGE_MIME = new Map([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

function resourceCacheKey(resource) {
  return hashString([
    resource.resourceId,
    resource.fileHash || '',
    resource.modifiedTime || '',
    resource.sourceRevision || '',
    resource.sourcePath || '',
  ].join('|'), 24);
}

function epubCacheDir(resource) {
  return path.join(config.READER_CACHE_DIR, `epub-${resourceCacheKey(resource)}`);
}

async function touchCache(resource) {
  const dir = epubCacheDir(resource);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, '.last-access'), new Date().toISOString(), 'utf-8');
}

async function requireBsdtar() {
  const bsdtar = await commandExists('bsdtar');
  if (!bsdtar) throw new Error('缺少 bsdtar/libarchive，无法读取 EPUB');
  return bsdtar;
}

async function listEpubEntries(resource) {
  const bsdtar = await requireBsdtar();
  const { stdout } = await runCommand(bsdtar, ['-tf', resource.sourcePath], {
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.endsWith('/'))
    .map(normalizeEntry);
}

function normalizeEntry(entry) {
  const text = String(entry || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = path.posix.normalize(text);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('Invalid EPUB entry path');
  }
  return normalized;
}

function resolveHref(baseEntry, href) {
  const raw = String(href || '').split('#')[0].split('?')[0];
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return '';
  const decoded = decodeURIComponent(raw.replace(/\+/g, '%20'));
  const baseDir = path.posix.dirname(normalizeEntry(baseEntry));
  return normalizeEntry(path.posix.join(baseDir === '.' ? '' : baseDir, decoded));
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*(["'])(.*?)\2/g;
  let match;
  while ((match = re.exec(String(tag || ''))) !== null) {
    attrs[match[1]] = decodeXml(match[3]);
  }
  return attrs;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(value) {
  return decodeXml(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function basenameTitle(entry) {
  return decodeURIComponent(path.posix.basename(String(entry || ''), path.posix.extname(entry || '')))
    .replace(/[_-]+/g, ' ')
    .trim();
}

async function readEpubEntry(resource, entry) {
  resource = await validateResource(resource);
  const bsdtar = await requireBsdtar();
  const normalized = normalizeEntry(entry);
  const { stdout } = await runCommand(bsdtar, ['-xOf', resource.sourcePath, normalized], {
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function parseManifestItems(opfText, opfPath) {
  const items = new Map();
  const itemRe = /<item\b[^>]*>/gi;
  let match;
  while ((match = itemRe.exec(opfText)) !== null) {
    const attrs = parseAttrs(match[0]);
    if (!attrs.id || !attrs.href) continue;
    const href = resolveHref(opfPath, attrs.href);
    items.set(attrs.id, {
      id: attrs.id,
      href,
      mediaType: attrs['media-type'] || attrs.mediaType || '',
      properties: attrs.properties || '',
    });
  }
  return items;
}

function parseSpineIds(opfText) {
  const ids = [];
  const itemrefRe = /<itemref\b[^>]*>/gi;
  let match;
  while ((match = itemrefRe.exec(opfText)) !== null) {
    const attrs = parseAttrs(match[0]);
    if (attrs.idref) ids.push(attrs.idref);
  }
  return ids;
}

function parseBookTitle(opfText, fallback) {
  const match = opfText.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i) ||
    opfText.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return stripTags(match?.[1] || '') || fallback || '';
}

function parseBookDescription(opfText) {
  const descriptionMatch = opfText.match(/<dc:description\b[^>]*>([\s\S]*?)<\/dc:description>/i) ||
    opfText.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i) ||
    opfText.match(/<meta\b[^>]*(?:property|name)\s*=\s*["'](?:dcterms:description|dc:description|description)["'][^>]*>([\s\S]*?)<\/meta>/i);
  const fromElement = stripTags(descriptionMatch?.[1] || '');
  if (fromElement) return fromElement;

  const metaRe = /<meta\b[^>]*>/gi;
  let match;
  while ((match = metaRe.exec(opfText)) !== null) {
    const attrs = parseAttrs(match[0]);
    const name = String(attrs.property || attrs.name || '').toLowerCase();
    if (!['dcterms:description', 'dc:description', 'description'].includes(name)) continue;
    const content = stripTags(attrs.content || '');
    if (content) return content;
  }
  return '';
}

function isIntroTitle(title) {
  const text = String(title || '')
    .replace(/[\s\u3000:：\-—_·.。]+/g, '')
    .toLowerCase();
  if (!text) return false;
  return /^(?:简介|簡介|介绍|介紹|内容简介|內容簡介|内容紹介|あらすじ|summary|description)$/.test(text) ||
    /(?:简介|簡介|内容简介|內容簡介|内容紹介|あらすじ|summary|description)/.test(text);
}

function chapterTextFromHtml(html) {
  const bodyMatch = String(html || '').match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const text = stripTags(bodyMatch ? bodyMatch[1] : html);
  return text.replace(/^\s*(?:简介|簡介|介绍|介紹|内容简介|內容簡介|内容紹介|あらすじ)\s*/i, '').trim();
}

function parseCoverEntry(opfText, manifestItems) {
  const metaCover = opfText.match(/<meta\b[^>]*(?:name|property)\s*=\s*["']cover["'][^>]*>/i);
  if (metaCover) {
    const attrs = parseAttrs(metaCover[0]);
    const id = attrs.content || attrs.refines || '';
    const item = manifestItems.get(String(id).replace(/^#/, ''));
    if (item?.href) return item.href;
  }

  for (const item of manifestItems.values()) {
    if (/\bcover-image\b/i.test(item.properties || '') && /^image\//i.test(item.mediaType || '')) {
      return item.href;
    }
  }

  for (const item of manifestItems.values()) {
    if (!/^image\//i.test(item.mediaType || '')) continue;
    if (/cover|封面/i.test(`${item.id} ${item.href}`)) return item.href;
  }
  return '';
}

function parseNavTitles(navText, navEntry) {
  const out = new Map();
  const linkRe = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(navText)) !== null) {
    const title = stripTags(match[3]);
    if (!title) continue;
    const entry = resolveHref(navEntry, decodeXml(match[2]));
    if (entry && !out.has(entry)) out.set(entry, title);
  }
  return out;
}

function parseNavTreeFromNavXhtml(navText, navEntry) {
  // Find the toc nav block first
  const tocBlockMatch = navText.match(/<nav\b[^>]*epub:type\s*=\s*(["'])([^"']*\btoc\b[^"']*)\1[^>]*>([\s\S]*?)<\/nav>/i)
    || navText.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i);
  const block = tocBlockMatch ? (tocBlockMatch[3] || tocBlockMatch[1] || '') : navText;

  function parseList(html) {
    const items = [];
    const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = liRe.exec(html)) !== null) {
      const inner = m[1];
      const aMatch = inner.match(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/i)
        || inner.match(/<span\b[^>]*>([\s\S]*?)<\/span>/i);
      if (!aMatch) continue;
      const hasHref = aMatch.length === 4;
      const title = stripTags(hasHref ? aMatch[3] : aMatch[1]);
      const href = hasHref ? resolveHref(navEntry, decodeXml(aMatch[2])) : '';
      const subOlMatch = inner.match(/<ol\b[^>]*>([\s\S]*?)<\/ol>/i);
      const children = subOlMatch ? parseList(subOlMatch[1]) : [];
      if (!title && !href && children.length === 0) continue;
      items.push({ title: title || basenameTitle(href) || '未命名', href, children });
    }
    return items;
  }
  return parseList(block);
}

function parseNavTitlesFromNcx(ncxText, ncxEntry) {
  const out = new Map();
  const navPointRe = /<navPoint\b[^>]*>([\s\S]*?)<\/navPoint>/gi;
  let m;
  while ((m = navPointRe.exec(ncxText)) !== null) {
    const inner = m[1];
    const labelMatch = inner.match(/<navLabel\b[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>/i);
    const contentMatch = inner.match(/<content\b[^>]*src\s*=\s*(["'])(.*?)\1/i);
    if (!labelMatch || !contentMatch) continue;
    const title = stripTags(labelMatch[1]);
    const entry = resolveHref(ncxEntry, decodeXml(contentMatch[2]));
    if (entry && title && !out.has(entry)) out.set(entry, title);
  }
  return out;
}

function parseNavTreeFromNcx(ncxText, ncxEntry) {
  // Recursively parse navMap > navPoint hierarchy
  function takeBlocks(src, tag) {
    const out = [];
    const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    let m;
    while ((m = re.exec(src)) !== null) {
      const start = m.index + m[0].length;
      let depth = 1;
      const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
      const closeRe = new RegExp(`<\\/${tag}\\s*>`, 'gi');
      openRe.lastIndex = start;
      closeRe.lastIndex = start;
      let pos = start;
      while (depth > 0) {
        openRe.lastIndex = pos;
        closeRe.lastIndex = pos;
        const o = openRe.exec(src);
        const c = closeRe.exec(src);
        if (!c) break;
        if (o && o.index < c.index) { depth += 1; pos = o.index + o[0].length; }
        else { depth -= 1; pos = c.index + c[0].length; if (depth === 0) { out.push({ inner: src.slice(start, c.index), end: pos }); re.lastIndex = pos; break; } }
      }
    }
    return out;
  }
  function parsePoints(src) {
    const items = [];
    for (const { inner } of takeBlocks(src, 'navPoint')) {
      const labelMatch = inner.match(/<navLabel\b[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>/i);
      const contentMatch = inner.match(/<content\b[^>]*src\s*=\s*(["'])(.*?)\1/i);
      const title = labelMatch ? stripTags(labelMatch[1]) : '';
      const href = contentMatch ? resolveHref(ncxEntry, decodeXml(contentMatch[2])) : '';
      const children = parsePoints(inner.replace(/^[\s\S]*?<\/navLabel>/i, ''));
      if (!title && !href && children.length === 0) continue;
      items.push({ title: title || basenameTitle(href) || '未命名', href, children });
    }
    return items;
  }
  const navMapMatch = ncxText.match(/<navMap\b[^>]*>([\s\S]*?)<\/navMap>/i);
  return parsePoints(navMapMatch ? navMapMatch[1] : ncxText);
}

function findNcxEntry(opfText, manifestItems) {
  // Spine attr `toc` references manifest item id
  const spineMatch = opfText.match(/<spine\b[^>]*>/i);
  if (spineMatch) {
    const attrs = parseAttrs(spineMatch[0]);
    if (attrs.toc) {
      const item = manifestItems.get(attrs.toc);
      if (item?.href) return item.href;
    }
  }
  for (const item of manifestItems.values()) {
    if (/application\/x-dtbncx\+xml/i.test(item.mediaType || '')) return item.href;
    if (/\.ncx$/i.test(item.href || '')) return item.href;
  }
  return '';
}

async function loadNavData(resource, opfText, manifestItems) {
  // Returns { titles: Map<entry,title>, tree: [...] }
  const result = { titles: new Map(), tree: [] };
  // EPUB3 nav.xhtml first
  const navItem = Array.from(manifestItems.values())
    .find(item => /\bnav\b/i.test(item.properties || ''));
  if (navItem?.href) {
    try {
      const text = await readEpubEntry(resource, navItem.href);
      result.titles = parseNavTitles(text, navItem.href);
      result.tree = parseNavTreeFromNavXhtml(text, navItem.href);
      if (result.titles.size > 0 || result.tree.length > 0) return result;
    } catch (error) {}
  }
  // EPUB2 NCX fallback
  const ncxEntry = findNcxEntry(opfText, manifestItems);
  if (ncxEntry) {
    try {
      const text = await readEpubEntry(resource, ncxEntry);
      result.titles = parseNavTitlesFromNcx(text, ncxEntry);
      result.tree = parseNavTreeFromNcx(text, ncxEntry);
    } catch (error) {}
  }
  return result;
}

function chapterEntriesFromSpine(spineIds, manifestItems) {
  return spineIds
    .map(id => manifestItems.get(id))
    .filter(item => item?.href && /(?:xhtml|html|xml)/i.test(item.mediaType || item.href));
}

async function getEpubManifest(resource) {
  resource = await validateResource(resource);
  if (!resource || resource.type !== 'epub') throw new Error('Resource is not an EPUB');
  const key = resourceCacheKey(resource);
  const cached = manifestCache.get(key);
  if (cached) return cached;

  const entries = new Set(await listEpubEntries(resource));
  const container = await readEpubEntry(resource, 'META-INF/container.xml');
  const rootfile = container.match(/<rootfile\b[^>]*>/i);
  const opfPath = normalizeEntry(parseAttrs(rootfile?.[0] || '')['full-path'] || '');
  if (!opfPath || !entries.has(opfPath)) throw new Error('EPUB 缺少 OPF package 文件');

  const opfText = await readEpubEntry(resource, opfPath);
  const manifestItems = parseManifestItems(opfText, opfPath);
  const spineIds = parseSpineIds(opfText);
  const { titles: navTitles, tree: navTree } = await loadNavData(resource, opfText, manifestItems);
  const spineItems = chapterEntriesFromSpine(spineIds, manifestItems);

  const chapters = spineItems.map((item, index) => ({
    index,
    title: navTitles.get(item.href) || basenameTitle(item.href) || `章节 ${index + 1}`,
    href: item.href,
    mediaType: item.mediaType,
  }));

  // Build a flat "book TOC" preserving the actual nav structure (for novel detail page).
  // Map each entry href → spine index when possible.
  const spineHrefIndex = new Map();
  spineItems.forEach((item, idx) => { if (item?.href) spineHrefIndex.set(item.href, idx); });
  function flattenTree(nodes, depth = 0, out = []) {
    for (const node of nodes || []) {
      const baseHref = String(node.href || '').split('#')[0];
      out.push({
        title: node.title || '',
        href: node.href || '',
        depth,
        chapterIndex: baseHref && spineHrefIndex.has(baseHref) ? spineHrefIndex.get(baseHref) : null,
      });
      if (node.children && node.children.length) flattenTree(node.children, depth + 1, out);
    }
    return out;
  }
  const tocFlat = flattenTree(navTree);

  const manifest = {
    resourceId: resource.resourceId,
    title: parseBookTitle(opfText, resource.title),
    description: parseBookDescription(opfText),
    opfPath,
    coverEntry: parseCoverEntry(opfText, manifestItems),
    chapters,
    toc: navTree,
    tocFlat,
    entryCount: entries.size,
    createdAt: new Date().toISOString(),
  };
  manifestCache.set(key, manifest);
  await touchCache(resource);
  return manifest;
}

// Identification reads the package metadata only; no navigation or book body is sent to AI.
async function getEpubEmbeddedMetadata(resource) {
  const container = await readEpubEntry(resource, 'META-INF/container.xml');
  const rootfile = container.match(/<rootfile\b[^>]*>/i);
  const opfPath = normalizeEntry(parseAttrs(rootfile?.[0] || '')['full-path'] || '');
  if (!opfPath) throw new Error('EPUB 缺少 OPF package 文件');
  const text = await readEpubEntry(resource, opfPath);
  const values = tag => [...text.matchAll(new RegExp(`<dc:${tag}\\b[^>]*>([\\s\\S]*?)<\\/dc:${tag}>`, 'gi'))]
    .map(match => stripTags(match[1]).slice(0, 4000)).filter(Boolean).slice(0, 30);
  return { title: parseBookTitle(text, ''), authors: values('creator'), publishers: values('publisher'),
    dates: values('date'), languages: values('language'), identifiers: values('identifier'),
    tags: values('subject'), description: parseBookDescription(text).slice(0, 8000) };
}

async function getEpubBrief(resource) {
  const manifest = await getEpubManifest(resource);
  const tocIntro = (manifest.tocFlat || []).find(item =>
    isIntroTitle(item?.title) && Number.isInteger(item.chapterIndex)
  );
  const chapterIntro = !tocIntro
    ? (manifest.chapters || []).find(chapter => isIntroTitle(chapter?.title))
    : null;
  const introChapterIndex = tocIntro?.chapterIndex ?? chapterIntro?.index;
  const introChapter = Number.isInteger(introChapterIndex)
    ? (manifest.chapters || [])[introChapterIndex]
    : null;

  if (introChapter?.href) {
    try {
      const html = await readEpubEntry(resource, introChapter.href);
      const text = chapterTextFromHtml(html);
      if (text) return text;
    } catch (error) {}
  }

  return String(manifest.description || '').trim();
}

function epubAssetApiPath(resourceId, entry) {
  return `/api/resources/${encodeURIComponent(resourceId)}/epub/assets/${
    normalizeEntry(entry).split('/').map(encodeURIComponent).join('/')
  }`;
}

function rewriteChapterAssets(resourceId, chapterEntry, html) {
  const baseEntry = normalizeEntry(chapterEntry);
  return String(html || '').replace(
    /\s(src|href)\s*=\s*(["'])(.*?)\2/gi,
    (full, attr, quote, rawValue) => {
      const value = decodeXml(rawValue);
      if (!value || value.startsWith('#') || /^(?:https?:|data:|mailto:|javascript:)/i.test(value)) {
        return ` ${attr}=${quote}${value}${quote}`;
      }
      const entry = resolveHref(baseEntry, value);
      if (!entry) return '';
      const ext = path.posix.extname(entry).toLowerCase();
      if (!IMAGE_MIME.has(ext)) return '';
      return ` ${attr}="${epubAssetApiPath(resourceId, entry)}"`;
    }
  );
}

function sanitizeChapterHtml(resourceId, chapterEntry, html) {
  const bodyMatch = String(html || '').match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  let content = bodyMatch ? bodyMatch[1] : String(html || '');
  content = content
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/\s+on[\w:-]+\s*=\s*(["']).*?\1/gi, '')
    .replace(/\s+on[\w:-]+\s*=\s*[^\s>]+/gi, '')
    .replace(/\sstyle\s*=\s*(["']).*?\1/gi, '');
  return rewriteChapterAssets(resourceId, chapterEntry, content);
}

async function getEpubChapter(resource, chapterIndex) {
  const manifest = await getEpubManifest(resource);
  const index = Number(chapterIndex);
  if (!Number.isInteger(index) || index < 0 || index >= manifest.chapters.length) {
    throw new Error('EPUB chapter not found');
  }
  const chapter = manifest.chapters[index];
  const html = await readEpubEntry(resource, chapter.href);
  await touchCache(resource);
  return {
    resourceId: resource.resourceId,
    chapterIndex: index,
    title: chapter.title,
    html: sanitizeChapterHtml(resource.resourceId, chapter.href, html),
  };
}

async function extractEpubEntryToCache(resource, entry, subdir = 'assets') {
  resource = await validateResource(resource);
  const normalized = normalizeEntry(entry);
  const cacheDir = epubCacheDir(resource);
  const target = safePath(cacheDir, subdir, normalized);
  const stat = await statSafe(target);
  if (stat?.isFile() && stat.size > 0) {
    await touchCache(resource);
    return target;
  }

  await ensureDir(path.dirname(target));
  const tmpPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.rm(tmpPath, { force: true }).catch(() => {});
  try {
    const bsdtar = await requireBsdtar();
    await streamCommandToFile(bsdtar, ['-xOf', resource.sourcePath, normalized], tmpPath);
    const tmpStat = await statSafe(tmpPath);
    if (!tmpStat?.isFile() || tmpStat.size <= 0) throw new Error('EPUB 资源为空');
    await fs.rename(tmpPath, target);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  await touchCache(resource);
  return target;
}

async function getEpubCoverFile(resource) {
  const manifest = await getEpubManifest(resource);
  if (!manifest.coverEntry) throw new Error('EPUB cover not found');
  return extractEpubEntryToCache(resource, manifest.coverEntry, 'cover');
}

async function getEpubAssetFile(resource, entry) {
  return extractEpubEntryToCache(resource, entry, 'assets');
}

function sanitizeNcxText(ncxText) {
  let text = String(ncxText || '');
  let previous = '';
  const leafNavPoint = /<navPoint\b[^>]*>(?:(?!<navPoint\b)[\s\S])*?<\/navPoint>/gi;
  while (text !== previous) {
    previous = text;
    text = text.replace(leafNavPoint, block => /<content\b/i.test(block) ? block : '');
  }
  return text;
}

async function packDirectoryAsZip(sourceDir, targetPath) {
  const bsdtar = await requireBsdtar();
  const entries = (await fs.readdir(sourceDir)).filter(Boolean);
  if (entries.length === 0) throw new Error('EPUB 解包目录为空');
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.rm(tmpPath, { force: true }).catch(() => {});
  try {
    await runCommand(bsdtar, ['--format', 'zip', '-cf', tmpPath, '-C', sourceDir, ...entries], {
      timeout: 180000,
      maxBuffer: 128 * 1024 * 1024,
    });
    const stat = await statSafe(tmpPath);
    if (!stat?.isFile() || stat.size <= 0) throw new Error('兼容 EPUB 打包失败');
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function getCompatibleEpubFile(resource) {
  resource = await validateResource(resource);
  const manifest = await getEpubManifest(resource);
  const opfText = await readEpubEntry(resource, manifest.opfPath);
  const manifestItems = parseManifestItems(opfText, manifest.opfPath);
  const ncxEntry = findNcxEntry(opfText, manifestItems);
  if (!ncxEntry) return resource.sourcePath;

  const ncxText = await readEpubEntry(resource, ncxEntry);
  const sanitized = sanitizeNcxText(ncxText);
  if (sanitized === ncxText) return resource.sourcePath;

  const cacheDir = epubCacheDir(resource);
  const targetPath = path.join(cacheDir, 'compatible', 'book.epub');
  const cached = await statSafe(targetPath);
  if (cached?.isFile() && cached.size > 0) {
    await touchCache(resource);
    return targetPath;
  }

  const tmpDir = path.join(cacheDir, `compatible-src-${process.pid}-${Date.now()}`);
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await ensureDir(tmpDir);
  try {
    const bsdtar = await requireBsdtar();
    await runCommand(bsdtar, ['-xf', resource.sourcePath, '-C', tmpDir], {
      timeout: 180000,
      maxBuffer: 128 * 1024 * 1024,
    });
    const ncxPath = safePath(tmpDir, ncxEntry);
    await fs.writeFile(ncxPath, sanitized, 'utf-8');
    await ensureDir(path.dirname(targetPath));
    await packDirectoryAsZip(tmpDir, targetPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  await touchCache(resource);
  return targetPath;
}

function contentTypeForEpubAsset(entry) {
  return IMAGE_MIME.get(path.posix.extname(String(entry || '')).toLowerCase()) || 'application/octet-stream';
}

async function hasEpubCover(resource) {
  try {
    const manifest = await getEpubManifest(resource);
    return !!manifest.coverEntry;
  } catch (error) {
    return false;
  }
}

module.exports = {
  contentTypeForEpubAsset,
  epubAssetApiPath,
  getEpubBrief,
  getEpubAssetFile,
  getEpubChapter,
  getCompatibleEpubFile,
  getEpubCoverFile,
  getEpubManifest,
  getEpubEmbeddedMetadata,
  hasEpubCover,
};
