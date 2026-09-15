const { readLibraryIndexes, readSeriesBundle } = require('./metadataStore');
const { getLibraryVersion } = require('./libraryEvents');
const { simplify } = require('./metadataLocalization');

const cache = new Map();
const relationCache = new Map();

function subjectIdOf(value) {
  const id = Number(value?.subjectId || value?.bangumiSubjectId || 0);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sourceUrlOf(value, kind = 'subject') {
  for (const candidate of [value?.sourceUrl, value?.url, value?.bangumiUrl]) {
    try {
      const url = new URL(candidate);
      if (['http:', 'https:'].includes(url.protocol)) return url.href;
    } catch {}
  }
  const id = kind === 'subject' ? subjectIdOf(value) : Number(value?.[`${kind}Id`] || 0);
  return Number.isSafeInteger(id) && id > 0 ? `https://bangumi.tv/${kind}/${id}` : '';
}

function metadataIdentity(value) {
  const id = subjectIdOf(value);
  if (id) return `subject:${id}`;
  const key = String(value?.metadataKey || value?.detailKey || '').trim();
  return key ? `metadata:${key}` : sourceIdentity(value);
}

function sourceIdentity(value) {
  const sourceUrl = sourceUrlOf(value);
  if (!sourceUrl) return '';
  const url = new URL(sourceUrl);
  url.hash = '';
  return `url:${url.href.replace(/\/$/, '')}`;
}

function hasWebScrapeResult(bundle) {
  const bangumi = bundle?.bangumi || {};
  return !!(bangumi.webScrape || bangumi.metadataKey || bundle?.series?.metadataKey ||
    bangumi.source === 'ai_web_scrape' ||
    bangumi.volumeMatches?.some(match => match.source === 'ai_web_scrape'));
}

async function officialRelations(subjectId) {
  const cached = relationCache.get(subjectId);
  if (cached && cached.expires > Date.now()) return cached.result;
  const result = require('./archiveSource').getApiJson(`/v0/subjects/${subjectId}/subjects`,
    { signal: AbortSignal.timeout(8000) }).then(rows => Array.isArray(rows) ? rows : []).catch(error => {
      console.warn(`[bangumi] 关联分类补全失败 ${subjectId}: ${error.message}`);
      return [];
    });
  relationCache.set(subjectId, { result, expires: Date.now() + 10 * 60 * 1000 });
  if (relationCache.size > 100) relationCache.delete(relationCache.keys().next().value);
  return result;
}
async function visibleWorks() {
  // Permission-filtered indexes are the only authority for local links.
  const { seriesIndex, resourceIndex } = await readLibraryIndexes();
  const populated = new Set(Object.values(resourceIndex || {}).map(resource => resource.seriesId));
  const rows = (seriesIndex || []).filter(row => populated.has(row.seriesId));
  const key = JSON.stringify([getLibraryVersion(), rows.map(row => row.seriesId).sort()]);
  if (!cache.has(key)) {
    const pending = (async () => {
      const works = [];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
        while (next < rows.length) {
          const row = rows[next++];
          const bundle = await readSeriesBundle(row.seriesId);
          if (!bundle?.resources?.length) continue;
          const identity = { ...bundle.series, ...bundle.bangumi };
          if (!metadataIdentity(identity)) continue;
          works.push({ seriesId: row.seriesId, subjectId: subjectIdOf(identity),
            metadataKey: identity.metadataKey || '', sourceUrl: sourceUrlOf(identity),
            category: row.category, name: bundle.bangumi.name || row.title,
            name_cn: row.title || bundle.bangumi.name_cn, image: bundle.bangumi.image || '',
            relations: [...(bundle.relations || []), ...(bundle.bangumi.relatedSubjects || [])] });
        }
      }));
      return works;
    })();
    cache.set(key, pending);
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    pending.catch(() => cache.delete(key));
  }
  return cache.get(key);
}

async function resolveLocalRelations(relations, { seriesIds = [], subjectIds = [], metadataKeys = [], sourceUrls = [], category = '', allowRemote = true } = {}) {
  const ownSeries = new Set(seriesIds), ownSubjects = new Set(subjectIds.map(Number).filter(Boolean));
  const ownKeys = new Set(metadataKeys.filter(Boolean).map(String));
  const ownUrls = new Set(sourceUrls.filter(Boolean).map(sourceUrl => sourceIdentity({ sourceUrl })).filter(Boolean));
  const isOwn = item => ownSubjects.has(subjectIdOf(item)) || ownKeys.has(item.metadataKey) || ownUrls.has(sourceIdentity(item));
  const works = (await visibleWorks()).filter(work => !ownSeries.has(work.seriesId) && !isOwn(work))
    .sort((a, b) => Number(b.category === category) - Number(a.category === category) || a.seriesId.localeCompare(b.seriesId));
  const byIdentity = new Map(), byUrl = new Map();
  for (const work of works) {
    const key = metadataIdentity(work);
    if (!byIdentity.has(key)) byIdentity.set(key, work);
    if (work.metadataKey && !byIdentity.has(`metadata:${work.metadataKey}`)) byIdentity.set(`metadata:${work.metadataKey}`, work);
    const urlKey = sourceIdentity(work);
    if (!urlKey) continue;
    if (!byUrl.has(urlKey)) byUrl.set(urlKey, work);
    else if (metadataIdentity(byUrl.get(urlKey)) !== key) byUrl.set(urlKey, null);
  }
  const resolved = new Map();
  for (const relation of relations || []) {
    if (isOwn(relation)) continue;
    const key = metadataIdentity(relation);
    const local = byIdentity.get(key) || byUrl.get(sourceIdentity(relation));
    resolved.set(local ? metadataIdentity(local) : (key || `${relation.relationType}:${relation.name}`), { ...relation,
      localSeriesId: local?.seriesId || null,
      image: relation.image || local?.image || '',
      relationLabel: typeof relation.relationType === 'string' && !/^\d+$/.test(relation.relationType) ? simplify(relation.relationType) : '',
      sourceUrl: sourceUrlOf(relation) || local?.sourceUrl || '',
      url: sourceUrlOf(relation) || local?.sourceUrl || '' });
  }
  // An already stored A -> B relation also makes B -> A navigable before B is rescraped.
  for (const work of works) {
    const key = metadataIdentity(work);
    if (resolved.has(key) || !work.relations.some(isOwn)) continue;
    resolved.set(key, { subjectId: work.subjectId, metadataKey: work.metadataKey,
      sourceUrl: work.sourceUrl, name: work.name, name_cn: work.name_cn,
      image: work.image, relationType: '', relationLabel: '', localSeriesId: byIdentity.get(key).seriesId,
      url: work.sourceUrl });
  }
  // Relation direction matters (e.g. prequel/sequel): ask the current subject, never infer an inverse label.
  if (allowRemote && [...resolved.values()].some(relation => !relation.relationLabel)) {
    const lists = await Promise.all([...ownSubjects].map(officialRelations));
    for (const item of lists.flat()) {
      const id = Number(item.subject?.id || item.id || item.subject_id);
      const relation = resolved.get(`subject:${id}`);
      if (!relation || !item.relation || typeof item.relation !== 'string') continue;
      relation.relationType = simplify(item.relation);
      relation.relationLabel = simplify(item.relation);
    }
  }
  return [...resolved.values()].sort((a, b) => Number(!!b.localSeriesId) - Number(!!a.localSeriesId));
}

module.exports = { resolveLocalRelations, metadataIdentity, sourceUrlOf, subjectIdOf, hasWebScrapeResult };
