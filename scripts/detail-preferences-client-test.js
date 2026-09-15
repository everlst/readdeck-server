const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
async function main() {
  const cache = new Map(), node = { classList: { contains: () => false } };
  let nextResponse, note = '';
  const context = { structuredClone, console,
    localStorage: { getItem: key => cache.get(key), setItem: (key, value) => cache.set(key, value) },
    document: { getElementById: () => node }, window: { scrollY: 0 },
    app: { state: { token: 'session-a' }, authFetch: async () => nextResponse, setPageScrollTop() {} },
    systemSettings: { section: 'display', render() {}, updateDirty() {}, note: text => { note = text; } },
  };
  vm.createContext(context);
  const preferences = vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/detail-preferences.js'), 'utf8') + '\ndetailPreferences', context);
  const response = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });
  nextResponse = response(preferences.defaults());
  await preferences.initialize({ instanceId: 'server-a', capabilities: ['user-preferences'] }, { id: 'reader' });
  const oldKey = preferences.key;
  preferences.draft.detailSections[0].visible = false;
  const before = JSON.stringify(preferences.draft);
  nextResponse = response({ error: '设置已在其他设备更新' }, 409);
  await preferences.save();
  assert.equal(preferences.conflict, true); assert.equal(JSON.stringify(preferences.draft), before); assert(note.includes('其他设备'));
  context.app.authFetch = async () => { throw new Error('offline'); };
  await preferences.load(); assert.equal(JSON.stringify(preferences.draft), before, 'offline fetch keeps the draft');
  context.app.authFetch = async () => response({ ...preferences.defaults(), revision: 4 });
  await preferences.load(); assert.equal(preferences.value.revision, 4); assert.equal(JSON.stringify(preferences.draft), before, 'SSE reload does not overwrite edits');
  let release;
  context.app.authFetch = () => new Promise(resolve => { release = resolve; });
  const pending = preferences.load();
  context.app.state.token = 'session-b'; context.app.authFetch = async () => response(preferences.defaults());
  await preferences.initialize({ instanceId: 'server-b', capabilities: ['user-preferences'] }, { id: 'reader' });
  release(response({ ...preferences.defaults(), revision: 99 })); await pending;
  assert.notEqual(preferences.key, oldKey); assert.equal(preferences.value.revision, 0);
  await preferences.initialize({ instanceId: 'server-a', capabilities: ['user-preferences'] }, { id: 'other-reader' });
  assert.notEqual(preferences.key, oldKey); assert(preferences.value.detailSections.every(row => row.visible));
  context.app.authFetch = async () => { throw new Error('old servers should not be requested'); };
  await preferences.initialize({ instanceId: 'old-server', capabilities: [] }, { id: 'reader' });
  assert.equal(preferences.supported, false); assert(preferences.render().includes('服务器尚不支持此设置'));
  console.log('display preference client ok: draft/conflict/offline retention, stale response rejection, account/server isolation and old-server fallback');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
