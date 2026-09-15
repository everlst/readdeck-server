/* Personal display settings: scoped to server instance + authenticated user. */
const detailPreferences = {
  labels: { characters: '角色', persons: '创作人员', relations: '关联条目' },
  value: null, draft: null, baseline: '', key: '', supported: true, conflict: false, sequence: 0,
  defaults() { return { revision: 0, detailSections: Object.keys(this.labels).map(id => ({ id, visible: true })) }; },
  sections() { return (this.value || this.defaults()).detailSections; },
  isDirty() { return !!this.draft && JSON.stringify(this.draft) !== this.baseline; },
  acceptDraft() { this.draft = structuredClone(this.value || this.defaults()); this.baseline = JSON.stringify(this.draft); this.conflict = false; },
  async initialize(info, account) {
    this.sequence++;
    this.key = 'readdeck-preferences:' + info.instanceId + ':' + account.id;
    this.value = this.defaults(); this.draft = null;
    this.supported = !Array.isArray(info.capabilities) || info.capabilities.includes('user-preferences');
    try { const cached = JSON.parse(localStorage.getItem(this.key)); if (this.valid(cached)) this.value = cached; } catch { /* use defaults */ }
    if (!this.supported) this.value = this.defaults();
    await this.load();
  },
  valid(value) {
    return Number.isSafeInteger(value?.revision) && value.revision >= 0 && value.detailSections?.length === 3
      && new Set(value.detailSections.map(row => row.id)).size === 3
      && value.detailSections.every(row => Object.hasOwn(this.labels, row.id) && typeof row.visible === 'boolean');
  },
  async load() {
    if (!this.key || !app.state.token || !this.supported) return;
    const key = this.key, token = app.state.token, sequence = ++this.sequence;
    try {
      const response = await app.authFetch('/api/me/preferences');
      if (key !== this.key || token !== app.state.token || sequence !== this.sequence) return;
      if (response.status === 404) { this.supported = false; this.value = this.defaults(); this.refreshPresentation(); return; }
      if (!response.ok) return;
      const value = await response.json();
      if (key !== this.key || token !== app.state.token || sequence !== this.sequence || !this.valid(value)) return;
      if (value.revision < (this.value?.revision || 0)) return;
      this.value = value;
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage is optional */ }
      const dirty = this.isDirty();
      if (!dirty) this.acceptDraft();
      this.refreshPresentation();
      if (systemSettings.section === 'display' && !dirty && document.getElementById('system-settings-page').classList.contains('active')) systemSettings.render();
      return true;
    } catch { /* keep the last saved value while offline */ }
  },
  refreshPresentation() {
    const top = window.scrollY;
    if (app.state.currentComic) app.renderMetadataSections();
    if (document.getElementById('comic-detail-page').classList.contains('active')) app.setPageScrollTop(top);
  },
  async save() {
    if (!this.supported || !this.draft) return;
    const key = this.key, token = app.state.token;
    systemSettings.loading = true; systemSettings.updateDirty();
    try {
      const response = await app.authFetch('/api/me/preferences', { method: 'PUT', body: JSON.stringify(this.draft) });
      const value = await response.json();
      if (key !== this.key || token !== app.state.token) return;
      if (!response.ok) { this.conflict = response.status === 409; throw new Error(value.error || '保存失败，请重试'); }
      if (!this.valid(value)) throw new Error('服务器返回的显示设置无效');
      this.sequence++; this.value = value; this.acceptDraft();
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage is optional */ }
      this.refreshPresentation(); systemSettings.render(); systemSettings.note('设置已保存，已同步到当前账号。');
    } catch (error) {
      if (key === this.key && token === app.state.token) { systemSettings.render(); systemSettings.note(error.message, true); }
    } finally { systemSettings.loading = false; systemSettings.updateDirty(); }
  },
  render() {
    if (!this.draft) this.acceptDraft();
    const arrow = delta => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="' + (delta < 0 ? 'M12 20V4m-7 7 7-7 7 7' : 'M12 4v16m-7-7 7 7 7-7') + '"/></svg>';
    return '<h2>作品详情显示</h2><p class="system-subtitle">设置同步到当前账号的网页和 App。</p>'
      + (!this.supported ? '<p class="system-notice">服务器尚不支持此设置，请更新服务器。</p>' : '')
      + '<h3 class="detail-preferences-heading">显示栏目与顺序</h3><div class="detail-preference-rows">'
      + this.draft.detailSections.map((row, index) => '<div class="detail-preference-row"><span>' + this.labels[row.id] + '</span><div class="detail-preference-actions">'
        + [-1, 1].map(delta => '<button class="btn-secondary" type="button" data-pref-move="' + row.id + '" data-delta="' + delta + '" aria-label="' + (delta < 0 ? '上移' : '下移') + this.labels[row.id] + '"' + (!this.supported || index + delta < 0 || index + delta > 2 ? ' disabled' : '') + '>' + arrow(delta) + '</button>').join('')
        + '<input class="system-switch" type="checkbox" data-pref-visible="' + row.id + '" aria-label="显示' + this.labels[row.id] + '"' + (row.visible ? ' checked' : '') + (!this.supported ? ' disabled' : '') + '></div></div>').join('')
      + '</div><p class="detail-preferences-help">使用上下箭头调整顺序，关闭开关可隐藏栏目。</p><button class="btn-secondary" data-pref-reset type="button"' + (!this.supported ? ' disabled' : '') + '>恢复默认</button>'
      + (this.conflict ? '<button class="btn-secondary" data-pref-reload type="button">重新载入最新设置</button>' : '');
  },
  bind() {
    document.addEventListener('change', event => {
      const id = event.target.dataset.prefVisible;
      if (!id || !this.draft) return;
      this.draft.detailSections.find(row => row.id === id).visible = event.target.checked;
      systemSettings.updateDirty();
    });
    document.addEventListener('click', async event => {
      const button = event.target.closest('[data-pref-move],[data-pref-reset],[data-pref-reload]');
      if (!button || button.disabled || systemSettings.loading) return;
      if (button.hasAttribute('data-pref-reload')) {
        if (!await this.load()) { systemSettings.note('无法连接服务器，已保留未保存的更改。', true); return; }
        this.acceptDraft();
      }
      else if (button.hasAttribute('data-pref-reset')) this.draft.detailSections = this.defaults().detailSections;
      else {
        const rows = this.draft.detailSections, index = rows.findIndex(row => row.id === button.dataset.prefMove), target = index + Number(button.dataset.delta);
        if (target < 0 || target >= rows.length) return;
        [rows[index], rows[target]] = [rows[target], rows[index]];
      }
      systemSettings.render();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.load(); });
    window.addEventListener('online', () => this.load());
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = { detailPreferences };
