// Synthetic, offline-only data for web-metadata-flow-test.js. No real book or credentials.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const BODY_SENTINEL = 'READDECK_PRIVATE_CHAPTER_BODY_MUST_NEVER_BE_SENT';
const KEY_SENTINEL = 'sk-fixture-never-send-local-secret';
const EPUB_TITLE = '星の旅 第1巻';
const LOCAL_METADATA = {
  comic: { name: '星の旅', author: ['山田太郎'], alias: ['星之旅原始别名'], publisher: ['本地出版社'],
    brief: '本地已有作品简介。', theme: ['冒险'], status: { display: '连载' }, date: '2026-01-01',
    language: 'ja', sourcePath: '/Users/fixture/private/book.epub', apiKey: KEY_SENTINEL,
    body: BODY_SENTINEL },
  body: BODY_SENTINEL,
};

async function writeEpub(destination, staging) {
  await fs.mkdir(path.join(staging, 'META-INF'), { recursive: true });
  await fs.writeFile(path.join(staging, 'mimetype'), 'application/epub+zip');
  await fs.writeFile(path.join(staging, 'META-INF/container.xml'), '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  await fs.writeFile(path.join(staging, 'book.opf'), '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:readdeck:web-flow-fixture</dc:identifier><dc:title>' + EPUB_TITLE + '</dc:title><dc:creator>山田太郎</dc:creator><dc:publisher>内嵌出版社</dc:publisher><dc:language>ja</dc:language><dc:date>2026-01-02</dc:date><dc:subject>冒険</dc:subject><dc:description>内嵌元数据简介。</dc:description><meta property="dcterms:modified">2026-01-02T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>');
  await fs.writeFile(path.join(staging, 'chapter.xhtml'), '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1>第一章</h1><p>' + BODY_SENTINEL + '</p></body></html>');
  await fs.writeFile(path.join(staging, 'nav.xhtml'), '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章</a></li></ol></nav></body></html>');
  await run('bsdtar', ['--format', 'zip', '-cf', destination, '-C', staging, '.']);
}

function resultFor(input, { failedIds = [], failed = false, bangumiId = input.forcedBangumiSubjectId,
  nameCn = '星之旅', titleOrigin = bangumiId ? 'bangumi' : 'web', rich = false } = {}) {
  const sources = [], fieldSources = [];
  const addSource = (url, title, excerpt) => {
    const source = { id: 's' + (sources.length + 1), url, title, excerpt };
    sources.push(source); return source;
  };
  const cite = (entity, prefix, source) => {
    for (const field of ['originalName', 'nameCn', 'mediaType', 'authors', 'publishers', 'date', 'tags',
      'summary', 'roles', 'voiceActors', 'relation', 'bangumiId', 'volumeNumber']) {
      const value = entity[field];
      if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) continue;
      if (field === 'nameCn' && ['translation', 'local'].includes(entity.titleOrigin)) continue;
      fieldSources.push({ field: prefix + '/' + field, sourceIds: [source.id] });
    }
  };
  const reason = failed ? '无法确认主作品身份' : failedIds.length ? '部分资源无法确认' : '';
  let work = null;
  const persons = [], characters = [], relations = [];
  if (!failed && input.mode === 'full') {
    const url = bangumiId ? `https://bgm.tv/subject/${bangumiId}`
      : 'https://publisher.example.test/books/' + encodeURIComponent(input.localWork.title);
    work = { originalName: '星の旅', nameCn, aliases: ['星之旅别名'], mediaType: input.localWork.mediaType,
      authors: ['山田太郎'], publishers: ['正式出版社'], date: '2026-01-02', status: '连载', tags: ['冒险'],
      summary: '星之旅的作品简介。', coverUrl: '', bangumiId: bangumiId ?? null, sourceUrls: [url], titleOrigin };
    const source = addSource(url, '星之旅正式出版资料', '星の旅（星之旅），山田太郎著，正式出版社出版；小说，2026-01-02，连载，冒险。星之旅的作品简介。');
    cite(work, '/work', source);
    if (rich) {
      persons.push({ originalName: '山田太郎', nameCn: '山田太郎', roles: ['作者'], summary: '星之旅的作者。', bangumiId: null, sourceUrls: [url], titleOrigin: 'web' });
      characters.push({ originalName: 'ヒカリ', nameCn: '光', summary: '星之旅的主角。', voiceActors: [], bangumiId: null, sourceUrls: [url], titleOrigin: 'translation' });
      relations.push({ originalName: '星の旅 漫画版', nameCn: '星之旅 漫画版', mediaType: 'comic', relation: '漫画改编', coverUrl: '', bangumiId: null, sourceUrls: [url], titleOrigin: 'web' });
      source.excerpt += '作者山田太郎；主角ヒカリ；星の旅 漫画版（星之旅 漫画版）为漫画改编。';
      cite(persons[0], '/persons/0', source); cite(characters[0], '/characters/0', source); cite(relations[0], '/relations/0', source);
    }
  }
  const resources = input.resources.map((resource, index) => {
    const isFailed = failed || failedIds.includes(resource.resourceId);
    const number = Number(resource.originalName.match(/Vol\.(\d+)/i)?.[1] || index + 1);
    const entity = { resourceId: resource.resourceId, status: isFailed ? 'failed' : 'success',
      reason: isFailed ? '本地特别版没有可确认的对应资料' : '', originalName: resource.originalName,
      nameCn: isFailed ? '' : `星之旅 第${number}卷`, volumeNumber: isFailed ? null : number,
      chapterNumber: null, volumeEnd: null, chapterEnd: null, summary: isFailed ? '' : `第${number}卷的简介。`,
      coverUrl: '', bangumiId: null, sourceUrls: [], titleOrigin: isFailed ? 'local' : 'web' };
    if (!isFailed) {
      const url = 'https://publisher.example.test/volumes/' + encodeURIComponent(resource.resourceId);
      const source = addSource(url, entity.nameCn, `${entity.originalName} 对应 ${entity.nameCn}；第${number}卷。${entity.summary}`);
      entity.sourceUrls = [url]; cite(entity, '/resources/' + index, source);
    }
    return entity;
  });
  return { schemaVersion: 1, status: failed ? 'failed' : failedIds.length ? 'partial' : 'success',
    reason, work, persons, characters, relations, resources, sources, fieldSources };
}

const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function responsesResult(result, { fakeSearch = false, text = JSON.stringify(result) } = {}) {
  return jsonResponse({ id: 'synthetic-web-flow-response', object: 'response', status: 'completed', output: [
    ...(!fakeSearch ? [{ id: 'ws-fixture', type: 'web_search_call', status: 'completed',
      action: { type: 'search', queries: ['星の旅 出版資料'], sources: result.sources.map(source => ({
        type: 'url', url: source.url, title: source.title })) } }] : []),
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
  ] });
}

module.exports = { BODY_SENTINEL, KEY_SENTINEL, EPUB_TITLE, LOCAL_METADATA, writeEpub, resultFor, jsonResponse, responsesResult };
