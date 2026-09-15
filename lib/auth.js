const crypto = require('crypto');
const store = require('./settingsStore');
const users = require('./userStore');
const TOKEN_EXPIRY = 30 * 24 * 3600 * 1000;
function createToken(user = users.get('admin')) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: user.id, version: user.version,
    iat: Date.now(), exp: Date.now() + TOKEN_EXPIRY })).toString('base64url');
  const signature = crypto.createHmac('sha256', store.secrets().signingKey).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + signature;
}
function verifyToken(token) {
  try {
    if (typeof token !== 'string' || token.length > 4096) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    if (JSON.parse(Buffer.from(header, 'base64url')).alg !== 'HS256') return null;
    const expected = crypto.createHmac('sha256', store.secrets().signingKey).update(header + '.' + body).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url'));
    const user = users.get(payload.sub);
    if (!user?.enabled || !Number.isFinite(payload.exp) || payload.exp <= Date.now() || payload.version !== user.version) return null;
    return { ...payload, ...users.publicUser(user) };
  } catch { return null; }
}
async function login(username, password) {
  const user = users.all().find(u => u.username === username && u.enabled);
  if (!user || !await store.checkPassword(password, user.password)) return null;
  return { token: createToken(user), ...users.publicUser(user) };
}
module.exports = { createToken, verifyToken, login };
