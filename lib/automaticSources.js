const store = require('./settingsStore');

// Background and button-triggered batches respect source switches; explicit single-work requests bypass them.
async function resourcesForScrape(resources, options = {}) {
  if (!options.automatic && !options.respectAutoScrape) return resources || [];
  const sources = store.snapshot().sources.filter(source => source.enabled && source.autoScrape &&
    (!options.sourceIds?.length || options.sourceIds.includes(source.id)));
  const states = await Promise.all(sources.map(store.sourceStatus));
  const ids = new Set(sources.filter((source, index) => states[index].available).map(source => source.id));
  return (resources || []).filter(resource => ids.has(resource.sourceId));
}
module.exports = { resourcesForScrape };
