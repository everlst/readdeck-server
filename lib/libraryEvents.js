const listeners = new Set();
let libraryVersion = 0;

function getLibraryVersion() {
  return libraryVersion;
}

function emitLibraryChanged(reason = 'library_changed', payload = {}) {
  libraryVersion += 1;
  const event = {
    version: libraryVersion,
    reason,
    payload,
    changedAt: new Date().toISOString(),
  };

  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn(`[library] change listener failed: ${error.message}`);
    }
  }

  return event;
}

function onLibraryChanged(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = {
  emitLibraryChanged,
  getLibraryVersion,
  onLibraryChanged,
};
