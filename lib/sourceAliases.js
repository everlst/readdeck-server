const path = require('path');
const config = require('./config');
const { contains } = require('./settingsStore');

function sourceSegmentFromRelativePath(relativePath) {
  return String(relativePath || '').split(/[\\/]/).filter(Boolean)[0] || '';
}
function sourceAliasForRelativePath(relativePath, options = {}) {
  const sources = config.LIBRARY_SOURCES;
  const byId = sources.find(s => s.id === options.sourceId);
  if (byId) return byId.name;
  const sourcePath = options.sourcePath;
  if (sourcePath && path.isAbsolute(sourcePath)) {
    return sources.find(s => contains(s.path, sourcePath))?.name || '';
  }
  return '';
}
module.exports = { sourceAliasForRelativePath, sourceSegmentFromRelativePath };
