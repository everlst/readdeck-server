const { AsyncLocalStorage } = require('async_hooks');
const context = new AsyncLocalStorage();
const user = () => context.getStore();
const isReader = () => user()?.role === 'reader';
function canRead(resource) { return !isReader() || (!!resource && (user().sourceIds || []).includes(resource.sourceId)); }
module.exports = { context, user, isReader, canRead };
