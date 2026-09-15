const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const settings = require('./settingsStore');
const { CONFIG_DIR } = require('./runtimePaths');
const file = path.join(CONFIG_DIR, 'users.json');
let chain = Promise.resolve();
const listeners = new Set();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function state() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { users: [], instanceId: '' }; }
}
function write(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function initialize() {
  const data = state();
  if (!data.instanceId) { data.instanceId = crypto.randomUUID(); write(data); }
  return data.instanceId;
}
function all() {
  const data = state();
  const account = settings.secrets().account;
  const root = data.users.find(u => u.id === 'admin') || {};
  return [{ id: 'admin', role: 'admin', enabled: true, sourceIds: [], ...root,
    ...account, version: (account?.version || 1) + (root.version || 0) },
  ...data.users.filter(u => u.id !== 'admin')];
}
const publicUser = u => ({ id: u.id, username: u.username, role: u.role, enabled: u.enabled,
  sourceIds: u.sourceIds || [], mustChangePassword: !!u.mustChangePassword });
const get = id => all().find(u => u.id === id);
async function hash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: (await scrypt(password, salt, 64)).toString('hex') };
}
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024 || password === 'admin') fail('密码需为 8–1024 个字符');
}
function serialized(fn) { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; }
async function save(id, input) {
  return serialized(async () => {
    const data = state();
    const existing = id ? get(id) : null;
    if (id && !existing) fail('用户不存在', 404);
    if (id === 'admin' && (input.username !== undefined || input.password)) fail('初始管理员请通过账户设置修改用户名和密码');
    const username = String(input.username ?? existing?.username ?? '').trim();
    if (!username || username.length > 64) fail('用户名需为 1–64 个字符');
    if (all().some(u => u.username === username && u.id !== id)) fail('用户名已存在', 409);
    const role = input.role ?? existing?.role ?? 'reader';
    if (!['admin', 'reader'].includes(role) || (id === 'admin' && role !== 'admin')) fail('角色无效');
    const enabled = input.enabled ?? existing?.enabled ?? true;
    if (typeof enabled !== 'boolean') fail('用户状态无效');
    const sourceIds = input.sourceIds ?? existing?.sourceIds ?? [];
    const sources = settings.snapshot().sources;
    if (!Array.isArray(sourceIds) || sourceIds.some(s => typeof s !== 'string' || !sources.some(x => x.id === s))) fail('来源授权无效');
    let password = existing?.password;
    if (!existing || input.password) { validatePassword(input.password); password = await hash(input.password); }
    const next = { id: id || crypto.randomUUID(), username, role, enabled, sourceIds: [...new Set(sourceIds)],
      password, version: (existing?.version || 0) + 1,
      mustChangePassword: input.password ? true : (existing?.mustChangePassword ?? true) };
    if (existing?.role === 'admin' && existing.enabled && (role !== 'admin' || !enabled)
      && !all().some(u => u.id !== id && u.role === 'admin' && u.enabled)) fail('至少保留一个有效管理员', 409);
    const rootVersion = data.users.find(u => u.id === 'admin')?.version || 0;
    data.users = data.users.filter(u => u.id !== next.id);
    if (id === 'admin') data.users.push({ id, enabled, role, sourceIds: [], version: rootVersion + 1 });
    else data.users.push(next);
    write(data); listeners.forEach(fn => fn(next.id));
    return publicUser(get(next.id));
  });
}
async function updateAccount(id, input) {
  if (id === 'admin') {
    return serialized(async () => {
      if (all().some(u => u.id !== id && u.username === String(input.username || '').trim())) fail('用户名已存在', 409);
      await settings.updateAccount(input);
      listeners.forEach(fn => fn(id));
      return publicUser(get(id));
    });
  }
  return serialized(async () => {
    const existing = get(id);
    if (!existing || !await settings.checkPassword(input.currentPassword, existing.password)) fail('当前密码错误', 403);
    validatePassword(input.password);
    const username = String(input.username || existing.username).trim();
    if (!username || username.length > 64 || all().some(u => u.id !== id && u.username === username)) fail('用户名无效或已存在', 409);
    const data = state();
    const password = await hash(input.password);
    data.users = data.users.map(u => u.id === id ? { ...u, username, password, version: u.version + 1, mustChangePassword: false } : u);
    write(data); listeners.forEach(fn => fn(id));
    return publicUser(get(id));
  });
}
async function resetAdministrator() {
  return serialized(async () => {
    await settings.resetAccount();
    const data = state();
    const rootVersion = data.users.find(user => user.id === 'admin')?.version || 0;
    data.users = data.users.filter(user => user.id !== 'admin');
    data.users.push({ id: 'admin', enabled: true, role: 'admin', sourceIds: [], version: rootVersion + 1 });
    write(data);
    listeners.forEach(fn => fn('admin'));
  });
}
module.exports = { all, get, save, initialize, publicUser, updateAccount, resetAdministrator, instanceId: () => state().instanceId,
  onChanged: fn => listeners.add(fn) };
