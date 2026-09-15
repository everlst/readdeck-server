const path = require('node:path');
const fs = require('node:fs/promises');
const { DATA_DIR } = require('./runtimePaths');
const { atomicWrite } = require('./settingsStore');

const sectionIds = ['characters', 'persons', 'relations'];
const defaults = () => ({ revision: 0, detailSections: sectionIds.map(id => ({ id, visible: true })) });
const file = userId => path.join(DATA_DIR, 'users', encodeURIComponent(userId), 'preferences.json');
const queues = new Map();
const listeners = new Set();
async function read(userId) {
  try { return JSON.parse(await fs.readFile(file(userId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return defaults(); throw error; }
}
async function save(userId, input) {
  const operation = async () => {
    const rows = input?.detailSections;
    if (!Number.isSafeInteger(input?.revision) || input.revision < 0 || !Array.isArray(rows)
      || rows.length !== sectionIds.length || new Set(rows.map(row => row?.id)).size !== sectionIds.length
      || rows.some(row => !sectionIds.includes(row?.id) || typeof row.visible !== 'boolean')) {
      throw Object.assign(new Error('作品详情显示设置无效'), { status: 400 });
    }
    const previous = await read(userId);
    if (input.revision !== previous.revision) throw Object.assign(new Error('设置已在其他设备更新，请重新载入后保存'), { status: 409 });
    const next = { revision: previous.revision + 1, detailSections: rows.map(({ id, visible }) => ({ id, visible })) };
    await atomicWrite(file(userId), next);
    for (const listener of listeners) {
      try { listener(userId, next.revision); } catch (error) { console.warn('[preferences] 通知失败:', error.message); }
    }
    return next;
  };
  const pending = (queues.get(userId) || Promise.resolve()).catch(() => {}).then(operation);
  queues.set(userId, pending);
  try { return await pending; }
  finally { if (queues.get(userId) === pending) queues.delete(userId); }
}
module.exports = { defaults, read, save, onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
