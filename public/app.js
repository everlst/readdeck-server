const app = {
    state: {
        comics: [],
        currentComic: null,
        currentGroup: 'default',
        detailExpanded: {},
        chapterExpanded: {},
        currentChapter: null,
        currentImages: [],
        currentPage: 0,
        readingDirection: 'rtl',
        doublePageMode: false,
        doublePageOffset: 0,
        uiVisible: false,
        confirmCallback: null,
        allChapters: [],
        currentChapterIndex: -1,
        token: null,
        progressCache: {},  // comicId -> progress data
        searchVisible: false,
        searchQuery: '',
        searchResults: null,  // null = not searching, [] = no results
        searchTimer: null,
        stripMode: false,
        sortBy: 'lastRead',
        sortOrder: 'desc',
        sortMenuVisible: false,
        libraryViewMode: 'grid',
        libraryCategory: 'comic',
        libraryCategories: [
            { key: 'comic', label: '漫画' },
            { key: 'novel', label: '小说' },
            { key: 'other', label: '其他' }
        ],
        categoryTabsExpanded: false,
        _preSortBy: null,     // backup before search switches to _score
        _preSortOrder: null,
        lastComicsLoadTime: 0,  // 上次加载漫画列表的时间戳
        tags: [],
        selectedTags: [],
        tagFilterExpanded: false,
        taskPollTimer: null,
        currentVolume: null,   // volume detail page state
        volumeReturnScrollTop: 0,
        novelMode: false,
        novelFont: 'kai',
        novelFontSize: 20,
        novelReadingMode: 'paged',
        novelPage: 0,
        novelPageCount: 1,
        novelPageStep: 0,
        currentNovel: null,
        lastTaskProgressMark: '',
        taskPollIdleCount: 0,
        taskPollGeneration: 0,
        scanSnapshotCommittedTaskId: 0,
        realtimeSource: null,
        realtimeConnected: false,
        realtimeLibraryTimer: null,
        realtimeDetailTimer: null,
        realtimeRefreshInFlight: false,
        realtimeRefreshPending: false,
        realtimeStatusHideTimer: null,
        comicsRefreshSequence: 0,
        comicsAppliedSequence: 0,
        searchRefreshSequence: 0,
        searchAppliedSequence: 0,
        listNeedsRender: false,
        coverCacheBust: {},
        imageZoomScale: 1,
        imageZoomX: 0,
        imageZoomY: 0,
    },

    // ─── Auth helpers ───
    getHeaders() {
        const h = { 'Content-Type': 'application/json' };
        if (this.state.token) h['Authorization'] = `Bearer ${this.state.token}`;
        return h;
    },

    authFetch(url, opts = {}) {
        const requestToken = this.state.token;
        let pendingKey, pendingId;
        if (url.startsWith('/api/progress/') && opts.method === 'PUT') {
            const body = JSON.parse(opts.body);
            if (!body.readAt) {
                const sequence = Math.max(Date.now(), Number(localStorage.getItem('readdeck-sequence') || 0) + 1);
                localStorage.setItem('readdeck-sequence', String(sequence));
                Object.assign(body, { readAt: new Date(Date.now() + (this.serverOffset || 0)).toISOString(), deviceId: this.deviceId, sequence });
            }
            opts.body = JSON.stringify(body);
            pendingKey = 'readdeck-progress-' + this.state.userId;
            pendingId = url + ':' + body.chapterUuid;
            const pending = JSON.parse(localStorage.getItem(pendingKey) || '{}');
            pending[pendingId] = { url, body }; localStorage.setItem(pendingKey, JSON.stringify(pending));
        }
        opts.headers = { ...this.getHeaders(), ...(opts.headers || {}) };
        // 对于 FormData 不要设置 Content-Type
        if (opts.body instanceof FormData) delete opts.headers['Content-Type'];
        return fetch(url, opts).then(res => {
            if (res.status === 401) {
                if (this.state.token === requestToken) {
                    this.disconnectRealtimeEvents();
                    this.state.token = null;
                    localStorage.removeItem('token');
                    this.showPage('login-page');
                }
                throw new Error('Unauthorized');
            }
            if (pendingKey && res.ok) {
                const pending = JSON.parse(localStorage.getItem(pendingKey) || '{}');
                if (JSON.stringify(pending[pendingId]?.body) === opts.body) delete pending[pendingId];
                localStorage.setItem(pendingKey, JSON.stringify(pending));
            }
            return res;
        });
    },

    withAssetToken(url) {
        if (!url) return '';
        if (!this.state.token) return url;

        try {
            const parsed = new URL(url, window.location.origin);
            const isLocalApiAsset =
                parsed.origin === window.location.origin &&
                parsed.pathname.startsWith('/api/');
            if (!isLocalApiAsset) return url;

            parsed.searchParams.set('token', this.state.token);
            const customCoverMatch = parsed.pathname.match(/^\/api\/series\/([^/]+)\/custom-cover$/);
            if (customCoverMatch) {
                const seriesId = decodeURIComponent(customCoverMatch[1]);
                const version = this.state.coverCacheBust?.[seriesId];
                if (version) parsed.searchParams.set('_cover', version);
            }
            return `${parsed.pathname}${parsed.search}${parsed.hash}`;
        } catch (e) {
            return url;
        }
    },

    withNoCache(url) {
        const sep = String(url).includes('?') ? '&' : '?';
        return `${url}${sep}_=${Date.now()}`;
    },

    disconnectRealtimeEvents() {
        if (this.state.realtimeSource) this.state.realtimeSource.close();
        this.state.realtimeSource = null;
        this.state.realtimeConnected = false;
        if (this.state.realtimeLibraryTimer) clearTimeout(this.state.realtimeLibraryTimer);
        if (this.state.realtimeDetailTimer) clearTimeout(this.state.realtimeDetailTimer);
        if (this.state.realtimeStatusHideTimer) clearTimeout(this.state.realtimeStatusHideTimer);
        this.state.realtimeLibraryTimer = null;
        this.state.realtimeDetailTimer = null;
        this.state.realtimeStatusHideTimer = null;
        this.state.realtimeRefreshPending = false;
    },

    stopTaskPolling() {
        if (this.state.taskPollTimer) clearInterval(this.state.taskPollTimer);
        this.state.taskPollTimer = null;
        this.state.taskPollGeneration += 1;
    },

    connectRealtimeEvents() {
        this.disconnectRealtimeEvents();
        if (!this.state.token || typeof EventSource === 'undefined') return false;

        const source = new EventSource(`/api/events?token=${encodeURIComponent(this.state.token)}`);
        this.state.realtimeSource = source;
        source.addEventListener('settings_changed', () => {
            systemSettings.changed().catch(error => console.warn(error.message));
        });
        source.addEventListener('open', () => {
            if (this.state.realtimeSource !== source) return;
            this.state.realtimeConnected = true;
            this.stopTaskPolling();
            if (typeof detailPreferences !== 'undefined') detailPreferences.load();
        });
        source.addEventListener('preferences_changed', () => { if (typeof detailPreferences !== 'undefined') detailPreferences.load(); });
        source.addEventListener('ready', event => {
            if (this.state.realtimeSource !== source) return;
            const data = this.parseRealtimeEvent(event);
            if (data?.tasks) this.applyRealtimeTaskSnapshot(data.tasks, { activeOnly: true });
        });
        source.addEventListener('library_changed', event => {
            if (this.state.realtimeSource !== source) return;
            this.handleRealtimeLibraryEvent(this.parseRealtimeEvent(event));
        });
        source.addEventListener('tasks_changed', event => {
            if (this.state.realtimeSource !== source) return;
            const data = this.parseRealtimeEvent(event);
            if (data?.tasks) this.applyRealtimeTaskSnapshot(data.tasks);
        });
        source.addEventListener('error', () => {
            if (this.state.realtimeSource !== source) return;
            this.state.realtimeConnected = false;
            if (this.state.token && !this.state.taskPollTimer) {
                this.startTaskPolling({ idleLimit: 24, activeOnly: true });
            }
        });
        return true;
    },

    parseRealtimeEvent(event) {
        try {
            return JSON.parse(event?.data || '{}');
        } catch (error) {
            console.warn('Failed to parse realtime event:', error);
            return null;
        }
    },

    handleRealtimeLibraryEvent(event) {
        if (!event) return;
        if (event.reason === 'derived_indexes_written') {
            this.scheduleRealtimeLibraryRefresh();
        }
        const seriesId = event.payload?.seriesId;
        if (!seriesId || this.state.currentComic?.comic?.id !== seriesId) return;
        const detailActive = document.getElementById('comic-detail-page')?.classList.contains('active');
        if (!detailActive) return;
        if (this.state.realtimeDetailTimer) clearTimeout(this.state.realtimeDetailTimer);
        this.state.realtimeDetailTimer = setTimeout(() => {
            this.state.realtimeDetailTimer = null;
            this.showComicDetail(seriesId, { skipPreferredVersion: true });
        }, 250);
    },

    scheduleRealtimeLibraryRefresh() {
        this.state.realtimeRefreshPending = true;
        if (this.state.realtimeLibraryTimer || this.state.realtimeRefreshInFlight) return;
        this.state.realtimeLibraryTimer = setTimeout(async () => {
            this.state.realtimeLibraryTimer = null;
            if (!this.state.realtimeRefreshPending || !this.state.token) return;
            this.state.realtimeRefreshPending = false;
            this.state.realtimeRefreshInFlight = true;
            try {
                const refreshed = await this.refreshComicsIncremental({ authoritative: true });
                if (refreshed.success && refreshed.applied) await this.loadTags();
            } finally {
                this.state.realtimeRefreshInFlight = false;
                if (this.state.realtimeRefreshPending) this.scheduleRealtimeLibraryRefresh();
            }
        }, 250);
    },

    taskName(type) {
        switch (type) {
            case 'scanLibrary': return '扫描书库';
            case 'scrapeSeries': return '刮削作品信息';
            case 'scanAndScrape': return '扫描并刮削书库';
            case 'updateArchive': return '更新元数据档案';
            default: return '后台任务';
        }
    },

    taskStatus(status) {
        switch (status) {
            case 'queued': return '等待中';
            case 'running': return '进行中';
            case 'success': return '已完成';
            case 'failed': return '失败';
            case 'cancelled': case 'canceled': return '已取消';
            default: return '未知状态';
        }
    },

    taskSummary(task) {
        return `${this.taskName(task.type)}：${this.taskStatus(task.status)}${task.error ? ' · ' + task.error : ''}`;
    },

    applyRealtimeTaskSnapshot(tasks, options = {}) {
        const latest = options.activeOnly
            ? (tasks || []).find(task => task.status === 'running' || task.status === 'queued')
            : this.pickObservedTask(tasks);
        if (!latest) return;
        const status = document.getElementById('task-status');
        if (!status) return;
        if (this.state.realtimeStatusHideTimer) clearTimeout(this.state.realtimeStatusHideTimer);
        status.style.display = 'flex';

        if (latest.status === 'running' || latest.status === 'queued') {
            if (latest.type === 'scanAndScrape' && latest.progress) {
                const p = latest.progress;
                const scanText = p.scanDone ? '扫描完成' : `扫描中，已发现 ${p.discovered}`;
                const volumeText = p.volumeOnlyTotal ? ` · 新增卷 ${p.volumeOnlyTotal}` : '';
                status.textContent = `${scanText}；刮削 ${p.completed}/${p.total}（成功 ${p.success} · 失败 ${p.failed}${volumeText}）`;
            } else {
                status.textContent = this.taskSummary(latest);
            }
            return;
        }

        if (latest.type === 'scanAndScrape' && latest.progress) {
            const p = latest.progress;
            const volumeText = p.volumeOnlyTotal ? ` · 新增卷 ${p.volumeOnlyTotal}` : '';
            status.textContent = latest.status === 'success'
                ? `批量刮削：完成 ${p.completed}/${p.total}（成功 ${p.success} · 失败 ${p.failed}${volumeText}）`
                : `批量刮削：失败 ${p.completed}/${p.total}（成功 ${p.success} · 失败 ${p.failed}${volumeText}） ${latest.error || ''}`;
        } else {
            status.textContent = this.taskSummary(latest);
        }
        this.scheduleRealtimeLibraryRefresh();
        this.state.realtimeStatusHideTimer = setTimeout(() => {
            status.style.display = 'none';
            this.state.realtimeStatusHideTimer = null;
        }, 3500);
    },

    async init() {
        systemSettings.bind();
        detailPreferences.bind();
        this.deviceId = localStorage.getItem('readdeck-device') || systemSettings.id('web');
        localStorage.setItem('readdeck-device', this.deviceId);
        window.addEventListener('online', () => this.flushPendingProgress());
        this.loadSettings();
        this.bindEvents();
        this._setupViewportHeight();
        this.updateLibraryViewUI();

        // 尝试自动登录
        const saved = localStorage.getItem('token');
        if (saved) {
            try {
                const res = await fetch('/api/verify', {
                    headers: { 'Authorization': `Bearer ${saved}` }
                });
                if (res.ok) {
                    const account = await res.json();
                    this.state.token = saved;
                    await systemSettings.afterLogin(account);
                    return;
                }
            } catch (e) {}
        }
        this.showPage('login-page');
    },

    // ─── Login / Logout ───
    async login() {
        const user = document.getElementById('login-user').value.trim();
        const pass = document.getElementById('login-pass').value;
        const errEl = document.getElementById('login-error');
        errEl.textContent = '';

        if (!user || !pass) { errEl.textContent = '请填写用户名和密码'; return; }

        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: user, password: pass })
            });
            const data = await res.json();
            if (!res.ok) { errEl.textContent = data.error || '登录失败'; return; }

            this.state.token = data.token;
            localStorage.setItem('token', data.token);
            await systemSettings.afterLogin(data);
        } catch (e) {
            errEl.textContent = '网络错误';
        }
    },

    async flushPendingProgress() {
        if (!this.state.token || !this.state.userId) return;
        const pending = JSON.parse(localStorage.getItem('readdeck-progress-' + this.state.userId) || '{}');
        for (const item of Object.values(pending)) {
            try { await this.authFetch(item.url, { method: 'PUT', body: JSON.stringify(item.body) }); } catch { break; }
        }
    },
    enterLibrary() {
        this.flushPendingProgress();
        // 登录成功后先进入主页，避免被初次扫描/刮削阻塞。
        this.showPage('comic-list-page');
        this.startTaskPolling({ idleLimit: 24, activeOnly: true });
        this.connectRealtimeEvents();
        this.loadCategories();
        this.loadComics();
        this.loadTags();
    },

    logout() {
        if (this._progressTimer) clearTimeout(this._progressTimer);
        this._exitNovelMode();
        this.state.progressCache = {}; this.state.comics = []; this.state.currentComic = null;
        this.disconnectRealtimeEvents();
        this.stopTaskPolling();
        this.state.token = null;
        localStorage.removeItem('token');
        this.showPage('login-page');
    },

    // ─── Viewport Height Fix (iPadOS / iOS Safari) ───
    _setupViewportHeight() {
        const setVH = () => {
            const viewport = window.visualViewport;
            const visualHeight = viewport?.height;
            const vh = Number.isFinite(visualHeight) && visualHeight > 0
                ? visualHeight
                : window.innerHeight;
            const layoutHeight = Math.max(
                Number(window.innerHeight || 0),
                Number(document.documentElement?.clientHeight || 0)
            );
            const viewportTop = Number(viewport?.offsetTop || 0);
            const bottomObstruction = viewport
                ? Math.max(0, layoutHeight - vh - viewportTop)
                : 0;
            const rootStyle = document.documentElement.style;
            rootStyle.setProperty('--app-height', `${Math.round(vh)}px`);
            rootStyle.setProperty('--visual-viewport-bottom', `${Math.round(bottomObstruction)}px`);
        };
        setVH();
        window.addEventListener('resize', setVH);
        // iPadOS Safari 中方向切换 / 键盘弹出时也需要更新
        window.addEventListener('orientationchange', () => {
            setTimeout(setVH, 100);
        });
        // visualViewport API 更精确地追踪实际视口变化
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', setVH);
            window.visualViewport.addEventListener('scroll', setVH);
        }
    },

    // ─── Settings ───
    loadSettings() {
        try {
            const s = JSON.parse(localStorage.getItem('readerSettings'));
            if (s) {
                this.state.readingDirection = s.readingDirection || 'rtl';
                this.state.doublePageMode = !!s.doublePageMode;
                this.state.doublePageOffset = s.doublePageOffset || 0;
                this.state.novelFont = s.novelFont || 'kai';
                this.state.novelFontSize = Number(s.novelFontSize || 20);
                this.state.novelReadingMode = 'paged';
            }
        } catch (e) {}
        try {
            const category = localStorage.getItem('libraryCategory');
            if (this.isSafeCategoryKey(category)) this.state.libraryCategory = category;
        } catch (e) {}
        // 加载排序偏好
        try {
            const sp = JSON.parse(localStorage.getItem('comicSortPref'));
            if (sp) {
                this.state.sortBy = sp.sortBy || 'lastRead';
                this.state.sortOrder = sp.sortOrder || 'desc';
                if (this.state.sortBy === 'lastRead') this.state.sortOrder = 'desc';
            }
        } catch (e) {}
        try {
            const viewMode = localStorage.getItem('libraryViewMode');
            this.state.libraryViewMode = this.normalizeLibraryViewMode(viewMode);
        } catch (e) {
            this.state.libraryViewMode = 'grid';
        }
    },

    saveSettings() {
        localStorage.setItem('readerSettings', JSON.stringify({
            readingDirection: this.state.readingDirection,
            doublePageMode: this.state.doublePageMode,
            doublePageOffset: this.state.doublePageOffset,
            novelFont: this.state.novelFont,
            novelFontSize: this.state.novelFontSize,
            novelReadingMode: this.state.novelReadingMode
        }));
    },

    // ─── 条漫模式：按漫画独立存储 ───
    loadStripModeForComic(comicId) {
        try {
            const map = JSON.parse(localStorage.getItem('stripModeComics')) || {};
            this.state.stripMode = !!map[comicId];
        } catch (e) {
            this.state.stripMode = false;
        }
        // 互斥：条漫模式下关闭拼页
        if (this.state.stripMode) this.state.doublePageMode = false;
    },

    saveStripModeForComic(comicId, enabled) {
        try {
            const map = JSON.parse(localStorage.getItem('stripModeComics')) || {};
            map[comicId] = enabled;
            localStorage.setItem('stripModeComics', JSON.stringify(map));
        } catch (e) {}
    },

    applySettings() {
        document.querySelectorAll('.toggle-btn[data-dir]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.dir === this.state.readingDirection);
        });
        const dp = document.getElementById('double-page-mode');
        if (dp) dp.checked = this.state.doublePageMode;
        const sm = document.getElementById('strip-mode');
        if (sm) sm.checked = this.state.stripMode;
        const fontSelect = document.getElementById('novel-font-select');
        if (fontSelect) fontSelect.value = this.state.novelFont;
        const fontSizeEl = document.getElementById('novel-font-size-value');
        if (fontSizeEl) fontSizeEl.textContent = `${this.state.novelFontSize}px`;
        document.querySelectorAll('[data-novel-mode]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.novelMode === this.state.novelReadingMode);
        });

        // 所有 slide slot 中的 image-container 都应用方向和模式
        document.querySelectorAll('.slide-page .image-container').forEach(ic => {
            ic.classList.remove('rtl', 'double-page');
            if (this.state.readingDirection === 'rtl') ic.classList.add('rtl');
            if (this.state.doublePageMode) ic.classList.add('double-page');
        });

        const slider = document.getElementById('page-slider');
        if (slider) {
            slider.style.direction = this.state.readingDirection === 'rtl' ? 'rtl' : 'ltr';
        }

        // 拼页偏移按钮：仅在漫画拼页模式下显示
        const offsetBtn = document.getElementById('toggle-offset-btn');
        if (offsetBtn) {
            offsetBtn.style.display = (this.state.doublePageMode && !this.state.novelMode) ? 'flex' : 'none';
        }

        // 条漫模式下隐藏拼页相关选项
        const doublePageRow = document.getElementById('double-page-row');
        if (doublePageRow) {
            doublePageRow.style.display = (this.state.stripMode || this.state.novelMode) ? 'none' : 'flex';
        }
        // 条漫模式下隐藏方向切换（条漫始终垂直）
        const dirRow = document.getElementById('direction-row');
        if (dirRow) {
            dirRow.style.display = (this.state.stripMode || this.state.novelMode) ? 'none' : 'flex';
        }
        const stripModeRow = document.getElementById('strip-mode-row');
        if (stripModeRow) {
            stripModeRow.style.display = this.state.novelMode ? 'none' : 'flex';
        }
        const novelModeRow = document.getElementById('novel-mode-row');
        if (novelModeRow) {
            novelModeRow.style.display = 'none';
        }
        const novelFontRow = document.getElementById('novel-font-row');
        if (novelFontRow) {
            novelFontRow.style.display = this.state.novelMode ? 'flex' : 'none';
        }
        const novelFontSizeRow = document.getElementById('novel-font-size-row');
        if (novelFontSizeRow) {
            novelFontSizeRow.style.display = this.state.novelMode ? 'flex' : 'none';
        }
        const novelTocBtn = document.getElementById('novel-toc-btn');
        if (novelTocBtn) {
            novelTocBtn.style.display = this.state.novelMode ? '' : 'none';
        }
        this.applyNovelTypography();
        this.applyNovelModeClass();
    },

    // ─── Events ───
    bindEvents() {
        // 登录
        document.getElementById('login-btn').addEventListener('click', () => this.login());
        document.getElementById('login-form').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.login();
        });

        // 搜索输入框
        document.getElementById('search-input').addEventListener('input', (e) => {
            this.onSearchInput(e.target.value);
        });
        document.getElementById('search-input').addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeSearch();
            }
        });

        // 方向切换按钮
        document.querySelectorAll('.toggle-btn[data-dir]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.state.readingDirection = btn.dataset.dir;
                this.saveSettings();
                this.applySettings();
                this.renderPage();
            });
        });

        // 拼页开关
        document.getElementById('double-page-mode').addEventListener('change', (e) => {
            this.state.doublePageMode = e.target.checked;
            if (e.target.checked) {
                this.state.stripMode = false;
                this._exitStripMode();
                // 按当前漫画保存关闭条漫模式
                if (this.state.currentComic) {
                    this.saveStripModeForComic(this.state.currentComic.comic.id, false);
                }
            }
            this.saveSettings();
            this.applySettings();
            this.renderPage();
        });

        // 条漫模式开关
        document.getElementById('strip-mode').addEventListener('change', (e) => {
            this.state.stripMode = e.target.checked;
            if (e.target.checked) {
                this.state.doublePageMode = false;
            } else {
                this._exitStripMode();
            }
            // 按当前漫画独立保存条漫模式
            if (this.state.currentComic) {
                this.saveStripModeForComic(this.state.currentComic.comic.id, e.target.checked);
            }
            this.saveSettings();
            this.applySettings();
            this.renderPage();
        });

        const novelFontSelect = document.getElementById('novel-font-select');
        if (novelFontSelect) {
            novelFontSelect.addEventListener('change', (e) => {
                const percent = this.currentNovelPositionPercent();
                this.state.novelFont = e.target.value || 'kai';
                this.saveSettings();
                this.applyNovelTypography();
                this.applyNovelLayout(percent);
            });
        }
        document.querySelectorAll('[data-novel-mode]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.changeNovelReadingMode(btn.dataset.novelMode);
            });
        });
        document.querySelectorAll('[data-novel-font-size]').forEach(btn => {
            btn.addEventListener('click', () => {
                const percent = this.currentNovelPositionPercent();
                const delta = Number(btn.dataset.novelFontSize || 0);
                this.state.novelFontSize = Math.max(15, Math.min(30, this.state.novelFontSize + delta));
                this.saveSettings();
                this.applySettings();
                this.applyNovelLayout(percent);
            });
        });

        // 页面滑块
        const pageSlider = document.getElementById('page-slider');
        const beginNovelSliderDrag = () => {
            if (this.state.novelMode) this.beginNovelSliderDrag();
        };
        const commitNovelSliderDrag = () => {
            if (this.state.novelMode) this.commitNovelSlider(Number(pageSlider.value));
        };
        pageSlider.addEventListener('pointerdown', beginNovelSliderDrag, { passive: true });
        pageSlider.addEventListener('mousedown', beginNovelSliderDrag);
        pageSlider.addEventListener('touchstart', beginNovelSliderDrag, { passive: true });
        pageSlider.addEventListener('pointerup', commitNovelSliderDrag, { passive: true });
        pageSlider.addEventListener('mouseup', commitNovelSliderDrag);
        pageSlider.addEventListener('touchend', commitNovelSliderDrag, { passive: true });
        pageSlider.addEventListener('touchcancel', () => this.endNovelSliderDrag(), { passive: true });
        pageSlider.addEventListener('change', commitNovelSliderDrag);
        pageSlider.addEventListener('keyup', (e) => {
            if (!this.state.novelMode) return;
            if (/^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(e.key)) {
                this.commitNovelSlider(Number(pageSlider.value));
            }
        });
        pageSlider.addEventListener('input', (e) => {
            if (this.state.novelMode) {
                this.previewNovelSlider(Number(e.target.value));
                return;
            }
            const page = parseInt(e.target.value) - 1;
            this.state.currentPage = page;
            if (this.state.stripMode) {
                this._cancelStripRestore();
                const container = document.getElementById('strip-container');
                if (container) {
                    const imgs = container.querySelectorAll('img.strip-img');
                    if (imgs[page]) {
                        imgs[page].scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                }
                this._updateIndicator();
                this.saveProgress(page);
            } else {
                this.renderPage();
            }
        });

        // 键盘
        window.addEventListener('keydown', (e) => {
            if (!document.getElementById('reader-page').classList.contains('active')) return;
            // Lightbox intercepts Escape
            const lightbox = document.getElementById('image-lightbox');
            if (lightbox && lightbox.style.display !== 'none') {
                if (e.key === 'Escape') { e.preventDefault(); this.closeImageLightbox(); }
                else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); this.rotateLightboxImage(); }
                return;
            }
            if (this.state.novelMode) {
                if (e.key === 'Escape') {
                    this.state.uiVisible ? this.hideUI() : this.exitReader();
                } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
                    e.preventDefault();
                    this.epubPrev();
                } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
                    e.preventDefault();
                    this.epubNext();
                } else if (e.key === '[') {
                    e.preventDefault();
                    this.switchNovelChapter((this.state.currentChapterIndex || 0) - 1);
                } else if (e.key === ']') {
                    e.preventDefault();
                    this.switchNovelChapter((this.state.currentChapterIndex || 0) + 1);
                } else if (e.key === 'r' || e.key === 'R') {
                    e.preventDefault();
                    this.reloadCurrentReader();
                }
                return;
            }
            if (this.state.stripMode) {
                // 条漫模式：上下键滚动，左右键无效
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    const c = document.getElementById('strip-container');
                    if (c) c.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'smooth' });
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    const c = document.getElementById('strip-container');
                    if (c) c.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
                } else if (e.key === 'Escape') {
                    this.state.uiVisible ? this.hideUI() : this.exitReader();
                } else if (e.key === 'r' || e.key === 'R') {
                    e.preventDefault();
                    this.reloadCurrentReader();
                }
                return;
            }
            if (this.isImageZoomed()) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this.resetImageZoom();
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    this.panImageBy(-80, 0);
                } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    this.panImageBy(80, 0);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    this.panImageBy(0, -80);
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.panImageBy(0, 80);
                }
                return;
            }
            if (e.key === 'ArrowLeft') {
                if (this.state.readingDirection === 'rtl') this.animateToPage('next'); else this.animateToPage('prev');
            } else if (e.key === 'ArrowRight') {
                if (this.state.readingDirection === 'rtl') this.animateToPage('prev'); else this.animateToPage('next');
            } else if (e.key === 'Escape') {
                this.state.uiVisible ? this.hideUI() : this.exitReader();
            } else if (e.key === 'r' || e.key === 'R') {
                e.preventDefault();
                this.reloadCurrentReader();
            }
        }, { capture: true });

        // 触摸区域（点击翻页）
        const handleTapIfNotSwiped = (callback) => {
            return (e) => {
                // 如果刚刚完成了一次滑动，不触发点击
                if (this._swipedRecently) return;
                if (!this.state.novelMode && this.shouldSuppressReaderTap()) return;
                if (this.state.novelMode && this.handleEpubOverlayInteractiveTap(e)) return;
                callback(e);
            };
        };
        document.getElementById('touch-prev').addEventListener('click', handleTapIfNotSwiped(() => {
            if (this.state.novelMode) {
                this.epubPrev();
                return;
            }
            if (this.state.readingDirection === 'rtl') this.animateToPage('next'); else this.animateToPage('prev');
        }));
        document.getElementById('touch-next').addEventListener('click', handleTapIfNotSwiped(() => {
            if (this.state.novelMode) {
                this.epubNext();
                return;
            }
            if (this.state.readingDirection === 'rtl') this.animateToPage('prev'); else this.animateToPage('next');
        }));
        document.getElementById('touch-center').addEventListener('click', handleTapIfNotSwiped(() => {
            this.toggleUI();
        }));
        let centerReloadTimer = null;
        let centerReloadStart = null;
        const clearCenterReloadTimer = () => {
            if (centerReloadTimer) clearTimeout(centerReloadTimer);
            centerReloadTimer = null;
            centerReloadStart = null;
        };
        this.cancelReaderCenterHold = clearCenterReloadTimer;
        const centerZone = document.getElementById('touch-center');
        centerZone.addEventListener('touchstart', (e) => {
            if (!document.getElementById('reader-page').classList.contains('active')) return;
            if (e.touches.length !== 1 || this.shouldSuppressReaderTap()) return;
            const t = e.touches[0];
            centerReloadStart = { x: t.clientX, y: t.clientY };
            centerReloadTimer = setTimeout(() => {
                centerReloadTimer = null;
                this._swipedRecently = true;
                setTimeout(() => { this._swipedRecently = false; }, 350);
                this.reloadCurrentReader();
            }, 850);
        }, { passive: true });
        centerZone.addEventListener('touchmove', (e) => {
            if (!centerReloadStart || !centerReloadTimer) return;
            if (e.touches.length !== 1 || this.isImageZoomInteractionActive()) {
                clearCenterReloadTimer();
                return;
            }
            const t = e.touches[0];
            if (Math.abs(t.clientX - centerReloadStart.x) > 18 || Math.abs(t.clientY - centerReloadStart.y) > 18) {
                clearCenterReloadTimer();
            }
        }, { passive: true });
        centerZone.addEventListener('touchend', clearCenterReloadTimer, { passive: true });
        centerZone.addEventListener('touchcancel', clearCenterReloadTimer, { passive: true });

        // 滑动手势 — 跟手拖拽 + 惯性翻页
        this._swipe = {
            active: false,
            startX: 0,
            startY: 0,
            currentX: 0,
            startTime: 0,
            locked: false,      // 是否已锁定为水平滑动
            rejected: false,    // 是否已判定为垂直滚动（放弃）
            velocityX: 0,
            lastX: 0,
            lastTime: 0,
            animating: false,   // 是否正在执行翻页动画
        };
        this._swipedRecently = false;

        const touchLayer = document.getElementById('reader-touch-layer');
        this.bindImageZoomEvents();

        touchLayer.addEventListener('touchstart', (e) => {
            if (this.state.novelMode) {
                const touch = e.touches[0];
                this._novelSwipe = {
                    startX: touch.clientX,
                    startY: touch.clientY,
                    currentX: touch.clientX,
                    currentY: touch.clientY,
                };
                return;
            }
            if (e.touches.length > 1 || this.shouldBlockReaderSwipeTouch(e)) {
                this.cancelReaderSwipe();
                return;
            }
            if (this.state.stripMode) return;
            if (this._swipe.animating) return;
            const t = e.touches[0];
            this._swipe.active = true;
            this._swipe.startX = t.clientX;
            this._swipe.startY = t.clientY;
            this._swipe.currentX = t.clientX;
            this._swipe.startTime = Date.now();
            this._swipe.locked = false;
            this._swipe.rejected = false;
            this._swipe.velocityX = 0;
            this._swipe.lastX = t.clientX;
            this._swipe.lastTime = Date.now();

            // 移除过渡动画以实现跟手效果
            const track = document.getElementById('slide-track');
            track.classList.remove('animating');
        }, { passive: true });

        touchLayer.addEventListener('touchmove', (e) => {
            if (this.state.novelMode) {
                if (!this._novelSwipe) return;
                const touch = e.touches[0];
                this._novelSwipe.currentX = touch.clientX;
                this._novelSwipe.currentY = touch.clientY;
                const dx = touch.clientX - this._novelSwipe.startX;
                const dy = touch.clientY - this._novelSwipe.startY;
                if (Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy) * 1.15) {
                    e.preventDefault();
                }
                return;
            }
            if (e.touches.length > 1 || this.shouldBlockReaderSwipeTouch(e)) {
                this.cancelReaderSwipe();
                return;
            }
            if (this.state.stripMode) return;
            if (!this._swipe.active || this._swipe.animating) return;

            const t = e.touches[0];
            const dx = t.clientX - this._swipe.startX;
            const dy = t.clientY - this._swipe.startY;

            // 方向锁定判定（阈值 10px）
            if (!this._swipe.locked && !this._swipe.rejected) {
                if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
                    if (Math.abs(dy) > Math.abs(dx) * 1.2) {
                        // 垂直方向占优，放弃拦截
                        this._swipe.rejected = true;
                        return;
                    }
                    this._swipe.locked = true;
                } else {
                    return;
                }
            }

            if (this._swipe.rejected) return;

            e.preventDefault();

            // 速度追踪
            const now = Date.now();
            const dt = now - this._swipe.lastTime;
            if (dt > 0) {
                this._swipe.velocityX = (t.clientX - this._swipe.lastX) / dt * 1000;
            }
            this._swipe.lastX = t.clientX;
            this._swipe.lastTime = now;
            this._swipe.currentX = t.clientX;

            // 计算偏移并应用到 slide-track
            const viewportWidth = document.getElementById('reader-viewport').offsetWidth;
            let offsetPx = dx;

            // 边界回弹阻尼：RTL 下 slot 已交换，左滑=prev slot=next page，右滑=next slot=prev page
            const isRtl = this.state.readingDirection === 'rtl';
            const canSlideRight = isRtl ? this._canGoNext() : this._canGoPrev(); // 右滑（dx>0）对应
            const canSlideLeft  = isRtl ? this._canGoPrev() : this._canGoNext(); // 左滑（dx<0）对应
            if ((offsetPx > 0 && !canSlideRight) || (offsetPx < 0 && !canSlideLeft)) {
                offsetPx = offsetPx * 0.25; // 阻尼系数
            }

            // 偏移百分比（相对于整个 track 的 1/3 = 一页宽度）
            const offsetPercent = (offsetPx / viewportWidth) * 33.3333;
            const track = document.getElementById('slide-track');
            track.style.transform = `translate3d(${-33.3333 + offsetPercent}%, 0, 0)`;
        }, { passive: false });

        touchLayer.addEventListener('touchend', (e) => {
            if (this.state.novelMode) {
                const swipe = this._novelSwipe;
                this._novelSwipe = null;
                if (!swipe) return;
                const touch = e.changedTouches[0];
                const endX = touch ? touch.clientX : swipe.currentX;
                const endY = touch ? touch.clientY : swipe.currentY;
                const dx = endX - swipe.startX;
                const dy = endY - swipe.startY;
                if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.2) {
                    e.preventDefault();
                    this._swipedRecently = true;
                    setTimeout(() => { this._swipedRecently = false; }, 350);
                    if (dx < 0) this.epubNext(); else this.epubPrev();
                }
                return;
            }
            if (this.shouldBlockReaderSwipeTouch(e)) {
                this.cancelReaderSwipe();
                return;
            }
            if (!this._swipe.active || this._swipe.animating) return;
            this._swipe.active = false;

            if (!this._swipe.locked || this._swipe.rejected) {
                // 没有触发水平滑动，不处理（交给 click 事件）
                return;
            }

            e.preventDefault();

            // 标记刚完成滑动，抑制后续 click 事件
            this._swipedRecently = true;
            setTimeout(() => { this._swipedRecently = false; }, 50);

            const dx = this._swipe.currentX - this._swipe.startX;
            const viewportWidth = document.getElementById('reader-viewport').offsetWidth;
            const velocity = this._swipe.velocityX;
            const isRtl = this.state.readingDirection === 'rtl';

            const absDx = Math.abs(dx);
            const threshold = viewportWidth * 0.2; // 20% 位移阈值
            const velocityThreshold = 300; // px/s 速度阈值
            const absVelocity = Math.abs(velocity);

            // direction 是物理方向：'slide-left' 或 'slide-right'
            // 然后映射到逻辑 prev/next（RTL 下映射相反）
            let direction = null;
            if (absVelocity > velocityThreshold || absDx > threshold) {
                const swipeDir = absVelocity > velocityThreshold ? velocity : dx;
                if (swipeDir > 0) {
                    // 物理右滑 → LTR 时是 prev，RTL 时是 next
                    const logicalDir = isRtl ? 'next' : 'prev';
                    if (logicalDir === 'prev' ? this._canGoPrev() : this._canGoNext()) {
                        direction = logicalDir;
                    }
                } else {
                    // 物理左滑 → LTR 时是 next，RTL 时是 prev
                    const logicalDir = isRtl ? 'prev' : 'next';
                    if (logicalDir === 'prev' ? this._canGoPrev() : this._canGoNext()) {
                        direction = logicalDir;
                    }
                }
            }

            if (direction) {
                // 章节边界检测：如果当前方向上本章已无更多页，切换到相邻章节
                if (direction === 'next' && this._getNextPageIndex() === null) {
                    if (this.state.currentChapterIndex < this.state.allChapters.length - 1) {
                        this._snapBack();
                        this.switchChapter(this.state.currentChapterIndex + 1, 'first');
                    } else {
                        this._snapBack();
                    }
                } else if (direction === 'prev' && this._getPrevPageIndex() === null) {
                    if (this.state.currentChapterIndex > 0) {
                        this._snapBack();
                        this.switchChapter(this.state.currentChapterIndex - 1, 'last');
                    } else {
                        this._snapBack();
                    }
                } else {
                    this._finishSwipe(direction);
                }
            } else {
                this._snapBack();
            }
        }, { passive: false });

        touchLayer.addEventListener('touchcancel', () => {
            if (this.state.novelMode) {
                this._novelSwipe = null;
                return;
            }
            if (this._swipe.active && this._swipe.locked && !this._swipe.rejected) {
                this._snapBack();
            }
            this._swipe.active = false;
        }, { passive: true });

        // 关闭上下文菜单（点击空白处）
        document.addEventListener('click', (e) => {
            this.closeContextMenu();
            // 关闭排序菜单（点击非排序区域时）
            if (!e.target.closest('.sort-anchor')) {
                this.closeSortMenu();
            }
        });
        document.addEventListener('touchstart', (e) => {
            if (!e.target.closest('.context-menu')) this.closeContextMenu();
        }, { passive: true });

        // 页面可见性变化 — 切回时自动刷新（距上次加载超过1分钟）
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible'
                && this.state.token
                && document.getElementById('comic-list-page').classList.contains('active')
                && Date.now() - this.state.lastComicsLoadTime > 60 * 1000) {
                this.loadComics();
            }
        });
        window.addEventListener('resize', () => {
            this.scheduleCategoryTabsLayout();
            if (!this.state.novelMode) return;
            const percent = this.currentNovelPositionPercent();
            requestAnimationFrame(() => this.applyNovelLayout(percent));
        });
        window.addEventListener('orientationchange', () => {
            setTimeout(() => this.scheduleCategoryTabsLayout(), 100);
        });
        if (document.fonts?.ready) {
            document.fonts.ready.then(() => this.scheduleCategoryTabsLayout()).catch(() => {});
        }
    },

    // ─── Library View ───
    normalizeLibraryViewMode(mode) {
        return mode === 'list' ? 'list' : 'grid';
    },

    prefersReducedMotion() {
        return typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    },

    updateLibraryViewUI() {
        const mode = this.normalizeLibraryViewMode(this.state.libraryViewMode);
        this.state.libraryViewMode = mode;
        const grid = document.getElementById('comic-grid');
        if (grid) {
            grid.dataset.view = mode;
            grid.classList.toggle('comic-list-view', mode === 'list');
        }
        const listButton = document.getElementById('library-list-view-btn');
        const gridButton = document.getElementById('library-grid-view-btn');
        [
            [listButton, mode === 'list'],
            [gridButton, mode === 'grid'],
        ].forEach(([button, active]) => {
            if (!button) return;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    },

    setLibraryViewMode(mode) {
        const nextMode = this.normalizeLibraryViewMode(mode);
        if (nextMode === this.state.libraryViewMode) {
            this.updateLibraryViewUI();
            return;
        }

        const applyMode = () => {
            this.state.libraryViewMode = nextMode;
            try {
                localStorage.setItem('libraryViewMode', nextMode);
            } catch (e) {}
            this.updateLibraryViewUI();
            if (this.state.searchResults !== null) {
                this.renderSearchResults(this.state.searchResults, this.state.searchQuery);
            } else {
                this.renderComicList();
            }
        };

        const canTransition = typeof document.startViewTransition === 'function'
            && !this.prefersReducedMotion();
        if (!canTransition) {
            applyMode();
            const grid = document.getElementById('comic-grid');
            if (grid) {
                grid.classList.add('is-switching-view');
                setTimeout(() => grid.classList.remove('is-switching-view'), 260);
            }
            return;
        }

        document.documentElement.classList.add('library-view-transition');
        try {
            const transition = document.startViewTransition(applyMode);
            transition.finished.finally(() => {
                document.documentElement.classList.remove('library-view-transition');
            });
        } catch (error) {
            document.documentElement.classList.remove('library-view-transition');
            applyMode();
        }
    },

    comicViewTransitionName(comicId) {
        let hash = 2166136261;
        for (const char of String(comicId || '')) {
            hash ^= char.codePointAt(0);
            hash = Math.imul(hash, 16777619);
        }
        return `comic-${(hash >>> 0).toString(36)}`;
    },

    libraryCountLabel(count) {
        return `共 ${Math.max(0, Number(count || 0))} 本`;
    },

    formatLibraryProgress(progress) {
        if (!progress?.lastChapterTitle) return '';
        const extra = progress.lastResourceType === 'epub'
            && Number.isFinite(Number(progress.lastScrollPercent))
            ? ` · ${Math.round(Number(progress.lastScrollPercent))}%`
            : '';
        return `${progress.lastChapterTitle}${extra}`;
    },

    formatLibraryResourceSummary(comic) {
        const resources = Number(comic?.resourceCount || 0);
        if (resources <= 0) return '';
        return `共 ${resources} 册`;
    },

    // ─── Sort ───
    getSortedComics(list) {
        if (!list || list.length === 0) return list;
        const { sortBy, sortOrder } = this.state;
        const sorted = [...list];
        const dir = sortOrder === 'asc' ? 1 : -1;

        sorted.sort((a, b) => {
            if (sortBy === 'name') {
                const nameA = a.name || '';
                const nameB = b.name || '';
                return dir * nameA.localeCompare(nameB, 'zh-Hans-CN', { sensitivity: 'base' });
            }
            if (sortBy === '_score') {
                const sa = a._score || 0;
                const sb = b._score || 0;
                return dir * (sa - sb);
            }
            if (sortBy === 'lastRead') {
                const pa = this.state.progressCache[a.id];
                const pb = this.state.progressCache[b.id];
                const ta = pa?.updatedAt || '';
                const tb = pb?.updatedAt || '';
                // 有阅读记录的始终排前面
                if (ta && !tb) return -1;
                if (!ta && tb) return 1;
                // 都有阅读记录，最近阅读的排前面（降序）
                if (ta && tb) return tb.localeCompare(ta);
                // 都无阅读记录，按更新日期排序
                const da = a.updatedAt || '';
                const db = b.updatedAt || '';
                if (!da && !db) return 0;
                if (!da) return 1;
                if (!db) return -1;
                return db.localeCompare(da);
            }
            // updatedAt / latestAddedAt — 日期字符串比较
            const da = a[sortBy] || '';
            const db = b[sortBy] || '';
            // 空值始终排末尾
            if (!da && !db) return 0;
            if (!da) return 1;
            if (!db) return -1;
            return dir * da.localeCompare(db);
        });
        return sorted;
    },

    saveSortPref() {
        localStorage.setItem('comicSortPref', JSON.stringify({
            sortBy: this.state.sortBy,
            sortOrder: this.state.sortOrder
        }));
    },

    changeSort(field) {
        if (field === 'lastRead') {
            this.state.sortBy = field;
            this.state.sortOrder = 'desc';
        } else if (this.state.sortBy === field) {
            // 同字段，翻转升降序
            this.state.sortOrder = this.state.sortOrder === 'asc' ? 'desc' : 'asc';
        } else {
            this.state.sortBy = field;
            // 名称默认升序，其他默认降序
            this.state.sortOrder = field === 'name' ? 'asc' : 'desc';
        }

        // 非临时排序（非 _score）时持久化
        if (field !== '_score') {
            this.saveSortPref();
        }

        this.closeSortMenu();
        this.updateSortUI();

        // 重新渲染当前视图
        if (this.state.searchResults !== null) {
            this.renderSearchResults(this.state.searchResults, this.state.searchQuery);
        } else {
            this.renderComicList();
        }
    },

    toggleSortMenu() {
        this.state.sortMenuVisible ? this.closeSortMenu() : this.openSortMenu();
    },

    openSortMenu() {
        this.state.sortMenuVisible = true;
        const menu = document.getElementById('sort-menu');
        menu.classList.add('active');
        const indicator = document.getElementById('sort-indicator');
        indicator?.classList.add('active');
        indicator?.setAttribute('aria-expanded', 'true');

        // 搜索时显示“按相关度”选项
        const scoreItem = document.getElementById('sort-item-score');
        scoreItem.style.display = this.state.searchResults !== null ? 'flex' : 'none';

        this.updateSortMenuItems();
    },

    closeSortMenu() {
        this.state.sortMenuVisible = false;
        document.getElementById('sort-menu').classList.remove('active');
        const indicator = document.getElementById('sort-indicator');
        indicator?.classList.remove('active');
        indicator?.setAttribute('aria-expanded', 'false');
    },

    updateSortMenuItems() {
        const items = document.querySelectorAll('.sort-menu-item');
        items.forEach(item => {
            const field = item.dataset.sort;
            const isActive = field === this.state.sortBy;
            item.classList.toggle('active', isActive);
            const arrow = item.querySelector('.sort-arrow');
            if (isActive && field !== 'lastRead') {
                arrow.textContent = this.state.sortOrder === 'asc' ? '↑' : '↓';
            } else {
                arrow.textContent = '';
            }
        });
    },

    updateSortIndicator() {
        const names = {
            lastRead: '按最近阅读',
            name: '按名称',
            updatedAt: '按更新日期',
            latestAddedAt: '按最新添加',
            _score: '按相关度'
        };
        const arrow = this.state.sortOrder === 'asc' ? '↑' : '↓';
        const label = names[this.state.sortBy] || this.state.sortBy;
        document.getElementById('sort-indicator-text').textContent = this.state.sortBy === 'lastRead'
            ? label
            : `${label} ${arrow}`;
    },

    updateSortUI() {
        this.updateSortMenuItems();
        this.updateSortIndicator();
        this.updateLibraryViewUI();
        this.updateCategoryTabs();
    },

    isSafeCategoryKey(category) {
        return typeof category === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(category);
    },

    isKnownLibraryCategory(category) {
        return (this.state.libraryCategories || []).some(item => item.key === category);
    },

    categoryLabel(category = this.state.libraryCategory) {
        const found = (this.state.libraryCategories || []).find(item => item.key === category);
        return found?.label || '作品';
    },

    setLibraryCategory(category) {
        if (!this.isKnownLibraryCategory(category)) return;
        if (this.state.libraryCategory === category) return;
        this.state.libraryCategory = category;
        localStorage.setItem('libraryCategory', category);
        this.state.selectedTags = [];
        this.renderTagFilter();
        this.updateCategoryTabs();
        if (this.state.searchResults !== null && this.state.searchQuery) {
            this.performSearch(this.state.searchQuery);
        } else {
            this.renderComicList();
        }
    },

    updateCategoryTabs() {
        const tabs = document.getElementById('category-tabs');
        if (tabs) {
            tabs.innerHTML = '';
            (this.state.libraryCategories || []).forEach(category => {
                const btn = document.createElement('button');
                btn.className = 'category-tab';
                btn.dataset.category = category.key;
                btn.type = 'button';
                btn.textContent = category.label || category.key;
                btn.classList.toggle('active', category.key === this.state.libraryCategory);
                btn.addEventListener('click', () => this.setLibraryCategory(category.key));
                tabs.appendChild(btn);
            });
        }
        const title = document.getElementById('list-title');
        if (title) title.textContent = 'ReadDeck';
        this.scheduleCategoryTabsLayout();
    },

    toggleCategoryTabsExpanded() {
        this.state.categoryTabsExpanded = !this.state.categoryTabsExpanded;
        this.updateCategoryTabsLayout();
    },

    scheduleCategoryTabsLayout() {
        if (this._categoryTabsLayoutFrame) cancelAnimationFrame(this._categoryTabsLayoutFrame);
        this._categoryTabsLayoutFrame = requestAnimationFrame(() => {
            this._categoryTabsLayoutFrame = null;
            this.updateCategoryTabsLayout();
        });
    },

    categoryTabsContentWidth(tabs) {
        const buttons = Array.from(tabs?.children || []);
        if (buttons.length === 0) return 0;
        const styles = window.getComputedStyle(tabs);
        const gap = Number.parseFloat(styles.columnGap || styles.gap || '0') || 0;
        return buttons.reduce((total, button) => total + button.getBoundingClientRect().width, 0)
            + gap * Math.max(0, buttons.length - 1);
    },

    updateCategoryTabsLayout() {
        const header = document.getElementById('list-header');
        const primary = header?.querySelector('.list-header-primary');
        const title = document.getElementById('list-title');
        const tabs = document.getElementById('category-tabs');
        const actions = header?.querySelector('.header-actions');
        const toggle = document.getElementById('category-tabs-toggle');
        if (!header || !primary || !title || !tabs || !actions || !toggle) return;

        header.classList.remove('category-layout-inline', 'category-layout-row', 'category-layout-scroll', 'category-tabs-expanded');

        const totalTabsWidth = this.categoryTabsContentWidth(tabs);
        const primaryWidth = primary.clientWidth;
        const primaryStyles = window.getComputedStyle(primary);
        const gap = Number.parseFloat(primaryStyles.columnGap || primaryStyles.gap || '0') || 0;
        const titleWidth = title.getBoundingClientRect().width;
        const actionsWidth = actions.getBoundingClientRect().width;
        const inlineWidth = Math.max(0, primaryWidth - titleWidth - actionsWidth - gap * 2);

        let layout = 'inline';
        if (totalTabsWidth > inlineWidth) {
            layout = totalTabsWidth <= primaryWidth ? 'row' : 'scroll';
        }

        if (layout !== 'scroll') this.state.categoryTabsExpanded = false;

        header.classList.add(`category-layout-${layout}`);
        header.classList.toggle('category-tabs-expanded', layout === 'scroll' && this.state.categoryTabsExpanded);
        toggle.hidden = layout !== 'scroll';
        toggle.textContent = this.state.categoryTabsExpanded ? '收起' : '展开';
        toggle.setAttribute('aria-expanded', String(layout === 'scroll' && this.state.categoryTabsExpanded));
    },

    filterByLibraryCategory(list) {
        const category = this.state.libraryCategory || 'comic';
        return (list || []).filter(item => (item.category || 'comic') === category);
    },

    // ─── Tags / Tasks ───
    async loadCategories() {
        try {
            const previousCategory = this.state.libraryCategory;
            const res = await this.authFetch('/api/categories');
            const categories = await res.json();
            if (Array.isArray(categories) && categories.length > 0) {
                this.state.libraryCategories = categories
                    .map(item => ({
                        key: String(item?.key || '').trim(),
                        label: String(item?.label || item?.key || '').trim()
                    }))
                    .filter(item => this.isSafeCategoryKey(item.key) && item.label);
            }
            if (!this.isKnownLibraryCategory(this.state.libraryCategory)) {
                this.state.libraryCategory = this.state.libraryCategories[0]?.key || 'comic';
                localStorage.setItem('libraryCategory', this.state.libraryCategory);
            }
            this.updateCategoryTabs();
            this.renderTagFilter();
            if (previousCategory !== this.state.libraryCategory) {
                if (this.state.searchResults !== null && this.state.searchQuery) {
                    this.performSearch(this.state.searchQuery);
                } else {
                    this.renderComicList();
                }
            }
        } catch (error) {
            console.error('Failed to load categories:', error);
            this.updateCategoryTabs();
        }
    },

    async loadTags() {
        try {
            const res = await this.authFetch('/api/tags');
            this.state.tags = await res.json();
            this.renderTagFilter();
        } catch (error) {
            console.error('Failed to load tags:', error);
        }
    },

    renderTagFilter() {
        const bar = document.getElementById('tag-filter-bar');
        if (!bar) return;
        let allTags = this.state.tags || [];
        const categoryComics = this.filterByLibraryCategory(this.state.comics || []);
        if (categoryComics.length > 0) {
            const tagCounts = new Map();
            categoryComics.forEach(item => {
                (item.tags || []).forEach(tag => {
                    const name = String(tag || '').trim();
                    if (!name) return;
                    tagCounts.set(name, (tagCounts.get(name) || 0) + 1);
                });
            });
            allTags = Array.from(tagCounts.entries())
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));
        }
        const tags = this.state.tagFilterExpanded ? allTags : allTags.slice(0, 12);
        if (tags.length === 0) {
            bar.style.display = 'none';
            return;
        }
        bar.style.display = 'flex';
        bar.classList.toggle('expanded', this.state.tagFilterExpanded);
        bar.innerHTML = '';
        if (allTags.length > 12) {
            const toggle = document.createElement('button');
            toggle.className = 'tag-chip tag-chip-toggle';
            toggle.textContent = this.state.tagFilterExpanded ? '收起' : `展开 ${allTags.length - 12}`;
            toggle.onclick = () => {
                this.state.tagFilterExpanded = !this.state.tagFilterExpanded;
                this.renderTagFilter();
            };
            bar.appendChild(toggle);
        }
        tags.forEach(tag => {
            const btn = document.createElement('button');
            btn.className = 'tag-chip' + (this.state.selectedTags.includes(tag.name) ? ' active' : '');
            btn.textContent = `${tag.name} ${tag.count}`;
            btn.onclick = () => this.toggleTagFilter(tag.name);
            bar.appendChild(btn);
        });
        if (this.state.selectedTags.length > 0) {
            const clear = document.createElement('button');
            clear.className = 'tag-chip tag-chip-clear';
            clear.textContent = '清除';
            clear.onclick = () => {
                this.state.selectedTags = [];
                this.renderTagFilter();
                this.renderComicList();
            };
            bar.appendChild(clear);
        }
    },

    toggleTagFilter(tagName) {
        const selected = this.state.selectedTags;
        if (selected.includes(tagName)) {
            this.state.selectedTags = selected.filter(t => t !== tagName);
        } else {
            this.state.selectedTags = [...selected, tagName];
        }
        this.renderTagFilter();
        if (this.state.searchResults !== null) {
            this.renderSearchResults(this.state.searchResults, this.state.searchQuery);
        } else {
            this.renderComicList();
        }
    },

    filterBySelectedTags(list) {
        const selected = this.state.selectedTags;
        if (!selected || selected.length === 0) return list;
        return list.filter(comic => {
            const tags = new Set((comic.tags || []).map(t => String(t).toLowerCase()));
            return selected.every(tag => tags.has(String(tag).toLowerCase()));
        });
    },

    async runScanAndScrape() {
        const status = document.getElementById('task-status');
        status.textContent = '扫描与刮削任务已入队';
        status.style.display = 'flex';
        try {
            await this.authFetch(this.withNoCache('/api/tasks/scan'), {
                method: 'POST',
                body: JSON.stringify({ scrape: true })
            });
            if (!this.state.realtimeConnected) this.startTaskPolling();
        } catch (error) {
            status.textContent = '任务启动失败';
        }
    },

    pickObservedTask(tasks) {
        if (!Array.isArray(tasks) || tasks.length === 0) return null;
        const activeScanTask = tasks.find(task =>
            task.type === 'scanAndScrape' && (task.status === 'running' || task.status === 'queued')
        );
        if (activeScanTask) return activeScanTask;
        const activeTask = tasks.find(task => task.status === 'running' || task.status === 'queued');
        return activeTask || tasks[0] || null;
    },

    async resumeTaskPollingIfNeeded() {
        if (this.state.role === 'reader') return;
        if (this.state.taskPollTimer) return;
        try {
            const res = await this.authFetch(this.withNoCache('/api/tasks'));
            const tasks = await this.readArrayResponse(res, '任务状态');
            const activeTask = tasks.find(task => task.status === 'running' || task.status === 'queued');
            if (activeTask) this.startTaskPolling();
        } catch (error) {
            console.warn('Failed to resume task polling:', error);
        }
    },

    taskSnapshotIsAuthoritative(task) {
        return task?.type === 'scanAndScrape' &&
            task.progress?.scanDone === true &&
            this.state.scanSnapshotCommittedTaskId !== task.id;
    },

    startTaskPolling(options = {}) {
        if (this.state.role === 'reader') return;
        if (this.state.taskPollTimer) clearInterval(this.state.taskPollTimer);
        const generation = this.state.taskPollGeneration + 1;
        this.state.taskPollGeneration = generation;
        this.state.lastTaskProgressMark = '';
        this.state.taskPollIdleCount = 0;
        this.state.scanSnapshotCommittedTaskId = 0;
        const idleLimit = Math.max(0, Number(options.idleLimit || 0));
        const activeOnly = options.activeOnly === true;
        let inFlight = false;
        let timer = null;
        const isCurrent = () => this.state.taskPollGeneration === generation;
        const stopPolling = () => {
            if (timer) clearInterval(timer);
            if (isCurrent() && this.state.taskPollTimer === timer) {
                this.state.taskPollTimer = null;
            }
        };
        const poll = async () => {
            if (!isCurrent() || inFlight) return;
            inFlight = true;
            try {
                const res = await this.authFetch(this.withNoCache('/api/tasks'));
                const tasks = await this.readArrayResponse(res, '任务状态');
                if (!isCurrent()) return;
                const latest = activeOnly
                    ? tasks.find(task => task.status === 'running' || task.status === 'queued')
                    : this.pickObservedTask(tasks);
                const status = document.getElementById('task-status');
                if (!latest) {
                    this.state.taskPollIdleCount += 1;
                    if (activeOnly && this.state.lastTaskProgressMark) {
                        const refreshed = await this.refreshComicsIncremental({ authoritative: true });
                        if (!isCurrent()) return;
                        if (!refreshed.success || !refreshed.applied) return;
                        await this.loadTags();
                        if (!isCurrent()) return;
                        this.state.lastTaskProgressMark = '';
                    }
                    if (idleLimit && this.state.taskPollIdleCount >= idleLimit) {
                        stopPolling();
                        this.state.taskPollIdleCount = 0;
                        if (status) status.style.display = 'none';
                    }
                    return;
                }
                this.state.taskPollIdleCount = 0;
                status.style.display = 'flex';
                if (latest.status === 'running' || latest.status === 'queued') {
                    if (latest.type === 'scanAndScrape' && latest.progress) {
                        const p = latest.progress;
                        const scanText = p.scanDone ? '扫描完成' : `扫描中，已发现 ${p.discovered}`;
                        status.textContent = `${scanText}；刮削 ${p.completed}/${p.total}（成功 ${p.success} · 失败 ${p.failed}）`;
                        const mark = `${latest.id}:${p.discovered}:${p.total}:${p.completed}:${p.scanDone ? 1 : 0}`;
                        if (mark !== this.state.lastTaskProgressMark) {
                            const authoritative = this.taskSnapshotIsAuthoritative(latest);
                            const refreshed = await this.refreshComicsIncremental({ authoritative });
                            if (!isCurrent()) return;
                            if (refreshed.success && refreshed.applied) {
                                this.state.lastTaskProgressMark = mark;
                                if (authoritative) this.state.scanSnapshotCommittedTaskId = latest.id;
                            }
                        }
                    } else {
                        status.textContent = this.taskSummary(latest);
                        this.state.lastTaskProgressMark = `${latest.id}:${latest.status}`;
                    }
                } else {
                    if (latest.type === 'scanAndScrape' && latest.progress) {
                        const p = latest.progress;
                        status.textContent = latest.status === 'success'
                            ? `批量刮削：完成 ${p.completed}/${p.total}（成功 ${p.success} · 失败 ${p.failed}）`
                            : `批量刮削：失败 ${p.completed}/${p.total}（成功 ${p.success} · 失败 ${p.failed}） ${latest.error || ''}`;
                    } else {
                        status.textContent = this.taskSummary(latest);
                    }
                    const refreshed = await this.refreshComicsIncremental({ authoritative: true });
                    if (!isCurrent()) return;
                    if (!refreshed.success || !refreshed.applied) return;
                    await this.loadTags();
                    if (!isCurrent()) return;
                    await this.refreshVisibleComicDetailAfterTask(latest);
                    if (!isCurrent()) return;
                    stopPolling();
                    this.state.lastTaskProgressMark = '';
                    setTimeout(() => { status.style.display = 'none'; }, 3500);
                }
            } catch (error) {
                if (isCurrent()) console.warn('Failed to poll tasks:', error);
            } finally {
                inFlight = false;
            }
        };
        poll();
        timer = setInterval(poll, 1200);
        this.state.taskPollTimer = timer;
    },

    async refreshVisibleComicDetailAfterTask(task) {
        const activeDetail = document.getElementById('comic-detail-page')?.classList.contains('active');
        const currentId = this.state.currentComic?.comic?.id;
        const taskSeriesId = task?.payload?.seriesId;
        if (!activeDetail || !currentId || !taskSeriesId || currentId !== taskSeriesId) return;
        await this.showComicDetail(currentId, { skipPreferredVersion: true });
    },

    // ─── Search ───
    toggleSearch() {
        this.state.searchVisible ? this.closeSearch() : this.openSearch();
    },

    openSearch() {
        this.state.searchVisible = true;
        document.getElementById('search-bar').style.display = 'block';
        document.getElementById('search-toggle-btn').classList.add('active');
        const input = document.getElementById('search-input');
        input.value = this.state.searchQuery;
        setTimeout(() => input.focus(), 50);

        // 备份当前排序偏好，搜索时切换到按相关度
        if (this.state._preSortBy === null) {
            this.state._preSortBy = this.state.sortBy;
            this.state._preSortOrder = this.state.sortOrder;
        }
        this.state.sortBy = '_score';
        this.state.sortOrder = 'desc';
        this.updateSortUI();
    },

    closeSearch() {
        this.state.searchVisible = false;
        document.getElementById('search-bar').style.display = 'none';
        document.getElementById('search-toggle-btn').classList.remove('active');
        if (this.state.searchQuery) {
            this.clearSearch();
        } else {
            // 即使没有搜索词，也要恢复排序偏好
            if (this.state._preSortBy !== null) {
                this.state.sortBy = this.state._preSortBy;
                this.state.sortOrder = this.state._preSortOrder;
                this.state._preSortBy = null;
                this.state._preSortOrder = null;
                this.updateSortUI();
            }
        }
    },

    clearSearch() {
        this.state.searchQuery = '';
        this.state.searchResults = null;
        if (this.state.searchTimer) clearTimeout(this.state.searchTimer);
        document.getElementById('search-input').value = '';
        document.getElementById('search-clear-btn').style.display = 'none';
        document.getElementById('search-status').style.display = 'none';

        // 恢复搜索前的排序偏好
        if (this.state._preSortBy !== null) {
            this.state.sortBy = this.state._preSortBy;
            this.state.sortOrder = this.state._preSortOrder;
            this.state._preSortBy = null;
            this.state._preSortOrder = null;
        }
        this.updateSortUI();

        this.renderComicList();
    },

    onSearchInput(value) {
        const query = value.trim();
        this.state.searchQuery = query;

        // 显示/隐藏清除按钮
        document.getElementById('search-clear-btn').style.display = query ? 'flex' : 'none';

        if (this.state.searchTimer) clearTimeout(this.state.searchTimer);

        if (!query) {
            this.state.searchResults = null;
            document.getElementById('search-status').style.display = 'none';
            this.renderComicList();
            return;
        }

        // 防抖 300ms
        this.state.searchTimer = setTimeout(() => this.performSearch(query), 300);
    },

    async performSearch(query, options = {}) {
        if (query !== this.state.searchQuery) return;
        const authoritative = options.authoritative !== false;
        const requestSequence = ++this.state.searchRefreshSequence;
        const requestCategory = this.state.libraryCategory;

        try {
            const res = await this.authFetch(
                `/api/comics/search?q=${encodeURIComponent(query)}&category=${encodeURIComponent(requestCategory)}`
            );
            const results = await this.readArrayResponse(res, '搜索结果');

            // 如果搜索词已变，丢弃结果
            if (query !== this.state.searchQuery) return;
            if (requestCategory !== this.state.libraryCategory) return;
            if (requestSequence !== this.state.searchRefreshSequence) return;
            this.state.searchAppliedSequence = requestSequence;

            this.state.searchResults = this.mergeComicSnapshots(
                this.state.searchResults,
                results,
                authoritative
            );
            this.renderSearchResults(this.state.searchResults, query);
            return { success: true, applied: true };
        } catch (error) {
            console.error('Search failed:', error);
            return { success: false, applied: false };
        }
    },

    renderComicCards(comics, options = {}) {
        const grid = document.getElementById('comic-grid');
        const query = options.query || '';
        const isSearch = !!options.search;
        const existing = new Map(
            Array.from(grid.children)
                .filter(el => el.classList?.contains('comic-card') && el.dataset.comicId)
                .map(el => [el.dataset.comicId, el])
        );
        const fragment = document.createDocumentFragment();

        if (!isSearch && comics.length === 0) {
            grid.innerHTML = '<div class="search-empty"><p>当前栏目暂无作品</p><p class="search-empty-hint">可在系统设置中确认来源并启动扫描；扫描发现作品后会自动显示。</p></div>';
            return;
        }

        comics.forEach((comic, index) => {
            let card = existing.get(comic.id);
            if (!card) {
                card = document.createElement('div');
                card.className = 'comic-card';
                card.dataset.comicId = comic.id;
                card.setAttribute('role', 'button');
                card.tabIndex = 0;

                const img = document.createElement('img');
                img.decoding = 'async';
                img.onerror = () => { img.style.visibility = 'hidden'; };
                img.onload = () => { img.style.visibility = ''; };
                card.appendChild(img);

                const info = document.createElement('div');
                info.className = 'comic-card-info';
                card.appendChild(info);

                const chevron = document.createElement('span');
                chevron.className = 'comic-card-chevron';
                chevron.setAttribute('aria-hidden', 'true');
                chevron.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
                card.appendChild(chevron);
            }

            card.onclick = () => this.showComicDetail(comic.id);
            card.onkeydown = (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                this.showComicDetail(comic.id);
            };
            card.setAttribute('aria-label', `打开《${comic.name || '未命名作品'}》详情`);
            card.style.viewTransitionName = this.comicViewTransitionName(comic.id);
            const img = card.querySelector('img');
            const coverUrl = this.withAssetToken(comic.cover || '');
            img.alt = comic.name || '';
            img.loading = index < 12 ? 'eager' : 'lazy';
            img.fetchPriority = index < 6 ? 'high' : 'low';
            if (img.dataset.src !== coverUrl) {
                img.dataset.src = coverUrl;
                img.style.visibility = coverUrl ? '' : 'hidden';
                if (coverUrl) {
                    img.src = coverUrl;
                } else {
                    img.removeAttribute('src');
                }
            }

            const progress = this.state.progressCache[comic.id];
            const progressText = this.formatLibraryProgress(progress);
            const authorText = String(comic.author || '');
            const listProgressText = progressText || this.formatLibraryResourceSummary(comic);
            let cardSummary = this.escapeHtml(progressText || authorText);
            if (isSearch && comic._matchFields && comic._matchFields.length > 0) {
                const fieldNames = { name: '名称', alias: '别名', author: '作者', tag: '标签', publisher: '出版社', brief: '简介' };
                const tags = comic._matchFields.map(f =>
                    `<span class="match-field">${fieldNames[f] || this.escapeHtml(f)}</span>`
                ).join(' ');
                cardSummary = `<span class="match-info">${tags} ${this.escapeHtml(authorText)}</span>`;
            }
            const updatedAt = this.formatDateOnly(comic.updatedAt || comic.latestAddedAt || '');

            card.querySelector('.comic-card-info').innerHTML = `
                <h3>${isSearch ? this.highlightMatch(comic.name, query) : this.escapeHtml(comic.name || '')}</h3>
                <p class="comic-card-summary">${cardSummary}</p>
                <p class="comic-list-author comic-list-only">${this.escapeHtml(authorText)}</p>
                <p class="comic-list-progress comic-list-only">${this.escapeHtml(listProgressText)}</p>
                ${this.renderCardTags(comic)}
                <p class="comic-list-updated comic-list-only">${updatedAt ? `更新 ${this.escapeHtml(updatedAt)}` : ''}</p>
            `;
            fragment.appendChild(card);
        });

        if (comics.length > 0) {
            const count = document.createElement('div');
            count.className = 'library-count';
            count.setAttribute('aria-live', 'polite');
            count.textContent = this.libraryCountLabel(comics.length);
            fragment.appendChild(count);
        }

        grid.replaceChildren(fragment);
        this.updateLibraryViewUI();
        requestAnimationFrame(() => this.trimVisibleCardTags(grid));
    },

    renderSearchResults(results, query) {
        const statusEl = document.getElementById('search-status');
        const grid = document.getElementById('comic-grid');

        const filteredResults = this.filterBySelectedTags(this.filterByLibraryCategory(results));
        if (filteredResults.length === 0) {
            statusEl.innerHTML = `未找到与 "<strong>${this.escapeHtml(query)}</strong>" 相关的${this.categoryLabel()}`;
            statusEl.style.display = 'flex';
            grid.innerHTML = '<div class="search-empty"><p>😕 没有匹配的结果</p><p class="search-empty-hint">试试其他关键词，支持模糊搜索</p></div>';
            return;
        }

        statusEl.innerHTML = `找到 <strong>${filteredResults.length}</strong> 部相关${this.categoryLabel()}`;
        statusEl.style.display = 'flex';

        const sorted = this.getSortedComics(filteredResults);
        this.renderComicCards(sorted, { query, search: true });
    },

    renderCardTags(comic) {
        const tags = (comic.tags || []).slice(0, 4);
        if (tags.length === 0) return '';
        const tagHtml = tags.map(tag => `<span>${this.escapeHtml(tag)}</span>`).join('');
        return `<div class="comic-card-tags">${tagHtml}</div>`;
    },

    trimCardTags(container) {
        if (!container || container.children.length <= 1) return;
        while (container.lastElementChild && container.scrollHeight > container.clientHeight + 1) {
            container.removeChild(container.lastElementChild);
        }
    },

    trimVisibleCardTags(scope = document) {
        if (this.state.libraryViewMode === 'list') return;
        scope.querySelectorAll('.comic-card-tags').forEach(container => this.trimCardTags(container));
    },

    // 高亮匹配的文字
    highlightMatch(text, query) {
        if (!text || !query) return this.escapeHtml(text || '');
        const escaped = this.escapeHtml(text);
        const queryEscaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try {
            const regex = new RegExp(`(${queryEscaped})`, 'gi');
            return escaped.replace(regex, '<mark>$1</mark>');
        } catch (e) {
            return escaped;
        }
    },

    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    // ─── UI Toggle ───
    toggleUI() { this.state.uiVisible ? this.hideUI() : this.showUI(); },
    showUI() {
        this.state.uiVisible = true;
        document.getElementById('reader-ui').classList.add('visible');
    },
    hideUI() {
        this.state.uiVisible = false;
        document.getElementById('reader-ui').classList.remove('visible');
        document.getElementById('settings-panel').classList.remove('active');
    },
    toggleSettings() {
        document.getElementById('settings-panel').classList.toggle('active');
    },

    // ─── Comics List ───
    mergeComicSnapshots(current, incoming, authoritative = true) {
        const next = Array.isArray(incoming) ? incoming : [];
        if (authoritative) return next;

        const merged = new Map();
        for (const comic of Array.isArray(current) ? current : []) {
            if (!comic?.id) continue;
            merged.set(comic.id, comic);
        }
        for (const comic of next) {
            if (!comic?.id) continue;
            merged.set(comic.id, comic);
        }
        return Array.from(merged.values());
    },

    comicSnapshotsEqual(current, next) {
        return JSON.stringify(current || []) === JSON.stringify(next || []);
    },

    async readArrayResponse(response, label = '列表') {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(payload)) {
            const message = payload?.error || `${label}加载失败`;
            throw new Error(message);
        }
        return payload;
    },

    applyComicsSnapshot(incoming, requestSequence, authoritative = true) {
        if (requestSequence !== this.state.comicsRefreshSequence) {
            return { applied: false, changed: false };
        }
        this.state.comicsAppliedSequence = requestSequence;
        const next = this.mergeComicSnapshots(this.state.comics, incoming, authoritative);
        const changed = !this.comicSnapshotsEqual(this.state.comics, next);
        if (changed) this.state.comics = next;
        return { applied: true, changed };
    },

    async loadComics() {
        const requestSequence = ++this.state.comicsRefreshSequence;
        try {
            const res = await this.authFetch('/api/comics');
            const incoming = await this.readArrayResponse(res, '书库');
            const applied = this.applyComicsSnapshot(incoming, requestSequence, true);
            if (!applied.applied) return;
            this.state.lastComicsLoadTime = Date.now();
            // 加载全部进度缓存
            try {
                const pRes = await this.authFetch('/api/progress');
                this.state.progressCache = await pRes.json();
            } catch (e) {}
            this.renderTagFilter();
            this.renderComicList();
            await this.resumeTaskPollingIfNeeded();
        } catch (error) {
            console.error('Failed to load comics:', error);
        }
    },

    async refreshComics() {
        const btn = document.getElementById('refresh-btn');
        if (btn.classList.contains('refreshing')) return; // 防止重复点击
        btn.classList.add('refreshing');
        const requestSequence = ++this.state.comicsRefreshSequence;
        try {
            const res = await this.authFetch(this.withNoCache('/api/comics?refresh=1'));
            const incoming = await this.readArrayResponse(res, '书库');
            const applied = this.applyComicsSnapshot(incoming, requestSequence, true);
            if (!applied.applied) return;
            await this.loadTags();
            this.state.lastComicsLoadTime = Date.now();
            try {
                const pRes = await this.authFetch('/api/progress');
                this.state.progressCache = await pRes.json();
            } catch (e) {}
            this.renderTagFilter();
            // 如果当前有搜索，重新执行搜索
            if (this.state.searchResults !== null && this.state.searchQuery) {
                this.performSearch(this.state.searchQuery);
            } else {
                this.renderComicList();
            }
        } catch (error) {
            console.error('Failed to refresh comics:', error);
        } finally {
            // 最少旋转 600ms 保证视觉反馈
            setTimeout(() => btn.classList.remove('refreshing'), 600);
        }
    },

    async refreshComicsIncremental(options = {}) {
        const authoritative = options.authoritative !== false;
        const requestSequence = ++this.state.comicsRefreshSequence;
        try {
            const res = await this.authFetch(this.withNoCache('/api/comics?cache=0'));
            const incoming = await this.readArrayResponse(res, '书库');
            const applied = this.applyComicsSnapshot(incoming, requestSequence, authoritative);
            if (!applied.applied) return { success: true, ...applied };
            this.state.lastComicsLoadTime = Date.now();
            if (this.state.searchResults !== null && this.state.searchQuery) {
                const searchRefresh = await this.performSearch(this.state.searchQuery, { authoritative });
                if (searchRefresh?.success === false) {
                    return { success: false, applied: false, changed: applied.changed };
                }
            } else if (applied.changed) {
                this.renderTagFilter();
                this.renderComicList();
            }
            return { success: true, ...applied };
        } catch (error) {
            console.error('Failed to refresh comics incrementally:', error);
            return { success: false, applied: false, changed: false };
        }
    },

    renderComicList() {
        this.updateSortUI();
        const sorted = this.getSortedComics(
            this.filterBySelectedTags(this.filterByLibraryCategory(this.state.comics))
        );
        this.renderComicCards(sorted);
        this.state.listNeedsRender = false;
    },

    formatDateOnly(value) {
        if (!value) return '';
        const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
        return match ? match[0] : String(value);
    },

    formatDateTime(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return new Intl.DateTimeFormat('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(date).replace(/\//g, '-');
    },

    formatFileSize(value) {
        const bytes = Number(value);
        if (!Number.isFinite(bytes) || bytes < 0) return '';
        if (bytes < 1024) return `${bytes} B`;
        const units = ['KB', 'MB', 'GB', 'TB'];
        let size = bytes / 1024;
        let index = 0;
        while (size >= 1024 && index < units.length - 1) {
            size /= 1024;
            index += 1;
        }
        return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
    },

    getPreferredVersionComicId(data, fallbackComicId = '') {
        const currentId = String(data?.comic?.id || fallbackComicId || '');
        const versionIds = [
            currentId,
            ...(Array.isArray(data?.resourceVersions)
                ? data.resourceVersions.map(item => item.seriesId)
                : []),
        ];
        const seen = new Set();
        let preferredId = currentId;
        let preferredUpdatedAt = '';

        for (const rawId of versionIds) {
            const versionId = String(rawId || '');
            if (!versionId || seen.has(versionId)) continue;
            seen.add(versionId);

            const updatedAt = String(this.state.progressCache?.[versionId]?.updatedAt || '');
            if (!updatedAt) continue;
            if (!preferredUpdatedAt || updatedAt > preferredUpdatedAt) {
                preferredUpdatedAt = updatedAt;
                preferredId = versionId;
            }
        }
        return preferredId;
    },

    getPreferredGroupFromProgress(groups, progress, fallbackGroup = '') {
        const entries = Object.entries(groups || {});
        if (entries.length === 0) return '';

        const lastChapterUuid = String(progress?.lastChapterUuid || '');
        if (lastChapterUuid) {
            const matched = entries.find(([, chapters]) =>
                Array.isArray(chapters) && chapters.some(ch => ch.chapterUuid === lastChapterUuid)
            );
            if (matched) return matched[0];
        }

        const lastResourceId = String(progress?.lastResourceId || '');
        if (lastResourceId) {
            const matched = entries.find(([, chapters]) =>
                Array.isArray(chapters) && chapters.some(ch => ch.resourceId === lastResourceId)
            );
            if (matched) return matched[0];
        }

        if (fallbackGroup && groups?.[fallbackGroup]) return fallbackGroup;
        return entries[0][0];
    },

    applyOptimisticListCoverFromCurrentComic(comicId) {
        const current = this.state.currentComic?.comic;
        if (!current || !Array.isArray(this.state.comics) || this.state.comics.length === 0) return;

        const subjectId = Number(current.bangumiSubjectId || 0);
        const metadataKey = String(current.metadataKey || '');
        const cover = this.withAssetToken(current.cover || '');
        if (!cover) return;

        let changed = false;
        this.state.comics = this.state.comics.map(item => {
            const sameComic = item.id === comicId;
            const sameSubject = subjectId > 0 && Number(item.bangumiSubjectId || 0) === subjectId;
            const sameMetadata = metadataKey && item.metadataKey === metadataKey;
            if (!sameComic && !sameSubject && !sameMetadata) return item;
            if (item.cover === cover) return item;
            changed = true;
            return {
                ...item,
                cover,
            };
        });

        if (changed && document.getElementById('comic-list-page')?.classList.contains('active')) {
            this.renderComicList();
        }
    },

    bustCoverCache(comicId) {
        if (!comicId) return;
        this.state.coverCacheBust = {
            ...(this.state.coverCacheBust || {}),
            [comicId]: String(Date.now()),
        };
    },

    async refreshAfterCoverChange(comicId) {
        if (!comicId) return;
        this.bustCoverCache(comicId);
        await this.showComicDetail(comicId);
        const preview = document.getElementById('edit-cover-preview');
        if (preview) preview.src = this.withAssetToken(this.state.currentComic?.comic?.cover || '');
        this.applyOptimisticListCoverFromCurrentComic(comicId);
        this.state.listNeedsRender = true;
        await this.refreshComicsIncremental();
    },

    openComicVersion(comicId) {
        return this.showComicDetail(comicId, {
            preferRecentVersion: false,
            skipPreferredVersion: true,
        });
    },

    // ─── Comic Detail ───
    async showComicDetail(comicId, options = {}) {
        try {
            const res = await this.authFetch(`/api/comics/${encodeURIComponent(comicId)}`);
            const data = await res.json();

            data.comic.cover = this.withAssetToken(data.comic.cover || '');
            if (this.state.currentComic?.comic?.id !== data.comic.id) { this.state.detailExpanded = {}; this.state.chapterExpanded = {}; }
            this.state.currentComic = data;

            // 从服务器刷新该漫画的最新阅读进度
            try {
                const pRes = await this.authFetch(`/api/progress/${encodeURIComponent(comicId)}`);
                const progress = await pRes.json();
                if (progress && (progress.lastChapterUuid || progress.lastResourceId || progress.updatedAt)) {
                    this.state.progressCache[comicId] = progress;
                }
            } catch (e) {}

            this.state.currentGroup = this.getPreferredGroupFromProgress(
                data.groups,
                this.state.progressCache[comicId],
                this.state.currentGroup
            );

            document.getElementById('comic-title').textContent = data.comic.name;
            document.getElementById('comic-cover').src = data.comic.cover || '';
            document.getElementById('comic-author').textContent =
                data.comic.author.map(a => a.name).join(', ');
            const statusText = data.comic.status?.display || '';
            document.getElementById('comic-status').textContent = statusText;
            document.getElementById('comic-status-row').style.display = statusText ? '' : 'none';
            document.getElementById('comic-updated').textContent = this.formatDateOnly(data.comic.updatedAt);
            document.getElementById('comic-brief').textContent = data.comic.brief;

            this.renderMetadataSections();
            this.renderContinueReading();
            this.renderGroupTabs();
            this.renderChapterList();
            this.showPage('comic-detail-page');
        } catch (error) {
            console.error('Failed to load comic:', error);
        }
    },

    metadataSources(entity = {}, fallback = {}, kind = 'subject') {
        const result = [];
        const seen = new Set();
        const append = (value, title = '') => {
            try {
                const url = new URL(String(value || ''));
                if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
                const isBangumi = ['bgm.tv', 'bangumi.tv', 'chii.in'].includes(url.hostname.toLowerCase());
                const key = isBangumi ? 'bangumi:' + url.pathname.replace(/\/+$/, '') : url.href;
                if (seen.has(key)) return;
                seen.add(key);
                result.push({ url: url.href, title: isBangumi ? 'Bangumi' : String(title || url.hostname) });
            } catch (_) { /* Missing or invalid links are displayed as plain text. */ }
        };
        for (const row of [entity, fallback]) {
            for (const key of ['sourceUrl', 'url', 'bangumiUrl']) append(row?.[key]);
        }
        for (const row of [entity, fallback]) {
            for (const key of ['sources', 'externalLinks']) {
                for (const source of Array.isArray(row?.[key]) ? row[key] : []) {
                    append(typeof source === 'string' ? source : source?.url, source?.title || source?.label);
                }
            }
        }
        {
            const keys = kind === 'person' ? ['personId', 'bangumiId'] : kind === 'character' ? ['characterId', 'bangumiId'] : ['bangumiSubjectId', 'bangumiId', 'subjectId'];
            for (const row of [entity, fallback]) {
                const id = keys.map(key => Number(row?.[key])).find(id => Number.isSafeInteger(id) && id > 0);
                if (id) { append(`https://bangumi.tv/${kind}/${id}`); break; }
            }
        }
        return result;
    },

    renderMetadataSections() {
        const root = document.getElementById('metadata-sections');
        const data = this.state.currentComic;
        if (!root || !data) return;
        const comic = data.comic;
        const bangumi = data.bangumi || {};
        const tags = comic.tags || [];
        const persons = data.persons || bangumi.persons || [];
        const characters = data.characters || bangumi.characters || [];
        const relations = data.relations || bangumi.relatedSubjects || [];
        const localVolumes = data.localVolumes || [];
        const bookSections = Array.isArray(data.bookSections) && data.bookSections.length > 0
            ? data.bookSections
            : (localVolumes.length > 0 ? [{
                key: 'legacy-volumes',
                title: comic.category === 'novel' ? '卷册' : '单行本',
                matchKind: 'offprint',
                items: localVolumes.map(volume => ({
                    ...volume,
                    representativeResourceId: volume.resourceId,
                    versionCount: volume.versionCount || 1,
                })),
            }] : []);
        const sources = this.metadataSources(comic, bangumi);

        const tagHtml = tags.length
            ? `<div class="detail-tags">${tags.map(tag => `<button onclick="app.applyDetailTag('${this.escapeAttr(tag)}')">${this.escapeHtml(tag)}</button>`).join('')}</div>`
            : '<p class="metadata-empty">暂无标签</p>';
        const metadataActions = `
            <div class="metadata-section-actions">
                <button class="btn-secondary compact" onclick="app.rescrapeCurrentComic()">重新刮削</button>
                ${comic.bangumiSubjectId ? '<button class="btn-secondary compact" onclick="app.clearBangumiData()">清除BGM刮削数据</button>' : ''}
                ${sources.map(source => `<a class="btn-secondary compact" href="${this.escapeAttr(source.url)}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(source.title)}</a>`).join('')}
            </div>
        `;

        const bookSectionsHtml = bookSections.map((section, sectionIndex) => {
            const items = Array.isArray(section.items) ? section.items : [];
            const itemHtml = items.map(book => {
                const resourceId = book.representativeResourceId || book.resourceId || '';
                const typeText = String(book.type || '').toLowerCase() === 'directory'
                    ? ''
                    : String(book.type || '').toUpperCase();
                const pageText = String(book.type || '').toLowerCase() === 'epub'
                    ? (book.pageCount ? `${book.pageCount}章` : '')
                    : (book.pageCount ? `${book.pageCount}P` : '');
                const metaText = [typeText, pageText].filter(Boolean).join(' · ');
                return `
                    <button class="volume-cover-item logical-book-card" onclick="app.showVolumeDetail('${this.escapeAttr(comic.id)}', '${this.escapeAttr(resourceId)}')">
                        <div class="logical-book-cover">
                            <img src="${this.withAssetToken(book.cover || '')}" alt="${this.escapeHtml(book.title || '')}" onerror="this.style.display='none'">
                            ${Number(book.versionCount || 0) > 1 ? `<em class="version-count-badge">${book.versionCount} 个版本</em>` : ''}
                        </div>
                        <span title="${this.escapeAttr(book.title || '')}">${this.escapeHtml(book.title || '')}</span>
                        <small>${this.escapeHtml(metaText)}</small>
                    </button>
                `;
            }).join('');
            return this.renderMetadataBrowserSection(
                `books-${sectionIndex}`,
                section.title || (comic.category === 'novel' ? '卷册' : '单行本'),
                'volume-cover-list logical-book-list',
                itemHtml,
                '暂无本地书本',
                { count: items.length, collapseAt: 5 }
            );
        }).join('');

        const entityCards = (values, kind) => values.map((entity, index) => {
            const name = this.entityName(entity);
            return `<button type="button" class="metadata-card" onclick="app.showEntityDetail('${kind}', ${index})" aria-label="查看${this.escapeAttr(name)}详情">
                ${this.entityImage(entity)}<span title="${this.escapeAttr(name)}">${this.escapeHtml(name)}</span>
                <small>${this.escapeHtml(this.entityRole(entity, kind))}</small></button>`;
        }).join('');

        const relationHtml = relations.map(relation => {
            const source = this.metadataSources(relation)[0];
            const tag = source || relation.localSeriesId ? 'a' : 'div';
            return `
            <${tag} class="relation-item ${relation.localSeriesId ? 'local' : 'remote'} ${relation.image ? 'has-image' : ''}"
               ${source || relation.localSeriesId ? `href="${this.escapeAttr(source?.url || '#')}"` : ''}
               ${relation.localSeriesId ? `data-local-series-id="${this.escapeAttr(relation.localSeriesId)}" onclick="if(!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){app.showComicDetail(this.dataset.localSeriesId);return false}"` : 'target="_blank" rel="noopener"'}
            >
                ${relation.image ? `<img src="${this.withAssetToken(relation.image)}" alt="${this.escapeHtml(relation.name_cn || relation.name || '')}" loading="lazy">` : ''}
                <span>${this.escapeHtml(relation.nameCn || relation.name_cn || relation.name || '')}</span>
                ${(relation.relationLabel ?? relation.relationType) ? `<small>${this.escapeHtml(String(relation.relationLabel ?? relation.relationType))}</small>` : ''}
                ${relation.localSeriesId ? '<small class="relation-local-label">本地可读</small>' : ''}
            </${tag}>
        `; }).join('');
        root.innerHTML = `
            <section class="metadata-section">
                <div class="metadata-section-header">
                    <h3>标签</h3>
                    ${metadataActions}
                </div>
                ${tagHtml}
            </section>
            ${bookSectionsHtml}
        `;
        const sections = {
            characters: { title: '角色', values: characters, css: 'metadata-card-list', html: entityCards(characters, 'character') },
            persons: { title: '创作人员', values: persons, css: 'metadata-card-list', html: entityCards(persons, 'person') },
            relations: { title: '关联条目', values: relations, css: 'relation-list', html: relationHtml },
        };
        const preferences = typeof detailPreferences !== 'undefined' ? detailPreferences.sections() : Object.keys(sections).map(id => ({ id, visible: true }));
        const entityRoot = document.getElementById('entity-sections');
        if (entityRoot) entityRoot.innerHTML = preferences.filter(row => row.visible && sections[row.id]?.values.length).map(({ id }) => {
            const section = sections[id];
            return this.renderMetadataBrowserSection(id, section.title, section.css, section.html, '', { count: section.values.length });
        }).join('');
    },

    entityName(entity) { return entity.nameCn || entity.name_cn || entity.name || '未命名'; },
    entityRole(entity, kind) {
        const value = entity.relationLabel || entity.relation || entity.role || entity.position || '';
        if (kind === 'character' && /^\d+$/.test(String(value))) return ({ 1: '主角', 2: '配角', 3: '客串' })[value] || '';
        return String(value);
    },
    entityImage(entity) {
        return `<div class="entity-image ${entity.image ? '' : 'missing-image'}"><svg viewBox="0 0 48 64" aria-hidden="true"><circle cx="24" cy="22" r="10"/><path d="M7 57v-7a17 17 0 0 1 34 0v7Z"/></svg>${entity.image ? `<img src="${this.escapeAttr(this.withAssetToken(entity.image))}" alt="${this.escapeAttr(this.entityName(entity))}" loading="lazy" onerror="this.hidden=true;this.parentElement.classList.add('missing-image')">` : ''}</div>`;
    },
    showEntityDetail(kind, index) {
        if (!['person', 'character'].includes(kind)) return;
        const data = this.state.currentComic, key = kind === 'person' ? 'persons' : 'characters';
        const entity = (data?.[key] || data?.bangumi?.[key] || [])[index];
        if (!entity) return;
        this.state.entityReturnScrollTop = window.scrollY || 0;
        const sources = this.metadataSources(entity, {}, kind);
        const summary = entity.translatedSummary || entity.summary || '';
        document.getElementById('entity-detail-title').textContent = kind === 'character' ? '角色详情' : '创作人员详情';
        document.getElementById('entity-detail-content').innerHTML = `<div class="entity-detail-hero">${this.entityImage(entity)}<div><h1>${this.escapeHtml(this.entityName(entity))}</h1><p>${this.escapeHtml(this.entityRole(entity, kind))}</p><div class="entity-source-links">${sources.map(source => `<a class="${source.title === 'Bangumi' ? 'btn-primary' : 'btn-secondary'}" href="${this.escapeAttr(source.url)}" target="_blank" rel="noopener noreferrer"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></svg>${source.title === 'Bangumi' ? '在 Bangumi 中查看' : this.escapeHtml(source.title)}</a>`).join('')}</div></div></div><section class="detail-section entity-biography"><h3>简介</h3><p>${this.escapeHtml(summary || '暂无简介')}</p>${entity.translatedSummary && entity.summary && entity.translatedSummary !== entity.summary ? `<details><summary>查看原文</summary><p>${this.escapeHtml(entity.summary)}</p></details>` : ''}</section>`;
        this.showPage('entity-detail-page'); this.setPageScrollTop(0);
    },
    closeEntityDetail() { this.showPage('comic-detail-page'); this.setPageScrollTop(this.state.entityReturnScrollTop || 0); },

    renderMetadataBrowserSection(sectionKey, title, listClass, contentHtml, emptyText, options = {}) {
        const count = Number(options.count || 0);
        const className = [
            'metadata-section',
            count ? '' : 'empty',
            this.state.detailExpanded?.[sectionKey] ? 'is-expanded' : '',
        ].filter(Boolean).join(' ');
        return `
            <section class="${className}" data-section-key="${sectionKey}">
                <div class="metadata-section-header">
                    <h3>${title}${count ? ` <span class="metadata-count">${count}</span>` : ''}</h3>
                    <div class="metadata-section-actions">
                        ${count > 0 ? `<button class="btn-secondary compact" type="button" data-role="toggle-section" aria-expanded="${!!this.state.detailExpanded?.[sectionKey]}" onclick="app.toggleMetadataSection('${this.escapeAttr(sectionKey)}')">${this.state.detailExpanded?.[sectionKey] ? '收起' : '展开'}</button>` : ''}
                    </div>
                </div>
                <div class="${listClass}">${contentHtml || `<p class="metadata-empty">${emptyText}</p>`}</div>
            </section>
        `;
    },

    toggleMetadataSection(sectionKey) {
        const section = document.querySelector(`.metadata-section[data-section-key="${sectionKey}"]`);
        if (!section) return;
        const expanded = section.classList.toggle('is-expanded');
        (this.state.detailExpanded ||= {})[sectionKey] = expanded;
        const button = section.querySelector('[data-role="toggle-section"]');
        if (button) { button.textContent = expanded ? '收起' : '展开'; button.setAttribute('aria-expanded', String(expanded)); }
    },

    openReaderByResource(resourceId, options = {}) {
        const groups = this.state.currentComic?.groups || {};
        for (const [groupKey, chapters] of Object.entries(groups)) {
            const chapter = chapters.find(item => item.resourceId === resourceId);
            if (chapter) {
                this.state.currentGroup = groupKey;
                const nextChapter = options.chapterTitle
                    ? { ...chapter, chapterTitle: `${chapter.chapterTitle} · ${options.chapterTitle}` }
                    : chapter;
                this.openReader(nextChapter, options);
                return;
            }
        }
    },

    // ─── Volume Detail Page ───
    async showVolumeDetail(comicId, resourceId) {
        this.state.volumeReturnScrollTop = window.scrollY ||
            document.documentElement.scrollTop ||
            document.body.scrollTop ||
            0;
        this.state.currentVolume = { comicId, resourceId };

        // Navigate immediately, show loading state
        document.getElementById('volume-detail-title').textContent = '\u52a0\u8f7d\u4e2d...';
        document.getElementById('volume-detail-cover').src = '';
        document.getElementById('volume-detail-cover').style.opacity = '';
        document.getElementById('volume-detail-summary-section').style.display = 'none';
        document.getElementById('volume-detail-versions-section').style.display = 'none';
        document.getElementById('volume-detail-version-list').innerHTML = '';
        document.getElementById('volume-detail-chapters-section').style.display = 'none';
        document.getElementById('volume-detail-chapter-list').innerHTML = '';
        document.getElementById('volume-detail-book-info').style.display = 'none';
        document.getElementById('volume-detail-book-info-content').innerHTML = '';
        document.getElementById('volume-detail-loading').style.display = 'flex';
        document.getElementById('volume-detail-pages-row').style.display = '';
        document.getElementById('volume-bgm-link').style.display = 'none';
        this.showPage('volume-detail-page');
        this.setPageScrollTop(0);

        try {
            const res = await this.authFetch(
                `/api/comics/${encodeURIComponent(comicId)}/volumes/${encodeURIComponent(resourceId)}`
            );
            const data = await res.json();
            Object.assign(this.state.currentVolume, data);

            document.getElementById('volume-detail-title').textContent =
                data.title || data.nameCn || data.nameJa || '';

            const coverEl = document.getElementById('volume-detail-cover');
            coverEl.src = data.cover ? this.withAssetToken(data.cover) : '';
            coverEl.style.opacity = '';

            // Date row
            const dateRow = document.getElementById('volume-detail-date-row');
            if (data.date) {
                document.getElementById('volume-detail-date').textContent = data.date;
                dateRow.style.display = '';
            } else {
                dateRow.style.display = 'none';
            }

            const pagesRow = document.getElementById('volume-detail-pages-row');
            pagesRow.style.display = '';
            document.getElementById('volume-detail-pages').textContent = data.type === 'epub'
                ? (data.chapterCount ? `${data.chapterCount}章` : (data.pageCount ? `${data.pageCount}章` : '—'))
                : (data.pageCount ? `${data.pageCount}\u9875` : '\u2014');
            const heroFormat = [
                data.type ? String(data.type).toUpperCase() : '',
                this.formatFileSize(data.fileSize),
            ].filter(Boolean).join(' · ');
            document.getElementById('volume-detail-type').textContent =
                heroFormat || '\u2014';

            // Keep the existing element ID while showing the actual metadata source.
            const bgmLink = document.getElementById('volume-bgm-link');
            const volumeSource = this.metadataSources(data)[0];
            if (volumeSource) {
                bgmLink.href = volumeSource.url;
                bgmLink.textContent = volumeSource.title;
                bgmLink.style.display = '';
            }

            // Summary
            const summarySection = document.getElementById('volume-detail-summary-section');
            const summaryEl = document.getElementById('volume-detail-summary');
            const toggleBtn = document.getElementById('volume-summary-toggle');
            const displaySummary = data.translatedSummary || data.summary;
            if (displaySummary) {
                summaryEl.textContent = displaySummary;
                this.state.currentVolume._showingOriginal = false;
                summarySection.style.display = '';
                const canToggle = !!(data.translatedSummary && data.summary &&
                    data.translatedSummary !== data.summary);
                toggleBtn.style.display = canToggle ? '' : 'none';
                toggleBtn.textContent = '\u663e\u793a\u539f\u6587';
            } else {
                summarySection.style.display = 'none';
            }

            this.renderVolumeVersions(data);

            const chapterSection = document.getElementById('volume-detail-chapters-section');
            const chapterList = document.getElementById('volume-detail-chapter-list');
            const subChapters = Array.isArray(data.subChapters) ? data.subChapters : [];
            if (subChapters.length > 0) {
                chapterList.innerHTML = subChapters.map((item, index) => {
                    const title = item.title || `章节 ${index + 1}`;
                    const startPage = Math.max(1, Number(item.startPage || 1));
                    const pageCount = Math.max(0, Number(item.pageCount || 0));
                    const isEpub = data.type === 'epub';
                    return `
                        <button class="volume-chapter-item" onclick="app.startReadingVolumeChapter(${startPage}, '${this.escapeAttr(title)}', ${pageCount})">
                            <span class="volume-chapter-item-title">${this.escapeHtml(title)}</span>
                            <span class="volume-chapter-item-meta">${isEpub ? `第 ${startPage} 章` : `第 ${startPage} 页${pageCount ? ` · ${pageCount}P` : ''}`}</span>
                        </button>
                    `;
                }).join('');
                chapterSection.style.display = '';
            } else {
                chapterSection.style.display = 'none';
                chapterList.innerHTML = '';
            }
            this.renderBookInformation(data);
        } catch (error) {
            console.error('Failed to load volume detail:', error);
        } finally {
            document.getElementById('volume-detail-loading').style.display = 'none';
        }
    },

    renderVolumeVersions(data) {
        const section = document.getElementById('volume-detail-versions-section');
        const list = document.getElementById('volume-detail-version-list');
        if (!section || !list) return;
        const versions = Array.isArray(data.versions) ? data.versions : [];
        if (versions.length === 0) {
            section.style.display = 'none';
            list.innerHTML = '';
            return;
        }
        list.innerHTML = versions.map(version => {
            const active = version.resourceId === data.resourceId || version.current;
            const countText = String(version.type || '').toLowerCase() === 'epub'
                ? (version.pageCount ? `${version.pageCount}章` : '')
                : (version.pageCount ? `${version.pageCount}页` : '');
            const meta = [
                version.format || (version.type ? String(version.type).toUpperCase() : ''),
                this.formatFileSize(version.fileSize),
                countText,
                version.firstIndexedAt ? `添加于 ${this.formatDateTime(version.firstIndexedAt)}` : '',
            ].filter(Boolean).join(' · ');
            return `
                <div class="book-version-row ${active ? 'active' : ''}" data-resource-id="${this.escapeAttr(version.resourceId)}">
                    <button class="book-version-select" type="button" onclick="app.switchBookVersion('${this.escapeAttr(version.resourceId)}')">
                        <span class="book-version-radio" aria-hidden="true"></span>
                        <span class="book-version-copy">
                            <strong>${this.escapeHtml(version.sourceAlias || version.sourceTitle || '版本')}</strong>
                            ${version.recentlyRead ? '<em class="recent-version-badge">最近阅读</em>' : ''}
                            <small>${this.escapeHtml(meta)}</small>
                        </span>
                        <span class="book-version-chevron" aria-hidden="true">›</span>
                    </button>
                    <button class="book-version-more" type="button" aria-label="版本操作" onclick="app.openBookVersionMenu(event, '${this.escapeAttr(version.resourceId)}')">•••</button>
                </div>
            `;
        }).join('');
        section.style.display = '';
    },

    renderBookInformation(data) {
        const section = document.getElementById('volume-detail-book-info');
        const content = document.getElementById('volume-detail-book-info-content');
        if (!section || !content) return;
        const current = data.currentVersion || (data.versions || []).find(version => version.resourceId === data.resourceId) || {};
        const source = current.sourceAlias || data.sourceAlias || current.sourceTitle || '本地资源';
        const sourcePath = current.sourcePath || data.sourcePath || '';
        const type = current.format || (data.type ? String(data.type).toUpperCase() : '');
        const size = this.formatFileSize(current.fileSize ?? data.fileSize);
        const countText = String(data.type || '').toLowerCase() === 'epub'
            ? (data.chapterCount ? `${data.chapterCount}章` : (data.pageCount ? `${data.pageCount}章` : ''))
            : (data.pageCount ? `${data.pageCount}页` : '');
        const addedAt = current.firstIndexedAt || data.firstIndexedAt || '';
        const resourceMeta = [type, size, countText, addedAt ? `添加于 ${this.formatDateTime(addedAt)}` : '']
            .filter(Boolean).join(' · ');
        content.innerHTML = `
            <div class="book-information-row">
                <span>来源</span>
                <p>${this.escapeHtml(source)}</p>
            </div>
            ${sourcePath ? `<div class="book-information-row book-information-path">
                <span>路径</span>
                <p>${this.escapeHtml(sourcePath)}</p>
            </div>` : ''}
            ${resourceMeta ? `<p class="book-information-meta">${this.escapeHtml(resourceMeta)}</p>` : ''}
        `;
        section.style.display = '';
    },

    async switchBookVersion(resourceId) {
        const current = this.state.currentVolume;
        if (!current?.comicId || !resourceId || current.resourceId === resourceId) return;
        const returnScrollTop = this.state.volumeReturnScrollTop || 0;
        await this.showVolumeDetail(current.comicId, resourceId);
        this.state.volumeReturnScrollTop = returnScrollTop;
    },

    ensureResourceMenu() {
        let menu = document.getElementById('resource-version-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'resource-version-menu';
            menu.className = 'resource-version-menu';
            menu.setAttribute('role', 'menu');
            menu.addEventListener('click', event => event.stopPropagation());
            document.body.appendChild(menu);
        }
        if (!this._resourceMenuDocumentHandler) {
            this._resourceMenuDocumentHandler = () => this.closeResourceMenu();
            document.addEventListener('click', this._resourceMenuDocumentHandler);
            window.addEventListener('resize', this._resourceMenuDocumentHandler);
            window.addEventListener('scroll', this._resourceMenuDocumentHandler, true);
        }
        return menu;
    },

    openResourceMenu(event, items = []) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const menu = this.ensureResourceMenu();
        menu.innerHTML = '';
        items.forEach(item => {
            if (item.separator) {
                const separator = document.createElement('div');
                separator.className = 'resource-menu-separator';
                menu.appendChild(separator);
                return;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = item.danger ? 'danger' : '';
            button.textContent = item.label;
            button.disabled = item.disabled === true;
            button.onclick = async clickEvent => {
                clickEvent.stopPropagation();
                this.closeResourceMenu();
                await item.action?.();
            };
            menu.appendChild(button);
        });
        menu.classList.add('open');
        const anchor = event?.currentTarget?.getBoundingClientRect?.() || { left: 12, right: 12, bottom: 12 };
        const menuRect = menu.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, anchor.right - menuRect.width));
        const below = anchor.bottom + 6;
        const top = below + menuRect.height <= window.innerHeight - 8
            ? below
            : Math.max(8, anchor.top - menuRect.height - 6);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    },

    closeResourceMenu() {
        const menu = document.getElementById('resource-version-menu');
        if (menu) menu.classList.remove('open');
    },

    openBookVersionMenu(event, resourceId) {
        const volume = this.state.currentVolume;
        const version = (volume?.versions || []).find(item => item.resourceId === resourceId);
        if (!volume || !version) return;
        const items = [];
        if (resourceId !== volume.resourceId) {
            items.push({ label: '切换到此版本', action: () => this.switchBookVersion(resourceId) });
        }
        if (this.state.role === 'reader') { this.openResourceMenu(event, items); return; }
        items.push({ separator: true });
        if (version.manualSplit) {
            items.push({ label: '恢复智能分组', action: () => this.restoreResourceGrouping(resourceId, 'book') });
        } else {
            items.push({ label: '拆分为独立书本', action: () => this.splitResourceGrouping(resourceId, 'book') });
        }
        items.push({ label: '删除当前版本', danger: true, action: () => this.deleteResourceVersion(resourceId) });
        this.openResourceMenu(event, items);
    },

    async splitResourceGrouping(resourceId, kind = 'book') {
        const comicId = this.state.currentComic?.comic?.id;
        if (!comicId || !resourceId) return;
        const response = await this.authFetch(
            `/api/comics/${encodeURIComponent(comicId)}/group-overrides/${encodeURIComponent(resourceId)}`,
            { method: 'PUT', body: JSON.stringify({ kind }) }
        );
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '拆分失败');
        await this.showComicDetail(comicId, { skipPreferredVersion: true });
        if (kind === 'book') await this.showVolumeDetail(comicId, resourceId);
    },

    async restoreResourceGrouping(resourceId, kind = 'book') {
        const comicId = this.state.currentComic?.comic?.id;
        if (!comicId || !resourceId) return;
        const response = await this.authFetch(
            `/api/comics/${encodeURIComponent(comicId)}/group-overrides/${encodeURIComponent(resourceId)}`,
            { method: 'DELETE' }
        );
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '恢复分组失败');
        await this.showComicDetail(comicId, { skipPreferredVersion: true });
        if (kind === 'book') await this.showVolumeDetail(comicId, resourceId);
    },

    async waitForBackgroundTask(taskId, timeoutMs = 15000) {
        if (!taskId) return;
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            const response = await this.authFetch(this.withNoCache('/api/tasks'));
            const tasks = await response.json();
            const task = Array.isArray(tasks) ? tasks.find(item => Number(item.id) === Number(taskId)) : null;
            if (!task || task.status === 'success' || task.status === 'failed') return task;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    },

    async deleteResourceVersion(resourceId) {
        const volume = this.state.currentVolume;
        const comicId = this.state.currentComic?.comic?.id;
        if (!volume || !comicId || !resourceId) return;
        const version = (volume.versions || []).find(item => item.resourceId === resourceId);
        const label = version?.sourceAlias || version?.sourceTitle || '当前版本';
        if (!confirm(`确定删除“${label}”对应的本地文件吗？此操作不可撤销。`)) return;
        const response = await this.authFetch(`/api/resources/${encodeURIComponent(resourceId)}`, { method: 'DELETE' });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || '删除失败');
        await this.waitForBackgroundTask(payload.taskId);
        await this.showComicDetail(comicId, { skipPreferredVersion: true });
        const nextVersion = (volume.versions || []).find(item => item.resourceId !== resourceId);
        if (nextVersion) await this.showVolumeDetail(comicId, nextVersion.resourceId);
    },

    closeVolumeDetail() {
        this.showPage('comic-detail-page');
        this.setPageScrollTop(this.state.volumeReturnScrollTop || 0);
    },

    startReadingCurrentVolume() {
        const resourceId = this.state.currentVolume?.resourceId;
        if (resourceId) this.openReaderByResource(resourceId);
    },

    startReadingVolumeChapter(startPage, chapterTitle = '', pageCount = 0) {
        const resourceId = this.state.currentVolume?.resourceId;
        if (!resourceId) return;
        const page = Math.max(1, Number(startPage || 1));
        const groups = this.state.currentComic?.groups || {};
        let groupKey = '';
        let baseChapter = null;
        for (const [key, chapters] of Object.entries(groups)) {
            baseChapter = chapters.find(item => item.resourceId === resourceId);
            if (baseChapter) {
                groupKey = key;
                break;
            }
        }
        if (!baseChapter) return;

        this.state.currentGroup = groupKey;
        const isEpub = String(baseChapter.resourceType || '').toLowerCase() === 'epub'
            || this.state.currentVolume?.type === 'epub';
        if (!isEpub) {
            const displayTitle = chapterTitle
                ? `${baseChapter.chapterTitle} · ${chapterTitle}`
                : baseChapter.chapterTitle;
            this.openReader({
                ...baseChapter,
                chapterTitle: displayTitle,
            }, {
                startPage: page - 1,
                forceStart: true,
            });
            return;
        }

        const subChapters = Array.isArray(this.state.currentVolume?.subChapters)
            ? this.state.currentVolume.subChapters
            : [];
        const chapterList = subChapters.map((item, index) => {
            const sourceStartPage = Math.max(1, Number(item.startPage || 1));
            const sourcePageCount = Math.max(0, Number(item.pageCount || 0));
            const title = item.title || `章节 ${index + 1}`;
            return {
                ...baseChapter,
                chapterUuid: `${resourceId}::${sourceStartPage}`,
                chapterTitle: `${baseChapter.chapterTitle} · ${title}`,
                order: index + 1,
                sourceStartPage,
                sourcePageCount,
                isVolumeSubChapter: true,
            };
        });
        const target = chapterList.find(item => item.sourceStartPage === page) || {
            ...baseChapter,
            chapterUuid: `${resourceId}::${page}`,
            chapterTitle: `${baseChapter.chapterTitle} · ${chapterTitle}`,
            sourceStartPage: page,
            sourcePageCount: Math.max(0, Number(pageCount || 0)),
            isVolumeSubChapter: true,
        };
        const openOptions = { chapterList, forceStart: true };
        // For epub, sub-chapter "page" is spine index + 1; pass 0-based to openNovelReader.
        openOptions.startPage = Math.max(0, page - 1);
        this.openReader(target, openOptions);
    },

    toggleVolumeSummaryLang() {
        const vol = this.state.currentVolume;
        if (!vol) return;
        const summaryEl = document.getElementById('volume-detail-summary');
        const toggleBtn = document.getElementById('volume-summary-toggle');
        if (!vol._showingOriginal) {
            summaryEl.textContent = vol.summary || '';
            toggleBtn.textContent = '\u663e\u793a\u8bd1\u6587';
            vol._showingOriginal = true;
        } else {
            summaryEl.textContent = vol.translatedSummary || vol.summary || '';
            toggleBtn.textContent = '\u663e\u793a\u539f\u6587';
            vol._showingOriginal = false;
        }
    },

    escapeAttr(str) {
        return String(str || '')
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },

    applyDetailTag(tag) {
        this.state.selectedTags = [tag];
        this.renderTagFilter();
        this.state.listNeedsRender = true;
        this.showComicList();
    },

    async rescrapeCurrentComic(subjectId = 0) {
        if (!this.state.currentComic?.comic?.id) return;
        subjectId = Number(subjectId || 0);
        const status = document.getElementById('task-status');
        if (status) {
            status.textContent = subjectId ? `按 Bangumi #${subjectId} 重新刮削任务已入队` : '单本刮削任务已入队';
            status.style.display = 'flex';
        }
        try {
            await this.authFetch(`/api/tasks/series/${encodeURIComponent(this.state.currentComic.comic.id)}/rescrape`, {
                method: 'POST',
                body: JSON.stringify(subjectId ? { subjectId } : {})
            });
            if (!this.state.realtimeConnected) this.startTaskPolling();
        } catch (error) {
            console.error('Rescrape failed:', error);
        }
    },

    getProgressResourceTitle(progress) {
        const resourceId = String(progress?.lastResourceId || '');
        if (!resourceId) return '';

        const localVolume = (this.state.currentComic?.localVolumes || [])
            .find(volume => volume.resourceId === resourceId);
        if (localVolume?.title) return String(localVolume.title).trim();

        const groups = this.state.currentComic?.groups || {};
        for (const chapters of Object.values(groups)) {
            const chapter = (chapters || []).find(item => item.resourceId === resourceId);
            if (chapter?.chapterTitle) return String(chapter.chapterTitle).trim();
        }

        const resource = (this.state.currentComic?.resources || [])
            .find(item => item.resourceId === resourceId);
        return String(resource?.title || '').trim();
    },

    formatContinueReadingText(progress) {
        const resourceTitle = this.getProgressResourceTitle(progress);
        const chapterTitle = String(progress?.lastChapterTitle || '').trim();
        const hasResourcePrefix = resourceTitle && chapterTitle && (
            chapterTitle === resourceTitle ||
            chapterTitle.startsWith(`${resourceTitle} ·`) ||
            chapterTitle.startsWith(`${resourceTitle} `)
        );
        const title = hasResourcePrefix
            ? chapterTitle
            : [resourceTitle, chapterTitle].filter(Boolean).join(' · ');
        const pageInfo = progress.lastResourceType === 'epub'
            ? (Number.isFinite(Number(progress.lastScrollPercent)) ? ` · ${Math.round(Number(progress.lastScrollPercent))}%` : '')
            : (progress.lastPage != null ? ` · 第 ${progress.lastPage + 1} 页` : '');
        return `${title}${pageInfo}`;
    },

    renderContinueReading() {
        const bar = document.getElementById('continue-reading-bar');
        const chapterEl = document.getElementById('continue-chapter');
        const comicId = this.state.currentComic.comic.id;
        const progress = this.state.progressCache[comicId];

        if (progress && progress.lastChapterUuid && progress.lastChapterTitle) {
            chapterEl.textContent = this.formatContinueReadingText(progress);
            bar.style.display = 'block';
        } else {
            bar.style.display = 'none';
        }
    },

    continueReading() {
        const comicId = this.state.currentComic.comic.id;
        const progress = this.state.progressCache[comicId];
        if (!progress || !progress.lastChapterUuid) return;

        const groups = this.state.currentComic.groups;

        // EPUB 的阅读进度以 resourceId + CFI 为准；TOC 子章节 uuid 不一定存在于详情页分组中。
        if (progress.lastResourceType === 'epub' && progress.lastResourceId) {
            for (const [groupKey, chapters] of Object.entries(groups)) {
                const baseChapter = chapters.find(c => c.resourceId === progress.lastResourceId);
                if (!baseChapter) continue;
                this.state.currentGroup = groupKey;
                const tabsEl = document.getElementById('group-tabs');
                tabsEl.querySelectorAll('.tab').forEach(t => {
                    t.classList.toggle('active', t.dataset.group === groupKey);
                });
                this.renderChapterList();
                this.openReader(baseChapter);
                return;
            }
        }

        // 在所有分组中查找该章节
        for (const groupKey of Object.keys(groups)) {
            const chapters = groups[groupKey];
            const chapter = chapters.find(c => c.chapterUuid === progress.lastChapterUuid);
            if (chapter) {
                // 切换到对应的分组 tab
                this.state.currentGroup = groupKey;
                const tabsEl = document.getElementById('group-tabs');
                tabsEl.querySelectorAll('.tab').forEach(t => {
                    t.classList.toggle('active', t.dataset.group === groupKey);
                });
                this.renderChapterList();
                this.openReader(chapter);
                return;
            }
        }

        if (progress.lastResourceId && progress.lastSourceStartPage) {
            for (const [groupKey, chapters] of Object.entries(groups)) {
                const baseChapter = chapters.find(c => c.resourceId === progress.lastResourceId);
                if (!baseChapter) continue;
                this.state.currentGroup = groupKey;
                const sourceStartPage = Math.max(1, Number(progress.lastSourceStartPage || 1));
                const savedPage = Math.max(0, Number(progress.lastPage || 0));
                const restored = {
                    ...baseChapter,
                    chapterTitle: progress.lastChapterTitle || baseChapter.chapterTitle,
                };
                this.openReader(restored, {
                    startPage: sourceStartPage - 1 + savedPage,
                    forceStart: true,
                });
                return;
            }
        }
    },

    renderGroupTabs() {
        const tabsEl = document.getElementById('group-tabs');
        tabsEl.innerHTML = '';
        const entries = this.getRenderableGroupEntries();
        const groupKeys = entries.map(([key]) => key);

        if (groupKeys.length === 0) {
            tabsEl.style.display = 'none';
            return;
        }

        tabsEl.style.display = 'flex';
        if (!groupKeys.includes(this.state.currentGroup)) {
            this.state.currentGroup = groupKeys[0];
        }

        const nameMap = { 'default': '默認', 'tankobon': '单行本' };
        entries.forEach(([key, chapters]) => {
            const btn = document.createElement('button');
            btn.className = 'tab' + (key === this.state.currentGroup ? ' active' : '');
            btn.dataset.group = key;
            const displayName = (chapters.length > 0 && chapters[0].groupName)
                ? chapters[0].groupName : (nameMap[key] || key);
            btn.textContent = displayName;

            // 如果只有一个分组，设置为只读样式
            if (groupKeys.length === 1) {
                btn.style.cursor = 'default';
                btn.onclick = null;
            } else {
                btn.onclick = () => {
                    tabsEl.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                    btn.classList.add('active');
                    this.state.currentGroup = key;
                    this.renderChapterList();
                };
            }

            tabsEl.appendChild(btn);
        });
    },

    getRenderableGroupEntries() {
        const groups = this.state.currentComic?.groups || {};
        const localVolumes = this.state.currentComic?.localVolumes || [];
        return Object.entries(groups).filter(([, chapters]) => {
            if (!Array.isArray(chapters) || chapters.length === 0) return false;
            const onlyVolumes = chapters.every(chapter => chapter.contentType === 'volume');
            return !(localVolumes.length > 0 && onlyVolumes);
        });
    },

    toggleChapterLayout() {
        const key = this.state.currentGroup;
        this.state.chapterExpanded ||= {};
        this.state.chapterExpanded[key] = !this.state.chapterExpanded[key];
        this.renderChapterList();
    },

    renderChapterList() {
        const list = document.getElementById('chapter-list');
        list.innerHTML = '';
        const entries = this.getRenderableGroupEntries();
        const groupKeys = entries.map(([key]) => key);
        const section = document.getElementById('chapter-section');
        if (section) section.hidden = groupKeys.length === 0;
        if (groupKeys.length === 0) {
            list.style.display = 'none';
            return;
        }
        if (!groupKeys.includes(this.state.currentGroup)) {
            this.state.currentGroup = groupKeys[0];
        }
        list.style.display = 'grid';
        const chapters = this.state.currentComic.groups[this.state.currentGroup] || [];
        const horizontal = this.state.currentComic.comic.category === 'comic';
        const expanded = !!this.state.chapterExpanded?.[this.state.currentGroup];
        if (section) {
            section.classList.toggle('chapters-collapsed', horizontal && !expanded);
            const toggle = document.getElementById('toggle-chapters');
            toggle.hidden = !horizontal; toggle.textContent = expanded ? '收起' : '展开'; toggle.setAttribute('aria-expanded', String(expanded));
            document.getElementById('chapter-section-title').textContent = `${horizontal ? '单话' : (chapters[0]?.groupName || '章节')} ${chapters.length}`;
        }
        list.style.display = horizontal && !expanded ? 'flex' : 'grid';
        chapters.sort((a, b) => a.order - b.order);

        const comicProgress = this.state.progressCache[this.state.currentComic.comic.id];

        chapters.forEach(chapter => {
            const item = document.createElement('div');
            item.className = 'chapter-item';

            // 标记有进度的章节
            if (comicProgress?.chapters?.[chapter.chapterUuid]) {
                item.classList.add('has-progress');
            }

            const typeText = String(chapter.resourceType || '').toLowerCase() === 'directory'
                ? ''
                : String(chapter.resourceType || '').toUpperCase();
            const pageText = chapter.pageCount ? `${chapter.pageCount}P` : '';
            const metaText = [typeText, pageText].filter(Boolean).join(' · ');
            const versionCount = Number(chapter.versionCount || 0);
            if (versionCount > 1) item.classList.add('has-versions');

            item.innerHTML = `
                <span>${this.escapeHtml(chapter.chapterTitle)}</span>
                ${metaText ? `<small>${this.escapeHtml(metaText)}</small>` : ''}
                ${versionCount > 1 ? `<em class="chapter-version-badge">${versionCount} 个版本</em>` : ''}
            `;
            if (versionCount > 1 || chapter.manualGrouping) {
                const menuButton = document.createElement('button');
                menuButton.type = 'button';
                menuButton.className = 'chapter-version-more';
                menuButton.setAttribute('aria-label', '章节版本操作');
                menuButton.textContent = '•••';
                menuButton.onclick = event => this.openChapterVersionMenu(event, chapter);
                item.appendChild(menuButton);
            }
            item.onclick = event => {
                if (event.target.closest('.chapter-version-more')) return;
                this.openReader(chapter);
            };
            item.setAttribute('role', 'button'); item.tabIndex = 0;
            item.onkeydown = event => { if (event.target === item && ['Enter', ' '].includes(event.key)) { event.preventDefault(); this.openReader(chapter); } };

            // 长按上下文菜单
            let pressTimer = null;
            let pressed = false;
            const startPress = (e) => {
                pressed = false;
                pressTimer = setTimeout(() => {
                    pressed = true;
                    e.preventDefault();
                    const rect = item.getBoundingClientRect();
                    if (!chapter.resourceId) {
                        this.showContextMenu(rect.left + rect.width / 2, rect.bottom + 4, chapter);
                    }
                }, 500);
            };
            const cancelPress = () => {
                if (pressTimer) clearTimeout(pressTimer);
            };
            const endPress = (e) => {
                cancelPress();
                if (pressed) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            };

            item.addEventListener('touchstart', startPress, { passive: false });
            item.addEventListener('touchmove', cancelPress, { passive: true });
            item.addEventListener('touchend', endPress);
            item.addEventListener('touchcancel', cancelPress);
            // 桌面端：右键
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                if (chapter.resourceId && Number(chapter.versionCount || 0) > 1) {
                    this.openChapterVersionMenu(e, chapter);
                } else if (!chapter.resourceId) {
                    this.showContextMenu(e.clientX, e.clientY, chapter);
                }
            });

            list.appendChild(item);
        });
    },

    openChapterVersionMenu(event, chapter) {
        const versions = Array.isArray(chapter?.versions) ? chapter.versions : [];
        if (!chapter || versions.length === 0) return;
        const items = versions.map(version => ({
            label: `${version.sourceAlias || version.sourceTitle || '版本'}${version.recentlyRead ? ' · 最近阅读' : ''}`,
            action: () => this.openReader({
                ...chapter,
                chapterUuid: version.resourceId || chapter.chapterUuid,
                resourceId: version.resourceId,
                seriesId: version.seriesId,
                sourceId: version.sourceId,
                resourceType: version.type || chapter.resourceType,
                pageCount: version.pageCount || chapter.pageCount,
            }),
        }));
        if (this.state.role === 'reader') { this.openResourceMenu(event, items); return; }
        items.push({ separator: true });
        const manualVersion = versions.find(version => version.manualSplit);
        if (manualVersion) {
            items.push({
                label: '恢复智能分组',
                action: () => this.restoreResourceGrouping(manualVersion.resourceId, 'chapter'),
            });
        } else {
            items.push({
                label: '拆分为独立章节',
                action: () => this.splitResourceGrouping(chapter.resourceId, 'chapter'),
            });
        }
        this.openResourceMenu(event, items);
    },

    // ─── Context Menu ───
    showContextMenu(x, y, chapter) {
        if (this.state.role === 'reader') return;
        const menu = document.getElementById('context-menu');
        const btn = document.getElementById('ctx-delete-chapter');

        // 克隆按钮以移除旧事件
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeContextMenu();
            this.deleteChapter(chapter.groupName, chapter.order, chapter.chapterTitle);
        });

        // 定位
        menu.style.display = 'block';
        const mw = menu.offsetWidth;
        const mh = menu.offsetHeight;
        const maxX = window.innerWidth - mw - 8;
        const maxY = window.innerHeight - mh - 8;
        menu.style.left = Math.min(Math.max(8, x - mw / 2), maxX) + 'px';
        menu.style.top = Math.min(y, maxY) + 'px';
    },

    closeContextMenu() {
        document.getElementById('context-menu').style.display = 'none';
    },

    // ─── Reader ───
    readerChapterList(chapter, options = {}) {
        const existing = this.state.allChapters || [];
        const kind = item => item.contentType || 'chapter';
        const sameResource = item => chapter.resourceId
            ? item.resourceId === chapter.resourceId
            : item.chapterUuid === chapter.chapterUuid;
        // Cross-book navigation and reloads reuse the queue chosen at session entry.
        if (Array.isArray(options.chapterList) && options.chapterList.length) {
            return options.chapterList.filter(item => kind(item) === kind(chapter));
        }
        if (chapter.isVolumeSubChapter) {
            return existing.some(item => item.chapterUuid === chapter.chapterUuid)
                ? existing.filter(item => item.resourceId === chapter.resourceId)
                : [chapter];
        }
        const candidates = (this.state.currentComic?.groups?.[this.state.currentGroup] || [])
            .filter(item => kind(item) === kind(chapter))
            .slice().sort((a, b) => a.order - b.order);
        if (kind(chapter) !== 'volume') {
            return candidates.map(item => sameResource(item) ||
                item.versions?.some(version => version.resourceId === chapter.resourceId) ? chapter : item)
                .filter(item => item.readable !== false || sameResource(item));
        }
        const books = new Map();
        for (const item of candidates) {
            const key = item.bookKey || item.resourceId || item.chapterUuid;
            if (!books.has(key)) books.set(key, []);
            books.get(key).push(item);
        }
        return [...books.values()].flatMap(versions => {
            if (versions.some(sameResource)) return [chapter];
            const readable = versions.filter(item => item.readable !== false);
            const preferred = readable.filter(item => chapter.sourceId
                ? item.sourceId === chapter.sourceId
                : chapter.seriesId && item.seriesId === chapter.seriesId);
            const selected = preferred.find(item => item.seriesId === chapter.seriesId) || preferred[0] || readable[0];
            return selected ? [selected] : [];
        });
    },

    async openReader(chapter, options = {}) {
        if (String(chapter?.resourceType || '').toLowerCase() === 'epub') {
            return this.openNovelReader(chapter, options);
        }
        const loadToken = Date.now();
        this._readerLoadToken = loadToken;
        this._readerForceRefresh = options.forceRefresh === true;
        try {
            this._exitNovelMode();
            this.state.currentChapter = chapter;
            this.state.currentImages = [];
            this.state.currentPage = Number.isInteger(options.startPage) ? options.startPage : 0;
            document.getElementById('reader-title').textContent =
                `${this.state.currentComic?.comic?.name || ''} — ${chapter.chapterTitle || ''}`;
            this.showPage('reader-page');
            document.querySelectorAll('.slide-page .image-container').forEach(container => {
                container.innerHTML = '';
            });
            this._exitStripMode();
            this.resetImageZoom();
            this.setReaderStatus('正在加载页面...');

            const chapters = this.readerChapterList(chapter, options);
            this.state.allChapters = chapters;
            this.state.currentChapterIndex = chapters.findIndex(
                c => c.chapterUuid === chapter.chapterUuid
            );

            if (chapter.resourceId) {
                const params = new URLSearchParams();
                const sliceResourcePages = options.sliceResourcePages === true;
                if (sliceResourcePages && chapter.sourceStartPage) params.set('startPage', String(chapter.sourceStartPage));
                if (sliceResourcePages && chapter.sourcePageCount) params.set('pageCount', String(chapter.sourcePageCount));
                const query = params.toString() ? `?${params.toString()}` : '';
                const res = await this.authFetch(
                    `/api/resources/${encodeURIComponent(chapter.resourceId)}/pages${query}`
                );
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || '资源打开失败');
                this.state.currentImages = data.pages.map(url => this.withAssetToken(url));
            } else {
                const chapterDir = this.buildChapterDir(chapter);
                const groupName = chapter.groupName;

                const res = await this.authFetch(
                    `/api/comics/${encodeURIComponent(this.state.currentComic.comic.id)}/${encodeURIComponent(groupName)}/${encodeURIComponent(chapterDir)}/images`
                );
                const data = await res.json();

                this.state.currentImages = data.images.map(img =>
                    this.withAssetToken(
                        `/api/comics/${encodeURIComponent(this.state.currentComic.comic.id)}/${encodeURIComponent(groupName)}/${encodeURIComponent(chapterDir)}/image/${encodeURIComponent(img)}`
                    )
                );
            }
            if (this._readerLoadToken !== loadToken) return;

            // 恢复阅读进度（优先服务器端）
            const comicId = this.state.currentComic.comic.id;
            let savedPage = 0;
            if (Number.isInteger(options.startPage) && options.startPage >= 0) {
                savedPage = options.startPage;
            } else {
                try {
                    const pRes = await this.authFetch(`/api/progress/${encodeURIComponent(comicId)}`);
                    const progress = await pRes.json();
                    if (progress.chapters?.[chapter.chapterUuid]) {
                        savedPage = progress.chapters[chapter.chapterUuid].page || 0;
                        if (chapter.isVolumeSubChapter && chapter.sourceStartPage && options.sliceResourcePages !== true) {
                            savedPage += Math.max(0, Number(chapter.sourceStartPage || 1) - 1);
                        }
                    } else if (progress.lastChapterUuid === chapter.chapterUuid && progress.lastPage != null) {
                        savedPage = Math.max(0, Number(progress.lastPage || 0));
                    }
                } catch (e) {}
            }
            if (this.state.currentImages.length > 0) {
                savedPage = Math.min(savedPage, this.state.currentImages.length - 1);
                if (savedPage < 0) savedPage = 0;
            } else {
                savedPage = 0;
            }
            this.state.currentPage = savedPage;

            document.getElementById('reader-title').textContent =
                `${this.state.currentComic.comic.name} — ${chapter.chapterTitle}`;

            const slider = document.getElementById('page-slider');
            slider.max = this.state.currentImages.length;

            this.state.uiVisible = false;
            document.getElementById('reader-ui').classList.remove('visible');
            document.getElementById('settings-panel').classList.remove('active');

            // 重置滑动状态
            if (this._swipe) this._swipe.animating = false;

            // 清理旧的条漫容器（切换章节时）
            const oldStrip = document.getElementById('strip-container');
            if (oldStrip) {
                if (this._stripScrollHandler) {
                    oldStrip.removeEventListener('scroll', this._stripScrollHandler);
                    this._stripScrollHandler = null;
                }
                oldStrip.remove();
            }

            // 加载当前漫画的条漫模式设置
            this.loadStripModeForComic(comicId);

            this.applySettings();
            this.renderPage();
            this.clearReaderStatus();
            this.preloadAdjacent();
        } catch (error) {
            console.error('Failed to open reader:', error);
            this.setReaderStatus(error.message || '页面加载失败', [
                { text: '重试', action: () => this.reloadCurrentReader() },
                { text: '返回', action: () => this.showPage('comic-detail-page') },
            ]);
        }
    },

    makeNovelChapter(baseChapter, manifestChapter, index) {
        const chapterNumber = index + 1;
        const baseTitle = baseChapter?.chapterTitle || this.state.currentComic?.comic?.name || '';
        const title = manifestChapter?.title || `章节 ${chapterNumber}`;
        return {
            ...baseChapter,
            chapterUuid: `${baseChapter.resourceId}::epub::${chapterNumber}`,
            chapterTitle: title === baseTitle ? title : `${baseTitle} · ${title}`,
            groupName: baseChapter.groupName || '章节',
            order: chapterNumber,
            resourceId: baseChapter.resourceId,
            resourceType: 'epub',
            sourceStartPage: chapterNumber,
            sourcePageCount: 1,
            isVolumeSubChapter: true,
            epubChapterIndex: index,
        };
    },

    ensureNovelContainer() {
        const viewport = document.getElementById('reader-viewport');
        let container = document.getElementById('novel-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'novel-container';
            container.innerHTML = `
                <div id="epub-viewer" class="epub-viewer"></div>
                <div id="novel-page-badge" class="novel-page-badge" aria-live="polite"></div>
            `;
            viewport.appendChild(container);
        }
        return container;
    },

    async openNovelReader(chapter, options = {}) {
        const loadToken = Date.now();
        this._readerLoadToken = loadToken;
        this._readerForceRefresh = options.forceRefresh === true;
        try {
            this._exitStripMode();
            this._exitNovelMode();
            this.state.novelMode = true;
            this.state.novelReadingMode = 'paged';
            this.state.currentChapter = chapter;
            this.state.currentImages = [];
            this.showPage('reader-page');
            this.setReaderStatus('\u6b63\u5728\u52a0\u8f7d\u5c0f\u8bf4...');
            document.getElementById('slide-track').style.display = 'none';
            const touchLayer = document.getElementById('reader-touch-layer');
            const useTouchOverlay = this.shouldUseEpubTouchOverlay();
            touchLayer.style.display = useTouchOverlay ? '' : 'none';
            touchLayer.classList.toggle('novel-touch-layer', useTouchOverlay);
            document.getElementById('reader-viewport').classList.add('novel-mode');
            this.applyNovelModeClass();
            const container = this.ensureNovelContainer();

            if (typeof window.ePub !== 'function') {
                throw new Error('epub.js \u672a\u52a0\u8f7d\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc');
            }

            const fontPrime = this.primeNovelFont();

            const bookUrl = this.withAssetToken(`/api/resources/${encodeURIComponent(chapter.resourceId)}/epub/file`);
            const book = window.ePub(bookUrl, { openAs: 'epub' });
            this._epubBook = book;
            this._epubBookUrl = bookUrl;
            this._epubResourceId = chapter.resourceId;
            this.prepareEpubCompatibilityFallbacks(book);
            this.invalidateEpubPageMap();

            const viewerEl = container.querySelector('#epub-viewer');
            viewerEl.innerHTML = '';
            const flow = this.state.novelReadingMode === 'scroll' ? 'scrolled-doc' : 'paginated';
            const rendition = book.renderTo(viewerEl, {
                width: '100%',
                height: '100%',
                flow,
                manager: 'default',
                spread: this.epubSpreadMode(),
                minSpreadWidth: this.epubMinSpreadWidth(),
                snap: true,
                allowScriptedContent: false,
            });
            this._epubRendition = rendition;
            this._epubReady = false;

            this.registerEpubThemes(rendition);
            rendition.themes.select(this.epubThemeName());
            rendition.themes.font(this.epubFontFamily());
            rendition.themes.fontSize(`${this.state.novelFontSize}px`);

            // Inject fonts + key/click handlers BEFORE first paint via content hook
            rendition.hooks.content.register((contents) => {
                return this.installEpubContentHooks(contents);
            });

            rendition.on('relocated', (location) => this.onEpubRelocated(location));

            // Fallback click on rendition itself (some epub.js builds dispatch here)
            rendition.on('click', (event) => {
                if (!event) return;
                this.handleIframeClick(event, window);
            });

            // Build chapters list from server manifest (for slider/title fallback)
            try {
                const mRes = await this.authFetch(
                    `/api/resources/${encodeURIComponent(chapter.resourceId)}/epub/manifest`
                );
                const manifest = await mRes.json();
                if (mRes.ok) {
                    this.state.currentNovel = { manifest, resourceId: chapter.resourceId };
                    const tocFlat = Array.isArray(manifest.tocFlat) ? manifest.tocFlat : [];
                    if (tocFlat.length > 0) {
                        this.state.allChapters = tocFlat.map((item, index) => ({
                            ...chapter,
                            chapterUuid: `${chapter.resourceId}::epub-toc::${index}`,
                            chapterTitle: item.title || `章节 ${index + 1}`,
                            resourceId: chapter.resourceId,
                            resourceType: 'epub',
                            order: index + 1,
                            epubChapterIndex: Number.isInteger(item.chapterIndex) ? item.chapterIndex : null,
                            href: item.href || '',
                            depth: Number.isInteger(item.depth) ? item.depth : 0,
                        }));
                        this._novelTocFromManifest = true;
                    } else {
                        this.state.allChapters = (manifest.chapters || []).map((item, index) =>
                            this.makeNovelChapter(chapter, item, index)
                        );
                        this._novelTocFromManifest = false;
                    }
                }
            } catch (e) {}

            // Load saved progress (CFI)
            let startTarget = null;
            try {
                const pRes = await this.authFetch(
                    `/api/progress/${encodeURIComponent(this.state.currentComic.comic.id)}`
                );
                const progress = await pRes.json();
                this.state.progressCache[this.state.currentComic.comic.id] = progress;
                if (!options.forceStart && progress?.lastResourceId === chapter.resourceId &&
                    progress.lastResourceType === 'epub' && progress.lastCfi) {
                    startTarget = progress.lastCfi;
                }
                if (Number.isInteger(options.startPage) && options.startPage >= 0 && !startTarget) {
                    // EPUB 目录章节传入的是 spine 的 0 基索引。
                    startTarget = options.startPage;
                }
            } catch (e) {}

            await this.waitForEpubCoreReady(book);
            if (this._readerLoadToken !== loadToken) return;

            // Build TOC from book.navigation only when server TOC is unavailable.
            try {
                const flat = [];
                const walk = (nodes, depth = 0) => {
                    for (const n of nodes || []) {
                        flat.push({
                            chapterTitle: n.label?.trim() || `章节 ${flat.length + 1}`,
                            href: n.href || '',
                            depth,
                            chapterUuid: `${chapter.resourceId}::epub::${flat.length}`,
                            resourceId: chapter.resourceId,
                            resourceType: 'epub',
                            order: flat.length + 1,
                            comicId: chapter.comicId,
                            groupName: chapter.groupName,
                        });
                        if (n.subitems && n.subitems.length) walk(n.subitems, depth + 1);
                    }
                };
                let navigation = book.navigation || null;
                if (!this._novelTocFromManifest && this._epubNavigationPromise) {
                    navigation = await Promise.race([
                        this._epubNavigationPromise,
                        new Promise(resolve => setTimeout(() => resolve(null), 1200)),
                    ]) || navigation;
                }
                walk(!this._novelTocFromManifest ? (navigation?.toc || []) : []);
                if (!this._novelTocFromManifest && flat.length > 0) {
                    this.state.allChapters = flat;
                    this._novelTocFromBook = true;
                }
            } catch (e) {}

            // Generate locations before first display so the footer is page/total, not percent.
            try {
                await this.withTimeout(book.locations.generate(1600), 8000, 'EPUB 位置生成超时');
                this._epubLocationsReady = true;
            } catch (e) {
                this._epubLocationsReady = false;
            }

            if (startTarget !== null && typeof startTarget === 'number') {
                const spineItem = book.spine.get(startTarget);
                await this.withFontTimeout(fontPrime);
                await rendition.display(spineItem ? spineItem.href : undefined);
            } else {
                await this.withFontTimeout(fontPrime);
                await rendition.display(startTarget || undefined);
            }
            this._epubReady = true;
            this.state.uiVisible = false;
            document.getElementById('reader-ui').classList.remove('visible');
            document.getElementById('settings-panel').classList.remove('active');
            this.applySettings();
            this.updateNovelIndicator();
            this.scheduleEpubPageMapBuild();
            this.clearReaderStatus();
        } catch (error) {
            console.error('Failed to open novel:', error);
            this.setReaderStatus(error.message || '\u5c0f\u8bf4\u52a0\u8f7d\u5931\u8d25', [
                { text: '\u91cd\u8bd5', action: () => this.reloadCurrentReader() },
                { text: '\u8fd4\u56de', action: () => this.showPage('comic-detail-page') },
            ]);
        }
    },

    epubThemeName() { return 'darkTheme'; },

    isPhonePortraitViewport() {
        const width = window.innerWidth || document.documentElement.clientWidth || 0;
        const height = window.innerHeight || document.documentElement.clientHeight || 0;
        return width > 0 && height > width && width < 700;
    },

    epubSpreadMode() {
        return this.isPhonePortraitViewport() ? 'none' : 'auto';
    },

    epubMinSpreadWidth() {
        return this.isPhonePortraitViewport() ? 999999 : 700;
    },

    epubFontFamily() {
        const map = {
            kai: "'Reader Plus Kai','AR PL UKai CN','Kaiti SC','STKaitiSC-Regular','\u6977\u4f53-\u7b80','STKaiti','\u534e\u6587\u6977\u4f53','BiauKaiTC-Regular','\u6a19\u6977\u9ad4-\u7e41','BiauKai','KaiTi','\u6977\u4f53',serif",
            lxgw: "'LXGW WenKai','LXGW WenKai Screen','Songti SC','SimSun',serif",
            song: "'Noto Serif SC','Songti SC','STSong','SimSun','\u5b8b\u4f53',serif",
            hei: "'Noto Sans SC','PingFang SC','Microsoft YaHei','Heiti SC','SimHei',sans-serif",
            yuan: "'Yuanti SC','Hiragino Maru Gothic ProN','Noto Sans SC','PingFang SC','YouYuan',sans-serif",
            system: "-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif",
        };
        return map[this.state.novelFont] || map.kai;
    },

    epubWebFontHref() {
        if (this.state.novelFont === 'lxgw') {
            return 'https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/style.css';
        }
        if (this.state.novelFont === 'song') {
            return 'https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600&display=swap';
        }
        if (this.state.novelFont === 'hei' || this.state.novelFont === 'yuan') {
            return 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap';
        }
        return '';
    },

    epubFontLoadFamily() {
        const map = {
            kai: 'Reader Plus Kai',
            lxgw: 'LXGW WenKai',
            song: 'Noto Serif SC',
            hei: 'Noto Sans SC',
            yuan: 'Noto Sans SC',
        };
        return map[this.state.novelFont] || '';
    },

    installHostNovelFontFace() {
        if (this.state.novelFont !== 'kai') return;
        let style = document.getElementById('reader-plus-host-novel-font');
        if (!style) {
            style = document.createElement('style');
            style.id = 'reader-plus-host-novel-font';
            document.head.appendChild(style);
        }
        style.textContent = this.epubLocalFontFaceCss();
    },

    waitForFontLoad(doc, fontSize, afterCssReady = null) {
        const family = this.epubFontLoadFamily();
        if (!family || !doc?.fonts?.load) return Promise.resolve();
        const sample = '\u6c38\u4e66\u6977\u4f53\uff0c\u3002\u3001';
        return Promise.resolve(afterCssReady)
            .then(() => doc.fonts.load(`${fontSize}px "${family}"`, sample))
            .then(() => doc.fonts?.ready || null)
            .catch(() => {});
    },

    primeNovelFont() {
        this.installHostNovelFontFace();
        const family = this.epubFontLoadFamily();
        if (!family || !document.fonts?.load) return Promise.resolve();
        const key = `${this.state.novelFont}|${family}`;
        if (this._novelFontPrimeKey === key && this._novelFontPrimePromise) {
            return this._novelFontPrimePromise;
        }
        const fontSize = Math.max(12, Math.min(40, Number(this.state.novelFontSize || 20)));
        this._novelFontPrimeKey = key;
        this._novelFontPrimePromise = this.waitForFontLoad(document, fontSize).catch(() => {
            if (this._novelFontPrimeKey === key) {
                this._novelFontPrimeKey = '';
                this._novelFontPrimePromise = null;
            }
        });
        return this._novelFontPrimePromise;
    },

    withFontTimeout(promise, timeoutMs = 20000) {
        return Promise.race([
            Promise.resolve(promise),
            new Promise(resolve => setTimeout(resolve, timeoutMs)),
        ]).catch(() => {});
    },

    withTimeout(promise, timeoutMs = 15000, errorMessage = '操作超时') {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
            Promise.resolve(promise).then(
                value => {
                    clearTimeout(timer);
                    resolve(value);
                },
                error => {
                    clearTimeout(timer);
                    reject(error);
                }
            );
        });
    },

    ensureEpubPageListFallback(book) {
        if (!book || book.pageList) return;
        const fallback = {
            pages: [],
            locations: [],
            pageFromCfi() { return -1; },
            cfiFromPage() { return null; },
            pageFromPercentage() { return -1; },
            percentageFromPage() { return -1; },
            load() { return Promise.resolve(this); },
            parse() { return this; },
        };
        try { book.pageList = fallback; } catch (e) {}
    },

    prepareEpubCompatibilityFallbacks(book) {
        if (!book) return;
        if (book.ready?.catch) {
            book.ready.catch(error => {
                console.warn('EPUB ready failed, using manifest fallback:', error);
            });
        }
        if (book.loaded?.navigation?.then) {
            this._epubNavigationPromise = book.loaded.navigation.catch(error => {
                console.warn('EPUB navigation failed, using server TOC fallback:', error);
                return null;
            });
        } else {
            this._epubNavigationPromise = Promise.resolve(book.navigation || null);
        }
        if (book.loaded?.pageList?.then) {
            book.loaded.pageList.then(
                () => this.ensureEpubPageListFallback(book),
                () => this.ensureEpubPageListFallback(book)
            );
        } else {
            this.ensureEpubPageListFallback(book);
        }
    },

    async waitForEpubCoreReady(book, timeoutMs = 15000) {
        if (!book?.loaded) throw new Error('EPUB 初始化失败');
        const required = ['manifest', 'spine', 'resources', 'displayOptions'];
        const optional = ['metadata', 'cover', 'pageList'];
        const waits = [
            ...required.map(name => Promise.resolve(book.loaded[name])),
            ...optional.map(name => Promise.resolve(book.loaded[name]).catch(() => null)),
        ].filter(Boolean);
        await this.withTimeout(Promise.all(waits), timeoutMs, 'EPUB 基础信息加载超时');
        this.ensureEpubPageListFallback(book);
    },

    shouldUseEpubTouchOverlay() {
        const ua = navigator.userAgent || '';
        const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const isSafari = /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|FxiOS|Edg|EdgiOS|OPR|OPiOS)\//.test(ua);
        return isIOS || isSafari;
    },

    installEpubWebFont(doc) {
        const href = this.epubWebFontHref();
        if (!doc?.head) return null;
        doc.querySelectorAll('link[data-reader-plus-font]').forEach(link => {
            if (!href || link.dataset.readerPlusFont !== href) link.remove();
        });
        if (!href) return null;
        let link = doc.querySelector(`link[data-reader-plus-font="${href}"]`);
        const waitForFonts = () => doc.fonts && typeof doc.fonts.ready?.then === 'function'
            ? doc.fonts.ready.catch(() => {})
            : Promise.resolve();
        if (!link) {
            link = doc.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            link.crossOrigin = 'anonymous';
            link.dataset.readerPlusFont = href;
            const linkReady = new Promise(resolve => {
                link.onload = () => {
                    link.dataset.readerPlusFontLoaded = '1';
                    resolve();
                };
                link.onerror = resolve;
                setTimeout(resolve, 5000);
            });
            doc.head.appendChild(link);
            return linkReady.then(waitForFonts);
        }
        return waitForFonts();
    },

    epubLocalFontFaceCss() {
        if (this.state.novelFont !== 'kai') return '';
        const punctuationUrl = new URL('/fonts/reader-plus-kai-punctuation.ttf', window.location.href).href;
        return `
            @font-face {
                font-family: 'Reader Plus Kai';
                src: url('https://cdn.jsdelivr.net/npm/@fontpkg/ar-pl-u-kai-cn@0.2.20080216/UKaiCN.ttf') format('truetype'),
                     local('AR PL UKai CN'), local('UKaiCN'),
                     local('Kaiti SC'), local('Kaiti SC Regular'), local('STKaitiSC-Regular'),
                     local('\u6977\u4f53-\u7b80'), local('\u6977\u4f53-\u7b80 \u5e38\u89c4\u4f53'),
                     local('STKaiti'), local('\u534e\u6587\u6977\u4f53'),
                     local('BiauKaiTC-Regular'), local('\u6a19\u6977\u9ad4-\u7e41'), local('BiauKai'),
                     local('KaiTi'), local('\u6977\u4f53');
                font-weight: 400;
                font-style: normal;
                font-display: block;
            }
            /* UKai CN 的这三个字形居中；局部字库保留笔形和字宽，改用横排靠下标点。 */
            @font-face {
                font-family: 'Reader Plus Kai';
                src: url('${punctuationUrl}') format('truetype');
                unicode-range: U+3001-3002, U+FF0C;
                font-weight: 400;
                font-style: normal;
                font-display: block;
            }
        `;
    },

    syncEpubTypographyDocument(doc, options = {}) {
        if (!doc?.head) return null;
        const fontSize = Math.max(12, Math.min(40, Number(this.state.novelFontSize || 20)));
        const hideUntilReady = options.hideUntilReady === true && !!this.epubFontLoadFamily();
        if (hideUntilReady) {
            doc.documentElement?.classList?.remove('reader-plus-font-ready');
            doc.documentElement?.classList?.add('reader-plus-font-loading');
        }
        const fontReady = this.installEpubWebFont(doc);
        const fontFamily = this.epubFontFamily();
        doc.getElementById('reader-plus-font')?.remove();
        let style = doc.getElementById('reader-plus-typography');
        if (!style) {
            style = doc.createElement('style');
            style.id = 'reader-plus-typography';
            doc.head.appendChild(style);
        }
        style.textContent = `
            ${this.epubLocalFontFaceCss()}
            html.reader-plus-font-loading body {
                opacity: 0 !important;
            }
            html.reader-plus-font-ready body {
                opacity: 1 !important;
            }
            html, body {
                font-family: ${fontFamily} !important;
                font-size: ${fontSize}px !important;
                line-height: 1.85 !important;
            }
            p, span, div, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, a, ruby, rt, em, strong {
                font-family: ${fontFamily} !important;
            }
        `;
        try {
            doc.documentElement?.style?.setProperty('font-family', fontFamily, 'important');
            doc.body?.style?.setProperty('font-family', fontFamily, 'important');
            doc.body?.style?.setProperty('font-size', `${fontSize}px`, 'important');
        } catch (e) {}
        const documentFontReady = this.waitForFontLoad(doc, fontSize, fontReady);
        const ready = Promise.all([fontReady, documentFontReady].filter(Boolean)).catch(() => {});
        if (!hideUntilReady) return ready;
        const reveal = () => {
            doc.documentElement?.classList?.remove('reader-plus-font-loading');
            doc.documentElement?.classList?.add('reader-plus-font-ready');
        };
        return this.withFontTimeout(ready).then(reveal, reveal);
    },

    registerEpubThemes(rendition) {
        const fontFamily = this.epubFontFamily();
        const baseRules = {
            'html, body': {
                'background': '#111 !important',
                'color': '#f1eee8 !important',
                'font-family': `${fontFamily} !important`,
                'line-height': '1.85 !important',
                'padding': '0 !important',
            },
            'p, span, div, li, td, th, h1, h2, h3, h4, h5, h6, blockquote': {
                'font-family': 'inherit !important',
                'color': 'inherit !important',
            },
            'a, a:link, a:visited': {
                'color': '#7ab7ff !important',
                'text-decoration': 'none !important',
            },
            'img, svg, image, picture': {
                'max-width': '100% !important',
                'max-height': '90vh !important',
                'page-break-inside': 'avoid',
                'break-inside': 'avoid',
                'cursor': 'zoom-in',
            },
            'figure': { 'page-break-inside': 'avoid', 'break-inside': 'avoid' },
            'table': { 'max-width': '100% !important' },
        };
        rendition.themes.register('darkTheme', baseRules);
    },

    installEpubContentHooks(contents) {
        const doc = contents?.document;
        const win = contents?.window;
        if (!doc || !win) return;
        try {
            let style = doc.getElementById('reader-plus-fix');
            if (!style) {
                style = doc.createElement('style');
                style.id = 'reader-plus-fix';
                doc.head.appendChild(style);
            }
            style.textContent = `
                html, body {
                    background:#111 !important;
                    color:#f1eee8 !important;
                }
                p, span, div, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, a {
                    color: inherit !important;
                }
                img, svg, image, picture {
                    max-width: 100% !important;
                    max-height: 90vh !important;
                    page-break-inside: avoid;
                    break-inside: avoid;
                    cursor: zoom-in;
                }
                figure, p:has(> img:only-child) {
                    page-break-inside: avoid;
                    break-inside: avoid;
                }
                a, a:link, a:visited { color: #7ab7ff; text-decoration: none; }
            `;
            const fontReady = this.syncEpubTypographyDocument(doc, { hideUntilReady: true });

            // 3. iframe 内键盘与点击
            doc.addEventListener('keydown', (e) => this.handleIframeKey(e));
            doc.addEventListener('click', (e) => this.handleIframeClick(e, win), true);
            return fontReady;
        } catch (e) {}
    },

    handleIframeKey(e) {
        if (!this._epubRendition) return;
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
            e.preventDefault();
            this.epubPrev();
        } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
            e.preventDefault();
            this.epubNext();
        } else if (e.key === 'Escape') {
            this.state.uiVisible ? this.hideUI() : this.exitReader();
        }
    },

    handleIframeClick(e, win) {
        if (!this._epubRendition) return;
        const now = Date.now();
        if (now - (this._lastEpubTapAt || 0) < 80) return;
        this._lastEpubTapAt = now;
        const target = e.target;
        // Image / link / form widgets handled separately
        if (target && target.tagName === 'IMG') {
            e.preventDefault();
            e.stopPropagation();
            this.openImageLightbox(target.currentSrc || target.src);
            return;
        }
        if (target && /^(A|BUTTON|INPUT|SELECT|TEXTAREA|VIDEO|AUDIO)$/.test(target.tagName)) return;
        const frame = win?.frameElement || null;
        const frameRect = frame?.getBoundingClientRect?.() || null;
        const x = frameRect ? frameRect.left + (e.clientX || 0) : (e.clientX || 0);
        const w = window.innerWidth || (win && win.innerWidth) || 1;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        if (x < w * 0.30) this.epubPrev();
        else if (x > w * 0.70) this.epubNext();
        else this.toggleUI();
    },

    handleEpubOverlayInteractiveTap(e) {
        const clientX = Number(e?.clientX);
        const clientY = Number(e?.clientY);
        if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
        const hit = this.findEpubContentAtPoint(clientX, clientY);
        if (!hit?.element) return false;
        return this.handleEpubInteractiveElement(hit.element, hit);
    },

    findEpubContentAtPoint(clientX, clientY) {
        const frames = Array.from(document.querySelectorAll('#epub-viewer iframe'));
        for (const frame of frames) {
            try {
                const rect = frame.getBoundingClientRect();
                if (clientY < rect.top || clientY > rect.bottom || clientX < rect.left || clientX > rect.right) continue;
                const doc = frame.contentDocument || frame.contentWindow?.document;
                const win = frame.contentWindow;
                if (!doc || !win) continue;
                const localX = clientX - rect.left;
                const localY = clientY - rect.top;
                const element = doc.elementFromPoint(localX, localY);
                if (element) return { element, doc, win, frame, localX, localY };
            } catch (error) {}
        }
        return null;
    },

    handleEpubInteractiveElement(element, hit = {}) {
        const node = element?.nodeType === 1 ? element : element?.parentElement;
        if (!node || typeof node.closest !== 'function') return false;
        const image = node.closest('img, image, picture');
        if (image) {
            const src = this.epubImageSource(image, hit.doc);
            if (src) {
                this.openImageLightbox(src);
                return true;
            }
        }
        const link = node.closest('a[href]');
        if (link) {
            const href = link.getAttribute('href') || '';
            if (this.displayEpubHref(href, hit)) return true;
            const absoluteHref = link.href || '';
            if (/^https?:\/\//i.test(absoluteHref)) {
                window.open(absoluteHref, '_blank', 'noopener');
                return true;
            }
            return true;
        }
        if (node.closest('button, input, select, textarea, video, audio, [role="button"], [role="link"]')) {
            return true;
        }
        return false;
    },

    epubImageSource(image, doc) {
        const raw = image.currentSrc || image.src ||
            image.getAttribute?.('src') ||
            image.getAttribute?.('href') ||
            image.getAttribute?.('xlink:href') || '';
        if (!raw) return '';
        if (/^(?:data:|blob:|https?:\/\/)/i.test(raw)) return raw;
        try { return new URL(raw, doc?.baseURI || window.location.href).href; } catch (e) { return raw; }
    },

    displayEpubHref(rawHref, hit = {}) {
        const raw = String(rawHref || '').trim();
        if (!raw || raw === '#' || /^(?:javascript|mailto|tel):/i.test(raw)) return false;
        if (/^https?:\/\//i.test(raw)) {
            window.open(raw, '_blank', 'noopener');
            return true;
        }
        const candidates = this.epubHrefCandidates(raw, hit);
        if (candidates.length === 0) return false;
        this._lastEpubTapAt = Date.now();
        this.tryDisplayEpubHrefCandidates(candidates);
        return true;
    },

    epubHrefCandidates(rawHref, hit = {}) {
        const currentHref = String(this._epubLocation?.start?.href || '').split('?')[0];
        const currentBase = currentHref.split('#')[0];
        const baseDir = currentBase.includes('/') ? currentBase.slice(0, currentBase.lastIndexOf('/') + 1) : '';
        let clean = String(rawHref || '').split('?')[0];
        try { clean = decodeURIComponent(clean); } catch (e) {}
        clean = clean.replace(/^\/+/, '');
        const candidates = [];
        const add = href => {
            const normalized = this.normalizeEpubRelativeHref(href);
            if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
        };
        if (clean.startsWith('#')) {
            add(`${currentBase}${clean}`);
        } else if (clean.startsWith('./') || clean.startsWith('../') || !clean.includes('/')) {
            add(`${baseDir}${clean}`);
            add(clean);
        } else {
            add(clean);
            add(`${baseDir}${clean}`);
        }
        const absolute = hit.element?.closest?.('a[href]')?.href || '';
        if (absolute && !/^https?:\/\//i.test(absolute)) add(absolute);
        return candidates;
    },

    normalizeEpubRelativeHref(href) {
        const text = String(href || '').trim();
        if (!text || /^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
        const hashIndex = text.indexOf('#');
        const hash = hashIndex >= 0 ? text.slice(hashIndex) : '';
        const pathPart = (hashIndex >= 0 ? text.slice(0, hashIndex) : text).replace(/^\/+/, '');
        const parts = [];
        pathPart.split('/').forEach(part => {
            if (!part || part === '.') return;
            if (part === '..') parts.pop();
            else parts.push(part);
        });
        return `${parts.join('/')}${hash}`;
    },

    async tryDisplayEpubHrefCandidates(candidates) {
        await this.withFontTimeout(this.primeNovelFont());
        for (const href of candidates) {
            try {
                await this._epubRendition.display(href);
                return;
            } catch (error) {}
        }
    },

    applyEpubFontFix() {
        if (!this._epubRendition) return;
        const contents = this._epubRendition.getContents() || [];
        return Promise.all(contents.map(content => {
            try {
                const doc = content.document;
                if (!doc) return null;
                return this.syncEpubTypographyDocument(doc, { hideUntilReady: true });
            } catch (e) {}
            return null;
        }).filter(Boolean)).catch(() => {});
    },

    handleEpubKey(e) {
        // legacy stub – iframe key events are now handled by handleIframeKey
        if (!this._epubRendition) return;
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') this.epubPrev();
        else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') this.epubNext();
    },

    async epubPrev() {
        if (!this._epubRendition) return;
        await this.withFontTimeout(this.primeNovelFont());
        if (this._epubRendition) return this._epubRendition.prev();
    },

    async epubNext() {
        if (!this._epubRendition) return;
        await this.withFontTimeout(this.primeNovelFont());
        if (this._epubRendition) return this._epubRendition.next();
    },

    _normalizeHref(href) {
        if (!href) return '';
        const s = String(href).split('#')[0].split('?')[0];
        const parts = s.split('/');
        return parts[parts.length - 1] || s;
    },

    onEpubRelocated(location) {
        this._epubLocation = location;
        const percentage = Number(location?.start?.percentage || 0) * 100;
        this.state.novelScrollPercent = percentage;
        try {
            const href = location?.start?.href;
            const baseHref = String(href || '').split('#')[0];
            const base = this._normalizeHref(href);
            const chapters = this.state.allChapters || [];
            // Match chapter by (a) book.navigation toc href base, (b) manifest spine href.
            let idx = chapters.findIndex(item => {
                const itemHref = String(item.href || '').split('#')[0];
                return itemHref && (itemHref === baseHref || this._normalizeHref(itemHref) === base);
            });
            if (idx < 0) {
                idx = chapters.findIndex(item => {
                    const ch = this.state.currentNovel?.manifest?.chapters?.[item.epubChapterIndex];
                    return ch && this._normalizeHref(ch.href) === base;
                });
            }
            if (idx >= 0) {
                this.state.currentChapterIndex = idx;
                this.state.currentChapter = chapters[idx];
                document.getElementById('reader-title').textContent =
                    `${this.state.currentComic.comic.name} \u2014 ${chapters[idx].chapterTitle}`;
                this._highlightTocItem(idx);
            }
        } catch (e) {}
        this.updateNovelIndicator();
        if (!this._novelSliderDragging || this._novelSliderCommitInFlight) {
            this.saveNovelProgress();
        }
    },

    async switchNovelChapter(index) {
        const chapters = this.state.allChapters || [];
        const target = chapters[Math.max(0, Math.min(index, chapters.length - 1))];
        if (!target || !this._epubBook || !this._epubRendition) return;
        await this.withFontTimeout(this.primeNovelFont());
        // 1) Spine index from server-parsed TOC is the most reliable path.
        try {
            const spineIdx = Number.isInteger(target.epubChapterIndex) ? target.epubChapterIndex :
                (Number.isInteger(target.chapterIndex) ? target.chapterIndex : index);
            const spineItem = this._epubBook.spine.get(spineIdx);
            if (spineItem && spineItem.href) {
                await this._epubRendition.display(spineItem.href);
                return;
            }
        } catch (e) {}
        // 2) Direct href from book.navigation / manifest as fallback.
        if (target.href) {
            try { await this._epubRendition.display(target.href); return; } catch (e) {}
        }
        // 3) Manifest spine href fallback.
        const ch = this.state.currentNovel?.manifest?.chapters?.[target.epubChapterIndex];
        if (ch?.href) await this._epubRendition.display(ch.href);
    },

    /* ===== TOC panel ===== */
    toggleNovelToc(force) {
        const panel = document.getElementById('novel-toc-panel');
        const backdrop = document.getElementById('novel-toc-backdrop');
        if (!panel) return;
        const show = typeof force === 'boolean' ? force : panel.style.display === 'none';
        if (show) {
            this.renderNovelToc();
            panel.style.display = 'flex';
            if (backdrop) backdrop.style.display = 'block';
        } else {
            panel.style.display = 'none';
            if (backdrop) backdrop.style.display = 'none';
        }
    },

    dismissNovelToc() {
        this.toggleNovelToc(false);
        this.hideUI();
    },

    renderNovelToc() {
        const list = document.getElementById('novel-toc-list');
        if (!list) return;
        const chapters = this.state.allChapters || [];
        list.innerHTML = '';
        chapters.forEach((ch, i) => {
            const li = document.createElement('li');
            li.textContent = ch.chapterTitle || `\u7ae0\u8282 ${i + 1}`;
            li.dataset.idx = String(i);
            if (i === this.state.currentChapterIndex) li.classList.add('active');
            li.addEventListener('click', () => {
                this.switchNovelChapter(i);
                this.toggleNovelToc(false);
            });
            list.appendChild(li);
        });
    },

    _highlightTocItem(idx) {
        const list = document.getElementById('novel-toc-list');
        if (!list) return;
        list.querySelectorAll('li').forEach(li => {
            li.classList.toggle('active', Number(li.dataset.idx) === idx);
        });
    },

    /* ===== Image lightbox ===== */
    openImageLightbox(src) {
        if (!src) return;
        const box = document.getElementById('image-lightbox');
        const img = document.getElementById('image-lightbox-img');
        if (!box || !img) return;
        this._lightboxRotation = 0;
        this._lightboxOpenAnimated = false;
        img.onload = () => this.fitLightboxImage({ animateOpen: true });
        img.style.width = '';
        img.style.height = '';
        img.style.opacity = '0';
        img.style.transform = 'rotate(0deg) scale(.72)';
        img.src = src;
        box.style.display = 'flex';
        this.bindLightboxResize();
        if (img.complete) requestAnimationFrame(() => this.fitLightboxImage({ animateOpen: true }));
    },

    bindLightboxResize() {
        if (this._lightboxResizeHandler) return;
        this._lightboxResizeHandler = () => this.fitLightboxImage();
        window.addEventListener('resize', this._lightboxResizeHandler);
        window.addEventListener('orientationchange', this._lightboxResizeHandler);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', this._lightboxResizeHandler);
        }
    },

    unbindLightboxResize() {
        if (!this._lightboxResizeHandler) return;
        window.removeEventListener('resize', this._lightboxResizeHandler);
        window.removeEventListener('orientationchange', this._lightboxResizeHandler);
        if (window.visualViewport) {
            window.visualViewport.removeEventListener('resize', this._lightboxResizeHandler);
        }
        this._lightboxResizeHandler = null;
    },

    fitLightboxImage(options = {}) {
        const img = document.getElementById('image-lightbox-img');
        const box = document.getElementById('image-lightbox');
        if (!img || !box || box.style.display === 'none') return;

        const naturalWidth = img.naturalWidth || 0;
        const naturalHeight = img.naturalHeight || 0;
        if (!naturalWidth || !naturalHeight) return;

        const rotation = ((this._lightboxRotation || 0) % 360 + 360) % 360;
        const rotated = rotation === 90 || rotation === 270;
        const viewport = window.visualViewport || window;
        const maxWidth = Math.max(1, (viewport.width || window.innerWidth) * 0.92);
        const maxHeight = Math.max(1, (viewport.height || window.innerHeight) * 0.92);
        const visualWidth = rotated ? naturalHeight : naturalWidth;
        const visualHeight = rotated ? naturalWidth : naturalHeight;
        const fitScale = Math.min(maxWidth / visualWidth, maxHeight / visualHeight);
        const scale = Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1;

        img.style.width = `${naturalWidth}px`;
        img.style.height = `${naturalHeight}px`;

        if (options.animateOpen && !this._lightboxOpenAnimated) {
            this._lightboxOpenAnimated = true;
            img.style.transition = 'none';
            img.style.opacity = '0';
            img.style.transform = `rotate(${this._lightboxRotation || 0}deg) scale(${scale * 0.72})`;
            img.getBoundingClientRect();
            img.style.transition = '';
            requestAnimationFrame(() => {
                img.style.opacity = '';
                img.style.transform = `rotate(${this._lightboxRotation || 0}deg) scale(${scale})`;
            });
            return;
        }

        img.style.opacity = '';
        img.style.transform = `rotate(${this._lightboxRotation || 0}deg) scale(${scale})`;
    },

    rotateLightboxImage() {
        const img = document.getElementById('image-lightbox-img');
        if (!img) return;
        this._lightboxRotation = ((this._lightboxRotation || 0) - 90) % 360;
        this.fitLightboxImage();
    },

    closeImageLightbox(event) {
        if (event && event.target && event.target.tagName === 'IMG') return;
        const box = document.getElementById('image-lightbox');
        if (box) box.style.display = 'none';
        this._lightboxOpenAnimated = false;
        this.unbindLightboxResize();
    },

    changeNovelReadingMode(mode) {
        mode = 'paged';
        if (this.state.novelReadingMode === mode) return;
        this.state.novelReadingMode = mode;
        this.saveSettings();
        this.applySettings();
        if (this._epubRendition) {
            const flow = mode === 'scroll' ? 'scrolled-doc' : 'paginated';
            this._epubRendition.flow(flow);
            const cfi = this._epubLocation?.start?.cfi;
            if (cfi) this.withFontTimeout(this.primeNovelFont())
                .then(() => this._epubRendition?.display?.(cfi));
        }
    },

    applyNovelModeClass() {
        const viewport = document.getElementById('reader-viewport');
        const container = document.getElementById('novel-container');
        const readerUi = document.getElementById('reader-ui');
        const isPaged = this.state.novelMode && this.state.novelReadingMode === 'paged';
        if (readerUi) {
            readerUi.classList.toggle('novel-ui', this.state.novelMode);
        }
        if (viewport) {
            viewport.classList.toggle('novel-scroll', this.state.novelMode && !isPaged);
            viewport.classList.toggle('novel-paged', isPaged);
        }
        if (container) {
            container.classList.toggle('novel-scroll', !isPaged);
            container.classList.toggle('novel-paged', isPaged);
        }
    },

    currentNovelPositionPercent() {
        return Number(this.state.novelScrollPercent || 0);
    },

    applyNovelLayout() {
        this.applyNovelModeClass();
        if (this._epubRendition && this.state.novelReadingMode === 'paged') {
            this.invalidateEpubPageMap();
            try {
                if (typeof this._epubRendition.spread === 'function') {
                    this._epubRendition.spread(this.epubSpreadMode(), this.epubMinSpreadWidth());
                }
                if (typeof this._epubRendition.resize === 'function') {
                    this._epubRendition.resize('100%', '100%');
                }
                const cfi = this._epubLocation?.start?.cfi;
                if (cfi) this.withFontTimeout(this.primeNovelFont())
                    .then(() => this._epubRendition?.display?.(cfi));
            } catch (e) {}
        }
        this.updateNovelIndicator();
        this.scheduleEpubPageMapBuild();
    },

    getNovelPageInfo() {
        const loc = this._epubLocation;
        const displayed = loc?.start?.displayed;
        const bookLayoutPageInfo = this.getEpubBookLayoutPageInfo(loc);
        if (bookLayoutPageInfo) return bookLayoutPageInfo;
        const book = this._epubBook;
        if (book && loc && this._epubLocationsReady && book.locations.length() > 0) {
            const locationIndex = Number(book.locations.locationFromCfi(loc.start.cfi));
            const total = Number(book.locations.length());
            if (Number.isFinite(locationIndex) && Number.isFinite(total) && total > 0) {
                return {
                    current: Math.max(1, Math.min(total, locationIndex + 1)),
                    total,
                    source: 'book-locations',
                };
            }
        }
        if (displayed && Number(displayed.page) > 0 && Number(displayed.total) > 0) {
            return {
                current: Number(displayed.page),
                total: Number(displayed.total),
                source: 'layout',
            };
        }
        const pct = Math.round(Number(this.state.novelScrollPercent || 0));
        return { current: pct, total: 100, source: 'percent' };
    },

    getEpubPageMapKey(resourceId = this._epubResourceId) {
        const viewer = document.getElementById('epub-viewer');
        const rect = viewer?.getBoundingClientRect?.();
        const width = Math.round(rect?.width || viewer?.clientWidth || 0);
        const height = Math.round(rect?.height || viewer?.clientHeight || 0);
        if (!resourceId || width <= 0 || height <= 0) return '';
        return [
            resourceId,
            width,
            height,
            this.epubSpreadMode(),
            this.epubMinSpreadWidth(),
            this.state.novelFont,
            this.state.novelFontSize,
        ].join('|');
    },

    invalidateEpubPageMap() {
        this._epubBookPageMap = null;
        this._epubPageMapBuildToken = (this._epubPageMapBuildToken || 0) + 1;
    },

    scheduleEpubPageMapBuild() {
        if (!this.state.novelMode || !this._epubBookUrl || !this._epubResourceId) return;
        const key = this.getEpubPageMapKey();
        if (!key || this._epubBookPageMap?.key === key) return;
        if (this._epubPageMapScheduled) return;
        this._epubPageMapScheduled = true;
        setTimeout(() => {
            this._epubPageMapScheduled = false;
            this.buildEpubBookPageMap().catch(error => {
                console.warn('Failed to build EPUB page map:', error);
            });
        }, 0);
    },

    async buildEpubBookPageMap() {
        if (!this.state.novelMode || !this._epubBookUrl || typeof window.ePub !== 'function') return;
        const key = this.getEpubPageMapKey();
        if (!key || this._epubBookPageMap?.key === key) return;

        const viewer = document.getElementById('epub-viewer');
        const rect = viewer?.getBoundingClientRect?.();
        const width = Math.max(1, Math.round(rect?.width || viewer?.clientWidth || 0));
        const height = Math.max(1, Math.round(rect?.height || viewer?.clientHeight || 0));
        if (!width || !height) return;

        const token = (this._epubPageMapBuildToken || 0) + 1;
        this._epubPageMapBuildToken = token;
        const measureHost = document.createElement('div');
        measureHost.style.cssText = [
            'position:fixed',
            'left:-20000px',
            'top:0',
            `width:${width}px`,
            `height:${height}px`,
            'overflow:hidden',
            'visibility:hidden',
            'pointer-events:none',
            'z-index:-1',
        ].join(';');
        document.body.appendChild(measureHost);

        let measureBook = null;
        let measureRendition = null;
        try {
            measureBook = window.ePub(this._epubBookUrl, { openAs: 'epub' });
            measureRendition = measureBook.renderTo(measureHost, {
                width: '100%',
                height: '100%',
                flow: 'paginated',
                manager: 'default',
                spread: this.epubSpreadMode(),
                minSpreadWidth: this.epubMinSpreadWidth(),
                snap: true,
                allowScriptedContent: false,
            });
            this.registerEpubThemes(measureRendition);
            measureRendition.themes.select(this.epubThemeName());
            measureRendition.themes.font(this.epubFontFamily());
            measureRendition.themes.fontSize(`${this.state.novelFontSize}px`);
            measureRendition.hooks.content.register(contents => {
                const doc = contents?.document;
                if (!doc) return;
                try {
                    return this.syncEpubTypographyDocument(doc);
                } catch (e) {}
            });

            await measureBook.ready;
            if (token !== this._epubPageMapBuildToken || key !== this.getEpubPageMapKey()) return;

            const manifestChapters = this.state.currentNovel?.manifest?.chapters || [];
            const spineItems = measureBook.spine?.spineItems || [];
            const spineCount = Math.max(spineItems.length, manifestChapters.length);
            const totals = [];
            const hrefs = [];
            for (let i = 0; i < spineCount; i += 1) {
                if (token !== this._epubPageMapBuildToken || key !== this.getEpubPageMapKey()) return;
                const item = measureBook.spine?.get?.(i) || spineItems[i] || null;
                const target = item?.href || manifestChapters[i]?.href || i;
                try {
                    await measureRendition.display(target);
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    const locInfo = typeof measureRendition.currentLocation === 'function'
                        ? measureRendition.currentLocation()
                        : null;
                    const total = Number(locInfo?.start?.displayed?.total || locInfo?.end?.displayed?.total || 1);
                    totals[i] = Math.max(1, Math.round(total));
                    hrefs[i] = item?.href || locInfo?.start?.href || manifestChapters[i]?.href || '';
                } catch (e) {
                    totals[i] = 1;
                    hrefs[i] = item?.href || manifestChapters[i]?.href || '';
                }
            }

            if (token !== this._epubPageMapBuildToken || key !== this.getEpubPageMapKey()) return;
            let totalPages = 0;
            const prefixes = totals.map(total => {
                const prefix = totalPages;
                totalPages += Math.max(1, Number(total) || 1);
                return prefix;
            });
            this._epubBookPageMap = {
                key,
                resourceId: this._epubResourceId,
                totals,
                hrefs,
                prefixes,
                totalPages,
            };
            this.updateNovelIndicator();
        } finally {
            try { measureRendition?.destroy?.(); } catch (e) {}
            try { measureBook?.destroy?.(); } catch (e) {}
            measureHost.remove();
        }
    },

    getEpubLocationSpineIndex(location, pageMap = this._epubBookPageMap) {
        const directIndex = Number(location?.start?.index);
        if (Number.isInteger(directIndex) && directIndex >= 0) return directIndex;
        const href = String(location?.start?.href || '').split('#')[0];
        if (!href || !pageMap?.hrefs) return -1;
        const normalizedHref = this._normalizeHref(href);
        return pageMap.hrefs.findIndex(item => {
            const itemHref = String(item || '').split('#')[0];
            return itemHref === href || this._normalizeHref(itemHref) === normalizedHref;
        });
    },

    getEpubBookLayoutPageInfo(location = this._epubLocation) {
        const pageMap = this._epubBookPageMap;
        const displayed = location?.start?.displayed;
        if (!pageMap?.totalPages || !displayed) return null;
        const spineIndex = this.getEpubLocationSpineIndex(location, pageMap);
        if (spineIndex < 0 || spineIndex >= pageMap.totals.length) return null;
        const sectionTotal = Math.max(1, Number(pageMap.totals[spineIndex]) || Number(displayed.total) || 1);
        const sectionPage = Math.max(1, Math.min(sectionTotal, Number(displayed.page) || 1));
        return {
            current: Math.max(1, Math.min(pageMap.totalPages, (pageMap.prefixes[spineIndex] || 0) + sectionPage)),
            total: pageMap.totalPages,
            source: 'book-layout',
        };
    },

    updateNovelIndicator() {
        if (!this.state.novelMode) return;
        const indicator = document.getElementById('page-indicator');
        const slider = document.getElementById('page-slider');
        const badge = document.getElementById('novel-page-badge');
        if (!indicator || !slider) return;
        const pageInfo = this.getNovelPageInfo();
        const text = pageInfo.source === 'percent'
            ? `${pageInfo.current}%`
            : `${pageInfo.current} / ${pageInfo.total}`;
        indicator.textContent = '';
        indicator.style.display = 'none';
        if (badge) {
            badge.textContent = text;
            badge.style.display = text ? 'block' : 'none';
        }
        slider.style.display = '';
        slider.min = 0;
        slider.max = 1000;
        slider.step = 1;
        slider.style.direction = 'ltr';
        if (this._novelSliderDragging || this._novelSliderCommitInFlight) {
            this.updateNovelSliderPreview(this._novelSliderPendingValue ?? Number(slider.value));
            return;
        }
        slider.value = Math.round(this.getNovelProgressRatio(pageInfo) * 1000);
    },

    beginNovelSliderDrag() {
        if (!this.state.novelMode) return;
        this._novelSliderDragging = true;
        const slider = document.getElementById('page-slider');
        this._novelSliderPendingValue = Number(slider?.value || 0);
        this.updateNovelSliderPreview(this._novelSliderPendingValue);
    },

    endNovelSliderDrag() {
        this._novelSliderDragging = false;
        this._novelSliderCommitInFlight = false;
        this._novelSliderPendingValue = null;
        this.updateNovelIndicator();
    },

    previewNovelSlider(value) {
        if (!this.state.novelMode) return;
        this._novelSliderDragging = true;
        this.updateNovelSliderPreview(value);
        this.requestNovelSliderPageDisplay(this._novelSliderPendingValue);
    },

    updateNovelSliderPreview(value) {
        const slider = document.getElementById('page-slider');
        const badge = document.getElementById('novel-page-badge');
        if (!slider) return;
        const safeValue = this.clampNovelSliderValue(value);
        const max = this.novelSliderMax();
        const ratio = max > 0 ? safeValue / max : 0;
        this._novelSliderPendingValue = safeValue;
        slider.value = Math.round(safeValue);

        const currentInfo = this.getNovelPageInfo();
        let text = `${Math.round(ratio * 100)}%`;
        if (currentInfo && currentInfo.source !== 'percent' && Number(currentInfo.total) > 0) {
            const total = Number(currentInfo.total);
            const current = Math.max(1, Math.min(total, Math.round(ratio * total) || 1));
            text = `${current} / ${total}`;
        }
        if (badge) {
            badge.textContent = text;
            badge.style.display = text ? 'block' : 'none';
        }
    },

    commitNovelSlider(value) {
        if (!this.state.novelMode || !this._epubRendition) return Promise.resolve();
        this._novelSliderDragging = true;
        this._novelSliderCommitInFlight = true;
        this.updateNovelSliderPreview(value);
        const commitValue = this._novelSliderPendingValue ?? Number(value || 0);
        const displayPromise = this.requestNovelSliderPageDisplay(commitValue);
        if (this._novelSliderCommitPromise) return this._novelSliderCommitPromise;
        this._novelSliderCommitPromise = Promise.resolve(displayPromise)
            .catch(() => {})
            .finally(() => {
                this._novelSliderCommitPromise = null;
                this._novelSliderCommitInFlight = false;
                this.endNovelSliderDrag();
                this.saveNovelProgress();
            });
        return this._novelSliderCommitPromise;
    },

    novelSliderMax() {
        const slider = document.getElementById('page-slider');
        return Number(slider?.max || 1000) || 1000;
    },

    clampNovelSliderValue(value) {
        const max = this.novelSliderMax();
        return Math.max(0, Math.min(max, Number(value || 0)));
    },

    novelSliderRatio(value) {
        const max = this.novelSliderMax();
        return max > 0 ? this.clampNovelSliderValue(value) / max : 0;
    },

    getNovelSliderTargetCfi(value) {
        const book = this._epubBook;
        if (!book || !this._epubLocationsReady || book.locations.length() <= 0) return '';
        const ratio = this.novelSliderRatio(value);
        if (typeof book.locations.cfiFromPercentage === 'function') {
            return book.locations.cfiFromPercentage(ratio) || '';
        }
        return book.locations.cfiFromLocation(
            Math.max(1, Math.round(ratio * book.locations.length()))
        ) || '';
    },

    requestNovelSliderPageDisplay(value) {
        if (!this.state.novelMode || !this._epubRendition) return Promise.resolve();
        const safeValue = this.clampNovelSliderValue(value);
        this._novelSliderPendingDisplayValue = safeValue;
        if (this._novelSliderDisplayLoopPromise) return this._novelSliderDisplayLoopPromise;

        this._novelSliderDisplayLoopPromise = (async () => {
            let displayedValue = null;
            while (this.state.novelMode && this._epubRendition) {
                const nextValue = this._novelSliderPendingDisplayValue;
                if (!Number.isFinite(nextValue) || Math.round(nextValue) === Math.round(displayedValue ?? NaN)) break;
                this._novelSliderPendingDisplayValue = null;
                displayedValue = nextValue;
                await this.displayNovelSliderValue(nextValue);
                const pendingValue = this._novelSliderPendingDisplayValue;
                if (!this._novelSliderDragging && !this._novelSliderCommitInFlight) break;
                if (!Number.isFinite(pendingValue) || Math.round(pendingValue) === Math.round(displayedValue)) break;
            }
        })()
            .catch(() => {})
            .finally(() => {
                this._novelSliderDisplayLoopPromise = null;
            });
        return this._novelSliderDisplayLoopPromise;
    },

    async displayNovelSliderValue(value) {
        const cfi = this.getNovelSliderTargetCfi(value);
        if (!cfi || !this._epubRendition) return;
        await this.withFontTimeout(this.primeNovelFont(), 1200);
        if (this._epubRendition) await this._epubRendition.display(cfi);
    },

    getNovelProgressRatio(pageInfo = null) {
        const locationPercentage = Number(this._epubLocation?.start?.percentage);
        if (Number.isFinite(locationPercentage) && locationPercentage >= 0) {
            return Math.max(0, Math.min(1, locationPercentage));
        }
        const savedPercent = Number(this.state.novelScrollPercent || 0) / 100;
        if (Number.isFinite(savedPercent) && savedPercent >= 0) {
            return Math.max(0, Math.min(1, savedPercent));
        }
        if (pageInfo && Number(pageInfo.total) > 0) {
            return Math.max(0, Math.min(1, Number(pageInfo.current || 0) / Number(pageInfo.total)));
        }
        return 0;
    },

    setNovelPage() { /* no-op: epub.js manages pagination */ },

    async goNovelPage(target) {
        if (!this._epubRendition) return;
        if (typeof target === 'number') {
            const book = this._epubBook;
            if (book && this._epubLocationsReady && book.locations.length() > 0) {
                const slider = document.getElementById('page-slider');
                const max = Number(slider?.max || 1000) || 1000;
                const ratio = Math.max(0, Math.min(1, Number(target) / max));
                const cfi = typeof book.locations.cfiFromPercentage === 'function'
                    ? book.locations.cfiFromPercentage(ratio)
                    : book.locations.cfiFromLocation(Math.max(1, Math.round(ratio * book.locations.length())));
                if (cfi) {
                    await this.withFontTimeout(this.primeNovelFont());
                    if (this._epubRendition) await this._epubRendition.display(cfi);
                }
            }
        }
    },

    applyNovelTypography() {
        if (!this._epubRendition) return;
        this.invalidateEpubPageMap();
        const fontPrime = this.primeNovelFont();
        try {
            this.registerEpubThemes(this._epubRendition);
            this._epubRendition.themes.select(this.epubThemeName());
            this._epubRendition.themes.font(this.epubFontFamily());
            this._epubRendition.themes.fontSize(`${this.state.novelFontSize}px`);
            this.applyEpubFontFix();
            const cfi = this._epubLocation?.start?.cfi;
            if (cfi) requestAnimationFrame(() => {
                this.withFontTimeout(fontPrime).then(() => this._epubRendition?.display?.(cfi));
            });
            this.updateNovelIndicator();
            this.scheduleEpubPageMapBuild();
        } catch (e) {}
    },

    novelScrollPercent() { return Number(this.state.novelScrollPercent || 0); },

    onNovelScroll() { /* handled by epub.js relocated event */ },

    saveNovelProgress() {
        if (!this.state.novelMode || !this.state.currentChapter) return;
        if (this._progressTimer) clearTimeout(this._progressTimer);
        this._progressTimer = setTimeout(() => this.flushNovelProgress(), 500);
    },

    flushNovelProgress() {
        if (!this.state.novelMode || !this.state.currentChapter || !this.state.currentComic?.comic?.id) return;
        if (this._progressTimer) {
            clearTimeout(this._progressTimer);
            this._progressTimer = null;
        }
        const comicId = this.state.currentComic.comic.id;
        const chapter = this.state.currentChapter;
        const cfi = this._epubLocation?.start?.cfi || '';
        const scrollPercent = Number(this.state.novelScrollPercent || 0);
        const page = Number.isInteger(this.state.currentChapterIndex) ? this.state.currentChapterIndex : 0;

        if (!this.state.progressCache[comicId]) this.state.progressCache[comicId] = {};
        Object.assign(this.state.progressCache[comicId], {
            lastChapterUuid: chapter.chapterUuid,
            lastPage: page,
            lastChapterTitle: chapter.chapterTitle,
            lastGroupName: chapter.groupName,
            lastResourceId: chapter.resourceId || '',
            lastResourceType: 'epub',
            lastSourceStartPage: chapter.sourceStartPage || null,
            lastSourcePageCount: chapter.sourcePageCount || null,
            lastScrollPercent: scrollPercent,
            lastCfi: cfi,
            updatedAt: new Date().toISOString(),
        });
        if (!this.state.progressCache[comicId].chapters) this.state.progressCache[comicId].chapters = {};
        this.state.progressCache[comicId].chapters[chapter.chapterUuid] = {
            page,
            resourceId: chapter.resourceId || '',
            resourceType: 'epub',
            sourceStartPage: chapter.sourceStartPage || null,
            sourcePageCount: chapter.sourcePageCount || null,
            scrollPercent,
            cfi,
            readingMode: this.state.novelReadingMode,
        };

        this.authFetch(`/api/progress/${encodeURIComponent(comicId)}`, {
            method: 'PUT',
            body: JSON.stringify({
                chapterUuid: chapter.chapterUuid,
                page,
                chapterTitle: chapter.chapterTitle,
                groupName: chapter.groupName,
                resourceId: chapter.resourceId || '',
                resourceType: 'epub',
                sourceStartPage: chapter.sourceStartPage || null,
                sourcePageCount: chapter.sourcePageCount || null,
                scrollPercent,
                cfi,
            })
        }).catch(() => {});
        this.state.lastComicsLoadTime = 0;
    },

    _exitNovelMode() {
        this.state.novelMode = false;
        this.state.currentNovel = null;
        this._novelTocFromManifest = false;
        this._novelTocFromBook = false;
        if (this._novelProgressTimer) {
            clearTimeout(this._novelProgressTimer);
            this._novelProgressTimer = null;
        }
        if (this._epubRendition) {
            try { this._epubRendition.destroy(); } catch (e) {}
            this._epubRendition = null;
        }
        if (this._epubBook) {
            try { this._epubBook.destroy(); } catch (e) {}
            this._epubBook = null;
        }
        this._epubLocation = null;
        this._novelSwipe = null;
        this._epubBookUrl = '';
        this._epubResourceId = '';
        this.invalidateEpubPageMap();
        this._epubLocationsReady = false;
        this._epubReady = false;
        const container = document.getElementById('novel-container');
        if (container) container.remove();
        const viewport = document.getElementById('reader-viewport');
        if (viewport) {
            viewport.classList.remove('novel-mode', 'novel-scroll', 'novel-paged');
        }
        const slideTrack = document.getElementById('slide-track');
        if (slideTrack) slideTrack.style.display = '';
        const touchLayer = document.getElementById('reader-touch-layer');
        if (touchLayer) {
            touchLayer.style.display = '';
            touchLayer.classList.remove('novel-touch-layer');
        }
        const tocPanel = document.getElementById('novel-toc-panel');
        if (tocPanel) tocPanel.style.display = 'none';
        const tocBackdrop = document.getElementById('novel-toc-backdrop');
        if (tocBackdrop) tocBackdrop.style.display = 'none';
        const lightbox = document.getElementById('image-lightbox');
        if (lightbox) lightbox.style.display = 'none';
        const readerUi = document.getElementById('reader-ui');
        if (readerUi) readerUi.classList.remove('novel-ui');
        // 恢复默认滑动条（退出小说模式）
        const slider = document.getElementById('page-slider');
        if (slider) {
            slider.style.display = '';
            slider.min = 1;
            slider.step = 1;
        }
        const indicator = document.getElementById('page-indicator');
        if (indicator) indicator.style.display = '';
    },

    buildChapterDir(chapter) {
        const order = chapter.order;
        const orderStr = Number.isInteger(order) ? String(Math.floor(order)) : String(order);
        return `${orderStr} ${chapter.chapterTitle}`;
    },

    setReaderStatus(message, actions = []) {
        const viewport = document.getElementById('reader-viewport');
        if (!viewport) return;
        let status = document.getElementById('reader-status');
        if (!status) {
            status = document.createElement('div');
            status.id = 'reader-status';
            status.className = 'reader-status';
            viewport.appendChild(status);
        }
        status.innerHTML = '';
        const text = document.createElement('span');
        text.textContent = message || '';
        status.appendChild(text);
        if (actions.length > 0) {
            const actionWrap = document.createElement('div');
            actionWrap.className = 'reader-status-actions';
            actions.forEach(item => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = item.text;
                button.addEventListener('click', item.action);
                actionWrap.appendChild(button);
            });
            status.appendChild(actionWrap);
        }
        status.style.display = message ? 'flex' : 'none';
    },

    clearReaderStatus() {
        const status = document.getElementById('reader-status');
        if (status) status.style.display = 'none';
    },

    readerImageUrl(url, retry = 0) {
        if (!retry && !this._readerForceRefresh) return url;
        try {
            const parsed = new URL(url, window.location.origin);
            parsed.searchParams.set('refresh', '1');
            parsed.searchParams.set('retry', '1');
            parsed.searchParams.set('_', `${Date.now()}-${retry || 'reload'}`);
            return `${parsed.pathname}${parsed.search}${parsed.hash}`;
        } catch (e) {
            const sep = String(url).includes('?') ? '&' : '?';
            return `${url}${sep}refresh=1&retry=1&_=${Date.now()}-${retry || 'reload'}`;
        }
    },

    markReaderImageLoaded(img) {
        if (img._readerLoadTimer) clearTimeout(img._readerLoadTimer);
        img.classList.remove('is-loading', 'is-error');
    },

    createReaderImage(pageIndex, className = '') {
        const img = document.createElement('img');
        img.src = this.readerImageUrl(this.state.currentImages[pageIndex]);
        img.draggable = false;
        img.loading = 'eager';
        img.decoding = 'async';
        img.dataset.pageIndex = String(pageIndex);
        img.dataset.retryCount = '0';
        img.dataset.readerLoadToken = String(this._readerLoadToken || '');
        img.className = ['reader-img', 'is-loading', className].filter(Boolean).join(' ');
        img.onload = () => {
            if (img.decode) {
                img.decode()
                    .then(() => this.markReaderImageLoaded(img))
                    .catch(() => this.handleReaderImageError(img));
            } else {
                this.markReaderImageLoaded(img);
            }
        };
        img.onerror = () => {
            if (img._readerLoadTimer) clearTimeout(img._readerLoadTimer);
            this.handleReaderImageError(img);
        };
        this.armReaderImageTimeout(img);
        return img;
    },

    armReaderImageTimeout(img) {
        if (img._readerLoadTimer) clearTimeout(img._readerLoadTimer);
        img._readerLoadTimer = setTimeout(() => {
            if (!img.complete || img.naturalWidth === 0) {
                this.handleReaderImageError(img);
            }
        }, 12000);
    },

    handleReaderImageError(img) {
        if (!img.isConnected || img.dataset.readerLoadToken !== String(this._readerLoadToken || '')) return;
        const pageIndex = Number(img.dataset.pageIndex || 0);
        const nextRetry = Number(img.dataset.retryCount || 0) + 1;
        if (nextRetry <= 3) {
            img.dataset.retryCount = String(nextRetry);
            img.classList.add('is-loading');
            setTimeout(() => {
                this.armReaderImageTimeout(img);
                img.src = this.readerImageUrl(this.state.currentImages[pageIndex], nextRetry);
            }, 300 * nextRetry);
            return;
        }
        img.classList.remove('is-loading');
        img.classList.add('is-error');
        img.alt = `第 ${pageIndex + 1} 页加载失败`;
        this.setReaderStatus(`第 ${pageIndex + 1} 页加载失败`, [
            { text: '重新加载当前章节', action: () => this.reloadCurrentReader() },
        ]);
    },

    bindImageZoomEvents() {
        if (this._imageZoomEventsBound) return;
        this._imageZoomEventsBound = true;
        this._imageZoom = {
            scale: 1,
            x: 0,
            y: 0,
            pinch: null,
            pan: null,
            gesture: null,
            gestureStartScale: 1,
        };
        this._imageZoomSuppressUntil = 0;
        this._imageZoomBrowserGuardUntil = 0;
        this._imageZoomModifierState = { ctrl: false, meta: false };

        const viewport = document.getElementById('reader-viewport');
        const readerPage = document.getElementById('reader-page');
        const eventSurface = readerPage || viewport;
        if (!eventSurface) return;

        window.addEventListener('wheel', (e) => this.handleImageZoomWheel(e), { passive: false, capture: true });
        document.addEventListener('wheel', (e) => this.handleImageZoomWheel(e), { passive: false, capture: true });
        window.addEventListener('touchstart', (e) => this.handleImageZoomTouchStart(e), { passive: false, capture: true });
        window.addEventListener('touchmove', (e) => this.handleImageZoomTouchMove(e), { passive: false, capture: true });
        window.addEventListener('touchend', (e) => this.handleImageZoomTouchEnd(e), { passive: false, capture: true });
        window.addEventListener('touchcancel', (e) => this.handleImageZoomTouchEnd(e), { passive: false, capture: true });
        eventSurface.addEventListener('touchstart', (e) => this.handleImageZoomTouchStart(e), { passive: false, capture: true });
        eventSurface.addEventListener('touchmove', (e) => this.handleImageZoomTouchMove(e), { passive: false, capture: true });
        eventSurface.addEventListener('touchend', (e) => this.handleImageZoomTouchEnd(e), { passive: false, capture: true });
        eventSurface.addEventListener('touchcancel', (e) => this.handleImageZoomTouchEnd(e), { passive: false, capture: true });
        eventSurface.addEventListener('pointerdown', (e) => this.handleImageZoomPointerDown(e), { passive: false, capture: true });
        eventSurface.addEventListener('pointermove', (e) => this.handleImageZoomPointerMove(e), { passive: false, capture: true });
        eventSurface.addEventListener('pointerup', (e) => this.handleImageZoomPointerEnd(e), { passive: false, capture: true });
        eventSurface.addEventListener('pointercancel', (e) => this.handleImageZoomPointerEnd(e), { passive: false, capture: true });
        eventSurface.addEventListener('lostpointercapture', (e) => this.handleImageZoomPointerEnd(e), { passive: false, capture: true });
        eventSurface.addEventListener('dblclick', (e) => this.handleImageZoomDoubleClick(e), { capture: true });

        // Safari/macOS trackpad pinch exposes gesture events instead of ctrl+wheel.
        window.addEventListener('gesturestart', (e) => this.handleImageZoomGestureStart(e), { passive: false, capture: true });
        window.addEventListener('gesturechange', (e) => this.handleImageZoomGestureChange(e), { passive: false, capture: true });
        window.addEventListener('gestureend', (e) => this.handleImageZoomGestureEnd(e), { passive: false, capture: true });
        document.addEventListener('gesturestart', (e) => this.handleImageZoomGestureStart(e), { passive: false, capture: true });
        document.addEventListener('gesturechange', (e) => this.handleImageZoomGestureChange(e), { passive: false, capture: true });
        document.addEventListener('gestureend', (e) => this.handleImageZoomGestureEnd(e), { passive: false, capture: true });

        window.addEventListener('keydown', (e) => this.updateImageZoomModifierState(e, true), { capture: true });
        window.addEventListener('keyup', (e) => this.updateImageZoomModifierState(e, false), { capture: true });
        window.addEventListener('blur', () => {
            this._imageZoomModifierState = { ctrl: false, meta: false };
        });
    },

    updateImageZoomModifierState(e, pressed) {
        if (!this._imageZoomModifierState) this._imageZoomModifierState = { ctrl: false, meta: false };
        if (e.key === 'Control') this._imageZoomModifierState.ctrl = pressed;
        if (e.key === 'Meta') this._imageZoomModifierState.meta = pressed;
    },

    isApplePlatform() {
        const platform = navigator.userAgentData?.platform || navigator.platform || '';
        return /Mac|iPhone|iPad|iPod/i.test(platform) ||
            (navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1);
    },

    isImageZoomWheelModifier(e) {
        const modifiers = this._imageZoomModifierState || { ctrl: false, meta: false };
        const ctrl = !!(e.ctrlKey || e.getModifierState?.('Control') || modifiers.ctrl);
        const meta = !!(e.metaKey || e.getModifierState?.('Meta') || modifiers.meta);
        return this.isApplePlatform() ? (meta || ctrl) : ctrl;
    },

    canHandleImageZoom() {
        return this.isImageReaderActive() &&
            Array.isArray(this.state.currentImages) &&
            this.state.currentImages.length > 0;
    },

    isImageReaderActive() {
        return document.getElementById('reader-page')?.classList.contains('active') &&
            !this.state.novelMode;
    },

    isImageZoomEventTarget(e) {
        const target = e?.target;
        if (!target?.closest) return true;
        if (target.closest('#reader-ui, #settings-panel, #novel-toc-panel, #image-lightbox')) return false;
        return !!target.closest('#reader-viewport, #reader-touch-layer, #reader-page');
    },

    shouldBlockImageReaderBrowserZoom(e) {
        if (!this.isImageReaderActive()) return false;
        const target = e?.target;
        if (target === window || target === document || target === document.documentElement || target === document.body) {
            return true;
        }
        if (!target?.closest) return true;
        if (target.closest('#settings-panel, #novel-toc-panel, #image-lightbox')) return false;
        return !!target.closest('#reader-page');
    },

    isImageZoomGlobalEventTarget(e) {
        if (!this.shouldBlockImageReaderBrowserZoom(e)) return false;
        const target = e?.target;
        if (target === window || target === document || target === document.documentElement || target === document.body) {
            return true;
        }
        if (!target?.closest) return true;
        if (target.closest('#reader-ui, #settings-panel, #novel-toc-panel, #image-lightbox')) return false;
        return !!target.closest('#reader-page');
    },

    imageZoomViewportRect() {
        return document.getElementById('reader-viewport')?.getBoundingClientRect() || null;
    },

    imageZoomEventPoint(e, options = {}) {
        const rect = this.imageZoomViewportRect();
        const fallback = rect
            ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
            : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        const x = Number(e?.clientX);
        const y = Number(e?.clientY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return fallback;
        if (options.fallbackCenterOnZero && x === 0 && y === 0) return fallback;
        return { x, y };
    },

    imageZoomState() {
        if (!this._imageZoom) {
            this._imageZoom = { scale: 1, x: 0, y: 0, pinch: null, pan: null, gesture: null, gestureStartScale: 1 };
        }
        return this._imageZoom;
    },

    markImageZoomEventHandled(e, name) {
        if (!e) return false;
        const key = `__readerPlusImageZoom${name || ''}Handled`;
        if (e[key]) return true;
        try { e[key] = true; } catch (error) {}
        return false;
    },

    guardImageReaderBrowserGesture(duration = 700) {
        const until = Date.now() + duration;
        this._imageZoomBrowserGuardUntil = Math.max(Number(this._imageZoomBrowserGuardUntil || 0), until);
    },

    isImageZoomBrowserGestureGuardActive() {
        return Date.now() < Number(this._imageZoomBrowserGuardUntil || 0);
    },

    blockImageReaderBrowserGesture(e, duration = 700) {
        if (e?.cancelable !== false) e?.preventDefault?.();
        e?.stopPropagation?.();
        this.guardImageReaderBrowserGesture(duration);
    },

    preventImageZoomDefault(e) {
        if (e?.cancelable !== false) e?.preventDefault?.();
        e?.stopPropagation?.();
    },

    isImageZoomInteractionActive(options = {}) {
        const zoom = this.imageZoomState();
        const active = !!(zoom.pinch || zoom.pan || zoom.gesture) ||
            Date.now() < Number(this._imageZoomSuppressUntil || 0);
        return options.includeBrowserGuard
            ? active || this.isImageZoomBrowserGestureGuardActive()
            : active;
    },

    shouldSuppressReaderTap() {
        return this.isImageZoomed() || this.isImageZoomInteractionActive();
    },

    shouldBlockReaderSwipeTouch(e) {
        if (this.state.novelMode || this.state.stripMode) return false;
        if (e?.touches && e.touches.length > 1) return true;
        return this.isImageZoomed() || this.isImageZoomInteractionActive();
    },

    cancelReaderSwipe() {
        const swipe = this._swipe;
        if (!swipe) return;
        if (swipe.active && swipe.locked && !swipe.rejected && !swipe.animating) {
            this._snapBack();
        }
        swipe.active = false;
        swipe.locked = false;
        swipe.rejected = false;
    },

    isImageZoomed() {
        return this.imageZoomState().scale > 1.01;
    },

    currentImageZoomTarget() {
        return this.state.stripMode
            ? document.getElementById('strip-container')
            : document.querySelector('#slide-current .image-container');
    },

    clampImageZoom(scale) {
        const value = Number(scale) || 1;
        return Math.max(1, Math.min(5, value));
    },

    resetImageZoom() {
        const zoom = this.imageZoomState();
        zoom.scale = 1;
        zoom.x = 0;
        zoom.y = 0;
        zoom.pinch = null;
        zoom.pan = null;
        zoom.gesture = null;
        this._imageZoomSuppressUntil = 0;
        this._imageZoomBrowserGuardUntil = 0;
        clearTimeout(this._imageZoomClickTimer);
        this._swipedRecently = false;
        this.cancelReaderSwipe();
        this.state.imageZoomScale = 1;
        this.state.imageZoomX = 0;
        this.state.imageZoomY = 0;
        this.applyImageZoom();
    },

    applyImageZoom() {
        const zoom = this.imageZoomState();
        const viewport = document.getElementById('reader-viewport');
        const touchLayer = document.getElementById('reader-touch-layer');
        const zoomed = zoom.scale > 1.01;

        if (viewport) viewport.classList.toggle('image-zoomed', zoomed);
        if (touchLayer) touchLayer.classList.toggle('zoomed', zoomed);

        const current = document.querySelector('#slide-current .image-container');
        document.querySelectorAll('.slide-page .image-container').forEach(container => {
            if (zoomed && !this.state.stripMode && container === current) return;
            if (container.classList.contains('zoom-active')) container.classList.remove('zoom-active');
            container.style.removeProperty('--zoom-scale');
            container.style.removeProperty('--zoom-x');
            container.style.removeProperty('--zoom-y');
        });

        if (!this.state.stripMode && current && zoomed) {
            if (!current.classList.contains('zoom-active')) current.classList.add('zoom-active');
            current.style.setProperty('--zoom-scale', String(Math.round(zoom.scale * 1000) / 1000));
            current.style.setProperty('--zoom-x', `${Math.round(zoom.x * 100) / 100}px`);
            current.style.setProperty('--zoom-y', `${Math.round(zoom.y * 100) / 100}px`);
        }

        const strip = document.getElementById('strip-container');
        if (strip) {
            strip.classList.toggle('zoomed', this.state.stripMode && zoomed);
            strip.style.setProperty('--strip-zoom-scale', String(this.state.stripMode ? zoom.scale : 1));
        }
    },

    imageZoomBaseContentSize() {
        const images = Array.from(document.querySelectorAll('#slide-current .image-container img.reader-img'))
            .filter(img => img.isConnected && !img.classList.contains('is-error'));
        if (images.length === 0) {
            const target = this.currentImageZoomTarget();
            if (!target) return null;
            return {
                width: Math.max(1, target.offsetWidth || 0),
                height: Math.max(1, target.offsetHeight || 0),
            };
        }
        let width = 0;
        let height = 0;
        for (const img of images) {
            const style = getComputedStyle(img);
            const itemWidth = parseFloat(style.width) || img.offsetWidth || 0;
            const itemHeight = parseFloat(style.height) || img.offsetHeight || 0;
            const marginX = (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
            const marginY = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
            if (itemWidth <= 0 || itemHeight <= 0) continue;
            width += itemWidth + marginX;
            height = Math.max(height, itemHeight + marginY);
        }
        return {
            width: Math.max(1, width),
            height: Math.max(1, height),
        };
    },

    clampImagePan(scale = null) {
        const zoom = this.imageZoomState();
        if (this.state.stripMode) return;
        const rect = this.imageZoomViewportRect();
        if (!rect) return;
        const nextScale = Math.max(1, Number(scale || zoom.scale || 1));
        const contentSize = this.imageZoomBaseContentSize();
        const contentWidth = contentSize?.width || rect.width;
        const contentHeight = contentSize?.height || rect.height;
        const maxX = Math.max(0, (contentWidth * nextScale - rect.width) / 2);
        const maxY = Math.max(0, (contentHeight * nextScale - rect.height) / 2);
        zoom.x = Math.max(-maxX, Math.min(maxX, zoom.x));
        zoom.y = Math.max(-maxY, Math.min(maxY, zoom.y));
    },

    normalizeImageZoom() {
        const zoom = this.imageZoomState();
        zoom.scale = this.clampImageZoom(zoom.scale);
        if (zoom.scale <= 1.01) {
            zoom.scale = 1;
            zoom.x = 0;
            zoom.y = 0;
        } else {
            this.clampImagePan(zoom.scale);
        }
        this.syncImageZoomState();
        this.applyImageZoom();
        if (zoom.scale === 1 && !zoom.pinch && !zoom.pan && !zoom.gesture) {
            this.relaxImageZoomTapSuppressionAfterReset();
        }
    },

    zoomImageTo(scale, clientX, clientY) {
        if (!this.canHandleImageZoom()) return;
        const zoom = this.imageZoomState();
        const nextScale = this.clampImageZoom(scale);
        const target = this.currentImageZoomTarget();
        if (!target) return;

        if (this.state.stripMode) {
            this.zoomStripTo(nextScale, clientX, clientY);
            return;
        }

        const rect = this.imageZoomViewportRect();
        if (!rect) return;
        const focalX = Number.isFinite(clientX) ? clientX - rect.left - rect.width / 2 : 0;
        const focalY = Number.isFinite(clientY) ? clientY - rect.top - rect.height / 2 : 0;
        const ratio = nextScale / zoom.scale;
        zoom.x = focalX - (focalX - zoom.x) * ratio;
        zoom.y = focalY - (focalY - zoom.y) * ratio;
        zoom.scale = nextScale;
        if (nextScale <= 1.01) {
            zoom.scale = 1;
            zoom.x = 0;
            zoom.y = 0;
        } else {
            this.clampImagePan(nextScale);
        }
        this.syncImageZoomState();
        this.applyImageZoom();
    },

    zoomStripTo(scale, clientX, clientY) {
        const zoom = this.imageZoomState();
        const container = document.getElementById('strip-container');
        if (!container) return;
        const oldScale = zoom.scale || 1;
        const nextScale = this.clampImageZoom(scale);
        const rect = container.getBoundingClientRect();
        const focalX = Number.isFinite(clientX) ? clientX - rect.left : rect.width / 2;
        const focalY = Number.isFinite(clientY) ? clientY - rect.top : rect.height / 2;
        const scrollX = (container.scrollLeft + focalX) / oldScale;
        const scrollY = (container.scrollTop + focalY) / oldScale;
        zoom.scale = nextScale <= 1.01 ? 1 : nextScale;
        zoom.x = 0;
        zoom.y = 0;
        this.syncImageZoomState();
        this.applyImageZoom();
        container.scrollLeft = Math.max(0, scrollX * zoom.scale - focalX);
        container.scrollTop = Math.max(0, scrollY * zoom.scale - focalY);
    },

    panImageBy(deltaX, deltaY) {
        const zoom = this.imageZoomState();
        if (!this.isImageZoomed()) return;
        if (this.state.stripMode) {
            const container = document.getElementById('strip-container');
            if (container) {
                container.scrollLeft += deltaX;
                container.scrollTop += deltaY;
            }
            return;
        }
        zoom.x -= deltaX;
        zoom.y -= deltaY;
        this.clampImagePan(zoom.scale);
        this.syncImageZoomState();
        this.applyImageZoom();
    },

    syncImageZoomState() {
        const zoom = this.imageZoomState();
        this.state.imageZoomScale = zoom.scale;
        this.state.imageZoomX = zoom.x;
        this.state.imageZoomY = zoom.y;
    },

    imagePinchDistance(touches) {
        const a = touches[0];
        const b = touches[1];
        return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    },

    imagePinchCenter(touches) {
        const a = touches[0];
        const b = touches[1];
        return {
            x: (a.clientX + b.clientX) / 2,
            y: (a.clientY + b.clientY) / 2,
        };
    },

    beginImageZoomScaleInteraction(point, options = {}) {
        const zoom = this.imageZoomState();
        const focus = point || this.imageZoomEventPoint(null, { fallbackCenterOnZero: true });
        zoom.gesture = {
            scale: zoom.scale || 1,
            point: focus,
        };
        zoom.gestureStartScale = zoom.scale || 1;
        if (options.clearPinch !== false) zoom.pinch = null;
        zoom.pan = null;
        this.cancelReaderCenterHold?.();
        this.cancelReaderSwipe();
        this.guardImageReaderBrowserGesture(options.browserGuardDuration || 700);
        this.suppressImageZoomClick(options.suppressDuration || 450);
    },

    updateImageZoomScaleInteraction(scaleRatio, point, options = {}) {
        const zoom = this.imageZoomState();
        const start = zoom.gesture || {
            scale: zoom.gestureStartScale || zoom.scale || 1,
            point: point || this.imageZoomEventPoint(null, { fallbackCenterOnZero: true }),
        };
        const focus = options.fixedPoint === false && point ? point : (start.point || point);
        const ratio = Math.max(0.05, Number(scaleRatio) || 1);
        this.zoomImageTo((start.scale || 1) * ratio, focus?.x, focus?.y);
        this.guardImageReaderBrowserGesture(options.browserGuardDuration || 700);
        this.suppressImageZoomClick(options.suppressDuration || 350);
    },

    endImageZoomScaleInteraction(options = {}) {
        const zoom = this.imageZoomState();
        zoom.gesture = null;
        this.normalizeImageZoom();
        this.guardImageReaderBrowserGesture(options.browserGuardDuration || 900);
        this.suppressImageZoomClick(this.isImageZoomed() ? (options.suppressDuration || 450) : 120);
    },

    handleImageZoomGestureStart(e) {
        if (!this.shouldBlockImageReaderBrowserZoom(e)) return;
        if (this.markImageZoomEventHandled(e, 'Gesture')) return;
        this.blockImageReaderBrowserGesture(e, 900);
        const zoom = this.imageZoomState();
        if (zoom.pinch || !this.canHandleImageZoom() || !this.isImageZoomGlobalEventTarget(e)) return;
        this.beginImageZoomScaleInteraction(this.imageZoomEventPoint(e, { fallbackCenterOnZero: true }), {
            suppressDuration: 450,
            browserGuardDuration: 900,
        });
    },

    handleImageZoomGestureChange(e) {
        const zoom = this.imageZoomState();
        if (!this.shouldBlockImageReaderBrowserZoom(e) && !zoom.gesture) return;
        if (this.markImageZoomEventHandled(e, 'Gesture')) return;
        this.blockImageReaderBrowserGesture(e, 900);
        if (zoom.pinch || !this.canHandleImageZoom() || (!zoom.gesture && !this.isImageZoomGlobalEventTarget(e))) return;
        this.updateImageZoomScaleInteraction(Number(e.scale || 1), null, {
            fixedPoint: true,
            suppressDuration: 350,
            browserGuardDuration: 900,
        });
    },

    handleImageZoomGestureEnd(e) {
        const zoom = this.imageZoomState();
        if (!this.shouldBlockImageReaderBrowserZoom(e) && !zoom.gesture) return;
        if (this.markImageZoomEventHandled(e, 'Gesture')) return;
        this.blockImageReaderBrowserGesture(e, 1200);
        if (zoom.pinch || !this.canHandleImageZoom()) return;
        this.endImageZoomScaleInteraction({ suppressDuration: 650, browserGuardDuration: 1200 });
    },

    handleImageZoomWheel(e) {
        if (!this.shouldBlockImageReaderBrowserZoom(e)) return;
        if (this.isImageZoomBrowserGestureGuardActive()) {
            if (this.markImageZoomEventHandled(e, 'WheelGuard')) return;
            this.blockImageReaderBrowserGesture(e, 320);
            return;
        }
        const modifierZoom = this.isImageZoomWheelModifier(e);
        if (!this.canHandleImageZoom()) {
            if (modifierZoom) {
                if (this.markImageZoomEventHandled(e, 'Wheel')) return;
                this.preventImageZoomDefault(e);
            }
            return;
        }
        if (!this.isImageZoomGlobalEventTarget(e)) {
            if (modifierZoom) {
                if (this.markImageZoomEventHandled(e, 'Wheel')) return;
                this.preventImageZoomDefault(e);
            }
            return;
        }
        const plainWheelZoom = !this.state.stripMode;
        if (modifierZoom || plainWheelZoom) {
            if (this.markImageZoomEventHandled(e, 'Wheel')) return;
            this.preventImageZoomDefault(e);
            const zoom = this.imageZoomState();
            const deltaUnit = e.deltaMode === 1 ? 18 : (e.deltaMode === 2 ? window.innerHeight : 1);
            const delta = -e.deltaY * deltaUnit;
            const factor = Math.exp(delta * (modifierZoom ? 0.0025 : 0.0018));
            const point = this.imageZoomEventPoint(e);
            this.zoomImageTo(zoom.scale * factor, point.x, point.y);
            return;
        }
        if (this.isImageZoomed() && !this.state.stripMode) {
            if (this.markImageZoomEventHandled(e, 'WheelPan')) return;
            this.preventImageZoomDefault(e);
            this.panImageBy(e.deltaX, e.deltaY);
        }
    },

    handleImageZoomTouchStart(e) {
        const zoom = this.imageZoomState();
        const shouldBlock = this.shouldBlockImageReaderBrowserZoom(e);
        const canZoomTarget = this.canHandleImageZoom() && this.isImageZoomEventTarget(e);
        if (e.touches.length >= 2) {
            if (shouldBlock) {
                if (this.markImageZoomEventHandled(e, 'Touch')) return;
                this.blockImageReaderBrowserGesture(e, 1000);
                this.cancelReaderCenterHold?.();
                this.cancelReaderSwipe();
                this.suppressImageZoomClick(650);
            }
            if (!canZoomTarget) return;
            const center = this.imagePinchCenter(e.touches);
            this.beginImageZoomScaleInteraction(center, {
                clearPinch: false,
                suppressDuration: 650,
                browserGuardDuration: 1000,
            });
            zoom.pinch = {
                distance: this.imagePinchDistance(e.touches),
            };
            zoom.pan = null;
            return;
        }
        if (e.touches.length === 1 && this.isImageZoomed() && canZoomTarget) {
            if (this.markImageZoomEventHandled(e, 'Touch')) return;
            this.blockImageReaderBrowserGesture(e, 700);
            this.cancelReaderCenterHold?.();
            this.cancelReaderSwipe();
            const touch = e.touches[0];
            zoom.pan = {
                x: touch.clientX,
                y: touch.clientY,
            };
            this.suppressImageZoomClick(350);
            return;
        }
    },

    handleImageZoomTouchMove(e) {
        const zoom = this.imageZoomState();
        const shouldBlock = this.shouldBlockImageReaderBrowserZoom(e);
        const canZoomTarget = this.canHandleImageZoom() && this.isImageZoomEventTarget(e);
        if (shouldBlock && (
            e.touches.length >= 2 ||
            zoom.pinch ||
            zoom.pan ||
            this.isImageZoomed() ||
            this.isImageZoomBrowserGestureGuardActive()
        )) {
            if (this.markImageZoomEventHandled(e, 'Touch')) return;
            this.blockImageReaderBrowserGesture(e, e.touches.length >= 2 ? 1000 : 650);
        }
        if (!canZoomTarget) return;
        if (e.touches.length >= 2 && zoom.pinch) {
            const distance = this.imagePinchDistance(e.touches);
            const center = this.imagePinchCenter(e.touches);
            this.updateImageZoomScaleInteraction(distance / Math.max(1, zoom.pinch.distance), center, {
                fixedPoint: false,
                suppressDuration: 350,
                browserGuardDuration: 1000,
            });
            return;
        }
        if (e.touches.length === 1 && zoom.pan && this.isImageZoomed()) {
            const touch = e.touches[0];
            this.panImageBy(zoom.pan.x - touch.clientX, zoom.pan.y - touch.clientY);
            zoom.pan = { x: touch.clientX, y: touch.clientY };
            this.suppressImageZoomClick(250);
        }
    },

    handleImageZoomTouchEnd(e) {
        const zoom = this.imageZoomState();
        const shouldBlock = this.shouldBlockImageReaderBrowserZoom(e) || !!(zoom.pinch || zoom.pan);
        const canZoomTarget = this.canHandleImageZoom() && this.isImageZoomEventTarget(e);
        if (shouldBlock && (zoom.pinch || zoom.pan || this.isImageZoomed())) {
            if (this.markImageZoomEventHandled(e, 'Touch')) return;
            this.blockImageReaderBrowserGesture(e, 1200);
            this.suppressImageZoomClick(650);
        }
        zoom.pinch = null;
        zoom.gesture = null;
        if (canZoomTarget && e.touches && e.touches.length === 1 && this.isImageZoomed()) {
            const touch = e.touches[0];
            zoom.pan = { x: touch.clientX, y: touch.clientY };
        } else {
            zoom.pan = null;
        }
        if (this.canHandleImageZoom()) {
            this.normalizeImageZoom();
            if (!this.isImageZoomed()) this.relaxImageZoomTapSuppressionAfterReset();
        }
    },

    handleImageZoomPointerDown(e) {
        if (e.pointerType === 'touch' || e.button !== 0) return;
        if (!this.canHandleImageZoom() || !this.isImageZoomEventTarget(e) || !this.isImageZoomed()) return;
        if (this.markImageZoomEventHandled(e, 'Pointer')) return;
        this.blockImageReaderBrowserGesture(e, 500);
        this.cancelReaderCenterHold?.();
        this.cancelReaderSwipe();
        const zoom = this.imageZoomState();
        zoom.pan = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
        try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch (error) {}
        this.suppressImageZoomClick(350);
    },

    handleImageZoomPointerMove(e) {
        if (e.pointerType === 'touch') return;
        const zoom = this.imageZoomState();
        if (!zoom.pan || zoom.pan.pointerId !== e.pointerId || !this.isImageZoomed()) return;
        if (this.markImageZoomEventHandled(e, 'Pointer')) return;
        this.blockImageReaderBrowserGesture(e, 350);
        this.panImageBy(zoom.pan.x - e.clientX, zoom.pan.y - e.clientY);
        zoom.pan = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
        this.suppressImageZoomClick(250);
    },

    handleImageZoomPointerEnd(e) {
        if (e.pointerType === 'touch') return;
        const zoom = this.imageZoomState();
        if (!zoom.pan || zoom.pan.pointerId !== e.pointerId) return;
        if (this.markImageZoomEventHandled(e, 'Pointer')) return;
        this.blockImageReaderBrowserGesture(e, 500);
        zoom.pan = null;
        try { e.currentTarget?.releasePointerCapture?.(e.pointerId); } catch (error) {}
        this.normalizeImageZoom();
        this.suppressImageZoomClick(350);
    },

    handleImageZoomDoubleClick(e) {
        if (!this.canHandleImageZoom() || !this.isImageZoomEventTarget(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const zoom = this.imageZoomState();
        if (zoom.scale > 1.01) this.resetImageZoom();
        else this.zoomImageTo(2.2, e.clientX, e.clientY);
        this.suppressImageZoomClick(320);
    },

    suppressImageZoomClick(duration = 320) {
        const until = Date.now() + duration;
        this._imageZoomSuppressUntil = Math.max(Number(this._imageZoomSuppressUntil || 0), until);
        this._swipedRecently = true;
        clearTimeout(this._imageZoomClickTimer);
        this._imageZoomClickTimer = setTimeout(() => {
            if (Date.now() >= Number(this._imageZoomSuppressUntil || 0)) {
                this._swipedRecently = false;
            }
        }, duration + 20);
    },

    relaxImageZoomTapSuppressionAfterReset(duration = 120) {
        const currentUntil = Number(this._imageZoomSuppressUntil || 0);
        if (!currentUntil) return;
        const nextUntil = Date.now() + duration;
        if (currentUntil <= nextUntil) return;
        this._imageZoomSuppressUntil = nextUntil;
        clearTimeout(this._imageZoomClickTimer);
        this._imageZoomClickTimer = setTimeout(() => {
            if (Date.now() >= Number(this._imageZoomSuppressUntil || 0)) {
                this._swipedRecently = false;
            }
        }, duration + 20);
    },

    async reloadCurrentReader() {
        const chapter = this.state.currentChapter;
        if (!chapter) return;
        const startPage = Math.max(0, Number(this.state.currentPage || 0));
        await this.openReader(chapter, { startPage, forceRefresh: true, chapterList: this.state.allChapters });
    },

    // 计算当前页在拼页模式下是否为拼页的起始位置
    _isDoublePageStart(page) {
        const offset = this.state.doublePageOffset;
        // offset=0: 拼页组是 [0,1], [2,3], [4,5]...
        // offset=1: 第0页单独, 拼页组是 [1,2], [3,4], [5,6]...
        if (offset === 0) return page % 2 === 0;
        if (page === 0) return true; // offset=1 时第0页单独
        return (page - offset) % 2 === 0;
    },

    // 获取当前页显示几张图（1或2）
    _getPageCount(page) {
        const total = this.state.currentImages.length;
        if (!this.state.doublePageMode) return 1;
        const offset = this.state.doublePageOffset;
        // offset=1 时第0页单独显示
        if (offset === 1 && page === 0) return 1;
        // 最后一页如果落单也单独显示
        if (page + 1 >= total) return 1;
        // 正常拼页
        return 2;
    },

    // 将当前页对齐到最近的拼页起始页
    _alignToPageStart(page) {
        const total = this.state.currentImages.length;
        page = Math.max(0, Math.min(page, total - 1));
        if (!this.state.doublePageMode) return page;
        const offset = this.state.doublePageOffset;
        if (offset === 1 && page === 0) return 0;
        // 对齐到拼页组的起始
        if (offset === 0) return page - (page % 2);
        if (page < offset) return 0;
        return page - ((page - offset) % 2);
    },

    renderPage() {
        this.resetImageZoom();
        // 条漫模式走独立渲染路径
        if (this.state.stripMode) {
            this._renderStripMode();
            return;
        }

        const indicator = document.getElementById('page-indicator');
        const slider = document.getElementById('page-slider');

        const total = this.state.currentImages.length;
        if (total === 0) return;
        this.clearReaderStatus();

        // 确保普通模式下 slide-track 和触摸层可见
        document.getElementById('slide-track').style.display = '';
        document.getElementById('reader-touch-layer').style.display = '';
        const viewport = document.getElementById('reader-viewport');
        viewport.classList.remove('strip-mode');

        let page = Math.min(this.state.currentPage, total - 1);
        if (this.state.doublePageMode) {
            page = this._alignToPageStart(page);
        }
        this.state.currentPage = page;

        // 渲染三个 slot: prev, current, next
        // RTL 模式下交换 prev/next slot 的内容，使 next 在左侧、prev 在右侧
        const isRtl = this.state.readingDirection === 'rtl';
        this._renderSlot('slide-prev', isRtl ? this._getNextPageIndex() : this._getPrevPageIndex());
        this._renderSlot('slide-current', page);
        this._renderSlot('slide-next', isRtl ? this._getPrevPageIndex() : this._getNextPageIndex());

        // 复位 track 位置
        const track = document.getElementById('slide-track');
        track.classList.remove('animating');
        track.style.transform = 'translate3d(-33.3333%, 0, 0)';

        if (this.state.doublePageMode) {
            const count = this._getPageCount(page);
            if (count === 2) {
                indicator.textContent = `${page + 1}-${page + 2} / ${total}`;
            } else {
                indicator.textContent = `${page + 1} / ${total}`;
            }
        } else {
            indicator.textContent = `${page + 1} / ${total}`;
        }

        slider.value = page + 1;
        slider.max = total;

        // 保存进度到服务器（节流）
        this.saveProgress(page);
        this.preloadAdjacent();
    },

    // 更新页码指示器和滑块（不重建 DOM）
    _updateIndicator() {
        const indicator = document.getElementById('page-indicator');
        const slider = document.getElementById('page-slider');
        const total = this.state.currentImages.length;
        const page = this.state.currentPage;

        if (this.state.doublePageMode) {
            const count = this._getPageCount(page);
            if (count === 2) {
                indicator.textContent = `${page + 1}-${page + 2} / ${total}`;
            } else {
                indicator.textContent = `${page + 1} / ${total}`;
            }
        } else {
            indicator.textContent = `${page + 1} / ${total}`;
        }

        slider.value = page + 1;
        slider.max = total;
    },

    // 渲染某个 slide slot 的内容
    _renderSlot(slotId, pageIndex) {
        const slot = document.getElementById(slotId);
        const container = slot.querySelector('.image-container');
        container.innerHTML = '';
        container.className = 'image-container';

        if (pageIndex === null || pageIndex === undefined) return;

        // 应用方向和模式 class
        if (this.state.readingDirection === 'rtl') container.classList.add('rtl');
        if (this.state.doublePageMode) container.classList.add('double-page');

        const total = this.state.currentImages.length;
        if (pageIndex < 0 || pageIndex >= total) return;

        if (this.state.doublePageMode) {
            const count = this._getPageCount(pageIndex);
            const img1 = this.createReaderImage(pageIndex);
            container.appendChild(img1);

            if (count === 2 && pageIndex + 1 < total) {
                const img2 = this.createReaderImage(pageIndex + 1);
                container.appendChild(img2);
            } else {
                container.classList.remove('double-page');
            }
        } else {
            const img = this.createReaderImage(pageIndex);
            container.appendChild(img);
        }
    },

    // ─── 条漫模式 ───
    _stripScrollHandler: null,
    _stripScrollTimer: null,
    _stripRestoreToken: 0,
    _stripRestoreTargetPage: null,

    _renderStripMode() {
        const total = this.state.currentImages.length;
        if (total === 0) return;

        const viewport = document.getElementById('reader-viewport');
        viewport.classList.add('strip-mode');

        // 隐藏普通模式元素
        document.getElementById('slide-track').style.display = 'none';
        document.getElementById('reader-touch-layer').style.display = 'none';

        // 创建或复用条漫容器
        let container = document.getElementById('strip-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'strip-container';
            viewport.appendChild(container);
        }

        // 构建内容
        container.innerHTML = '';

        // 上一章提示
        if (this.state.currentChapterIndex > 0) {
            const prevChapter = this.state.allChapters[this.state.currentChapterIndex - 1];
            const prevHint = document.createElement('div');
            prevHint.className = 'strip-chapter-hint strip-prev-chapter';
            prevHint.innerHTML = `<span class="strip-hint-label">上一章</span><span class="strip-hint-title">${this.escapeHtml(prevChapter.chapterTitle)}</span>`;
            prevHint.addEventListener('click', () => {
                this.switchChapter(this.state.currentChapterIndex - 1, 'last');
            });
            container.appendChild(prevHint);
        } else {
            const topHint = document.createElement('div');
            topHint.className = 'strip-chapter-hint strip-boundary';
            topHint.innerHTML = '<span class="strip-hint-label">已是第一章</span>';
            container.appendChild(topHint);
        }

        // 图片列表
        for (let i = 0; i < total; i++) {
            const img = this.createReaderImage(i, 'strip-img');
            img.dataset.page = i;
            container.appendChild(img);
        }

        // 下一章提示
        if (this.state.currentChapterIndex < this.state.allChapters.length - 1) {
            const nextChapter = this.state.allChapters[this.state.currentChapterIndex + 1];
            const nextHint = document.createElement('div');
            nextHint.className = 'strip-chapter-hint strip-next-chapter';
            nextHint.innerHTML = `<span class="strip-hint-label">下一章</span><span class="strip-hint-title">${this.escapeHtml(nextChapter.chapterTitle)}</span>`;
            nextHint.addEventListener('click', () => {
                this.switchChapter(this.state.currentChapterIndex + 1, 'first');
            });
            container.appendChild(nextHint);
        } else {
            const bottomHint = document.createElement('div');
            bottomHint.className = 'strip-chapter-hint strip-boundary';
            bottomHint.innerHTML = '<span class="strip-hint-label">已是最后一章</span>';
            container.appendChild(bottomHint);
        }

        // 点击中央区域切换 UI
        container.addEventListener('click', (e) => {
            // 不拦截章节提示按钮的点击
            if (e.target.closest('.strip-chapter-hint')) return;
            const y = e.clientY;
            const h = window.innerHeight;
            // 中间 1/3 区域切换 UI
            if (y > h / 3 && y < h * 2 / 3) {
                this.toggleUI();
            }
        });
        container.addEventListener('wheel', () => this._cancelStripRestore(), { passive: true, once: true });
        container.addEventListener('touchstart', () => this._cancelStripRestore(), { passive: true, once: true });

        // 滚动监听 — 跟踪当前页
        if (this._stripScrollHandler) {
            container.removeEventListener('scroll', this._stripScrollHandler);
        }
        this._stripScrollHandler = () => this._onStripScroll();
        container.addEventListener('scroll', this._stripScrollHandler, { passive: true });

        // 更新指示器
        const indicator = document.getElementById('page-indicator');
        const slider = document.getElementById('page-slider');
        slider.max = total;
        slider.style.direction = 'ltr';
        indicator.textContent = `${this.state.currentPage + 1} / ${total}`;
        slider.value = this.state.currentPage + 1;

        // 恢复进度 — 滚动到保存的页面
        const savedPage = Math.min(this.state.currentPage, total - 1);
        this._restoreStripScrollPosition(container, savedPage, total);

        this.saveProgress(savedPage);
    },

    _restoreStripScrollPosition(container, savedPage, total) {
        const page = Math.max(0, Math.min(Number(savedPage) || 0, total - 1));
        const token = ++this._stripRestoreToken;
        this._stripRestoreTargetPage = page;

        if (page <= 0) {
            container.scrollTop = 0;
            this._stripRestoreTargetPage = null;
            return;
        }

        const imgs = Array.from(container.querySelectorAll('img.strip-img'));
        const relevantImgs = imgs.slice(0, page + 1);
        const targetImg = imgs[page];
        if (!targetImg) {
            this._stripRestoreTargetPage = null;
            return;
        }

        const applyScroll = () => {
            if (token !== this._stripRestoreToken || !container.isConnected) return;
            this.state.currentPage = page;
            this._updateIndicator();
            targetImg.scrollIntoView({ block: 'start' });
        };

        relevantImgs.forEach(img => {
            if (!img.complete) {
                img.addEventListener('load', applyScroll, { once: true });
                img.addEventListener('error', applyScroll, { once: true });
            }
        });

        let attempts = 0;
        const retryUntilLaidOut = () => {
            if (token !== this._stripRestoreToken || !container.isConnected) return;
            attempts += 1;
            applyScroll();

            const ready = relevantImgs.every(img => img.complete || img.classList.contains('is-error'));
            if (ready || attempts >= 80) {
                setTimeout(() => {
                    if (token !== this._stripRestoreToken || !container.isConnected) return;
                    applyScroll();
                    this._stripRestoreTargetPage = null;
                    if (!ready) this._stripRestoreToken += 1;
                }, 120);
                return;
            }

            setTimeout(() => requestAnimationFrame(retryUntilLaidOut), 100);
        };

        requestAnimationFrame(retryUntilLaidOut);
    },

    _cancelStripRestore() {
        if (this._stripRestoreTargetPage == null) return;
        this._stripRestoreToken += 1;
        this._stripRestoreTargetPage = null;
    },

    _onStripScroll() {
        if (this._stripScrollTimer) return;
        this._stripScrollTimer = setTimeout(() => {
            this._stripScrollTimer = null;

            const container = document.getElementById('strip-container');
            if (!container) return;

            const imgs = container.querySelectorAll('img.strip-img');
            if (imgs.length === 0) return;

            if (this._stripRestoreTargetPage != null) {
                this.state.currentPage = this._stripRestoreTargetPage;
                this._updateIndicator();
                return;
            }

            const scrollTop = container.scrollTop;
            const midY = scrollTop + container.clientHeight / 2;

            let currentPage = 0;
            for (let i = 0; i < imgs.length; i++) {
                if (imgs[i].offsetTop <= midY) {
                    currentPage = i;
                } else {
                    break;
                }
            }

            if (currentPage !== this.state.currentPage) {
                this.state.currentPage = currentPage;
                this._updateIndicator();
                this.saveProgress(currentPage);
            }
        }, 100);
    },

    _exitStripMode() {
        const container = document.getElementById('strip-container');
        if (container) {
            if (this._stripScrollHandler) {
                container.removeEventListener('scroll', this._stripScrollHandler);
                this._stripScrollHandler = null;
            }
            container.remove();
        }
        if (this._stripScrollTimer) {
            clearTimeout(this._stripScrollTimer);
            this._stripScrollTimer = null;
        }
        this._stripRestoreToken += 1;
        this._stripRestoreTargetPage = null;
        const viewport = document.getElementById('reader-viewport');
        viewport.classList.remove('strip-mode');
        document.getElementById('slide-track').style.display = '';
        document.getElementById('reader-touch-layer').style.display = '';
    },

    // 获取上一页的 page index（考虑拼页）
    _getPrevPageIndex() {
        const page = this.state.currentPage;
        if (!this.state.doublePageMode) {
            return page > 0 ? page - 1 : null;
        }
        const curStart = this._alignToPageStart(page);
        if (curStart > 0) {
            return this._alignToPageStart(curStart - 1);
        }
        return null;
    },

    // 获取下一页的 page index（考虑拼页）
    _getNextPageIndex() {
        const total = this.state.currentImages.length;
        const page = this.state.currentPage;
        if (!this.state.doublePageMode) {
            return page + 1 < total ? page + 1 : null;
        }
        const count = this._getPageCount(page);
        const nextPage = page + count;
        return nextPage < total ? nextPage : null;
    },

    // 能否向前翻页
    _canGoPrev() {
        return this._getPrevPageIndex() !== null || this.state.currentChapterIndex > 0;
    },

    // 能否向后翻页
    _canGoNext() {
        return this._getNextPageIndex() !== null || this.state.currentChapterIndex < this.state.allChapters.length - 1;
    },

    // 带动画翻页（键盘/点击触发）
    animateToPage(direction) {
        if (this.isImageZoomed()) {
            this.resetImageZoom();
            return;
        }
        if (this._swipe.animating) return;

        if (direction === 'prev') {
            if (this._getPrevPageIndex() !== null) {
                this._finishSwipe('prev');
            } else if (this.state.currentChapterIndex > 0) {
                this.switchChapter(this.state.currentChapterIndex - 1, 'last');
            }
        } else {
            if (this._getNextPageIndex() !== null) {
                this._finishSwipe('next');
            } else if (this.state.currentChapterIndex < this.state.allChapters.length - 1) {
                this.switchChapter(this.state.currentChapterIndex + 1, 'first');
            }
        }
    },

    // 完成翻页滑动动画
    _finishSwipe(direction) {
        if (!this.state.novelMode && (this.isImageZoomed() || this.isImageZoomInteractionActive())) {
            this.cancelReaderSwipe();
            return;
        }
        this._swipe.animating = true;
        const track = document.getElementById('slide-track');
        const isRtl = this.state.readingDirection === 'rtl';

        // 物理滑动方向：slot 布局在 RTL 下已交换（prev slot = next page, next slot = prev page）
        // LTR: prev → 滑到左 slot(0%), next → 滑到右 slot(-66.6667%)
        // RTL: prev → 滑到右 slot(-66.6667%), next → 滑到左 slot(0%)
        let targetPercent;
        if (isRtl) {
            targetPercent = direction === 'prev' ? -66.6667 : 0;
        } else {
            targetPercent = direction === 'prev' ? 0 : -66.6667;
        }

        track.classList.add('animating');
        track.style.transform = `translate3d(${targetPercent}%, 0, 0)`;

        const onEnd = () => {
            track.removeEventListener('transitionend', onEnd);

            // 更新 state
            if (direction === 'prev') {
                this.state.currentPage = this._getPrevPageIndex();
            } else {
                this.state.currentPage = this._getNextPageIndex();
            }

            // ── 无闪烁复位：通过交换 DOM 节点避免重建 ──
            const slidePrev = document.getElementById('slide-prev');
            const slideCurrent = document.getElementById('slide-current');
            const slideNext = document.getElementById('slide-next');

            // 判断物理滑动方向：滑向左 slot 还是右 slot
            const slidToLeft = targetPercent > -33.3333; // targetPercent=0 即滑到了左 slot

            if (slidToLeft) {
                // 用户看到的是左 slot 的内容，现在要让它成为新的 current
                // 旋转: prev→丢弃, current→next, next(目标)→current
                // 实际操作：把 next(右) 移到最前面变成新 prev
                track.insertBefore(slideNext, slidePrev);
            } else {
                // 用户看到的是右 slot 的内容，现在要让它成为新的 current
                // 旋转: next→丢弃, current→prev, prev(目标)→current
                // 实际操作：把 prev(左) 移到最后面变成新 next
                track.appendChild(slidePrev);
            }

            // 瞬间复位 track 到中间位置（由于 DOM 节点已交换，视觉无跳动）
            track.classList.remove('animating');
            track.style.transform = 'translate3d(-33.3333%, 0, 0)';

            // 恢复正确的 id（DOM 顺序变了，需要重新分配 id）
            const slots = track.children;
            slots[0].id = 'slide-prev';
            slots[1].id = 'slide-current';
            slots[2].id = 'slide-next';

            // 同步 #image-container id 到当前页的容器
            for (const s of slots) {
                const ic = s.querySelector('.image-container');
                if (ic) ic.removeAttribute('id');
            }
            const currentIC = slots[1].querySelector('.image-container');
            if (currentIC) currentIC.id = 'image-container';

            // 只需要更新被丢弃的那个 slot（现在是新的 prev 或 next）
            const newIsRtl = this.state.readingDirection === 'rtl';
            if (slidToLeft) {
                // 新的 prev slot（slots[0]）需要更新内容
                const prevContent = newIsRtl ? this._getNextPageIndex() : this._getPrevPageIndex();
                this._renderSlot('slide-prev', prevContent);
            } else {
                // 新的 next slot（slots[2]）需要更新内容
                const nextContent = newIsRtl ? this._getPrevPageIndex() : this._getNextPageIndex();
                this._renderSlot('slide-next', nextContent);
            }

            // 更新 UI 指示器
            this._updateIndicator();

            // 保存进度和预加载
            this.saveProgress(this.state.currentPage);
            this.preloadAdjacent();

            this._swipe.animating = false;
        };

        track.addEventListener('transitionend', onEnd);

        // 安全超时，防止 transitionend 未触发
        setTimeout(() => {
            if (this._swipe.animating) {
                onEnd();
            }
        }, 400);
    },

    // 回弹到当前页
    _snapBack() {
        const track = document.getElementById('slide-track');
        track.classList.add('animating');
        track.style.transform = 'translate3d(-33.3333%, 0, 0)';

        const onEnd = () => {
            track.removeEventListener('transitionend', onEnd);
            track.classList.remove('animating');
        };
        track.addEventListener('transitionend', onEnd);
        setTimeout(() => {
            track.classList.remove('animating');
        }, 400);
    },

    // 节流保存进度
    _progressTimer: null,
    saveProgress(page) {
        const comicId = this.state.currentComic?.comic?.id;
        const chapter = this.state.currentChapter;
        if (!comicId || !chapter) return;
        const savedPage = Math.max(0, Number.isFinite(Number(page)) ? Number(page) : 0);
        const chapterSnapshot = {
            chapterUuid: chapter.chapterUuid,
            chapterTitle: chapter.chapterTitle,
            groupName: chapter.groupName,
            resourceId: chapter.resourceId || '',
            sourceStartPage: chapter.sourceStartPage || null,
            sourcePageCount: chapter.sourcePageCount || null,
        };
        if (this._progressTimer) clearTimeout(this._progressTimer);
        this._progressTimer = setTimeout(() => {
            this._progressTimer = null;
            this.authFetch(`/api/progress/${encodeURIComponent(comicId)}`, {
                method: 'PUT',
                body: JSON.stringify({
                    chapterUuid: chapterSnapshot.chapterUuid,
                    page: savedPage,
                    chapterTitle: chapterSnapshot.chapterTitle,
                    groupName: chapterSnapshot.groupName,
                    resourceId: chapterSnapshot.resourceId,
                    sourceStartPage: chapterSnapshot.sourceStartPage,
                    sourcePageCount: chapterSnapshot.sourcePageCount,
                })
            }).catch(() => {});

            // 同时更新本地缓存
            if (!this.state.progressCache[comicId]) this.state.progressCache[comicId] = {};
            this.state.progressCache[comicId].lastChapterUuid = chapterSnapshot.chapterUuid;
            this.state.progressCache[comicId].lastPage = savedPage;
            this.state.progressCache[comicId].lastChapterTitle = chapterSnapshot.chapterTitle;
            this.state.progressCache[comicId].lastResourceId = chapterSnapshot.resourceId;
            this.state.progressCache[comicId].lastSourceStartPage = chapterSnapshot.sourceStartPage;
            this.state.progressCache[comicId].lastSourcePageCount = chapterSnapshot.sourcePageCount;
            this.state.progressCache[comicId].updatedAt = new Date().toISOString();
            if (!this.state.progressCache[comicId].chapters) this.state.progressCache[comicId].chapters = {};
            this.state.progressCache[comicId].chapters[chapterSnapshot.chapterUuid] = {
                page: savedPage,
                resourceId: chapterSnapshot.resourceId,
                sourceStartPage: chapterSnapshot.sourceStartPage,
                sourcePageCount: chapterSnapshot.sourcePageCount,
            };
            // 下一次回到首页时强制刷新，确保多版本代表项与封面按最新阅读同步。
            this.state.lastComicsLoadTime = 0;
        }, 800);
    },

    toggleDoublePageOffset() {
        this.state.doublePageOffset = this.state.doublePageOffset === 0 ? 1 : 0;
        this.saveSettings();
        this.renderPage();
    },

    preloadAdjacent() {
        const count = this.state.doublePageMode ? this._getPageCount(this.state.currentPage) : 1;
        const total = this.state.currentImages.length;
        const next = this.state.currentPage + count;
        for (let i = next; i < Math.min(next + 3, total); i++) {
            const img = new Image();
            img.src = this.state.currentImages[i];
        }
    },

    prevPage() {
        this.animateToPage('prev');
    },

    nextPage() {
        this.animateToPage('next');
    },

    async switchChapter(idx, position) {
        const chapter = this.state.allChapters[idx];
        if (!chapter) return;
        const openOptions = { chapterList: this.state.allChapters };
        if (position === 'first') {
            openOptions.startPage = chapter.isVolumeSubChapter && chapter.sourceStartPage
                ? Math.max(0, Number(chapter.sourceStartPage || 1) - 1)
                : 0;
        }
        await this.openReader(chapter, openOptions);
        if (position === 'last') {
            const total = this.state.currentImages.length;
            const lastPage = Math.max(0, total - 1);
            if (this.state.stripMode) {
                this.state.currentPage = lastPage;
                this.renderPage();
                // 条漫模式滚动到底部
                requestAnimationFrame(() => {
                    const c = document.getElementById('strip-container');
                    if (c) {
                        const imgs = c.querySelectorAll('img.strip-img');
                        if (imgs[lastPage]) {
                            imgs[lastPage].scrollIntoView({ block: 'start' });
                        }
                    }
                });
            } else {
                this.state.currentPage = this.state.doublePageMode
                    ? this._alignToPageStart(lastPage)
                    : lastPage;
                this.renderPage();
            }
        }
    },

    async exitReader() {
        this.hideUI();

        if (this.state.novelMode) {
            this.flushNovelProgress();
            const comicId = this.state.currentComic.comic.id;
            this.applyOptimisticListCoverFromCurrentComic(comicId);
            this.state.lastComicsLoadTime = 0;
            this._exitNovelMode();
            this.renderContinueReading();
            this.renderChapterList();
            this.state.listNeedsRender = true;
            this.showPage('comic-detail-page');
            return;
        }

        // 清理条漫模式
        this._exitStripMode();

        // 取消节流定时器，立即保存当前进度
        if (this._progressTimer) clearTimeout(this._progressTimer);
        const comicId = this.state.currentComic.comic.id;
        const chapter = this.state.currentChapter;
        const page = this.state.currentPage;

        // 立即更新本地缓存
        if (!this.state.progressCache[comicId]) this.state.progressCache[comicId] = {};
        this.state.progressCache[comicId].lastChapterUuid = chapter.chapterUuid;
        this.state.progressCache[comicId].lastPage = page;
        this.state.progressCache[comicId].lastChapterTitle = chapter.chapterTitle;
        this.state.progressCache[comicId].lastGroupName = chapter.groupName;
        this.state.progressCache[comicId].lastResourceId = chapter.resourceId || '';
        this.state.progressCache[comicId].lastSourceStartPage = chapter.sourceStartPage || null;
        this.state.progressCache[comicId].lastSourcePageCount = chapter.sourcePageCount || null;
        this.state.progressCache[comicId].updatedAt = new Date().toISOString();
        if (!this.state.progressCache[comicId].chapters) this.state.progressCache[comicId].chapters = {};
        this.state.progressCache[comicId].chapters[chapter.chapterUuid] = {
            page,
            resourceId: chapter.resourceId || '',
            sourceStartPage: chapter.sourceStartPage || null,
            sourcePageCount: chapter.sourcePageCount || null,
        };
        this.applyOptimisticListCoverFromCurrentComic(comicId);
        this.state.lastComicsLoadTime = 0;

        // 先保存到服务器，再切换页面，确保数据一致
        try {
            await this.authFetch(`/api/progress/${encodeURIComponent(comicId)}`, {
                method: 'PUT',
                body: JSON.stringify({
                    chapterUuid: chapter.chapterUuid,
                    page: page,
                    chapterTitle: chapter.chapterTitle,
                    groupName: chapter.groupName,
                    resourceId: chapter.resourceId || '',
                    sourceStartPage: chapter.sourceStartPage || null,
                    sourcePageCount: chapter.sourcePageCount || null,
                })
            });
        } catch (e) {}

        // 刷新详情页 UI
        this.renderContinueReading();
        this.renderChapterList();
        this.state.listNeedsRender = true;
        this.showPage('comic-detail-page');
    },

    // ─── Metadata Edit（含封面） ───
    openEditModal() {
        const c = this.state.currentComic.comic;
        document.getElementById('edit-name').value = c.name || '';
        document.getElementById('edit-alias').value = c.alias || '';
        document.getElementById('edit-bangumi-subject-id').value = c.bangumiSubjectId || '';
        document.getElementById('edit-author').value = c.author.map(a => a.name).join(', ');
        document.getElementById('edit-status').value = c.status?.display || '';
        document.getElementById('edit-brief').value = c.brief || '';
        document.getElementById('edit-cover-preview').src = this.withAssetToken(c.cover || '');
        const bgmCoverBtn = document.getElementById('use-bangumi-cover-btn');
        if (bgmCoverBtn) {
            bgmCoverBtn.disabled = false;
            bgmCoverBtn.textContent = '使用BGM封面';
        }
        const saveStatus = document.getElementById('edit-save-status');
        if (saveStatus) saveStatus.textContent = '';
        this.populateCoverSourceOptions();
        document.getElementById('edit-modal').style.display = 'flex';
    },

    populateCoverSourceOptions() {
        const select = document.getElementById('edit-cover-resource');
        const pageInput = document.getElementById('edit-cover-page-number');
        if (!select || !pageInput) return;

        const resources = (this.state.currentComic.coverResources || this.state.currentComic.resources || [])
            .filter(resource =>
                resource.readable !== false &&
                resource.type !== 'epub' &&
                Number(resource.pageCount || 0) > 0
            );

        select.innerHTML = '';
        if (resources.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '暂无可用资源';
            select.appendChild(option);
            select.disabled = true;
            pageInput.disabled = true;
            pageInput.value = '1';
            pageInput.max = '1';
            return;
        }

        for (const resource of resources) {
            const option = document.createElement('option');
            option.value = resource.resourceId;
            const type = (resource.contentType || resource.type || '').toUpperCase();
            const source = resource.sourceAlias || resource.sourceTitle || resource.sourceSegment || '';
            option.textContent = `${source ? `${source} · ` : ''}${resource.title || resource.resourceId} (${type} · ${resource.pageCount || 0}P)`;
            select.appendChild(option);
        }

        const preferred = resources.find(resource => resource.contentType === 'volume') || resources[0];
        select.value = preferred.resourceId;
        select.disabled = false;
        pageInput.disabled = false;
        pageInput.value = '1';
        this.onEditCoverResourceChange();
    },

    onEditCoverResourceChange() {
        const select = document.getElementById('edit-cover-resource');
        const pageInput = document.getElementById('edit-cover-page-number');
        if (!select || !pageInput) return;

        const resources = this.state.currentComic.coverResources || this.state.currentComic.resources || [];
        const resource = resources.find(item => item.resourceId === select.value);
        const maxPage = Math.max(1, Number(resource?.pageCount || 1));
        pageInput.max = String(maxPage);

        let value = Number(pageInput.value || 1);
        if (!Number.isFinite(value) || value < 1) value = 1;
        if (value > maxPage) value = maxPage;
        pageInput.value = String(Math.floor(value));
    },

    async applyCoverFromPage() {
        const select = document.getElementById('edit-cover-resource');
        const pageInput = document.getElementById('edit-cover-page-number');
        if (!select || !pageInput || !select.value) return;

        const maxPage = Math.max(1, Number(pageInput.max || 1));
        const pageNumber = Math.min(maxPage, Math.max(1, Math.floor(Number(pageInput.value || 1))));

        try {
            await this.authFetch(`/api/comics/${encodeURIComponent(this.state.currentComic.comic.id)}/cover/from-page`, {
                method: 'POST',
                body: JSON.stringify({ resourceId: select.value, pageNumber }),
            });
            await this.refreshAfterCoverChange(this.state.currentComic.comic.id);
        } catch (error) {
            console.error('Failed to set cover from page:', error);
        }
    },

    closeEditModal() {
        document.getElementById('edit-modal').style.display = 'none';
    },

    async saveMetadata() {
        const comicId = this.state.currentComic?.comic?.id;
        const saveButton = document.getElementById('edit-save-button');
        const saveStatus = document.getElementById('edit-save-status');
        if (!comicId || saveButton?.disabled) return;
        const name = document.getElementById('edit-name').value.trim();
        const alias = document.getElementById('edit-alias').value.trim();
        const authorStr = document.getElementById('edit-author').value.trim();
        const status = document.getElementById('edit-status').value.trim();
        const brief = document.getElementById('edit-brief').value.trim();

        const authors = authorStr.split(/[,，]/).filter(s => s.trim()).map(s => ({
            name: s.trim(), alias: null, path_word: ''
        }));

        if (saveStatus) saveStatus.textContent = '';
        if (saveButton) {
            saveButton.disabled = true;
            saveButton.textContent = '保存中';
        }
        try {
            const response = await this.authFetch(`/api/comics/${encodeURIComponent(comicId)}/metadata`, {
                method: 'PUT',
                body: JSON.stringify({ name, alias, brief, author: authors, status: { display: status } })
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok) throw new Error(payload?.error || '元数据保存失败');
            this.closeEditModal();
            await this.showComicDetail(comicId, { skipPreferredVersion: true });
            this.state.listNeedsRender = true;
            await this.refreshComicsIncremental();
        } catch (error) {
            console.error('Failed to save metadata:', error);
            if (saveStatus) saveStatus.textContent = error.message || '元数据保存失败';
        } finally {
            if (saveButton) {
                saveButton.disabled = false;
                saveButton.textContent = '保存';
            }
        }
    },

    async rescrapeFromEditSubject() {
        const input = document.getElementById('edit-bangumi-subject-id');
        const subjectId = Number(input?.value || 0);
        if (!Number.isInteger(subjectId) || subjectId <= 0) return;
        this.closeEditModal();
        await this.rescrapeCurrentComic(subjectId);
    },

    async clearBangumiData() {
        if (!this.state.currentComic?.comic?.id) return;
        const name = this.state.currentComic.comic.name || '';
        this.confirm('清除 BGM 刮削数据', `确定要清除「${name}」的 Bangumi 刮削数据吗？将回退到本地元数据.json；没有本地元数据时回到默认信息。`, async () => {
            try {
                await this.authFetch(`/api/comics/${encodeURIComponent(this.state.currentComic.comic.id)}/bangumi`, {
                    method: 'DELETE'
                });
                await this.showComicDetail(this.state.currentComic.comic.id);
                await this.loadComics();
            } catch (error) {
                console.error('Failed to clear Bangumi data:', error);
            }
        });
    },

    // ─── Cover ───
    async uploadCover(event) {
        const file = event.target.files[0];
        if (!file) return;
        const form = new FormData();
        form.append('cover', file);

        try {
            await this.authFetch(`/api/comics/${encodeURIComponent(this.state.currentComic.comic.id)}/cover`, {
                method: 'POST',
                body: form
            });
            await this.refreshAfterCoverChange(this.state.currentComic.comic.id);
        } catch (error) {
            console.error('Failed to upload cover:', error);
        }
        event.target.value = '';
    },

    async useBangumiCover() {
        const comicId = this.state.currentComic?.comic?.id;
        if (!comicId) return;

        const input = document.getElementById('edit-bangumi-subject-id');
        const inputSubjectId = Number(input?.value || 0);
        const currentSubjectId = Number(this.state.currentComic?.comic?.bangumiSubjectId || 0);
        const subjectId = Number.isInteger(inputSubjectId) && inputSubjectId > 0
            ? inputSubjectId
            : currentSubjectId;
        if (!Number.isInteger(subjectId) || subjectId <= 0) return;

        const btn = document.getElementById('use-bangumi-cover-btn');
        const originalText = btn?.textContent || '使用BGM封面';
        if (btn) {
            btn.disabled = true;
            btn.textContent = '获取中...';
        }

        try {
            const res = await this.authFetch(`/api/comics/${encodeURIComponent(comicId)}/cover/from-bangumi`, {
                method: 'POST',
                body: JSON.stringify({ subjectId }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Bangumi 封面获取失败');

            await this.refreshAfterCoverChange(comicId);
        } catch (error) {
            console.error('Failed to use Bangumi cover:', error);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        }
    },

    async deleteCover() {
        this.confirm('删除封面', '确定要删除自定义封面吗？将回退到默认封面。', async () => {
            try {
                await this.authFetch(`/api/comics/${encodeURIComponent(this.state.currentComic.comic.id)}/cover`, {
                    method: 'DELETE'
                });
                await this.refreshAfterCoverChange(this.state.currentComic.comic.id);
            } catch (error) {
                console.error('Failed to delete cover:', error);
            }
        });
    },

    // ─── Delete ───
    async deleteChapter(groupName, order, title) {
        const orderStr = Number.isInteger(order) ? String(Math.floor(order)) : String(order);
        const chapterDir = `${orderStr} ${title}`;

        this.confirm('删除章节', `确定要删除「${title}」吗？此操作不可撤销。`, async () => {
            try {
                await this.authFetch(`/api/comics/${encodeURIComponent(this.state.currentComic.comic.id)}/${encodeURIComponent(groupName)}/${encodeURIComponent(chapterDir)}`, {
                    method: 'DELETE'
                });
                await this.showComicDetail(this.state.currentComic.comic.id);
            } catch (error) {
                console.error('Failed to delete chapter:', error);
            }
        });
    },

    async deleteComic() {
        const name = this.state.currentComic.comic.name;
        this.confirm('删除作品', `确定要删除「${name}」及其所有文件吗？此操作不可撤销。`, async () => {
            try {
                await this.authFetch(`/api/comics/${encodeURIComponent(this.state.currentComic.comic.id)}`, {
                    method: 'DELETE'
                });
                await this.loadComics();
                this.showComicList();
            } catch (error) {
                console.error('Failed to delete comic:', error);
            }
        });
    },

    // ─── Confirm Dialog ───
    confirm(title, message, callback) {
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').textContent = message;
        const btn = document.getElementById('confirm-ok-btn');
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', () => {
            this.closeConfirm();
            callback();
        });
        document.getElementById('confirm-modal').style.display = 'flex';
    },

    closeConfirm() {
        document.getElementById('confirm-modal').style.display = 'none';
    },

    // ─── Navigation ───
    showComicList() {
        // 重置搜索状态
        if (this.state.searchResults !== null) {
            this.clearSearch();
        }
        if (this.state.listNeedsRender) {
            this.renderComicList();
        }
        this.showPage('comic-list-page');
        if (!this.state.lastComicsLoadTime || Date.now() - this.state.lastComicsLoadTime > 60 * 1000) {
            this.loadComics();
        }
    },

    showPage(pageId) {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById(pageId).classList.add('active');
        const readerActive = pageId === 'reader-page';
        document.documentElement.classList.toggle('reader-active', readerActive);
        document.body?.classList.toggle('reader-active', readerActive);
    },

    setPageScrollTop(value = 0) {
        const top = Math.max(0, Number(value || 0));
        window.scrollTo(0, top);
        document.documentElement.scrollTop = top;
        document.body.scrollTop = top;
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { app };
} else if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => app.init());
}
