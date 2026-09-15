const { inputFingerprint } = require('./scrapeContext');
const { isMetadataResource } = require('./metadataResources');

function subjectId(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function hasResult(bundle) {
  const bangumi = bundle?.bangumi || {};
  return !!(subjectId(bangumi.subjectId) || bangumi.matchedAt || bangumi.detailsFetchedAt ||
    bangumi.webScrape?.completedAt || ['success', 'partial', 'fallback'].includes(bangumi.webScrape?.status) ||
    bangumi.source === 'local_metadata' || bangumi.source === 'ai_web_scrape' || bangumi.webScrape?.knownWork ||
    bangumi.matchedBy === 'local_metadata_fallback' ||
    bundle?.overrides?.bangumiScrapeCompletedAt);
}

function resourceFingerprint(resource) {
  return inputFingerprint({ resourceId: resource.resourceId, type: resource.type,
    relativePath: resource.relativePath || '', fileHash: resource.fileHash || '',
    modifiedTime: resource.modifiedTime || '', fileSize: resource.fileSize ?? null,
    contentFingerprint: resource.contentFingerprint || '' });
}

function resourceChanged(previous, current) {
  if (!previous) return true;
  const comparable = previous.contentFingerprint ? current : { ...current, contentFingerprint: '' };
  return resourceFingerprint(previous) !== resourceFingerprint(comparable);
}

function fingerprints(resources) {
  return Object.fromEntries((resources || []).map(resource => [resource.resourceId, resourceFingerprint(resource)]));
}

function changedResources(bundle) {
  const recorded = bundle.bangumi?.resourceFingerprints || {};
  const pending = new Set(bundle.bangumi?.pendingResourceIds || []);
  // Missing legacy fingerprints are not evidence that the entire work changed.
  return (bundle.resources || []).filter(resource => isMetadataResource(resource) &&
    (pending.has(resource.resourceId) || (recorded[resource.resourceId] &&
      recorded[resource.resourceId] !== resourceFingerprint(resource))));
}

function completedState(bundle, resources = bundle.resources || []) {
  const processed = new Set(resources.map(resource => resource.resourceId));
  return { resourceFingerprints: { ...(bundle.bangumi?.resourceFingerprints || {}), ...fingerprints(resources) },
    pendingResourceIds: (bundle.bangumi?.pendingResourceIds || []).filter(id => !processed.has(id)) };
}

module.exports = { subjectId, hasResult, resourceFingerprint, resourceChanged, fingerprints, changedResources, completedState };
