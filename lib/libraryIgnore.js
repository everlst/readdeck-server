// Files owned by synchronizers, the OS or the NAS are not reading resources.
// Match reserved entries only; normal dot-prefixed book names remain usable.
const ignored = new Set(['.ds_store', '.sync', '.stfolder', '.stversions', '.stignore',
  '.git', '__macosx', '#recycle', '@eadir']);

function isIgnoredLibraryEntry(name) {
  return !name || ignored.has(name.toLowerCase()) || name.startsWith('._');
}

function isIgnoredLibraryPath(relativePath) {
  return String(relativePath || '').split(/[\\/]/).filter(Boolean).some(isIgnoredLibraryEntry);
}

module.exports = { isIgnoredLibraryEntry, isIgnoredLibraryPath };
