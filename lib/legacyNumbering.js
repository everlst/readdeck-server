const { parseName } = require('./nameParser');

// Legacy downloaders use order to locate a directory, not necessarily to number a book.
function legacyNumbering(resource) {
  const legacy = resource?.legacy;
  if (!legacy || legacy.order == null || legacy.order === '') return null;
  const order = Number(legacy.order);
  if (!Number.isFinite(order) || order < 0) return null;
  const kind = resource.contentType;
  if (kind !== 'volume' && kind !== 'chapter') return null;
  for (const name of [legacy.chapterTitle, legacy.chapterDir, resource.parseHints?.chapterDir]) {
    if (!name) continue;
    const parsed = parseName(name);
    const range = kind === 'volume' ? parsed.volumeRange : parsed.chapterRange;
    if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
      return { ...range, kind, order };
    }
  }
  return null;
}

function normalizeLegacyResource(resource) {
  const numbering = legacyNumbering(resource);
  if (!numbering) return resource;
  const patch = {};
  const replaceOrder = (field, number) => {
    if (resource[field] != null && Number(resource[field]) === numbering.order && Number(resource[field]) !== number) {
      patch[field] = number;
    }
  };
  replaceOrder('detectedNumber', numbering.start);
  replaceOrder('detectedNumberEnd', numbering.end);
  replaceOrder(numbering.kind === 'volume' ? 'volumeNumber' : 'chapterNumber', numbering.start);
  return Object.keys(patch).length ? { ...resource, ...patch } : resource;
}

function correctLegacyVolumeDisplayTitle(title, resource) {
  const numbering = legacyNumbering(resource);
  if (!numbering || numbering.kind !== 'volume' || numbering.start !== numbering.end || numbering.start === numbering.order) return title;
  const text = String(title || '').normalize('NFKC').trim();
  // Only repair a generic label containing the known legacy sorting value.
  const match = text.match(/^(?:第\s*(\d+(?:\.\d+)?)\s*[卷巻册冊]|(?:vol(?:ume)?\.?\s*)(\d+(?:\.\d+)?))$/i);
  return match && Number(match[1] ?? match[2]) === numbering.order ? `第${numbering.start}册` : title;
}

module.exports = { legacyNumbering, normalizeLegacyResource, correctLegacyVolumeDisplayTitle };
