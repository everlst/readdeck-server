const fs = require('node:fs');
const path = require('node:path');
const schema = require('./webScrapeSchema.json');

const { WEB_SCRAPE_POLICY_VERSION: POLICY_VERSION } = require('./scrapeContext');
const MAX_RESOURCES_PER_BATCH = 8;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MEDIA_TYPES = ['novel', 'comic', 'anime', 'artbook', 'other', ''];
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'webScrapePrompt.txt'), 'utf8').trimEnd()
  + '\n\nWebScrapeResultV1 JSON Schema：\n' + JSON.stringify(schema, null, 2);

// Normalize only tracking/fragment differences, never silently trust a different host or page.
function sourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\\]/.test(value)) return '';
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_')) url.searchParams.delete(key);
    return url.href;
  } catch { return ''; }
}

// Only identity metadata crosses this boundary. File content, paths, progress, credentials,
// and arbitrary nested objects are not forwarded, even if the collector accidentally adds them.
const METADATA_KEYS = new Set([
  'title', 'titleCn', 'name', 'nameCn', 'nameJa', 'originalName', 'subtitle', 'series', 'seriesTitle',
  'author', 'authors', 'creator', 'creators', 'illustrator', 'illustrators', 'publisher', 'publishers',
  'alias', 'aliases', 'alternateTitles', 'language', 'languages', 'date', 'publishedAt', 'publicationDate',
  'isbn', 'identifiers', 'identifier', 'description', 'summary', 'brief', 'tags', 'subjects', 'subject',
  'type', 'mediaType', 'format', 'volumeNumber', 'chapterNumber', 'volumeEnd', 'chapterEnd', 'number',
  'detectedNumber', 'detectedNumberType', 'detectedNumberEnd', 'numberType', 'numberEnd', 'edition',
  'parsedTitle', 'normalizedTitle', 'workTitle', 'resourceTitle', 'bangumiId', 'subjectId', 'role', 'roles',
  'sourceUrls', 'titleOrigin', 'status', 'originalDirectoryNames', 'entries', 'aiName', 'seriesName',
  'dates', 'historicalBangumiId',
]);
const WORK_KEYS = Object.keys(schema.definitions.work.properties);
function safeText(value, field, max = 16000) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    throw new Error(field + ' 必须为有效字符串');
  }
  // Ignore complete HTTP(S) URL tokens only for path detection. Never rewrite the input.
  // An absolute path after a URL/space is still checked; internal title slashes remain legal.
  const pathText = value.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '');
  if (/^\//.test(pathText) || /(?:^|[\s"'()\[\]{}“”‘’（）「」『』【】=:])(?:\/[^\s"<>]+|[A-Za-z]:[\\/]|file:\/\/|\\\\)/i.test(pathText)
      || /\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{8,})/i.test(value)) {
    throw new Error(field + ' 不得含本机绝对路径或凭据');
  }
  return value;
}

function metadata(value, field, depth = 0) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(field + ' 必须为元数据对象');
  if (depth > 4) throw new Error(field + ' 元数据嵌套过深');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!METADATA_KEYS.has(key)) continue;
    const at = field + '.' + key;
    const clean = child => {
      if (child === null) return null;
      if (typeof child === 'string') return safeText(child, at);
      if (typeof child === 'number' && Number.isFinite(child)) return child;
      if (child && typeof child === 'object' && !Array.isArray(child)) return metadata(child, at, depth + 1);
      throw new Error(at + ' 元数据类型无效');
    };
    if (Array.isArray(item)) {
      if (item.length > 128) throw new Error(at + ' 元数据集合过大');
      result[key] = item.map(clean);
    } else result[key] = clean(item);
  }
  return result;
}

function inputSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input 必须为对象');
  if (!['full', 'resources'].includes(input.mode)) throw new Error('mode 必须为 full 或 resources');
  if (!Array.isArray(input.resources) || input.resources.length > MAX_RESOURCES_PER_BATCH) throw new Error('每批 resources 必须为数组且最多 8 个');
  if (input.mode === 'resources' && !input.resources.length) throw new Error('resources 模式至少需要一个资源');
  const forced = input.forcedBangumiSubjectId ?? null;
  if (forced !== null && (!Number.isSafeInteger(forced) || forced < 1)) throw new Error('forcedBangumiSubjectId 必须为正整数或 null');
  const local = input.localWork ?? {};
  if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error('localWork 必须为对象');
  const stringList = (value, field) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 128) throw new Error(field + ' 必须为字符串数组');
    return value.map(item => safeText(item, field, 1024));
  };
  const rawName = (value, field) => {
    const name = safeText(value, field, 1024);
    if (/[/\\]/.test(name)) throw new Error(field + ' 只接受原始名称，不接受文件路径');
    return name;
  };
  const mediaType = local.mediaType ?? '';
  if (!MEDIA_TYPES.includes(mediaType)) throw new Error('localWork.mediaType 无效');
  const resources = input.resources.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('resources/' + index + ' 必须为对象');
    const resourceId = safeText(item.resourceId, 'resourceId', 512);
    if (!resourceId.trim() || /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(resourceId)) throw new Error('resourceId 必须为非空本地标识，不能是绝对路径');
    return {
      resourceId,
      originalName: rawName(item.originalName ?? '', 'resources/' + index + '/originalName'),
      format: safeText(item.format ?? '', 'resource.format', 32),
      embeddedMetadata: metadata(item.embeddedMetadata, 'embeddedMetadata'),
      localMetadata: metadata(item.localMetadata, 'resource.localMetadata'),
      existingParseHints: metadata(item.existingParseHints, 'resource.existingParseHints'),
    };
  });
  if (new Set(resources.map(item => item.resourceId)).size !== resources.length) throw new Error('输入 resourceId 不得重复');
  let knownWork = null;
  if (input.knownWork != null) {
    if (typeof input.knownWork !== 'object' || Array.isArray(input.knownWork)) throw new Error('knownWork 必须为对象或 null');
    knownWork = metadata(Object.fromEntries(WORK_KEYS.filter(key => Object.hasOwn(input.knownWork, key)).map(key => [key, input.knownWork[key]])), 'knownWork');
    // These are context only; the adapter still owns its saved work and its provenance.
  }
  if (input.mode === 'resources' && !knownWork) throw new Error('resources 模式必须提供 knownWork');
  if (input.knownTerms !== undefined && (!Array.isArray(input.knownTerms) || input.knownTerms.length > 512)) throw new Error('knownTerms 必须为数组且最多 512 项');
  const knownTerms = (input.knownTerms || []).map(term => {
    if (!term || typeof term !== 'object' || Array.isArray(term)) throw new Error('knownTerms 项必须为 {originalName,nameCn}');
    return { originalName: safeText(term.originalName, 'knownTerms.originalName', 1024), nameCn: safeText(term.nameCn, 'knownTerms.nameCn', 1024) };
  });
  const result = {
    mode: input.mode, forcedBangumiSubjectId: forced,
    localWork: {
      originalDirectoryNames: stringList(local.originalDirectoryNames, 'originalDirectoryNames').map(name => rawName(name, 'originalDirectoryNames')),
      title: safeText(local.title ?? '', 'localWork.title', 1024), mediaType,
      authors: stringList(local.authors, 'localWork.authors'), aliases: stringList(local.aliases, 'localWork.aliases'),
      localMetadata: metadata(local.localMetadata, 'localWork.localMetadata'),
      existingParseHints: metadata(local.existingParseHints, 'localWork.existingParseHints'),
    },
    knownWork, knownTerms, resources,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error('输入元数据超过 256 KiB');
  return result;
}

function evidenceSnapshot(response) {
  return {
    searchCalls: Number.isSafeInteger(response?.searchCalls) && response.searchCalls >= 0 ? response.searchCalls : 0,
    sources: (Array.isArray(response?.sources) ? response.sources : []).filter(source => sourceUrl(source?.url))
      .map(source => ({ url: sourceUrl(source.url), title: typeof source.title === 'string' ? source.title.slice(0, 1024) : '' })),
  };
}

function safeError(error, settings) {
  let message = String(error?.message || '联网刮削请求失败');
  if (settings.apiKey) message = message.split(settings.apiKey).join('[REDACTED]');
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/[\r\n\t]/g, ' ').slice(0, 1600);
}

/**
 * One semantic batch only. The caller chunks >8 resources, captures aiOptions once per task,
 * supplies knownWork/knownTerms for later batches, and owns cache, metadata keys and fallback.
 * Provider scheduling/deduplication/priority remain shared with all other AI calls.
 * deps.webSearch has aiProvider.webSearch's signature; deps.sleep receives milliseconds.
 */
async function scrapeBatch(input, aiOptions, deps = {}) {
  let snapshot, settings;
  let evidence = { searchCalls: 0, sources: [] };
  const failure = (code, reason, errors, attempts) => ({ result: null, evidence, attempts, reason, failure: { code, reason, errors } });
  try { snapshot = inputSnapshot(input); }
  catch (error) { return failure('input_invalid', error.message, [error.message], 0); }
  // Never consult mutable global settings. Each attempt gets a fresh copy of the same snapshot.
  if (!aiOptions || typeof aiOptions !== 'object' || Array.isArray(aiOptions)
      || ['baseUrl', 'apiKey', 'model'].some(key => typeof aiOptions[key] !== 'string' || !aiOptions[key].trim())) {
    return failure('configuration_invalid', '必须显式提供固定的 baseUrl、apiKey 和 model', [], 0);
  }
  settings = Object.fromEntries(['baseUrl', 'apiKey', 'model', 'effort', 'concurrency', 'timeout'].filter(key => aiOptions[key] !== undefined).map(key => [key, aiOptions[key]]));
  if (JSON.stringify(snapshot).includes(settings.apiKey.trim())) return failure('input_invalid', '识别元数据不得包含当前 AI 凭据', [], 0);
  const webSearch = deps.webSearch || require('./aiProvider').webSearch;
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let errors = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(snapshot) }];
    // Evidence belongs to this attempt only. A failed request cannot reuse an older search result.
    evidence = { searchCalls: 0, sources: [] };
    try {
      const response = await webSearch({ messages, allowUnverifiedResult: true }, { ...settings });
      evidence = evidenceSnapshot(response);
      if (typeof response?.text !== 'string' || !response.text.trim() || Buffer.byteLength(response.text) > MAX_TEXT_BYTES) throw new Error('返回文本为空或超过 2 MiB');
      let result;
      try { result = JSON.parse(response.text); }
      catch { throw new Error('返回文本必须为单个有效 JSON 对象，不能包含 Markdown、解释或截断内容'); }
      // JSON decoding is the transport boundary. Content, names, IDs and sources
      // are the model's final decision; do not run schema/provenance/language acceptance.
      return { result, evidence, attempts: attempt };
    } catch (error) { errors = [safeError(error, settings)]; }
    if (attempt < 3) await sleep(attempt * 1000);
  }
  return failure('retry_exhausted', '联网刮削尝试 3 次仍失败：' + errors.join('；').slice(0, 3000), errors, 3);
}

module.exports = { POLICY_VERSION, MAX_RESOURCES_PER_BATCH, schema, scrapeBatch };
