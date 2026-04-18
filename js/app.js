'use strict';

// ═══════════════════════════════════════════════════════════════
// Windjammer Production App — app.js
// Stages: Inside Stage | Beach Stage (shared crew)
// ═══════════════════════════════════════════════════════════════

class WindjammerApp {
    constructor() {
        this.authToken   = localStorage.getItem('wj_auth_token') || null;
        this.currentUser = null;
        this.currentStage = 'inside'; // active stage tab on dashboard
        this.currentPage  = 'dashboard';

        // Cached data
        this.productions = [];
        this.crew        = [];
        this.tasks       = [];
        this.equipment   = [];

        this.ROLES = { ADMIN: 'admin', OWNER: 'owner', MANAGER: 'manager', USER: 'user' };
    }

    // ── Bootstrap ───────────────────────────────────────────────
    async init() {
        this.setupLogin();

        if (this.authToken) {
            const valid = await this.validateSession();
            if (valid) { this.showApp(); return; }
        }
        this.showLoginScreen();
    }

    // ── Auth ─────────────────────────────────────────────────────
    setupLogin() {
        const form = document.getElementById('loginForm');
        if (form) form.addEventListener('submit', e => this.handleLogin(e));
    }

    async handleLogin(e) {
        e.preventDefault();
        const name    = document.getElementById('loginName').value.trim();
        const pin     = document.getElementById('loginPin').value.trim();
        const errorEl = document.getElementById('loginError');
        const errText = document.getElementById('loginErrorText');
        const btn     = document.getElementById('loginBtn');

        if (!name || !pin) return;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in…';
        errorEl.style.display = 'none';

        try {
            const res  = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pin }) });
            const data = await res.json();
            if (data.success) {
                this.authToken   = data.token;
                this.currentUser = data.user;
                localStorage.setItem('wj_auth_token', data.token);
                this.showApp();
            } else {
                errText.textContent = data.message || 'Invalid name or PIN';
                errorEl.style.display = 'flex';
                document.getElementById('loginPin').value = '';
            }
        } catch {
            errText.textContent = 'Connection error. Is the server running?';
            errorEl.style.display = 'flex';
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
        }
    }

    async validateSession() {
        try {
            const res  = await fetch('/api/auth/me', { headers: { 'Authorization': `Bearer ${this.authToken}` } });
            const data = await res.json();
            if (data.success) { this.currentUser = data.user; return true; }
            return false;
        } catch { return false; }
    }

    showLoginScreen() {
        document.getElementById('loginScreen').style.display  = 'flex';
        document.getElementById('appContainer').style.display = 'none';
    }

    logout() {
        fetch('/api/auth/logout', { method: 'POST', headers: { 'Authorization': `Bearer ${this.authToken}` } }).catch(() => {});
        this.authToken = null;
        localStorage.removeItem('wj_auth_token');
        this.showLoginScreen();
    }

    // ── Authenticated fetch ─────────────────────────────────────
    async apiFetch(url, options = {}) {
        if (!options.headers) options.headers = {};
        options.headers['Authorization'] = `Bearer ${this.authToken}`;
        const res = await fetch(url, options);
        if (res.status === 401) { this.showLoginScreen(); throw new Error('Session expired'); }
        return res;
    }

    // ── Show App ────────────────────────────────────────────────
    showApp() {
        document.getElementById('loginScreen').style.display  = 'none';
        document.getElementById('appContainer').style.display = '';

        this.bindEvents();
        this.renderNavUser();
        this.buildStageTabBar();
        this.navigateTo('dashboard');
        this.loadAllData();
    }

    renderNavUser() {
        const el = document.getElementById('navUserName');
        if (el && this.currentUser) el.textContent = this.currentUser.name;
    }

    // ── Stage tab bar in topnav ─────────────────────────────────
    buildStageTabBar() {
        const bar = document.getElementById('stageTabBar');
        if (!bar) return;
        const stages = [{ id: 'inside', label: 'Inside Stage' }, { id: 'beach', label: 'Beach Stage' }];
        bar.innerHTML = stages.map(s =>
            `<button class="stage-tab-nav${s.id === this.currentStage ? ' active-' + s.id : ''}" data-stage="${s.id}">${s.label}</button>`
        ).join('');
        bar.querySelectorAll('.stage-tab-nav').forEach(btn => {
            btn.addEventListener('click', () => this.switchStage(btn.dataset.stage));
        });
    }

    switchStage(stageId) {
        this.currentStage = stageId;
        // Update topnav tabs
        document.querySelectorAll('.stage-tab-nav').forEach(b => {
            b.className = 'stage-tab-nav' + (b.dataset.stage === stageId ? ` active-${stageId}` : '');
        });
        // If on dashboard, swap visible stage panel
        if (this.currentPage === 'dashboard') {
            document.querySelectorAll('.stage-dashboard').forEach(el => { el.style.display = 'none'; });
            const panel = document.getElementById(`dash-${stageId}`);
            if (panel) panel.style.display = '';
        }
    }

    // ── Events ──────────────────────────────────────────────────
    bindEvents() {
        // Sidebar nav
        document.querySelectorAll('.sidebar-menu li[data-page]').forEach(li => {
            li.addEventListener('click', () => this.navigateTo(li.dataset.page));
        });

        // Hamburger
        document.getElementById('navToggle')?.addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('open');
        });

        // Logout
        document.getElementById('logoutBtn')?.addEventListener('click', () => this.logout());

        // Stage filter tabs (productions, tasks, equipment pages)
        document.querySelectorAll('.stage-filter-tabs .stage-tab').forEach(btn => {
            btn.addEventListener('click', e => {
                const tabs = e.target.closest('.stage-filter-tabs').querySelectorAll('.stage-tab');
                tabs.forEach(t => t.classList.remove('active'));
                btn.classList.add('active');
                this.applyFilters();
            });
        });

        // Task filters
        document.getElementById('taskStatusFilter')?.addEventListener('change', () => this.renderTasks());
        document.getElementById('taskSortSelect')?.addEventListener('change', () => this.renderTasks());
    }

    // ── Navigation ──────────────────────────────────────────────
    navigateTo(page) {
        this.currentPage = page;
        document.querySelectorAll('.page-view').forEach(v => { v.style.display = 'none'; v.classList.remove('active'); });
        document.querySelectorAll('.sidebar-menu li').forEach(li => li.classList.remove('active'));

        const view = document.getElementById(`${page}View`);
        const li   = document.querySelector(`.sidebar-menu li[data-page="${page}"]`);
        if (view) { view.style.display = ''; view.classList.add('active'); }
        if (li)   li.classList.add('active');

        if (page === 'dashboard') this.switchStage(this.currentStage);
        if (page === 'settings')  this.renderSettings();
    }

    // ── Load all data ────────────────────────────────────────────
    async loadAllData() {
        try {
            const [prRes, crRes, tRes, eqRes] = await Promise.all([
                this.apiFetch('/api/productions'),
                this.apiFetch('/api/crew'),
                this.apiFetch('/api/tasks'),
                this.apiFetch('/api/equipment')
            ]);
            this.productions = (await prRes.json()).data || [];
            this.crew        = (await crRes.json()).data || [];
            this.tasks       = (await tRes.json()).data  || [];
            this.equipment   = (await eqRes.json()).data || [];

            this.renderDashboard();
            this.renderProductions();
            this.renderCrew();
            this.renderTasks();
            this.renderEquipment();
        } catch (err) {
            console.error('Data load error:', err);
        }
    }

    // ── Helpers ──────────────────────────────────────────────────
    escapeHtml(str) {
        return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    getActiveStageFilter(tabsId) {
        const active = document.querySelector(`#${tabsId} .stage-tab.active`);
        return active ? active.dataset.stage : 'all';
    }

    filterByStage(items, stageFilter) {
        if (!stageFilter || stageFilter === 'all') return items;
        return items.filter(i => (i.Stage || '').toLowerCase() === stageFilter.toLowerCase());
    }

    applyFilters() {
        const page = this.currentPage;
        if (page === 'productions') this.renderProductions();
        if (page === 'tasks')       this.renderTasks();
        if (page === 'equipment')   this.renderEquipment();
    }

    // ── Dashboard ────────────────────────────────────────────────
    renderDashboard() {
        ['inside', 'beach'].forEach(stageId => {
            const stageName = stageId === 'inside' ? 'Inside Stage' : 'Beach Stage';
            const prods     = this.productions.filter(p => (p.Stage || '').toLowerCase() === stageId);
            const tasks     = this.tasks.filter(t => (t.Stage || '').toLowerCase() === stageId && (t.Status || '').toLowerCase() !== 'completed');
            const crews     = [...new Set(this.productions.filter(p => (p.Stage || '').toLowerCase() === stageId).flatMap(p => [p.Lead, p['Op 1'], p['Op 2'], p['Op 3']]).filter(Boolean))];

            // Stats
            const el = id => document.getElementById(`${stageId}-${id}`);
            if (el('statProductions')) el('statProductions').textContent = prods.length;
            if (el('statTasks'))       el('statTasks').textContent       = tasks.length;
            if (el('statCrew'))        el('statCrew').textContent        = crews.length;

            // Productions widget
            const prodBody = el('widgetProductionsBody');
            if (prodBody) {
                if (prods.length === 0) {
                    prodBody.innerHTML = '<div class="widget-empty"><i class="fas fa-calendar"></i><span>No upcoming productions</span></div>';
                } else {
                    prodBody.innerHTML = prods.slice(0, 8).map(p => `
                        <div class="widget-list-item">
                            <div class="widget-item-info">
                                <span class="widget-item-title">${this.escapeHtml(p.Title || p['Show Name'] || p.Name || 'Untitled')}</span>
                                <span class="widget-item-subtitle">${this.escapeHtml(p.Date || '')}${p.Venue ? ' — ' + p.Venue : ''}</span>
                            </div>
                        </div>`).join('');
                }
            }

            // Tasks widget
            const taskBody = el('widgetTasksBody');
            if (taskBody) {
                if (tasks.length === 0) {
                    taskBody.innerHTML = '<div class="widget-empty"><i class="fas fa-check-circle"></i><span>No open tasks</span></div>';
                } else {
                    taskBody.innerHTML = tasks.slice(0, 8).map(t => {
                        const statusClass = this._statusClass(t.Status);
                        const isUrgent = ['high','urgent'].includes((t.Priority || '').toLowerCase());
                        return `
                        <div class="widget-list-item">
                            <div class="widget-item-info">
                                <span class="widget-item-title">${this.escapeHtml(t.Task || t.Title || 'Untitled')}</span>
                                <span class="widget-item-subtitle">${this.escapeHtml(t['Assigned To'] || '')}</span>
                            </div>
                            <span class="widget-item-badge ${statusClass}">${this.escapeHtml(t.Status || 'Pending')}</span>
                            ${isUrgent ? `<span class="widget-item-badge badge-urgent" style="margin-left:4px;"><i class="fas fa-flag"></i> ${this.escapeHtml(t.Priority)}</span>` : ''}
                        </div>`;
                    }).join('');
                }
            }
        });
    }

    _statusClass(status) {
        const s = (status || '').toLowerCase();
        if (s.includes('complet')) return 'badge-completed';
        if (s.includes('progress')) return 'badge-progress';
        return 'badge-pending';
    }

    // ── Productions ──────────────────────────────────────────────
    renderProductions() {
        const stageFilter = this.getActiveStageFilter('prodStageTabs');
        const items = this.filterByStage(this.productions, stageFilter);
        const container = document.getElementById('productionsList');
        if (!container) return;

        if (items.length === 0) {
            container.innerHTML = '<div class="loading-state">No productions found.</div>';
            return;
        }

        container.innerHTML = items.map(p => {
            const stageId = (p.Stage || '').toLowerCase();
            return `
            <div class="card">
                <div class="card-title">${this.escapeHtml(p.Title || p['Show Name'] || p.Name || 'Untitled')}</div>
                <div class="card-meta">
                    ${p.Stage ? `<span><i class="fas fa-map-marker-alt"></i> ${this.escapeHtml(p.Stage)}</span>` : ''}
                    ${p.Date  ? `<span><i class="fas fa-calendar"></i> ${this.escapeHtml(p.Date)}</span>` : ''}
                    ${p.Venue ? `<span><i class="fas fa-building"></i> ${this.escapeHtml(p.Venue)}</span>` : ''}
                    ${p.Lead  ? `<span><i class="fas fa-user-tie"></i> Lead: ${this.escapeHtml(p.Lead)}</span>` : ''}
                </div>
                ${stageId ? `<div style="margin-top:10px;"><span class="stage-badge ${stageId.includes('inside') ? 'inside' : 'beach'}">${this.escapeHtml(p.Stage)}</span></div>` : ''}
            </div>`;
        }).join('');
    }

    // ── Crew ─────────────────────────────────────────────────────
    renderCrew() {
        const container = document.getElementById('crewList');
        if (!container) return;

        if (this.crew.length === 0) {
            container.innerHTML = '<div class="loading-state">No crew members found.</div>';
            return;
        }

        container.innerHTML = this.crew.map(c => `
            <div class="card">
                <div class="card-title">${this.escapeHtml(c.Name || c['Full Name'] || 'Unknown')}</div>
                <div class="card-meta">
                    ${c.Role  ? `<span><i class="fas fa-id-badge"></i> ${this.escapeHtml(c.Role)}</span>` : ''}
                    ${c.Email ? `<span><i class="fas fa-envelope"></i> ${this.escapeHtml(c.Email)}</span>` : ''}
                    ${c.Phone ? `<span><i class="fas fa-phone"></i> ${this.escapeHtml(c.Phone)}</span>` : ''}
                </div>
            </div>`).join('');
    }

    // ── Tasks ────────────────────────────────────────────────────
    renderTasks() {
        const stageFilter  = this.getActiveStageFilter('taskStageTabs');
        const statusFilter = (document.getElementById('taskStatusFilter')?.value || '').toLowerCase();
        const sortMode     = document.getElementById('taskSortSelect')?.value || 'status-date';

        let items = this.filterByStage(this.tasks, stageFilter);
        if (statusFilter) items = items.filter(t => (t.Status || '').toLowerCase() === statusFilter);

        const statusOrder = s => {
            const v = (s || '').toLowerCase();
            if (v.includes('progress')) return 1;
            if (v === 'pending')        return 0;
            if (v === 'on hold')        return 2;
            return 3; // completed
        };

        if (sortMode === 'date') {
            items = [...items].sort((a, b) => (b._rowIndex || 0) - (a._rowIndex || 0));
        } else if (sortMode === 'status') {
            items = [...items].sort((a, b) => statusOrder(a.Status) - statusOrder(b.Status));
        } else { // status-date
            items = [...items].sort((a, b) => statusOrder(a.Status) - statusOrder(b.Status) || (b._rowIndex || 0) - (a._rowIndex || 0));
        }

        const container = document.getElementById('tasksList');
        if (!container) return;

        if (items.length === 0) {
            container.innerHTML = '<div class="loading-state">No tasks found.</div>';
            return;
        }

        container.innerHTML = items.map(task => {
            const statusKey  = (task.Status || 'pending').toLowerCase().replace(/\s+/g, '-');
            const priority   = task.Priority || '';
            const showPriority = ['high', 'urgent'].includes(priority.toLowerCase());
            const stageId    = (task.Stage || '').toLowerCase();
            return `
            <div class="task-card">
                <div class="task-card-header">
                    <span class="task-status ${statusKey}">${this.escapeHtml(task.Status || 'Pending')}</span>
                    ${showPriority ? `<span class="task-priority ${priority.toLowerCase()}"><i class="fas fa-flag"></i> ${this.escapeHtml(priority)}</span>` : ''}
                    ${stageId ? `<span class="stage-badge ${stageId.includes('inside') ? 'inside' : 'beach'}" style="padding:2px 8px;font-size:0.72rem;">${this.escapeHtml(task.Stage)}</span>` : ''}
                </div>
                <div class="task-title">${this.escapeHtml(task.Task || task.Title || 'Untitled Task')}</div>
                ${task.Comments ? `<div style="font-size:0.82rem;color:var(--text-muted);margin-top:4px;">${this.escapeHtml(task.Comments)}</div>` : ''}
                <div style="font-size:0.8rem;color:var(--text-muted);margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;">
                    ${task['Show Name'] ? `<span><i class="fas fa-ticket-alt"></i> ${this.escapeHtml(task['Show Name'])}</span>` : ''}
                    ${task['Assigned To'] ? `<span><i class="fas fa-user"></i> ${this.escapeHtml(task['Assigned To'])}</span>` : ''}
                </div>
            </div>`;
        }).join('');
    }

    // ── Equipment ────────────────────────────────────────────────
    renderEquipment() {
        const stageFilter = this.getActiveStageFilter('equipStageTabs');
        const items = this.filterByStage(this.equipment, stageFilter);
        const container = document.getElementById('equipmentList');
        if (!container) return;

        if (items.length === 0) {
            container.innerHTML = '<div class="loading-state">No equipment found.</div>';
            return;
        }

        container.innerHTML = items.map(e => {
            const stageId = (e.Stage || '').toLowerCase();
            return `
            <div class="card">
                <div class="card-title">${this.escapeHtml(e.Item || e.Name || 'Unknown Item')}</div>
                <div class="card-meta">
                    ${e.Category ? `<span><i class="fas fa-tag"></i> ${this.escapeHtml(e.Category)}</span>` : ''}
                    ${e.Status   ? `<span><i class="fas fa-info-circle"></i> ${this.escapeHtml(e.Status)}</span>` : ''}
                    ${e.Location ? `<span><i class="fas fa-map-pin"></i> ${this.escapeHtml(e.Location)}</span>` : ''}
                </div>
                ${stageId ? `<div style="margin-top:10px;"><span class="stage-badge ${stageId.includes('inside') ? 'inside' : 'beach'}">${this.escapeHtml(e.Stage)}</span></div>` : ''}
            </div>`;
        }).join('');
    }

    // ── Settings ─────────────────────────────────────────────────
    renderSettings() {
        const el = document.getElementById('settingsUserInfo');
        if (el && this.currentUser) el.textContent = `Logged in as ${this.currentUser.name} (${this.currentUser.role})`;
    }
}

// ── Boot ─────────────────────────────────────────────────────────
const app = new WindjammerApp();
document.addEventListener('DOMContentLoaded', () => app.init());
