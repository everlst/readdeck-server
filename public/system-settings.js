/* Application-wide settings, separate from per-device reader preferences. */
const systemSettings = {
  aiModels: [], aiState: 'idle', aiMessage: '', aiSequence: 0, aiTimer: null, aiController: null,
  section: 'sources', draft: null, baseline: '', forcedPassword: false, loading: false, accountDirty: false,
  sections: [
    ['display', '作品详情显示', 'grid'],
    ['sources', '书库来源', 'folder'], ['categories', '栏目管理', 'grid'],
    ['scanning', '扫描与刮削', 'scan'], ['metadata', '元数据服务', 'globe'],
    ['cache', '缓存与性能', 'cache'], ['users', '用户管理', 'user'], ['account', '账户与安全', 'user'],
  ],
  icon(name) {
    const shapes = {
      folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
      grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
      scan: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
      globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
      cache: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>',
      user: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-3a8 8 0 0 1 16 0v3"/>',
      back: '<path d="m12 4-8 8 8 8M4 12h17"/>',
      plus: '<path d="M12 4v16M4 12h16"/>',
      reload: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
    };
    return '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (shapes[name] || shapes.grid) + '</svg>';
  },
  esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  id(prefix) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return prefix + '-' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  },
  async request(url, options = {}) {
    let response;
    try { response = await app.authFetch(url, options); }
    catch (error) {
      if (error.name === 'AbortError' || error.message === 'Unauthorized') throw error;
      throw new Error('无法连接服务器或连接已中断，请检查网络和服务器日志');
    }
    const body = await response.json().catch(() => null);
    const id = response.headers?.get('X-ReadDeck-Request-Id');
    const suffix = id ? '（请求编号：' + id + '）' : '';
    if (!response.ok) {
      const message = typeof body?.error === 'string' ? body.error : body?.error?.message;
      throw new Error(typeof message === 'string' && message ? message : '服务器返回 HTTP ' + response.status +
        (body === null ? '，未返回有效 JSON；请检查服务器或反向代理日志' : '，未提供错误详情；请检查服务器日志') + suffix);
    }
    if (!body || typeof body !== 'object') throw new Error('服务器返回 HTTP ' + response.status + '，响应不是有效的 JSON 对象' + suffix);
    return body;
  },
  async afterLogin(account) {
    app.state.username = account.username;
    app.state.role = account.role; app.state.userId = account.id;
    app.state.progressCache = {}; app.state.comics = []; app.state.lastComicsLoadTime = 0;
    document.body.classList.toggle('reader-account', account.role === 'reader');
    const info = await fetch('/api/server').then(r => r.json());
    app.serverOffset = Date.parse(info.serverTime) - Date.now();
    if (account.mustChangePassword) {
      this.forcedPassword = true;
      this.section = 'account';
      this.draft = null;
      app.showPage('system-settings-page');
      this.render();
      return;
    }
    this.forcedPassword = false;
    await detailPreferences.initialize(info, account);
    if (account.role === 'reader') { app.enterLibrary(); return; }
    const settings = await this.request('/api/settings');
    this.accept(settings);
    if (!settings.libraryConfirmed || settings.scanRequired) {
      this.section = 'sources';
      app.showPage('system-settings-page');
      this.render();
    } else app.enterLibrary();
  },
  accept(settings) {
    this.resetAI();
    this.draft = settings;
    this.draft.diagnostics ??= { debugEnabled: false };
    this.draft.credentials = { ...settings.credentials, aiApiKey: '', bangumiToken: '', clearAiApiKey: false, clearBangumiToken: false };
    this.baseline = JSON.stringify(this.draft);
  },
  settingsDirty() { return !!this.draft && JSON.stringify(this.draft) !== this.baseline; },
  isDirty() { return this.accountDirty || this.settingsDirty() || detailPreferences.isDirty(); },
  async open() {
    this.forcedPassword = false;
    await detailPreferences.load(); detailPreferences.acceptDraft();
    if (app.state.role === 'reader') { this.section = 'display'; this.draft = null; app.showPage('system-settings-page'); this.render(); return; }
    this.section = 'sources';
    this.accept(await this.request('/api/settings'));
    app.showPage('system-settings-page');
    this.render();
  },
  leave() {
    if (this.forcedPassword) return;
    if (this.isDirty() && !confirm('尚有未保存的更改，确定离开吗？')) return;
    this.resetAI();
    this.draft = null;
    detailPreferences.acceptDraft();
    app.enterLibrary();
  },
  note(message, error = false) {
    const el = document.getElementById('system-settings-message');
    el.textContent = message;
    el.classList.toggle('error', error);
    el.hidden = !message;
  },
  updateDirty() {
    document.getElementById('system-settings-content').inert = this.loading;
    document.getElementById('system-settings-dirty').textContent = this.isDirty() ? '有未保存的更改' : '';
    const save = document.getElementById('system-settings-save');
    save.disabled = this.loading || (!this.isDirty() && this.draft?.libraryConfirmed !== false);
    save.hidden = this.forcedPassword || ['account', 'users'].includes(this.section);
    if (this.section === 'display') save.disabled = this.loading || !detailPreferences.supported || !detailPreferences.isDirty();
    save.textContent = this.section === 'display' ? '保存' : '保存更改';
  },
  input(label, field, value, opts = {}) {
    return '<label class="system-field"><span>' + this.esc(label) + '</span><input aria-label="' + this.esc(label) + '" data-field="' + this.esc(field) + '" type="' + (opts.type || 'text') + '" value="' + this.esc(value) + '"' +
      (opts.min ? ' min="' + opts.min + '"' : '') + (opts.max ? ' max="' + opts.max + '"' : '') +
      (opts.placeholder ? ' placeholder="' + this.esc(opts.placeholder) + '"' : '') +
      (opts.type === 'password' ? ' autocomplete="new-password"' : '') + '></label>';
  },
  toggle(label, field, checked, description = '', disabled = false) {
    return '<label class="system-switch-row"><span><span>' + this.esc(label) + '</span>' +
      (description ? '<small>' + this.esc(description) + '</small>' : '') +
      '</span><input class="system-switch" type="checkbox" data-field="' + this.esc(field) + '" aria-label="' + this.esc(label) + '"' + (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '></label>';
  },
  render() {
    this.accountDirty = false;
    const page = document.getElementById('system-settings-page');
    page.classList.toggle('password-required', this.forcedPassword);
    const reload = page.querySelector?.('.settings-reload');
    if (reload) reload.hidden = this.section === 'display' || app.state.role === 'reader';
    document.getElementById('system-settings-back').hidden = this.forcedPassword;
    const nav = document.getElementById('system-settings-nav');
    nav.innerHTML = this.sections.filter(([id]) => app.state.role !== 'reader' || ['account', 'display'].includes(id)).map(([id, label, icon]) =>
      '<button type="button" data-action="section" data-section="' + id + '" class="' + (this.section === id ? 'selected' : '') + '"' +
      (this.section === id ? ' aria-current="page"' : '') + '>' + this.icon(icon) + '<span>' + label + '</span></button>').join('');
    nav.hidden = this.forcedPassword;
    const content = document.getElementById('system-settings-content');
    const renderers = { sources: 'renderSources', categories: 'renderCategories', scanning: 'renderScanning', metadata: 'renderMetadata', cache: 'renderCache', account: 'renderAccount', users: 'renderUsers' };
    content.innerHTML = this.section === 'display' ? detailPreferences.render() : this[renderers[this.section]]();
    this.note('');
    this.updateDirty();
    const prompt = document.getElementById('system-scan-prompt');
    prompt.hidden = this.forcedPassword || !this.draft?.scanRequired;
    if (this.section === 'metadata' && this.aiState === 'idle') this.scheduleAI();
  },
  renderSources() {
    const s = this.draft;
    const e = v => this.esc(v);
    const status = new Map((s.sourceStatus || []).map(x => [x.id, x]));
    const rows = s.sources.map((source, i) => {
      const prefix = 'sources.' + i + '.';
      const unavailable = status.get(source.id)?.available === false;
      const categories = '<option value="auto"' + (source.mode === 'auto' ? ' selected' : '') + '>自动识别（漫画 / 小说）</option>' +
        s.categories.map(c => '<option value="' + e(c.id) + '"' + (source.mode === 'fixed' && source.categoryId === c.id ? ' selected' : '') + '>' + e(c.label) + '</option>').join('');
      return '<details aria-label="' + e(source.name || '新来源') + '" class="system-source' + (!source.enabled ? ' disabled-source' : '') + '"' +
        (!window.matchMedia('(max-width:760px)').matches || i === 0 ? ' open' : '') + '><summary>' + this.icon('folder') + '<span>' + e(source.name || '新来源') + '</span>' +
        (unavailable ? '<small class="source-warning">离线</small>' : '') + '<span class="source-chevron">⌄</span></summary>' +
        '<div class="system-source-fields">' +
        this.toggle('启用', prefix + 'enabled', source.enabled) +
        this.input('来源名称', prefix + 'name', source.name) +
        '<div class="source-path-field' + (unavailable ? ' invalid' : '') + '">' + this.input('容器路径', prefix + 'path', source.path, { placeholder: s.discoveryRoot + '/来源ID' }) +
        (unavailable ? '<small class="source-warning">路径不存在或不可访问</small>' : '') + '</div>' +
        '<label class="system-field"><span>归类方式</span><select aria-label="归类方式" data-field="' + prefix + 'classification">' + categories + '</select></label>' +
        this.toggle('监听', prefix + 'watch', source.watch) + this.toggle('自动刮削', prefix + 'autoScrape', source.autoScrape) +
        '<div class="system-row-actions"><button class="system-text-button" type="button" data-action="source-menu" data-index="' + i + '" aria-label="来源操作 ' + e(source.name) + '">⋮</button></div></div></details>';
    }).join('');
    return '<h2>书库来源</h2><p class="system-intro">管理容器内已挂载的目录，并决定每个来源如何显示和更新。</p>' +
      (!s.libraryConfirmed ? '<div class="system-notice">请确认来源名称与归类方式，保存后点击“立即扫描”建立书库。</div>' : '') +
      '<div class="system-discovery"><span>已配置 ' + s.sources.length + ' 个来源</span><button type="button" class="btn-secondary" data-action="discover">' + this.icon('reload') + '重新检测</button></div>' +
      '<div class="system-source-heading" aria-hidden="true"><span>启用</span><span>来源名称</span><span>容器路径</span><span>归类方式</span><span>监听</span><span>自动刮削</span><span>操作</span></div>' +
      '<div class="system-source-list">' + (rows || '<p class="system-empty">尚未发现来源。将目录挂载到 ' + e(s.discoveryRoot) + ' 下，或手动添加容器路径。</p>') + '</div><dialog id="system-source-menu" class="system-source-menu" aria-label="来源操作"></dialog>' +
      '<button class="btn-secondary system-add" type="button" data-action="add-source">' + this.icon('plus') + '添加路径</button>' +
      '<div class="system-note"><p>路径为容器内路径，需要与 Compose 中的挂载目标一致。</p><p>保存更改无需重启应用。路径与归类变更将在完整扫描后应用到书库。</p><p>关闭自动刮削的来源不会参与批量刮削，仍可在单本详情中重新刮削。移除来源只移除配置，不删除原始资源。</p></div>';
  },
  renderCategories() {
    const s = this.draft;
    return '<h2>栏目管理</h2><p class="system-intro">调整首页标签的名称、顺序与显示状态。</p><div class="system-category-list">' +
      s.categories.map((c, i) => '<div class="system-category">' +
        this.input('栏目名称', 'categories.' + i + '.label', c.label) +
        this.toggle('显示', 'categories.' + i + '.visible', c.visible) +
        '<div class="system-row-actions"><button class="btn-secondary" data-action="category-up" data-index="' + i + '" aria-label="上移 ' + this.esc(c.label) + '"' + (!i ? ' disabled' : '') + '>↑</button>' +
        '<button class="btn-secondary" data-action="category-down" data-index="' + i + '" aria-label="下移 ' + this.esc(c.label) + '"' + (i === s.categories.length - 1 ? ' disabled' : '') + '>↓</button>' +
        (['comic', 'novel', 'other'].includes(c.id) ? '<small>默认栏目</small>' : '<button class="system-text-button danger" data-action="remove-category" data-index="' + i + '">删除</button>') +
        '</div><small class="system-category-sources">' + this.esc(s.sources.filter(source => source.mode === 'fixed' && source.categoryId === c.id).map(source => source.name).join('、') || (['comic', 'novel'].includes(c.id) ? '包含自动识别来源' : '尚未绑定来源')) + '</small></div>').join('') +
      '</div><button type="button" class="btn-secondary system-add" data-action="add-category">' + this.icon('plus') + '添加栏目</button><p class="system-note">默认栏目可改名、排序和隐藏；删除自定义栏目前，请先更改引用它的来源。</p>';
  },
  renderScanning() {
    const s = this.draft.scanning;
    return '<h2>扫描与刮削</h2><p class="system-intro">设置启动时的更新方式，以及 NAS 目录监听。</p>' +
      (this.draft.watcher?.error ? '<div class="system-notice">监听器不可用：' + this.esc(this.draft.watcher.error) + '。请检查挂载权限，仍可手动扫描。</div>' : '') + '<div class="system-form">' +
      this.toggle('启动后扫描书库', 'scanning.onStart', s.onStart, '完成首次改密与来源确认后，在登录时启动。') +
      this.toggle('启动扫描后自动刮削', 'scanning.autoScrapeOnStart', s.autoScrapeOnStart, '只处理开启自动刮削的来源。') +
      this.toggle('使用轮询监听', 'scanning.usePolling', s.usePolling, '默认通过文件变化通知实时监听。仅在 SMB/NFS 等网络目录收不到通知时开启轮询。') +
      this.input('同时刮削作品数（1–8）', 'scanning.scrapeConcurrency', s.scrapeConcurrency ?? 4, { type: 'number', min: 1, max: 8 }) +
      '<div id="system-polling-interval"' + (s.usePolling ? '' : ' hidden') + '>' +
      this.input('轮询间隔（毫秒）', 'scanning.intervalMs', s.intervalMs, { type: 'number', min: 1000, max: 3600000 }) +
      '<p class="system-note">1000 毫秒 = 1 秒，例如 5000 毫秒表示每 5 秒检查一次。</p></div>' +
      '<div class="system-actions"><button type="button" class="btn-secondary" data-action="scan">立即扫描</button><button type="button" class="btn-secondary" data-action="scrape">扫描并刮削</button></div>' +
      '<p class="system-note">监听与自动刮削可在“书库来源”中逐个设置。此处与书库工具栏的批量刮削均只处理开启自动刮削的来源。</p></div>';
  },
  resetAI() {
    clearTimeout(this.aiTimer); this.aiController?.abort(); this.aiSequence++;
    this.aiModels = []; this.aiState = 'idle'; this.aiMessage = '';
  },
  scheduleAI() {
    clearTimeout(this.aiTimer);
    if (!this.draft || this.draft.credentials.clearAiApiKey || !this.draft.metadata.aiBaseUrl ||
        !(this.draft.credentials.aiApiKey?.trim() || this.draft.credentials.aiApiKeyConfigured)) return;
    this.aiTimer = setTimeout(() => this.loadAIModels(), 650);
  },
  async loadAIModels() {
    clearTimeout(this.aiTimer);
    const sequence = ++this.aiSequence, draft = this.draft;
    if (!draft) return;
    this.aiController?.abort(); this.aiController = new AbortController();
    this.aiState = 'loading'; this.aiMessage = '正在获取模型…'; this.refreshAIPickers();
    try {
      const result = await this.request('/api/settings/ai/models', { method: 'POST', signal: this.aiController.signal, body: JSON.stringify({
        baseUrl: draft.metadata.aiBaseUrl, apiKey: draft.credentials.aiApiKey, clearApiKey: draft.credentials.clearAiApiKey,
      }) });
      if (sequence !== this.aiSequence || draft !== this.draft) return;
      this.aiModels = result.models;
      const selected = this.aiModels.find(model => model.id === draft.metadata.aiModel);
      if (!selected) { draft.metadata.aiModel = ''; draft.metadata.aiReasoningEffort = ''; }
      else this.selectAIEffort(selected);
      this.aiState = 'ready'; this.aiMessage = this.aiModels.length ? '已获取 ' + this.aiModels.length + ' 个模型' : '当前密钥没有可用的对话模型';
    } catch (error) {
      if (sequence !== this.aiSequence || draft !== this.draft) return;
      this.aiState = 'error'; this.aiMessage = error.message;
    }
    this.refreshAIPickers(); this.updateDirty();
  },
  selectAIEffort(selected) {
    const previous = this.draft.metadata.aiReasoningEffort;
    const value = ({ minimal: 'low', xhigh: 'high', max: 'high', ultra: 'high' })[previous] || previous;
    this.draft.metadata.aiReasoningEffort = selected.reasoning.options.some(option => option.value === value && !option.disabled) ? value : selected.reasoning.defaultEffort;
  },
  renderAIPickers() {
    const meta = this.draft.metadata;
    const selected = this.aiModels.find(model => model.id === meta.aiModel);
    const modelOptions = '<option value="">请选择模型</option>' + this.aiModels.map(model => '<option value="' + this.esc(model.id) + '"' + (model.id === meta.aiModel ? ' selected' : '') + '>' + this.esc(model.id) + '</option>').join('') +
      (!selected && meta.aiModel ? '<option selected value="' + this.esc(meta.aiModel) + '">' + this.esc(meta.aiModel) + '（待验证）</option>' : '');
    return '<label class="system-field"><span>模型</span><select aria-label="模型" data-field="metadata.aiModel"' + (this.aiState !== 'ready' || !this.aiModels.length ? ' disabled' : '') + '>' + modelOptions + '</select></label><div id="system-ai-reasoning">' + this.renderAIReasoning() + '</div>';
  },
  renderAIReasoning() {
    const meta = this.draft.metadata;
    const selected = this.aiModels.find(model => model.id === meta.aiModel);
    const options = selected?.reasoning.options || [{ value: 'none', label: '无' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }];
    return '<label class="system-field"><span>思考程度</span><select aria-label="思考程度" data-field="metadata.aiReasoningEffort"' + (!selected ? ' disabled' : '') + '>' + options.map(option => '<option value="' + this.esc(option.value) + '"' + (option.value === (meta.aiReasoningEffort || 'none') ? ' selected' : '') + (option.disabled ? ' disabled' : '') + '>' + this.esc(option.label) + '</option>').join('') + '</select></label>' +
      '<p class="system-note" role="status"' + (this.aiState === 'error' ? ' style="color:var(--danger-color, #b42318)"' : '') + '>' + this.esc(this.aiMessage || '请填写接口地址与 API Key') + '</p>';
  },
  refreshAIPickers() {
    const region = document.getElementById('system-ai-pickers');
    if (region && this.draft) region.innerHTML = this.renderAIPickers();
  },
  renderMetadata() {
    const s = this.draft;
    return '<h2>元数据服务</h2><p class="system-intro">配置 Bangumi 与 OpenAI 兼容服务，丰富作品信息与中文展示。</p><div class="system-form">' +
      '<h3>OpenAI 兼容服务</h3>' +
      this.input('接口地址', 'metadata.aiBaseUrl', s.metadata.aiBaseUrl, { type: 'url', placeholder: 'https://api.openai.com/v1' }) +
      this.input('API Key', 'credentials.aiApiKey', s.credentials.aiApiKey, { type: 'password', placeholder: s.credentials.aiApiKeyConfigured ? '•••••••• 已配置，留空保持不变' : '未配置' }) +
      this.toggle('清除已保存的 API Key', 'credentials.clearAiApiKey', s.credentials.clearAiApiKey) +
      '<div id="system-ai-pickers">' + this.renderAIPickers() + '</div>' +
      '<div class="system-actions"><button class="btn-secondary" type="button" data-action="refresh-ai">重新获取模型</button><button class="btn-secondary" type="button" data-action="test-ai">测试模型调用</button></div>' +
      '<p class="system-note">填写地址和密钥后自动获取模型。选择模型后自动更新思考程度；更换地址需重新输入密钥。测试模型调用会发送一条简短请求。</p>' +
      this.input('AI 请求并发数（1–12）', 'metadata.aiConcurrency', s.metadata.aiConcurrency ?? 4, { type: 'number', min: 1, max: 12 }) +
      '<p class="system-note">普通、联网及连接测试共用此上限，相邻请求至少间隔 3 秒。等待发送不占并发名额；完全相同的并发请求会合并。</p>' +
      this.toggle('AI 联网刮削', 'metadata.aiWebSearchEnabled', s.metadata.aiWebSearchEnabled ?? true) +
      '<p class="system-note">扫描始终使用本地名称和目录结构。开启后，AI 通过一次联网请求识别主作品，再从 Bangumi 获取详情、人物、关联和卷册；识别失败时使用传统候选匹配。关闭后直接使用传统匹配。书名、人名和简介需要翻译时均使用普通 AI 请求。</p>' +
      '<p class="system-note">切换模式会保留已有结果，包括部分结果和本地回退；新增或变化的卷册仅补充对应资源。只有显式强制重刮才完整替换，失败时保留旧结果。无已有结果且两种识别方式都失败时，使用本地资料回退。保存后对之后启动的任务生效，正在运行的任务保持原模式与 AI 配置。</p>' +
      '<button class="btn-secondary" type="button" data-action="test-ai-search">测试联网搜索</button>' +
      '<p class="system-note">测试会实际联网搜索并核对来源，可能需要两分钟并产生 API 与搜索费用。</p>' +
      '<div id="system-traditional-matching">' + this.renderTraditionalMatching() + '</div>' +
      this.toggle('AI 本地作品智能分组', 'metadata.localGroupEnabled', s.metadata.localGroupEnabled) +
      '<p class="system-note">本地资源智能分组独立生效，不受联网刮削开关影响。</p>' +
      '<h3>Bangumi</h3>' +
      this.input('Access Token（可选）', 'credentials.bangumiToken', s.credentials.bangumiToken, { type: 'password', placeholder: s.credentials.bangumiTokenConfigured ? '•••••••• 已配置，留空保持不变' : '未配置，使用公开接口' }) +
      this.toggle('清除已保存的 Token', 'credentials.clearBangumiToken', s.credentials.clearBangumiToken) +
      '<button class="btn-secondary" type="button" data-action="test-bangumi">测试 Bangumi 连接</button>' +
      '<p class="system-note">密钥保存在数据目录，设置页不会回显。获取模型不执行刮削；测试模型调用可能产生少量 API 费用。</p>' +
      '<h3>调试与诊断</h3>' + this.toggle('调试模式', 'diagnostics.debugEnabled', s.diagnostics?.debugEnabled ?? false) +
      '<p class="system-note">默认关闭，保存后立即生效。将详细设置、AI 请求与响应、搜索事件、耗时及错误堆栈输出到服务器日志（Docker 容器日志）。密钥、密码和 Token 自动脱敏；日志可能包含书名、提示词及模型回答，过长内容会截断。排查结束后请关闭。</p></div>';
  },
  renderTraditionalMatching() {
    const m = this.draft.metadata;
    const note = '用于传统候选匹配及共享卷册流程，两种模式均可使用。';
    return this.toggle('作品匹配', 'metadata.matchEnabled', m.matchEnabled, note) +
      this.toggle('卷册匹配', 'metadata.volumeMatchEnabled', m.volumeMatchEnabled, note);
  },
  renderCache() {
    const c = this.draft.cache;
    return '<h2>缓存与性能</h2><p class="system-intro">控制阅读缓存占用。清理缓存不会删除原始资源或阅读进度。</p><div class="system-form">' +
      this.input('阅读缓存容量上限（MB，默认 150，上限 4096）', 'cache.maxSizeMb', c.maxSizeMb, { type: 'number', min: 64, max: 4096 }) +
      this.input('最多缓存资源数', 'cache.maxResources', c.maxResources, { type: 'number', min: 1, max: 100000 }) +
      this.input('缓存保留时间（分钟）', 'cache.ttlMinutes', c.ttlMinutes, { type: 'number', min: 1, max: 525600 }) +
      '<button class="btn-secondary" data-action="clear-cache" type="button">清理未使用的缓存</button><p class="system-note">近期活跃阅读资源会继续保留，以免打断阅读。</p></div>';
  },
  renderUsers() {
    const fields = user => '<form class="readdeck-user-form system-form" data-user="' + this.esc(user?.id || '') + '">' +
      '<label class="system-field"><span>用户名</span><input name="username" required value="' + this.esc(user?.username || '') + '"' + (user?.id === 'admin' ? ' disabled' : '') + '></label>' +
      '<label class="system-field"><span>密码</span><input name="password" type="password" minlength="8" placeholder="' + (user ? '留空保留原密码' : '至少 8 位，首次登录需修改') + '"' + (user?.id === 'admin' ? ' disabled' : '') + '></label>' +
      '<label class="system-field"><span>角色</span><select name="role"' + (user?.id === 'admin' ? ' disabled' : '') + '><option value="reader"' + (user?.role === 'reader' ? ' selected' : '') + '>读者</option><option value="admin"' + (user?.role === 'admin' ? ' selected' : '') + '>管理员</option></select></label>' +
      '<label><input name="enabled" type="checkbox"' + (user?.enabled !== false ? ' checked' : '') + '>启用账号</label>' +
      '<fieldset><legend>允许访问的来源（管理员可访问全部）</legend>' + this.draft.sources.map(source => '<label><input type="checkbox" name="sourceIds" value="' + this.esc(source.id) + '"' + (user?.sourceIds?.includes(source.id) ? ' checked' : '') + '>' + this.esc(source.name) + '</label>').join('') + '</fieldset>' +
      '<button class="btn-primary" type="submit">' + (user ? '保存用户' : '创建用户') + '</button></form>';
    return '<h2>用户管理</h2><p class="system-intro">阅读进度按用户保存。新来源需要明确授权。</p>' + (this.users || []).map(user => '<details class="system-source readdeck-user"><summary>' + this.esc(user.username) + '</summary>' + fields(user) + '</details>').join('') + '<details class="system-source readdeck-user"><summary>添加用户</summary>' + fields(null) + '</details>';
  },
  renderAccount() {
    return '<h2>账户与安全</h2><p class="system-intro">' + (this.forcedPassword ? '首次登录请先修改默认密码，之后即可配置书库。' : '修改账号后，其他设备需要重新登录。') +
      '</p><form id="system-account-form" class="system-form"><label class="system-field"><span>用户名</span><input name="username" required maxlength="64" autocomplete="username" value="' + this.esc(app.state.username || this.draft?.account?.username || 'admin') + '"></label>' +
      '<label class="system-field"><span>当前密码</span><input name="currentPassword" type="password" required autocomplete="current-password"></label>' +
      '<label class="system-field"><span>新密码</span><input name="password" type="password" required minlength="8" maxlength="1024" autocomplete="new-password" placeholder="至少 8 个字符"></label>' +
      '<label class="system-field"><span>确认新密码</span><input name="confirmation" type="password" required minlength="8" autocomplete="new-password"></label>' +
      '<button class="btn-primary" type="submit">保存账号与密码</button></form>';
  },
  editField(element) {
    if (!this.draft || element.disabled) return;
    const segments = element.dataset.field.split('.');
    const key = segments.pop();
    const target = segments.reduce((value, segment) => value[segment], this.draft);
    const value = element.type === 'checkbox' ? element.checked : element.type === 'number' ? Number(element.value) : element.value;
    if (key === 'classification') {
      target.mode = value === 'auto' ? 'auto' : 'fixed';
      target.categoryId = value === 'auto' ? '' : value;
    } else target[key] = value;
    if (element.dataset.field === 'metadata.aiWebSearchEnabled') {
      const matching = document.getElementById('system-traditional-matching');
      if (matching) matching.innerHTML = this.renderTraditionalMatching();
    }
    const details = element.closest('.system-source');
    if (key === 'name' && details) details.querySelector('summary span').textContent = value || '新来源';
    if (key === 'enabled' && details) details.classList.toggle('disabled-source', !value);
    if (element.dataset.field === 'scanning.usePolling') {
      const interval = document.getElementById('system-polling-interval');
      if (interval) interval.hidden = !value;
    }
    if (['metadata.aiBaseUrl', 'credentials.aiApiKey', 'credentials.clearAiApiKey'].includes(element.dataset.field)) {
      this.draft.metadata.aiModel = ''; this.draft.metadata.aiReasoningEffort = '';
      this.resetAI(); this.scheduleAI(); this.refreshAIPickers();
    } else if (element.dataset.field === 'metadata.aiModel') {
      this.draft.metadata.aiReasoningEffort = '';
      const selected = this.aiModels.find(model => model.id === value);
      if (selected) this.selectAIEffort(selected);
      document.getElementById('system-ai-reasoning').innerHTML = this.renderAIReasoning();
    }
    this.updateDirty();
  },
  async save() {
    if (this.section === 'display') return detailPreferences.save();
    if (this.loading) return;
    this.loading = true;
    this.updateDirty();
    try {
      this.accept(await this.request('/api/settings', { method: 'PUT', body: JSON.stringify(this.draft) }));
      this.render();
      this.note('设置已保存' + (this.draft.scanRequired ? '，请点击“立即扫描”更新书库。' : '，已应用。'));
      app.loadCategories();
    } catch (error) { this.note(error.message, true); }
    finally { this.loading = false; this.updateDirty(); }
  },
  async action(button) {
    const action = button.dataset.action;
    const index = Number(button.dataset.index);
    const s = this.draft;
    if (action === 'section') {
      if (this.accountDirty && !confirm('账号表单尚未保存，确定切换页面吗？')) return;
      this.section = button.dataset.section;
      if (this.section === 'users') this.users = await this.request('/api/users');
      this.render();
      document.querySelector('#system-settings-nav button.selected')?.focus();
      return;
    }
    if (action === 'source-menu') {
      const dialog = document.getElementById('system-source-menu');
      dialog.innerHTML = '<h3>' + this.esc(s.sources[index].name) + '</h3>' +
        ['source-up', 'source-down', 'remove-source'].map((id, position) => '<button type="button" class="btn-secondary" data-action="' + id + '" data-index="' + index + '"' +
          ((position === 0 && index === 0) || (position === 1 && index === s.sources.length - 1) ? ' disabled' : '') + '>' + ['上移来源', '下移来源', '移除来源配置'][position] + '</button>').join('') +
        '<button type="button" class="btn-secondary" data-action="close-source-menu">取消</button>';
      dialog.showModal(); return;
    }
    if (action === 'close-source-menu') { document.getElementById('system-source-menu').close(); return; }
    if (action === 'save') return this.save();
    if (action === 'leave') return this.leave();
    if (action === 'add-source') {
      s.sources.push({ id: this.id('source'), name: '', path: '', enabled: true, order: s.sources.length, mode: 'auto', categoryId: '', watch: true, autoScrape: true });
      this.render();
      document.querySelector('.system-source:last-child input[data-field$=".name"]')?.focus();
      return;
    }
    if (action === 'source-up' || action === 'source-down') {
      const target = index + (action === 'source-up' ? -1 : 1);
      [s.sources[index], s.sources[target]] = [s.sources[target], s.sources[index]];
      this.render();
      document.querySelector('[data-action="source-menu"][data-index="' + target + '"]')?.focus();
      return;
    }
    if (action === 'remove-source') {
      if (!confirm('移除“' + s.sources[index].name + '”的配置？原始文件不会删除。')) return;
      s.sources.splice(index, 1);
    } else if (action === 'discover') {
      const result = await this.request('/api/settings/discovered-sources');
      const found = result.sources.filter(source => !s.sources.some(existing => existing.path === source.path));
      s.sources.push(...found);
      this.render();
      this.note(found.length ? '已添加 ' + found.length + ' 个新来源，请确认后保存。' : '没有发现新的来源目录。');
      return;
    } else if (action === 'add-category') {
      s.categories.push({ id: this.id('category'), label: '新栏目', visible: true, order: s.categories.length });
    } else if (action === 'remove-category') {
      if (s.sources.some(source => source.mode === 'fixed' && source.categoryId === s.categories[index].id)) throw new Error('请先在书库来源中解除对此栏目的引用');
      s.categories.splice(index, 1);
    } else if (action === 'category-up' || action === 'category-down') {
      const target = index + (action === 'category-up' ? -1 : 1);
      [s.categories[index], s.categories[target]] = [s.categories[target], s.categories[index]];
    } else if (action === 'scan' || action === 'scrape') {
      if (this.isDirty() || !s.libraryConfirmed) throw new Error('请先保存设置，再启动扫描');
      const task = await this.request('/api/tasks/scan', { method: 'POST', body: JSON.stringify({ scrape: action === 'scrape' }) });
      this.note('已启动' + (action === 'scrape' ? '扫描与刮削' : '完整扫描') + '，任务 #' + task.id + '。完成后可返回书库。');
      app.startTaskPolling({ idleLimit: 24, activeOnly: true });
      app.connectRealtimeEvents();
      return;
    } else if (action === 'clear-cache') {
      if (!confirm('清理未使用的阅读缓存？原始资源和阅读进度会保留。')) return;
      const result = await this.request('/api/settings/cache/clear', { method: 'POST', body: '{}' });
      this.note(result.message);
      return;
    } else if (action === 'refresh-ai') {
      this.resetAI(); return this.loadAIModels();
    } else if (action.startsWith('test-')) {
      const provider = action.slice(5);
      const identity = JSON.stringify([s.metadata, s.credentials]);
      if (provider === 'ai-search') this.note('正在执行联网搜索并核对来源，请稍候…');
      const result = await this.request('/api/settings/test/' + provider, {
        method: 'POST', body: JSON.stringify({
          apiKey: provider.startsWith('ai') ? s.credentials.aiApiKey : s.credentials.bangumiToken,
          clearApiKey: s.credentials.clearAiApiKey, baseUrl: s.metadata.aiBaseUrl,
          model: s.metadata.aiModel, effort: s.metadata.aiReasoningEffort,
        }),
      });
      if (this.draft !== s || identity !== JSON.stringify([s.metadata, s.credentials])) return;
      this.note(result.message);
      return;
    } else if (action === 'reload') {
      if (this.isDirty() && !confirm('重新载入会丢弃未保存的更改，是否继续？')) return;
      this.accept(await this.request('/api/settings'));
    }
    this.render();
  },
  async accountSubmit(form) {
    if (this.settingsDirty() && !confirm('更新账号会重新载入设置并丢弃其他未保存的更改，是否继续？')) return;
    const data = Object.fromEntries(new FormData(form));
    if (data.password !== data.confirmation) throw new Error('两次输入的新密码不一致');
    app.disconnectRealtimeEvents();
    app.stopTaskPolling();
    let result;
    try { result = await this.request('/api/account', { method: 'PUT', body: JSON.stringify(data) }); }
    catch (error) { if (!this.forcedPassword) app.connectRealtimeEvents(); throw error; }
    app.state.token = result.token;
    localStorage.setItem('token', result.token);
    app.disconnectRealtimeEvents();
    app.state.username = result.username;
    this.forcedPassword = false;
    if (app.state.role === 'reader') { await this.afterLogin(result); return; }
    this.accept(await this.request('/api/settings'));
    this.section = this.draft.libraryConfirmed ? 'account' : 'sources';
    app.showPage('system-settings-page');
    this.render();
    this.note('账号已更新。其他设备需要重新登录。');
    if (this.draft.libraryConfirmed) app.connectRealtimeEvents();
  },
  async changed() {
    if (app.state.role === 'reader') { await app.loadCategories(); return; }
    await app.loadCategories();
    if (document.getElementById('comic-detail-page')?.classList.contains('active') && app.state.currentComic?.comic?.id) {
      await app.showComicDetail(app.state.currentComic.comic.id, { skipPreferredVersion: true });
    }
    if (document.getElementById('system-settings-page')?.classList.contains('active') && !this.isDirty() && !this.loading && !this.forcedPassword && this.section !== 'account') {
      const draft = this.draft;
      const latest = await this.request('/api/settings');
      // A user may start typing while the SSE refresh request is in flight.
      if (this.draft !== draft || this.isDirty() || this.loading || this.section === 'account') return;
      if (latest.revision === draft?.revision && JSON.stringify(latest.sourceStatus) === JSON.stringify(draft.sourceStatus) &&
          JSON.stringify(latest.watcher) === JSON.stringify(draft.watcher)) return;
      this.accept(latest);
      this.render();
    }
  },
  bind() {
    const page = document.getElementById('system-settings-page');
    window.matchMedia('(max-width:760px)').addEventListener('change', event => {
      page.querySelectorAll('.system-source').forEach((source, index) => { source.open = !event.matches || index === 0; });
    });
    page.addEventListener('input', event => {
      if (event.target.dataset.field) this.editField(event.target);
      else if (event.target.closest('#system-account-form')) { this.accountDirty = true; this.updateDirty(); }
    });
    page.addEventListener('click', async event => {
      const button = event.target.closest('button[data-action]');
      if (!button || button.disabled) return;
      button.disabled = true;
      try { await this.action(button); } catch (error) { this.note(error.message, true); }
      finally { button.disabled = false; this.updateDirty(); }
    });
    page.addEventListener('submit', async event => {
      if (event.target.matches('.readdeck-user-form')) {
        event.preventDefault(); const form = event.target; const button = form.querySelector('button'); button.disabled = true;
        try {
          const values = new FormData(form); const id = form.dataset.user;
          const body = { role: values.get('role'), enabled: values.has('enabled'), sourceIds: values.getAll('sourceIds') };
          if (id !== 'admin') body.username = values.get('username');
          if (values.get('password')) body.password = values.get('password');
          await this.request('/api/users' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
          this.users = await this.request('/api/users'); this.render(); this.note('用户已保存');
        } catch (error) { this.note(error.message, true); } finally { button.disabled = false; }
        return;
      }
      if (event.target.id !== 'system-account-form') return;
      event.preventDefault();
      const button = event.target.querySelector('button');
      button.disabled = true;
      try { await this.accountSubmit(event.target); } catch (error) { this.note(error.message, true); }
      finally { button.disabled = false; }
    });
    window.addEventListener('beforeunload', event => {
      if (page.classList.contains('active') && this.isDirty()) { event.preventDefault(); event.returnValue = ''; }
    });
  },
};
