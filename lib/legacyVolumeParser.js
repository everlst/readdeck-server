const path = require('path');
const { parseNameWithAI } = require('./aiNameParser');

async function parseLegacyVolumeNames(series, resources, { refresh = false } = {}) {
  // The shared AI provider queue owns request concurrency and spacing.
  return Promise.all(resources.map(async resource => {
    if (!resource.legacy || resource.contentType !== 'volume') return resource;
    const name = resource.legacy.chapterDir || path.basename(resource.sourcePath || resource.relativePath || '') ||
      resource.originalTitle || resource.title;
    const parsed = await parseNameWithAI(name, {
      kind: resource.type === 'directory' ? 'directory' : 'file', type: resource.type,
      category: resource.category || series.category, seriesTitle: series.title,
      parentName: resource.legacy.groupName || path.basename(path.dirname(resource.relativePath || '')),
      contentType: 'volume', originalTitle: resource.legacy.chapterTitle || resource.originalTitle || '',
      legacyOrder: resource.legacy.order,
    }, { refresh });
    const hasVolumeNumber = parsed.detectedNumberType === 'volume';
    return {
      ...resource,
      title: parsed.title,
      originalTitle: resource.originalTitle || resource.legacy.chapterTitle || resource.title,
      contentType: 'volume', detectedNumberType: 'volume',
      detectedNumber: hasVolumeNumber ? parsed.detectedNumber : null,
      detectedNumberEnd: hasVolumeNumber ? parsed.detectedNumberEnd : null,
      volumeNumber: hasVolumeNumber ? parsed.detectedNumber : null, chapterNumber: null,
      parseHints: { ...resource.parseHints, ...parsed.parseHints },
    };
  }));
}

module.exports = { parseLegacyVolumeNames };
