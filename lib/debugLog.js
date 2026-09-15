const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const context = new AsyncLocalStorage();
const sensitive = /(?:api[_-]?key|token|password|secret|authorization|cookie|credential|signing|salt|hash)/i;
let enabled = false;
function setEnabled(value) { enabled = value === true; }
function isEnabled() { return enabled; }
function secretValues(value, result = [], seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 12) return result;
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (sensitive.test(key) && typeof item === 'string' && item) result.push(item);
    else if (item && typeof item === 'object') secretValues(item, result, seen, depth + 1);
  }
  return result;
}
function withContext(id, secrets, work) { return context.run({ id, secrets }, work); }
function sanitize(value, secrets = []) {
  const known = [...new Set([...secrets, ...secretValues(value)].filter(item => typeof item === 'string' && item)
    .flatMap(item => {
      let encoded = item; try { encoded = encodeURIComponent(item); } catch { /* Preserve malformed Unicode for exact redaction. */ }
      return [item, encoded, JSON.stringify(item).slice(1, -1)];
    }))]
    .sort((a, b) => b.length - a.length);
  let remaining = 60000;
  const seen = new WeakSet();
  const clean = (item, depth = 0) => {
    if (remaining <= 0 || depth > 12) return '[TRUNCATED]';
    if (typeof item === 'string') {
      for (const secret of known) item = item.split(secret).join('[REDACTED]');
      item = item.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/sk-[\w-]+/g, '[REDACTED]')
        .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;<>]+)/gi, '$1[REDACTED]')
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
        .replace(/([?&](?:[^=&\s]*(?:key|token|secret|password|signature)[^=&\s]*)=)[^&#\s"<>]+/gi, '$1[REDACTED]');
      const limit = Math.min(12000, remaining); remaining -= Math.min(item.length, limit);
      return item.length > limit ? item.slice(0, limit) + '[TRUNCATED]' : item;
    }
    if (item instanceof Error) return clean({ name: item.name, message: item.message, stack: item.stack, code: item.code, status: item.status, cause: item.cause }, depth + 1);
    if (!item || typeof item !== 'object') { remaining -= 16; return item; }
    if (seen.has(item)) return '[CIRCULAR]';
    seen.add(item);
    const result = Array.isArray(item) ? [] : {};
    let count = 0;
    for (const [key, child] of Object.entries(item)) {
      if (count++ >= 200 || remaining <= 0) {
        if (Array.isArray(result)) result.push('[TRUNCATED]'); else result._truncated = true;
        break;
      }
      const safeKey = clean(key, depth + 1);
      // Token counts and configured/clear flags are useful diagnostics, not credentials.
      const redact = sensitive.test(key) && typeof child !== 'boolean' && typeof child !== 'number';
      const cleaned = redact ? '[REDACTED]' : clean(child, depth + 1);
      if (Array.isArray(result)) result.push(cleaned);
      else Object.defineProperty(result, safeKey, { value: cleaned, enumerable: true });
    }
    seen.delete(item);
    return result;
  };
  return clean(value);
}
function log(event, details, secrets = []) {
  if (!enabled) return;
  // Logging must never turn a successful operation into a failure.
  try {
    const scope = context.getStore();
    console.log('[debug] ' + JSON.stringify({ time: new Date().toISOString(), event, traceId: scope?.id,
      details: sanitize(details, [...(scope?.secrets || []), ...secrets]) }));
  } catch { /* Ignore unavailable log sinks or diagnostic serialization errors. */ }
}
function requestId() { return crypto.randomUUID(); }

module.exports = { setEnabled, isEnabled, secretValues, withContext, sanitize, log, requestId };
