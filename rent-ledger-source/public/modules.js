// Rent Ledger — screens for the modules added in stages 4-16: finance,
// ledger, reconciliation, leases, reminders, maintenance, expenses, reports,
// assistant, insights, settings/team/audit, tenancy & deposit settlement,
// notifications, and the tenant portal additions.
//
// app.js owns rendering and events; it calls into window.RL_EXT for any view,
// action or form it doesn't know. Everything here uses the same api(),
// esc(), fmtMoney(), toast() and confirmDialog() helpers as app.js.
(() => {
  const X = (window.RL_EXT = { views: {}, loaders: {}, actions: {}, submits: {}, changes: {}, tenantViews: {}, tenantLoaders: {} });
  const d = (X.d = {});            // loaded data per view
  const s = (X.s = {               // per-view UI state (filters, tabs)
    finance: { from: '', to: '', tab: 'overview', bill: { buildingId: '', floor: '', roomId: '', kinds: ['rent', 'electricity'], former: false }, skip: {} },
    ledger: { tab: 'bills', status: 'open', kind: '', buildingId: '', tenantId: '' },
    recon: { status: 'unmatched', open: {} },
    leases: { status: '', prefill: null, extract: null },
    reminders: { tab: 'outbox', status: '', previewKind: 'overdue' },
    maint: { status: 'open', buildingId: '', id: null },
    expenses: { from: '', to: '', buildingId: '', category: '' },
    reports: { from: '', to: '', open: null },
    settings: { tab: 'org' },
    tenantMaint: { id: null },
  });

  // ---------- helpers ----------
  const h = (v) => esc(v);
  const money = (v) => fmtMoney(v);
  const isOwner = () => session?.user?.role === 'owner';
  const can = (perm) => isOwner() || (session?.user?.role === 'manager' && (X.me?.permissions || []).includes(perm));
  const ym = (date = today()) => date.slice(0, 7);
  const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); const idx = y * 12 + mo - 1 + n; return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`; };
  const label = (str) => String(str || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const stamp = (status) => `<span class="stamp ${h(status)}">${h(status)}</span>`;
  const qs = (obj) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(obj)) if (v !== '' && v !== null && v !== undefined) p.set(k, v); const q = p.toString(); return q ? `?${q}` : ''; };
  const opt = (value, text, selected) => `<option value="${h(value)}" ${String(selected) === String(value) ? 'selected' : ''}>${h(text)}</option>`;
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const page = (title, sub, actions = '') => `<div class="page-head"><div><div class="page-title">${h(title)}</div>${sub ? `<div class="page-sub">${sub}</div>` : ''}</div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</div>`;
  const card = (title, body, extra = '') => `<article class="card ${extra}">${title ? `<h3>${title}</h3>` : ''}${body}</article>`;
  const empty = (text) => `<div class="empty-state"><div>${h(text)}</div></div>`;
  function table(columns, rows, { emptyText = 'Nothing here yet.', cls = '' } = {}) {
    if (!rows.length) return empty(emptyText);
    // Dates, amounts and percentages stay on one line; other cells may wrap.
    const short = (cell) => /^(₹-?[\d,.]+|-?[\d,.]+%?|\d{4}-\d{2}(-\d{2})?|—|–)$/.test(String(cell ?? '').trim());
    return `<div class="table-wrap"><table class="ledger ${cls}"><thead><tr>${columns.map((c) => `<th>${h(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((cell) => `<td${short(cell) ? ' class="nw"' : ''}>${cell ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  const field = (lbl, input, span = '') => `<div class="form-field" ${span ? `style="grid-column:${span}"` : ''}><label>${h(lbl)}</label>${input}</div>`;
  const tenantOptions = (selected, { activeOnly = true, blank = 'Choose tenant' } = {}) => `<option value="">${h(blank)}</option>` + cache.tenants.filter((t) => !activeOnly || t.active).map((t) => {
    const room = cache.rooms.find((r) => r.id === t.roomId);
    const b = room && cache.buildings.find((x) => x.id === room.buildingId);
    return opt(t.id, `${t.name} · ${b?.name || ''} ${room?.label || ''}`, selected);
  }).join('');
  const buildingOptions = (selected, blank = 'All properties') => `<option value="">${h(blank)}</option>` + cache.buildings.map((b) => opt(b.id, b.name, selected)).join('');
  const roomOptions = (selected, buildingId) => `<option value="">No specific room</option>` + cache.rooms.filter((r) => !buildingId || r.buildingId === buildingId).map((r) => {
    const b = cache.buildings.find((x) => x.id === r.buildingId);
    return opt(r.id, `${b?.name || ''} · ${r.label}`, selected);
  }).join('');
  const tenantName = (id) => cache.tenants.find((t) => t.id === id)?.name || '';

  // Opens a printable page or file that needs the signed-in user's token.
  async function openAuthed(url) {
    if (window.Capacitor?.isNativePlatform?.()) return openInApp(url);
    const win = window.open('', '_blank');
    try {
      const res = await fetch(apiUrl(url), { headers: { Authorization: `Bearer ${session?.token || ''}` } });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Could not open this.'); }
      const blob = await res.blob();
      const link = URL.createObjectURL(blob);
      if (win) win.location = link; else window.open(link, '_blank');
      setTimeout(() => URL.revokeObjectURL(link), 120_000);
    } catch (err) { if (win) win.close(); throw err; }
  }
  // Android / iPhone app: receipts and statements open on a full-screen sheet
  // inside the app (with Share), since there is no browser tab to open.
  async function openInApp(url) {
    const res = await fetch(apiUrl(url), { headers: { Authorization: `Bearer ${session?.token || ''}` } });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Could not open this.'); }
    const type = res.headers.get('content-type') || '';
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || (type.includes('html') ? 'document.html' : 'document');
    if (!type.includes('html')) return saveBlob(await res.blob(), name);
    const html = await res.text();
    const sheet = document.createElement('div');
    sheet.className = 'doc-viewer';
    sheet.innerHTML = '<div class="doc-viewer-bar"><button type="button" class="btn secondary" data-doc-close>Close</button><button type="button" class="btn" data-doc-share>Share</button></div><iframe title="Document" sandbox=""></iframe>';
    sheet.querySelector('iframe').srcdoc = html;
    sheet.querySelector('[data-doc-close]').onclick = () => sheet.remove();
    sheet.querySelector('[data-doc-share]').onclick = () => saveBlob(new Blob([html], { type: 'text/html' }), name.replace(/\.[a-z]+$/i, '') + '.html').catch((err) => toast(err.message, true));
    document.body.appendChild(sheet);
  }
  async function downloadAuthed(url, fallbackName) {
    const res = await fetch(apiUrl(url), { headers: { Authorization: `Bearer ${session?.token || ''}` } });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Download failed'); }
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
    await saveBlob(await res.blob(), name);
  }
  // In the Android / iPhone app a file can't simply be "downloaded"; it is
  // saved in the app and the phone's share sheet opens (WhatsApp, Files, Drive…).
  const nativeFiles = () => Boolean(window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins?.Filesystem && window.Capacitor.Plugins?.Share);
  const blobToBase64 = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = () => reject(new Error('The file could not be read.')); r.readAsDataURL(blob); });
  async function shareNative(blob, name) {
    const { Filesystem, Share } = window.Capacitor.Plugins;
    const written = await Filesystem.writeFile({ path: name, data: await blobToBase64(blob), directory: 'CACHE' });
    try { await Share.share({ title: name, url: written.uri, dialogTitle: name }); }
    catch (err) { if (!/cancel/i.test(String(err?.message || err))) throw err; }
  }
  function saveBlob(blob, name) {
    if (nativeFiles()) return shareNative(blob, name);
    const link = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = link; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(link), 60_000);
  }
  function readFile(file, { asText = false, max = 10 * 1024 * 1024, types } = {}) {
    if (!file) return Promise.reject(new Error('Choose a file first.'));
    if (file.size > max) return Promise.reject(new Error(`The file must be ${Math.round(max / 1048576)} MB or smaller.`));
    if (types && !types.includes(file.type)) return Promise.reject(new Error('Choose a JPG, PNG, WEBP image or a PDF.'));
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(asText ? String(r.result) : { data: String(r.result).split(',')[1], mimeType: file.type, originalName: file.name });
      r.onerror = () => reject(new Error('The file could not be read.'));
      if (asText) r.readAsText(file); else r.readAsDataURL(file);
    });
  }
  const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  X.helpers = { openAuthed, downloadAuthed, readFile, table, stamp };

  // Generic actions used across screens.
  X.actions['open-page'] = async (el) => { await openAuthed(el.dataset.url); return false; };
  X.actions['download'] = async (el) => { await downloadAuthed(el.dataset.url, el.dataset.name || 'export.csv'); return false; };
  X.actions['open-doc'] = async (el) => { await openAuthed(`/api/documents/${el.dataset.id}/file`); return false; };
  // Switching a tab or filter only changes what is shown; it doesn't throw away
  // what has already been loaded, so the switch is quick.
  X.actions['set-state'] = async (el) => { const [view, key] = el.dataset.key.split('.'); s[view][key] = el.dataset.value; state.forms = {}; await render(); return false; };
  X.changes['state'] = (el) => { const [view, key] = el.dataset.key.split('.'); s[view][key] = el.type === 'checkbox' ? el.checked : el.value; };

  // ---------- sidebar navigation ----------
  // The everyday sections stay in view; everything else sits under "More".
  const NAV_MAIN = [
    ['dashboard', 'Dashboard', null],
    ['ledger', 'Bills & payments', 'reports.view'],
    ['reminders', 'Reminders', 'reminders.manage'],
    ['maintenance', 'Repairs', 'maintenance.manage'],
    ['settings', 'Settings', null],
  ];
  const NAV_MORE = [
    ['finance', 'Finance', 'reports.view'],
    ['leases', 'Leases', 'leases.manage'],
    ['expenses', 'Expenses', 'expenses.manage'],
    ['reconciliation', 'Bank matching', 'reconciliation.manage'],
    ['reports', 'Reports', 'reports.view'],
    ['insights', 'Insights', 'reports.view'],
    ['assistant', 'Assistant', 'assistant.use'],
  ];
  const navAllowed = ([, , perm]) => !perm || can(perm);
  const navLink = ([view, text]) => `<button type="button" class="side-link ${state.view === view ? 'active' : ''}" data-nav="${view}"><span>${h(text)}</span></button>`;
  const MORE_KEY = 'rentLedgerNavMore';
  const moreOpen = () => { if (X.moreOpen === undefined) { try { X.moreOpen = localStorage.getItem(MORE_KEY) === '1'; } catch { X.moreOpen = false; } } return X.moreOpen; };
  X.sidebarNav = () => {
    const more = NAV_MORE.filter(navAllowed);
    const open = moreOpen();
    // When "More" is folded, the section you're on still shows.
    const moreGroup = more.length ? `<div class="side-more ${open ? 'open' : ''}"><button type="button" class="side-link side-more-toggle" data-action="nav-more" aria-expanded="${open}"><span>More</span><span class="chev" aria-hidden="true">▾</span></button>${more.map(navLink).join('')}</div>` : '';
    return `<nav class="side-nav" aria-label="Sections">${NAV_MAIN.filter(navAllowed).map(navLink).join('')}${moreGroup}</nav>`;
  };
  X.actions['nav-more'] = (el) => {
    X.moreOpen = !moreOpen();
    el.setAttribute('aria-expanded', String(X.moreOpen));
    el.closest('.side-more')?.classList.toggle('open', X.moreOpen);
    try { localStorage.setItem(MORE_KEY, X.moreOpen ? '1' : '0'); } catch { /* remembered for this visit only */ }
    return false;
  };
  // Notifications: a bell next to the name, with the unread count.
  X.sidebarBell = () => `<button type="button" class="side-bell ${state.view === 'notifications' ? 'active' : ''}" data-nav="notifications" title="Notifications" aria-label="Notifications${X.unread ? `, ${X.unread} unread` : ''}"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/></svg>${X.unread ? `<span class="nav-count">${X.unread}</span>` : ''}</button>`;
  X.sidebarFooter = () => '';

  // ---------- phones: bottom tab bar + "More" panel ----------
  // Shown only on narrow screens (see style.css); the sidebar is used on computers.
  const ICONS = {
    home: '<path d="M4 11.2 12 4.8l8 6.4V19a1 1 0 0 1-1 1h-4.5v-5.2h-5V20H5a1 1 0 0 1-1-1z"/>',
    bills: '<path d="M7 3.8h10a1 1 0 0 1 1 1V20l-3-1.8-3 1.8-3-1.8L6 20V4.8a1 1 0 0 1 1-1z"/><path d="M9.2 8.6h5.6M9.2 12.4h5.6"/>',
    remind: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
    repairs: '<path d="M14.7 4.2a4.3 4.3 0 0 0-4 5.6L4.6 15.9a2 2 0 0 0 2.9 2.9l6.1-6.1a4.3 4.3 0 0 0 5.6-4l-2.6 2.6-2.4-.5-.5-2.4 2.6-2.6c-.5-.4-1.1-.6-1.6-.6z"/>',
    more: '<circle cx="5.5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
    finance: '<path d="M4 19.5h16"/><path d="M7 16v-4M12 16V7M17 16v-6.5"/>',
    leases: '<path d="M7 3.8h7l4 4V19a1.2 1.2 0 0 1-1.2 1.2H7A1.2 1.2 0 0 1 5.8 19V5A1.2 1.2 0 0 1 7 3.8z"/><path d="M13.8 3.8v4.2H18M9 12.5h6M9 16h6"/>',
    expenses: '<rect x="3.5" y="6.5" width="17" height="12" rx="2"/><path d="M3.5 10.5h17M16 14.5h1.5"/>',
    reconciliation: '<path d="M4 9.5 12 5l8 4.5M5.5 10v7M10 10v7M14 10v7M18.5 10v7M4 19.5h16"/>',
    reports: '<path d="M7 3.8h10a1.2 1.2 0 0 1 1.2 1.2v14a1.2 1.2 0 0 1-1.2 1.2H7A1.2 1.2 0 0 1 5.8 19V5A1.2 1.2 0 0 1 7 3.8z"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>',
    insights: '<path d="M4 17l5-5 3.5 3.5L20 8"/><path d="M15 8h5v5"/>',
    assistant: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 16.5h-7l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>',
    messages: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 16.5h-7l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z"/>',
    documents: '<path d="M7 3.8h7l4 4V19a1.2 1.2 0 0 1-1.2 1.2H7A1.2 1.2 0 0 1 5.8 19V5A1.2 1.2 0 0 1 7 3.8z"/><path d="M13.8 3.8v4.2H18"/>',
    profile: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  const MOBILE_TABS = [['dashboard', 'Home', 'home', null], ['ledger', 'Bills', 'bills', 'reports.view'], ['reminders', 'Reminders', 'remind', 'reminders.manage'], ['maintenance', 'Repairs', 'repairs', 'maintenance.manage']];
  X.mobileNav = () => {
    const tabs = MOBILE_TABS.filter(navAllowed);
    const inTabs = tabs.some(([v]) => v === state.view);
    const sections = [...NAV_MORE, ['settings', 'Settings', null]].filter(navAllowed);
    const buildings = (cache.buildings || []).map((b) => {
      const rooms = (cache.rooms || []).filter((r) => r.buildingId === b.id);
      const occ = rooms.filter((r) => r.status === 'occupied').length;
      return `<button type="button" class="msheet-row ${state.buildingId === b.id ? 'active' : ''}" data-nav="building" data-id="${b.id}"><span>${h(b.name)}</span><small>${occ}/${rooms.length}</small></button>`;
    }).join('');
    return `<nav class="mnav" aria-label="Sections">${tabs.map(([view, text, ic]) => `<button type="button" class="mnav-btn ${state.view === view ? 'active' : ''}" data-nav="${view}" ${state.view === view ? 'aria-current="page"' : ''}>${icon(ic)}<span>${h(text)}</span></button>`).join('')}<button type="button" class="mnav-btn ${inTabs ? '' : 'active'}" data-action="mnav-more" aria-haspopup="dialog">${icon('more')}<span>More</span></button></nav>
      <div class="msheet" hidden><div class="msheet-backdrop" data-action="mnav-close"></div><div class="msheet-panel" role="dialog" aria-label="More">
        <div class="msheet-grip" aria-hidden="true"></div>
        <div class="msheet-grid">${sections.map(([view, text]) => `<button type="button" class="${state.view === view ? 'active' : ''}" data-nav="${view}">${icon(view)}<span>${h(text)}</span></button>`).join('')}</div>
        <div class="msheet-label">Properties</div>
        <div class="msheet-list">${buildings || '<p class="muted">No buildings yet.</p>'}<button type="button" class="msheet-row add" data-action="add-building"><span>+ Add building</span></button></div>
        <div class="msheet-foot"><button type="button" class="btn secondary" data-nav="profile">Profile</button><button type="button" class="btn secondary" data-action="logout">Sign out</button></div>
      </div></div>`;
  };
  const setSheet = (open) => {
    const sheet = document.querySelector('.msheet');
    if (!sheet) return;
    sheet.hidden = !open;
    document.body.classList.toggle('sheet-open', open);
  };
  X.actions['mnav-more'] = () => { setSheet(document.querySelector('.msheet')?.hidden); return false; };
  X.actions['mnav-close'] = () => { setSheet(false); return false; };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setSheet(false); });
  // Tenants: Home, Repairs, Messages, Documents, Profile at the bottom; notifications are the bell at the top.
  const TENANT_TABS = [['home', 'Home', 'home'], ['maintenance', 'Repairs', 'repairs'], ['messages', 'Messages', 'messages'], ['documents', 'Documents', 'documents'], ['profile', 'Profile', 'profile']];
  X.tenantMobileNav = () => `<nav class="mnav tenant-mnav" aria-label="Sections">${TENANT_TABS.map(([k, text, ic]) => `<button type="button" class="mnav-btn ${state.tenantView === k ? 'active' : ''}" data-tenant-nav="${k}">${icon(ic)}<span>${h(text)}</span></button>`).join('')}</nav>`;
  X.tenantBell = () => `<button type="button" class="side-bell tenant-bell ${state.tenantView === 'notifications' ? 'active' : ''}" data-tenant-nav="notifications" aria-label="Notifications${X.tenantUnread ? `, ${X.tenantUnread} unread` : ''}">${icon('bell')}${X.tenantUnread ? `<span class="nav-count">${X.tenantUnread}</span>` : ''}</button>`;

  // Called before every owner/manager render.
  // Who is signed in is fetched once; the unread count is checked in the
  // background (at most every 30 seconds) so it never holds up a page.
  X.beforeOwnerRender = async () => {
    if (!X.me) { try { X.me = await api('GET', '/api/auth/me'); } catch { X.me = { permissions: [] }; } }
    if (Date.now() - (X.unreadAt || 0) > 30_000 || state.view === 'notifications') {
      X.unreadAt = Date.now();
      api('GET', '/api/notifications').then((r) => {
        if ((r.unread || 0) === (X.unread || 0)) return;
        X.unread = r.unread || 0;
        document.querySelectorAll('.side-bell').forEach((bell) => { bell.outerHTML = X.sidebarBell(); });
      }).catch(() => {});
    }
  };
  X.load = async (view) => { if (X.loaders[view]) await X.loaders[view](); };

  // ---------- dashboard extras ----------
  X.dashboardExtras = () => {
    const f = d.dashFinance;
    if (!f || !can('reports.view')) return '';
    // A short addition to the dashboard's "Show details" line.
    return `<span class="dm-item">Expenses this month <b>${money(f.totals.expenses)}</b></span><span class="dm-item"><button type="button" class="link-btn" data-nav="finance">Open Finance →</button></span>`;
  };
  X.loadDashboardExtras = async () => {
    if (!can('reports.view')) return;
    try { d.dashFinance = await api('GET', `/api/finance/summary${qs({ from: ym(), to: ym() })}`); } catch { d.dashFinance = null; }
  };

  // ---------- finance overview ----------
  X.loaders.finance = async () => {
    if (s.finance.tab === 'bills') return loadBills();
    const from = s.finance.from || addMonths(ym(), -5);
    const to = s.finance.to || ym();
    [d.finance, d.balances] = await Promise.all([api('GET', `/api/finance/summary${qs({ from, to })}`), api('GET', '/api/ledger/balances')]);
  };
  X.views.finance = () => {
    if (s.finance.tab === 'bills') return billsView();
    const f = d.finance;
    if (!f) return page('Finance', 'Loading…') + financeTabs();
    const t = f.totals;
    const maxBar = Math.max(1, ...f.trend.map((m) => Math.max(m.billed, m.received)));
    const bar = (v, cls) => `<span class="bar ${cls}" style="width:${Math.round((v / maxBar) * 100)}%"></span>`;
    const trendRows = f.trend.map((m) => [h(m.month), money(m.billed), money(m.collected), money(m.received), money(m.expenses), `<div class="bars">${bar(m.billed, 'billed')}${bar(m.received, 'received')}</div>`]);
    const balances = (d.balances || []).filter((b) => b.outstanding || b.credit);
    return `${page('Finance', `${h(f.range.from)} to ${h(f.range.to)} · amounts from the ledger`)}${financeTabs()}
      <form class="card filter-bar" data-submit="finance-range"><div class="form-grid cols-3">${field('From', `<input type="month" name="from" value="${h(f.range.from)}">`)}${field('To', `<input type="month" name="to" value="${h(f.range.to)}">`)}<div class="form-actions"><button class="btn" type="submit">Apply</button></div></div></form>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">Billed</div><div class="stat-value">${money(t.billed)}</div></div>
        <div class="stat-card good"><div class="stat-label">Collected on these bills</div><div class="stat-value">${money(t.collectedOnBills)}</div></div>
        <div class="stat-card"><div class="stat-label">Collection rate</div><div class="stat-value">${t.collectionRate === null ? '–' : `${t.collectionRate}%`}</div></div>
        <div class="stat-card good"><div class="stat-label">Money received</div><div class="stat-value">${money(t.received)}</div></div>
        <div class="stat-card warn"><div class="stat-label">Expenses</div><div class="stat-value">${money(t.expenses)}</div></div>
        <div class="stat-card ${t.netCashFlow < 0 ? 'warn' : 'good'}"><div class="stat-label">Net cash flow</div><div class="stat-value">${money(t.netCashFlow)}</div></div>
        <div class="stat-card warn"><div class="stat-label">Outstanding today</div><div class="stat-value">${money(t.outstanding)}</div></div>
        <div class="stat-card warn"><div class="stat-label">Overdue today</div><div class="stat-value">${money(t.overdue)}</div></div>
      </div>
      ${card('Month by month', table(['Month', 'Billed', 'Collected', 'Received', 'Expenses', ''], trendRows, { cls: 'month-table' }))}
      ${card('By property', table(['Property', 'Billed', 'Received', 'Expenses', 'Net', 'Outstanding now'], f.byProperty.map((p) => [h(p.name), money(p.billed), money(p.received), money(p.expenses), money(p.net), money(p.outstanding)])))}
      ${card(`Tenant balances <small>${balances.length}</small>`, table(['Tenant', 'Room', 'Outstanding', 'Overdue', 'Credit', ''], balances.map((b) => [
        h(b.name) + (b.active ? '' : ' <small class="muted">(moved out)</small>'), `${h(b.buildingName)} ${h(b.roomLabel)}`, money(b.outstanding), b.overdue ? `<b class="is-due">${money(b.overdue)}</b>` : money(0), money(b.credit),
        `<div class="row-actions"><button class="btn small secondary" data-action="open-page" data-url="/api/ledger/tenants/${b.tenantId}/statement?format=html">Statement</button><button class="btn small secondary" data-action="ledger-tenant" data-id="${b.tenantId}">Bills</button><button class="btn small secondary" data-nav="tenancy" data-id="${b.tenantId}">Tenancy</button></div>`,
      ]), { emptyText: 'Nobody owes anything right now.' }))}
      ${f.leaseExpiries.length ? card('Leases ending soon', table(['Tenant', 'Room', 'Ends', 'Days left'], f.leaseExpiries.map((l) => [h(l.tenantName), h(l.roomLabel), h(l.endDate), l.daysLeft < 0 ? `<b class="is-due">${l.daysLeft}</b>` : l.daysLeft]))) : ''}
      <p class="basis-note">${h(f.basis)}</p>`;
  };
  X.submits['finance-range'] = (data) => { s.finance.from = data.from; s.finance.to = data.to; };
  X.actions['ledger-tenant'] = (el) => { s.ledger.tenantId = el.dataset.id; s.ledger.status = ''; state.view = 'ledger'; state.forms = {}; };

  // ---------- bills (PDF) for what is still pending ----------
  // Pick a property, floor or room and the types (rent, electricity…), tick
  // the bills you want, then download one PDF or share it from the phone.
  const financeTabs = () => `<div class="tab-row">${[['overview', 'Overview'], ['bills', 'Make bills']].map(([k, t]) => `<button class="tab-btn ${s.finance.tab === k ? 'active' : ''}" data-action="set-state" data-key="finance.tab" data-value="${k}">${t}</button>`).join('')}</div>`;
  const floorName = (n) => (Number(n) === 0 ? 'Ground floor' : `Floor ${n}`);
  const BILL_TYPES = [['rent', 'Rent'], ['electricity', 'Electricity'], ['gas', 'Gas'], ['other', 'Other charges']];
  const canShareFiles = (() => { try { return nativeFiles() || Boolean(navigator.canShare && navigator.canShare({ files: [new File(['%PDF'], 'bill.pdf', { type: 'application/pdf' })] })); } catch { return false; } })();
  async function loadBills() {
    const b = s.finance.bill;
    [d.bills, d.org] = await Promise.all([
      api('GET', `/api/bills/preview${qs({ buildingId: b.buildingId, floor: b.floor, roomId: b.roomId, kinds: b.kinds.join(','), includeFormer: b.former ? '1' : '' })}`),
      api('GET', '/api/org').catch(() => d.org || null),
    ]);
  }
  function pickSummary() {
    const bills = d.bills?.bills || [];
    const chosen = bills.filter((x) => !s.finance.skip[x.key]);
    return { n: chosen.length, of: bills.length, total: Math.round(chosen.reduce((t, x) => t + x.payable, 0) * 100) / 100, keys: chosen.map((x) => x.key) };
  }
  function updateBillBar() {
    const p = pickSummary();
    document.querySelectorAll('[data-bill-n]').forEach((el) => { el.textContent = p.n; });
    document.querySelectorAll('[data-bill-total]').forEach((el) => { el.textContent = money(p.total); });
    const all = document.querySelector('[data-bill-all]');
    if (all) { all.checked = p.n === p.of; all.indeterminate = p.n > 0 && p.n < p.of; }
    document.querySelectorAll('[data-bill-main]').forEach((btn) => { btn.disabled = !p.n; });
  }
  // Ticking bills only updates the count and total, without redrawing the page.
  document.addEventListener('change', (e) => {
    const pick = e.target.closest?.('[data-bill-pick]');
    const all = e.target.closest?.('[data-bill-all]');
    if (!pick && !all) return;
    if (all) {
      (d.bills?.bills || []).forEach((x) => { if (all.checked) delete s.finance.skip[x.key]; else s.finance.skip[x.key] = true; });
      document.querySelectorAll('[data-bill-pick]').forEach((c) => { c.checked = all.checked; });
    } else if (pick.checked) delete s.finance.skip[pick.dataset.billPick];
    else s.finance.skip[pick.dataset.billPick] = true;
    updateBillBar();
  });

  function billsView() {
    const b = s.finance.bill;
    const rooms = cache.rooms.filter((r) => !b.buildingId || r.buildingId === b.buildingId);
    const floors = [...new Set(rooms.map((r) => r.floorNumber))].sort((x, y) => x - y);
    const roomList = rooms.filter((r) => b.floor === '' || String(r.floorNumber) === String(b.floor));
    const manyBuildings = !b.buildingId && cache.buildings.length > 1;
    const filters = `<div class="card filter-bar bill-filters"><div class="form-grid cols-3">
        ${field('Property', `<select name="buildingId" data-ext-change="bill-filter">${buildingOptions(b.buildingId)}</select>`)}
        ${field('Floor', `<select name="floor" data-ext-change="bill-filter"><option value="">All floors</option>${floors.map((f) => opt(f, floorName(f), b.floor)).join('')}</select>`)}
        ${field('Room', `<select name="roomId" data-ext-change="bill-filter"><option value="">All rooms</option>${roomList.map((r) => opt(r.id, `${r.label}${manyBuildings ? ` · ${cache.buildings.find((x) => x.id === r.buildingId)?.name || ''}` : ''}`, b.roomId)).join('')}</select>`)}
      </div>
      <div class="bill-kinds" role="group" aria-label="What to include"><span class="bill-kinds-label">Include</span>${BILL_TYPES.map(([k, t]) => `<label class="bill-kind"><input type="checkbox" value="${k}" data-ext-change="bill-kind" ${b.kinds.includes(k) ? 'checked' : ''}><span>${t}</span></label>`).join('')}<label class="check bill-former"><input type="checkbox" data-ext-change="bill-former" ${b.former ? 'checked' : ''}> <span>Tenants who moved out</span></label></div></div>`;
    const head = page('Finance', 'Bills for what each room still owes');
    const data = d.bills;
    if (!data) return `${head}${financeTabs()}${filters}`;
    const bills = data.bills;
    const show = Object.fromEntries(BILL_TYPES.map(([k]) => [k, b.kinds.includes(k)]));
    const spread = new Set(bills.map((x) => x.buildingId)).size > 1;
    const cols = ['Room', 'Tenant', ...BILL_TYPES.filter(([k]) => show[k]).map(([k, t]) => (k === 'other' ? 'Other' : t)), 'To pay', ''];
    const amt = (v) => (v ? money(v) : '–');
    const rows = bills.map((x) => [
      `<label class="bill-pick"><input type="checkbox" data-bill-pick="${h(x.key)}" ${s.finance.skip[x.key] ? '' : 'checked'} aria-label="${h(`${x.roomLabel} ${x.tenantName}`)}"><span><b>${h(x.roomLabel)}</b><small>${h(x.floorName)}${spread ? ` · ${h(x.buildingName)}` : ''}</small></span></label>`,
      x.tenantName ? `${h(x.tenantName)}${x.tenantActive ? '' : ' <small class="muted">(moved out)</small>'}` : `<span class="muted">${x.roomStatus === 'owner' ? 'Owner’s floor' : 'No tenant'}</span>`,
      ...BILL_TYPES.filter(([k]) => show[k]).map(([k]) => amt(x[k])),
      `<span class="bill-topay"><b class="${x.overdue ? 'is-due' : ''}">${money(x.payable)}</b>${x.credit ? `<small class="bill-sub"><span>after advance</span> ${money(x.credit)}</small>` : ''}</span>`,
      `<div class="bill-actions"><button class="btn small secondary" data-action="bills-pdf" data-key="${h(x.key)}">PDF</button>${canShareFiles ? `<button class="btn small secondary" data-action="bills-share" data-key="${h(x.key)}">Share</button>` : ''}</div>`,
    ]);
    const p = pickSummary();
    const bar = bills.length ? `<div class="bills-bar">
        <label class="check bill-all"><input type="checkbox" data-bill-all ${p.n === p.of ? 'checked' : ''}> <span><b data-bill-n>${p.n}</b> / ${p.of}</span> <span>bills selected</span></label>
        <span class="bills-total"><b data-bill-total>${money(p.total)}</b> <span>to collect</span></span>
        <div class="bills-actions"><button class="btn" data-action="bills-pdf" data-bill-main ${p.n ? '' : 'disabled'}>Download PDF</button>${canShareFiles ? `<button class="btn secondary" data-action="bills-share" data-bill-main ${p.n ? '' : 'disabled'}>Share</button>` : ''}</div>
      </div>` : '';
    const former = data.former.count && !b.former ? `<p class="bill-note"><span>Not included: tenants who moved out owe</span> <b>${money(data.former.pending)}</b></p>` : '';
    const pd = d.org?.settings?.bills?.paymentDetails || '';
    const payCard = `<div class="card bill-pay">${state.forms['bills-pay'] && isOwner()
      ? `<form data-submit="bills-paydetails"><label class="bill-pay-title" for="bill-pd">How to pay (printed on every bill)</label><textarea id="bill-pd" name="paymentDetails" rows="4" maxlength="600" placeholder="UPI: yourname@upi&#10;Bank: name, account number, IFSC&#10;Cash: at the office, 10am to 6pm">${h(pd)}</textarea><div class="form-actions"><button class="btn" type="submit">Save</button><button class="btn secondary" type="button" data-toggle-form="bills-pay">Cancel</button></div></form>`
      : `<div class="bill-pay-row"><div><div class="bill-pay-title">How to pay (printed on every bill)</div>${pd ? `<div class="bill-pay-text" data-no-i18n>${h(pd)}</div>` : '<div class="bill-pay-text muted">Not added yet. Add your UPI ID or bank details so tenants know how to pay.</div>'}</div>${isOwner() ? `<button class="btn small secondary" data-toggle-form="bills-pay">${pd ? 'Edit' : 'Add'}</button>` : ''}</div>`}</div>`;
    return `${head}${financeTabs()}${filters}
      <div class="card bills-card">${bar}${table(cols, rows, { emptyText: 'Nothing is pending for this choice.' })}${former}</div>
      ${payCard}`;
  }
  X.changes['bill-filter'] = (el) => {
    const b = s.finance.bill;
    b[el.name] = el.value;
    if (el.name === 'buildingId') { b.floor = ''; b.roomId = ''; }
    if (el.name === 'floor') b.roomId = '';
    s.finance.skip = {};
  };
  X.changes['bill-kind'] = (el) => {
    const b = s.finance.bill;
    const chosen = new Set(b.kinds);
    if (el.checked) chosen.add(el.value); else chosen.delete(el.value);
    if (!chosen.size) { toast('Choose at least one type.', true); return; }
    b.kinds = BILL_TYPES.map(([k]) => k).filter((k) => chosen.has(k));
    s.finance.skip = {};
  };
  X.changes['bill-former'] = (el) => { s.finance.bill.former = el.checked; s.finance.skip = {}; };

  function billRequest(key) {
    const b = s.finance.bill;
    const body = { buildingId: b.buildingId, floor: b.floor, roomId: b.roomId, kinds: b.kinds, includeFormer: b.former };
    if (key) body.keys = [key];
    else {
      const p = pickSummary();
      if (!p.n) throw new Error('Tick at least one bill.');
      if (p.n < p.of) body.keys = p.keys;
    }
    return body;
  }
  async function fetchBillsPdf(body) {
    const res = await fetch(apiUrl('/api/bills/pdf'), { method: 'POST', headers: { Authorization: `Bearer ${session?.token || ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Could not make the PDF.'); }
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'bills.pdf';
    return { blob: await res.blob(), name };
  }
  X.actions['bills-pdf'] = async (el) => {
    const { blob, name } = await fetchBillsPdf(billRequest(el.dataset.key));
    await saveBlob(blob, name);
    return false;
  };
  X.actions['bills-share'] = async (el) => {
    const { blob, name } = await fetchBillsPdf(billRequest(el.dataset.key));
    if (nativeFiles()) { await shareNative(blob, name); return false; }
    try {
      await navigator.share({ files: [new File([blob], name, { type: 'application/pdf' })], title: name.replace(/\.pdf$/, '') });
    } catch (err) {
      if (err?.name !== 'AbortError') saveBlob(blob, name); // sharing not allowed here: download instead
    }
    return false;
  };
  X.submits['bills-paydetails'] = async (data) => {
    await api('PUT', '/api/org', { settings: { bills: { paymentDetails: data.paymentDetails || '' } } });
    state.forms['bills-pay'] = false;
    toast('Saved. It will be printed on every bill.');
  };

  // ---------- ledger ----------
  const KINDS = { rent: 'Rent', electricity: 'Electricity', gas: 'Gas', maintenance: 'Maintenance', late_fee: 'Late fee', damage: 'Damage', other: 'Other' };
  X.loaders.ledger = async () => {
    const l = s.ledger;
    if (l.tab === 'payments') d.payments = await api('GET', `/api/ledger/payments${qs({ tenantId: l.tenantId, buildingId: l.buildingId, limit: 300 })}`);
    else d.charges = await api('GET', `/api/ledger/charges${qs({ status: l.status, kind: l.kind, buildingId: l.buildingId, tenantId: l.tenantId, includeVoided: ['', 'void'].includes(l.status) ? '1' : '' })}`);
  };
  X.views.ledger = () => {
    const l = s.ledger;
    const tabs = `<div class="tab-row">${[['bills', 'Bills'], ['payments', 'Payments']].map(([k, t]) => `<button class="tab-btn ${l.tab === k ? 'active' : ''}" data-action="set-state" data-key="ledger.tab" data-value="${k}">${t}</button>`).join('')}</div>`;
    const filters = `<div class="card filter-bar"><div class="form-grid cols-3">
      ${field('Tenant', `<select data-ext-change="state" data-key="ledger.tenantId">${tenantOptions(l.tenantId, { activeOnly: false, blank: 'All tenants' })}</select>`)}
      ${field('Property', `<select data-ext-change="state" data-key="ledger.buildingId">${buildingOptions(l.buildingId)}</select>`)}
      ${l.tab === 'bills' ? field('Status', `<select data-ext-change="state" data-key="ledger.status">${[['open', 'Unpaid (open)'], ['', 'All'], ['overdue', 'Overdue'], ['partial', 'Partly paid'], ['paid', 'Paid'], ['waived', 'Waived'], ['void', 'Voided']].map(([v, t]) => opt(v, t, l.status)).join('')}</select>`) + field('Type', `<select data-ext-change="state" data-key="ledger.kind"><option value="">All types</option>${Object.entries(KINDS).map(([v, t]) => opt(v, t, l.kind)).join('')}</select>`) : ''}
    </div></div>`;
    const actions = `${can('payments.record') ? '<button class="btn" data-toggle-form="recordPayment">Record payment</button>' : ''}${can('bills.manage') ? '<button class="btn secondary" data-toggle-form="addCharge">Add charge</button>' : ''}<button class="btn secondary" data-action="download" data-url="/api/ledger/payments?format=csv" data-name="payments.csv">Payments CSV</button>`;
    return `${page('Bills & payments', 'Every bill and payment in one place.', actions)}
      ${state.forms.recordPayment ? recordPaymentForm() : ''}${state.forms.addCharge ? addChargeForm() : ''}
      ${tabs}${filters}${l.tab === 'payments' ? paymentsTable() : chargesTable()}`;
  };
  function recordPaymentForm() {
    if (!X.paymentKey) X.paymentKey = newKey();
    return card('Record a payment', `<form data-submit="record-payment"><input type="hidden" name="idempotencyKey" value="${X.paymentKey}"><div class="form-grid cols-3">
      ${field('Tenant *', `<select name="tenantId" required>${tenantOptions(s.ledger.tenantId, { activeOnly: false })}</select>`)}
      ${field('Amount (₹) *', '<input name="amount" type="number" min="0.01" step="0.01" required>')}
      ${field('Paid by *', `<select name="method" required>${[['upi', 'UPI'], ['cash', 'Cash'], ['bank_transfer', 'Bank transfer'], ['cheque', 'Cheque'], ['other', 'Other']].map(([v, t]) => opt(v, t)).join('')}</select>`)}
      ${field('Received on', `<input name="receivedOn" type="date" value="${today()}">`)}
      ${field('Reference (UTR / cheque no.)', '<input name="reference" maxlength="120">')}
      ${field('Notes', '<input name="notes" maxlength="500">')}
      <label class="check"><input type="checkbox" name="autoApply" checked> Apply to the oldest unpaid bills automatically (anything extra is kept as credit)</label>
    </div><div class="form-actions"><button class="btn" type="submit">Save payment</button><button class="btn secondary" type="button" data-toggle-form="recordPayment">Cancel</button></div></form>`, 'card-form');
  }
  function addChargeForm() {
    const now = new Date();
    return card('Add a charge', `<form data-submit="add-charge"><div class="form-grid cols-3">
      ${field('Tenant *', `<select name="tenantId" required>${tenantOptions(s.ledger.tenantId)}</select>`)}
      ${field('Type *', `<select name="kind" required>${['rent', 'maintenance', 'late_fee', 'damage', 'other'].map((k) => opt(k, KINDS[k])).join('')}</select>`)}
      ${field('Amount (₹) *', '<input name="amount" type="number" min="0.01" step="0.01" required>')}
      ${field('Due date', `<input name="dueDate" type="date" value="${today()}">`)}
      ${field('For month', `<input name="period" type="month" value="${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}">`)}
      ${field('Description', '<input name="description" maxlength="200" placeholder="e.g. Water tank cleaning share">')}
    </div><div class="form-actions"><button class="btn" type="submit">Add charge</button><button class="btn secondary" type="button" data-toggle-form="addCharge">Cancel</button></div></form>`, 'card-form');
  }
  function chargesTable() {
    const rows = (d.charges || []).map((c) => {
      const forms = [];
      if (state.forms[`adjust-${c.id}`]) forms.push(`<form class="inline-form" data-submit="adjust-charge" data-id="${c.id}"><select name="kind">${[['correction', 'Correction (+/−)'], ['discount', 'Discount'], ['late_fee', 'Late fee'], ...(isOwner() ? [['waiver', 'Waive'], ['write_off', 'Write off']] : [])].map(([v, t]) => opt(v, t)).join('')}</select><input name="amount" type="number" step="0.01" required placeholder="₹"><input name="reason" required maxlength="500" placeholder="Reason (kept in the audit log)"><button class="btn small" type="submit">Save</button><button class="btn small secondary" type="button" data-toggle-form="adjust-${c.id}">Cancel</button></form>`);
      if (state.forms[`void-${c.id}`]) forms.push(`<form class="inline-form" data-submit="void-charge" data-id="${c.id}"><input name="reason" required maxlength="300" placeholder="Why is this bill wrong?"><button class="btn small danger" type="submit">Void bill</button><button class="btn small secondary" type="button" data-toggle-form="void-${c.id}">Cancel</button></form>`);
      const acts = c.voided ? '' : [
        can('bills.manage') && c.status !== 'void' ? `<button class="btn small secondary" data-toggle-form="adjust-${c.id}">Adjust</button>` : '',
        isOwner() && !c.paid ? `<button class="btn small danger" data-toggle-form="void-${c.id}">Void</button>` : '',
        c.receipt ? `<button class="btn small secondary" data-action="open-doc" data-id="${c.receipt.id}">Proof (${h(c.receipt.reviewStatus)})</button>` : '',
      ].join('');
      return [`${h(c.label)}${c.description && c.kind !== 'rent' ? `<br><small class="muted">${h(c.description)}</small>` : ''}`, h(c.tenantName || '—'), `${h(c.buildingName)} ${h(c.roomLabel)}`, h(c.dueDate || '—'), money(c.amount), c.paid ? money(c.paid) : '—', `<b>${money(c.outstanding)}</b>`, stamp(c.status), `<div class="row-actions">${acts}</div>${forms.join('')}`];
    });
    const proofs = (d.charges || []).filter((c) => c.receipt && c.receipt.reviewStatus === 'unverified');
    const proofCard = proofs.length && can('payments.record') ? card(`Proofs to review <small>${proofs.length}</small>`, table(['Bill', 'Tenant', 'Outstanding', 'Proof', ''], proofs.map((c) => [h(c.label), h(c.tenantName), money(c.outstanding), `<button class="btn small secondary" data-action="open-doc" data-id="${c.receipt.id}">View</button>`,
      `<form class="inline-form" data-submit="review-proof" data-id="${c.receipt.id}"><input name="amount" type="number" step="0.01" min="0.01" value="${c.outstanding}" title="Amount received"><select name="method">${[['upi', 'UPI'], ['bank_transfer', 'Bank'], ['cash', 'Cash'], ['cheque', 'Cheque']].map(([v, t]) => opt(v, t)).join('')}</select><button class="btn small" type="submit" name="decision" value="accept">Accept</button><button class="btn small danger" type="button" data-action="reject-proof" data-id="${c.receipt.id}">Reject</button></form>`])), 'attention') : '';
    return proofCard + card('', table(['Bill', 'Tenant', 'Room', 'Due', 'Amount', 'Paid', 'Outstanding', 'Status', ''], rows, { emptyText: 'No bills match these filters.' }));
  }
  function paymentsTable() {
    const rows = (d.payments || []).map((p) => {
      const form = state.forms[`reverse-${p.id}`] ? `<form class="inline-form" data-submit="reverse-payment" data-id="${p.id}"><input name="reason" required maxlength="500" placeholder="Why is this payment being reversed?">${p.verification === 'verified' ? '<label class="check"><input type="checkbox" name="refundConfirmed"> The money was refunded / bounced</label>' : ''}<button class="btn small danger" type="submit">Reverse</button><button class="btn small secondary" type="button" data-toggle-form="reverse-${p.id}">Cancel</button></form>` : '';
      const acts = [
        `<button class="btn small secondary" data-action="open-page" data-url="/api/ledger/payments/${p.id}/receipt">Receipt</button>`,
        !p.reversed && p.unallocated > 0 && can('payments.record') ? `<button class="btn small secondary" data-action="apply-credit" data-id="${p.id}">Apply credit</button>` : '',
        !p.reversed && isOwner() ? `<button class="btn small danger" data-toggle-form="reverse-${p.id}">Reverse</button>` : '',
      ].join('');
      return [h(p.receivedOn), h(p.tenantName || '—'), h(p.roomLabel), money(p.amount), h(label(p.method)), h(p.reference || ''), p.verification === 'verified' ? stamp('verified') : '—', p.unallocated ? money(p.unallocated) : '—', p.reversed ? `${stamp('void')}<br><small>${h(p.reversalReason)}</small>` : '', `<div class="row-actions">${acts}</div>${form}`];
    });
    return card('', table(['Date', 'Tenant', 'Room', 'Amount', 'Method', 'Reference', 'Verified', 'Credit', 'Reversed', ''], rows, { emptyText: 'No payments recorded yet.' }));
  }
  X.submits['record-payment'] = async (data) => {
    const r = await api('POST', '/api/ledger/payments', { tenantId: data.tenantId, amount: data.amount, method: data.method, receivedOn: data.receivedOn, reference: data.reference, notes: data.notes, idempotencyKey: data.idempotencyKey, allocate: data.autoApply === 'on' });
    X.paymentKey = null;
    state.forms.recordPayment = false;
    toast(r.duplicate ? 'This payment was already recorded.' : `Payment of ${money(r.amount)} recorded${r.unallocated ? ` (${money(r.unallocated)} kept as credit)` : ''}`);
  };
  X.submits['add-charge'] = async (data) => {
    const t = cache.tenants.find((x) => x.id === data.tenantId);
    if (!t) throw new Error('Choose a tenant.');
    const [year, month] = (data.period || '').split('-').map(Number);
    await api('POST', '/api/ledger/charges', { kind: data.kind, roomId: t.roomId, tenantId: t.id, amount: data.amount, dueDate: data.dueDate, description: data.description, ...(year ? { year, month } : {}) });
    state.forms.addCharge = false;
    toast('Charge added');
  };
  X.submits['adjust-charge'] = async (data, form) => { await api('POST', `/api/ledger/charges/${form.dataset.id}/adjust`, data); state.forms[`adjust-${form.dataset.id}`] = false; toast('Adjustment recorded'); };
  X.submits['void-charge'] = async (data, form) => {
    if (!(await confirmDialog('The bill stays in the history marked as void and stops counting as money owed.', { title: 'Void this bill?', confirmLabel: 'Void bill', danger: true }))) return false;
    await api('POST', `/api/ledger/charges/${form.dataset.id}/void`, data); toast('Bill voided');
  };
  X.submits['reverse-payment'] = async (data, form) => {
    if (!(await confirmDialog('The payment stays in the history marked as reversed, and the bills it paid become unpaid again.', { title: 'Reverse this payment?', confirmLabel: 'Reverse payment', danger: true }))) return false;
    await api('POST', `/api/ledger/payments/${form.dataset.id}/reverse`, { reason: data.reason, refundConfirmed: data.refundConfirmed === 'on' }); toast('Payment reversed');
  };
  X.submits['review-proof'] = async (data, form) => { await api('POST', `/api/receipts/${form.dataset.id}/review`, { decision: 'accept', amount: data.amount, method: data.method }); toast('Proof accepted and payment recorded'); };
  X.actions['reject-proof'] = async (el) => {
    if (!(await confirmDialog('The tenant will still owe this bill. You can ask them for a clearer proof.', { title: 'Reject this proof?', confirmLabel: 'Reject', danger: true }))) return false;
    await api('POST', `/api/receipts/${el.dataset.id}/review`, { decision: 'reject' }); toast('Proof rejected');
  };
  X.actions['apply-credit'] = async (el) => { const r = await api('POST', `/api/ledger/payments/${el.dataset.id}/allocate`, {}); toast(r.applied.length ? `Applied to ${r.applied.length} bill(s)` : 'No unpaid bills to apply it to'); };

  // ---------- reconciliation ----------
  X.loaders.reconciliation = async () => { d.txns = await api('GET', `/api/reconciliation/transactions${qs({ status: s.recon.status })}`); };
  X.views.reconciliation = () => {
    const r = s.recon;
    const FLAG = { reference_already_recorded: 'This reference is already in the ledger', same_amount_and_date_recorded: 'A payment of this amount on this date is already recorded' };
    const rows = (d.txns || []).map((t) => {
      const sugg = r.open[t.id];
      let detail = '';
      if (sugg) {
        detail = `<div class="suggestions">${sugg.suggestions.map((sg) => `<div class="suggestion"><div><b>${h(sg.tenantName)}</b> · ${h(sg.roomLabel)} <span class="stamp ${sg.confidence === 'high' ? 'paid' : sg.confidence === 'medium' ? 'partial' : 'due'}">${h(sg.confidence)} (${sg.score})</span><ul>${sg.evidence.map((e) => `<li>${h(e)}</li>`).join('')}</ul>
          <small>${sg.allocations.length ? `Pays: ${sg.allocations.map((a) => `${h(a.label)} ${money(a.amount)}`).join(', ')}` : 'No open bills'}${sg.credit ? ` · ${money(sg.credit)} kept as credit` : ''}</small></div>
          <button class="btn small" data-action="recon-confirm" data-id="${t.id}" data-tenant="${sg.tenantId}" data-score="${sg.score}">Confirm match</button></div>`).join('') || `<p class="muted">${h(sugg.note || 'No likely tenant found.')}</p>`}
          <form class="inline-form" data-submit="recon-manual" data-id="${t.id}"><select name="tenantId" required>${tenantOptions('', { activeOnly: false, blank: 'Or choose the tenant yourself' })}</select><button class="btn small secondary" type="submit">Match to this tenant</button></form></div>`;
      }
      const acts = t.status === 'unmatched'
        ? `<button class="btn small" data-action="recon-suggest" data-id="${t.id}">${sugg ? 'Hide' : 'Find match'}</button><button class="btn small secondary" data-action="recon-ignore" data-id="${t.id}">Ignore</button>`
        : t.status === 'ignored' ? `<button class="btn small secondary" data-action="recon-reopen" data-id="${t.id}">Reopen</button>` : '';
      return [h(t.date), `<b>${money(t.amount)}</b>`, `${h(t.payer || '')}<br><small class="muted">${h(t.description)}</small>`, h(t.reference || ''), stamp(t.status) + t.flags.map((f) => `<div class="flag">⚠ ${h(FLAG[f] || f)}</div>`).join(''), `<div class="row-actions">${acts}</div>${detail}`];
    });
    return `${page('Bank matching', 'Upload a bank statement. Nothing is recorded until you confirm.')}
      ${card('Import statement', `<form data-submit="recon-import"><div class="form-grid cols-3">${field('Statement CSV file', '<input type="file" name="file" accept=".csv,text/csv">')}${field('…or paste the CSV', '<textarea name="csv" rows="3" placeholder="Date,Narration,Ref,Credit"></textarea>', 'span 2')}</div><div class="form-actions"><button class="btn" type="submit">Import</button></div><p class="profile-note">Only money coming in is imported. Lines already imported are skipped automatically.</p></form>`)}
      <div class="tab-row">${[['unmatched', 'To match'], ['matched', 'Matched'], ['ignored', 'Ignored'], ['', 'All']].map(([k, t]) => `<button class="tab-btn ${r.status === k ? 'active' : ''}" data-action="set-state" data-key="recon.status" data-value="${k}">${t}</button>`).join('')}</div>
      ${card('', table(['Date', 'Amount', 'From', 'Reference', 'Status', ''], rows, { emptyText: r.status === 'unmatched' ? 'No credits waiting to be matched.' : 'Nothing here.' }))}`;
  };
  X.submits['recon-import'] = async (data, form) => {
    const file = form.querySelector('input[type=file]').files[0];
    const csv = file ? await readFile(file, { asText: true, max: 2 * 1024 * 1024 }) : data.csv;
    if (!String(csv || '').trim()) throw new Error('Choose a CSV file or paste the statement.');
    const r = await api('POST', '/api/reconciliation/imports', { csv, fileName: file?.name || 'pasted.csv' });
    toast(`Imported ${r.imported} credit(s)${r.duplicates ? `, ${r.duplicates} already imported` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}`);
    s.recon.status = 'unmatched';
  };
  X.actions['recon-suggest'] = async (el) => {
    if (s.recon.open[el.dataset.id]) { delete s.recon.open[el.dataset.id]; return; }
    s.recon.open[el.dataset.id] = await api('GET', `/api/reconciliation/transactions/${el.dataset.id}/suggestions`);
  };
  X.actions['recon-confirm'] = async (el) => {
    const sugg = s.recon.open[el.dataset.id]?.suggestions.find((x) => x.tenantId === el.dataset.tenant);
    await api('POST', `/api/reconciliation/transactions/${el.dataset.id}/confirm`, { tenantId: el.dataset.tenant, score: Number(el.dataset.score), ...(sugg?.allocations.length ? { allocations: sugg.allocations.map((a) => ({ chargeId: a.chargeId, amount: a.amount })) } : {}) });
    delete s.recon.open[el.dataset.id];
    toast('Matched and recorded as a verified payment');
  };
  X.submits['recon-manual'] = async (data, form) => { await api('POST', `/api/reconciliation/transactions/${form.dataset.id}/confirm`, { tenantId: data.tenantId }); delete s.recon.open[form.dataset.id]; toast('Matched and recorded as a verified payment'); };
  X.actions['recon-ignore'] = async (el) => { await api('POST', `/api/reconciliation/transactions/${el.dataset.id}/ignore`, {}); toast('Ignored'); };
  X.actions['recon-reopen'] = async (el) => { await api('POST', `/api/reconciliation/transactions/${el.dataset.id}/reopen`, {}); toast('Reopened'); };

  // ---------- leases ----------
  const FREQ = { monthly: 'Monthly', quarterly: 'Quarterly', half_yearly: 'Half-yearly', yearly: 'Yearly' };
  X.loaders.leases = async () => { d.leases = await api('GET', `/api/leases${qs({ status: s.leases.status })}`); };
  X.views.leases = () => {
    const L = s.leases;
    const rows = (d.leases || []).map((l) => {
      const forms = [];
      if (state.forms[`activate-${l.id}`]) forms.push(`<form class="inline-form" data-submit="lease-activate" data-id="${l.id}"><label>Start billing from <input type="month" name="billFrom" value="${ym()}"></label><button class="btn small" type="submit">Activate</button><button class="btn small secondary" type="button" data-toggle-form="activate-${l.id}">Cancel</button><small class="muted">Months before this are assumed to be recorded already.</small></form>`);
      if (state.forms[`end-${l.id}`]) forms.push(`<form class="inline-form" data-submit="lease-end" data-id="${l.id}"><input name="reason" maxlength="300" placeholder="Reason"><label class="check"><input type="checkbox" name="terminate"> Terminated early</label><button class="btn small danger" type="submit">End lease</button><button class="btn small secondary" type="button" data-toggle-form="end-${l.id}">Cancel</button></form>`);
      if (state.forms[`renew-${l.id}`]) forms.push(`<form class="inline-form" data-submit="lease-renew" data-id="${l.id}"><label>New end date <input type="date" name="endDate"></label><label>Rent ₹ <input type="number" name="rent" step="0.01" min="0" value="${l.rent}"></label><button class="btn small" type="submit">Draft renewal</button><button class="btn small secondary" type="button" data-toggle-form="renew-${l.id}">Cancel</button></form>`);
      if (state.forms[`ldoc-${l.id}`]) forms.push(`<form class="inline-form" data-submit="lease-doc" data-id="${l.id}"><input type="file" name="file" accept="application/pdf,image/*" required><label class="check"><input type="checkbox" name="visibleToTenant" checked> Tenant can see it</label><button class="btn small" type="submit">Upload</button></form>`);
      const acts = [
        l.status === 'draft' ? `<button class="btn small" data-toggle-form="activate-${l.id}">Activate</button>` : '',
        l.status === 'active' ? `<button class="btn small secondary" data-toggle-form="renew-${l.id}">Renew</button>` : '',
        ['active', 'draft'].includes(l.status) ? `<button class="btn small danger" data-toggle-form="end-${l.id}">End</button>` : '',
        `<button class="btn small secondary" data-toggle-form="ldoc-${l.id}">Add document</button>`,
      ].join('');
      const docs = l.documents.map((doc) => `<button class="link-btn" data-action="open-doc" data-id="${doc.id}">📄 ${h(doc.originalName)}</button>`).join(' ');
      return [`<b>${h(l.tenantName)}</b><br><small class="muted">${h(l.buildingName)} ${h(l.roomLabel)}</small>`, `${h(l.startDate)} → ${h(l.endDate || 'open-ended')}${l.expiringSoon ? `<br><b class="is-due">${l.daysToEnd} days left</b>` : ''}`, `${money(l.rent)} <small>${h(FREQ[l.frequency])}, due day ${l.dueDay}</small>`, money(l.deposit), stamp(l.status), `<div class="row-actions">${acts}</div>${docs ? `<div class="docs">${docs}</div>` : ''}${forms.join('')}`];
    });
    const p = L.prefill || {};
    const extract = L.extract ? `<div class="extract-result"><p class="profile-note">${h(L.extract.note)}</p>${table(['Field', 'Suggested value', 'Found in'], Object.entries(L.extract.fields).filter(([, f]) => f && f.value !== null && f.value !== undefined && f.value !== '').map(([k, f]) => [h(label(k)), `<b>${h(f.value)}</b>`, `<small class="muted">“${h(String(f.source || '').slice(0, 140))}”</small>`]), { emptyText: 'Nothing recognisable was found. Fill the form by hand.' })}<button class="btn small" data-action="lease-use-extract">Use these values in the form</button></div>` : '';
    const form = state.forms.newLease ? card('New lease', `
      <form data-submit="lease-extract" class="extract-form"><div class="form-grid cols-3">${field('Read fields from the agreement (PDF)', '<input type="file" name="file" accept="application/pdf">')}${field('…or paste its text', '<textarea name="text" rows="2"></textarea>', 'span 2')}</div><div class="form-actions"><button class="btn small secondary" type="submit">Read from agreement</button></div></form>${extract}
      <form data-submit="lease-create"><div class="form-grid cols-3">
        ${field('Tenant *', `<select name="tenantId" required>${tenantOptions(p.tenantId)}</select>`)}
        ${field('Start date *', `<input type="date" name="startDate" required value="${h(p.startDate || today())}">`)}
        ${field('End date', `<input type="date" name="endDate" value="${h(p.endDate || '')}">`)}
        ${field('Rent (₹) *', `<input type="number" name="rent" min="0" step="0.01" required value="${h(p.rent ?? '')}">`)}
        ${field('Security deposit (₹)', `<input type="number" name="deposit" min="0" step="0.01" value="${h(p.deposit ?? '')}">`)}
        ${field('Rent frequency', `<select name="frequency">${Object.entries(FREQ).map(([v, t]) => opt(v, t, p.frequency || 'monthly')).join('')}</select>`)}
        ${field('Due day of month (1-28)', `<input type="number" name="dueDay" min="1" max="28" value="${h(p.dueDay || 5)}">`)}
        ${field('Notice period (days)', '<input type="number" name="noticeDays" min="0" max="365" value="30">')}
        <label class="check"><input type="checkbox" name="autoGenerateRent" checked> Create rent bills automatically each period</label>
        ${field('Terms / notes', '<textarea name="terms" rows="2" maxlength="5000"></textarea>', '1 / -1')}
      </div><div class="form-actions"><button class="btn" type="submit">Save as draft</button><button class="btn secondary" type="button" data-toggle-form="newLease">Cancel</button></div>
      <p class="profile-note">A lease starts as a draft. Activating it starts the rent schedule. Rent Ledger doesn't give legal advice; keep the signed agreement as a document.</p></form>`, 'card-form') : '';
    return `${page('Leases', 'Agreements and end dates.', can('leases.manage') ? '<button class="btn" data-toggle-form="newLease">New lease</button>' : '')}
      ${form}
      <div class="tab-row">${[['', 'All'], ['active', 'Active'], ['draft', 'Draft'], ['ended', 'Ended'], ['terminated', 'Terminated']].map(([k, t]) => `<button class="tab-btn ${L.status === k ? 'active' : ''}" data-action="set-state" data-key="leases.status" data-value="${k}">${t}</button>`).join('')}</div>
      ${card('', table(['Tenant', 'Term', 'Rent', 'Deposit', 'Status', ''], rows, { emptyText: 'No leases yet. Tenants without a lease are billed from the Rent tab as before.' }))}`;
  };
  X.submits['lease-extract'] = async (data, form) => {
    const file = form.querySelector('input[type=file]').files[0];
    const body = file ? await readFile(file, { types: ['application/pdf'] }) : { text: data.text };
    if (!file && !String(data.text || '').trim()) throw new Error('Choose the agreement PDF or paste its text.');
    s.leases.extract = await api('POST', '/api/leases/extract', body);
    state.forms.newLease = true;
  };
  X.actions['lease-use-extract'] = () => {
    const f = s.leases.extract?.fields || {};
    const val = (k) => (f[k] && f[k].value !== undefined && f[k].value !== null ? f[k].value : undefined);
    const match = val('tenantName') ? cache.tenants.find((t) => t.active && t.name.toLowerCase().includes(String(val('tenantName')).toLowerCase().split(' ')[0])) : null;
    s.leases.prefill = { tenantId: match?.id, startDate: val('startDate'), endDate: val('endDate'), rent: val('rent'), deposit: val('deposit'), dueDay: val('dueDay') };
    state.forms.newLease = true;
    toast('Values copied into the form. Check each one before saving.');
  };
  X.submits['lease-create'] = async (data) => {
    await api('POST', '/api/leases', { ...data, autoGenerateRent: data.autoGenerateRent === 'on' });
    s.leases.prefill = null; s.leases.extract = null; state.forms.newLease = false;
    toast('Lease saved as a draft. Activate it to start billing.');
  };
  X.submits['lease-activate'] = async (data, form) => { const r = await api('POST', `/api/leases/${form.dataset.id}/activate`, data); toast(`Lease active · ${r.chargesCreated} rent bill(s) created`); };
  X.submits['lease-end'] = async (data, form) => {
    if (!(await confirmDialog('The rent schedule stops. Bills already created are kept.', { title: 'End this lease?', confirmLabel: 'End lease', danger: true }))) return false;
    await api('POST', `/api/leases/${form.dataset.id}/end`, { reason: data.reason, terminate: data.terminate === 'on' }); toast('Lease ended');
  };
  X.submits['lease-renew'] = async (data, form) => { await api('POST', `/api/leases/${form.dataset.id}/renew`, { endDate: data.endDate, rent: data.rent }); toast('Renewal drafted. Activate it when it starts.'); };
  X.submits['lease-doc'] = async (data, form) => {
    const up = await readFile(form.querySelector('input[type=file]').files[0], { types: UPLOAD_TYPES });
    await api('POST', `/api/leases/${form.dataset.id}/documents`, { ...up, visibleToTenant: data.visibleToTenant === 'on' });
    toast('Document uploaded');
  };

  // ---------- reminders & outbox ----------
  const TPL = { rent_upcoming: 'Rent due soon', rent_due_today: 'Rent due today', rent_overdue: 'Rent overdue', lease_expiry: 'Lease ending', payment_received: 'Payment received', maintenance_update: 'Maintenance update' };
  X.loaders.reminders = async () => {
    const r = s.reminders;
    d.remSettings = await api('GET', '/api/reminders/settings');
    if (r.tab === 'outbox') d.outbox = await api('GET', `/api/outbox${qs({ status: r.status })}`);
    if (r.tab === 'preview') d.preview = await api('GET', `/api/reminders/preview${qs({ kind: r.previewKind })}`);
    if (r.tab === 'templates') d.templates = await api('GET', '/api/reminders/templates');
  };
  // Templates are shown the way a tenant would read them, with example details
  // highlighted, instead of raw {{tenantName}} codes.
  const SAMPLE = { tenantName: 'Asha', amount: '12,000', dueDate: '5 Oct 2026', bill: 'Rent Oct 2026', bills: 'Rent Sep 2026, Rent Oct 2026', daysOverdue: '3', property: 'Shri Geeta Sadan', unit: 'Room 101', endDate: '31 Dec 2026', daysLeft: '30', title: 'Leaking tap', status: 'In progress', comment: 'Plumber visits tomorrow', date: '3 Oct 2026' };
  const sampleText = (text) => h(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => `<mark class="tpl-fill">${h(k === 'ownerName' ? (session?.user?.name || 'Owner') : (SAMPLE[k] ?? k))}</mark>`);
  X.views.reminders = () => {
    const r = s.reminders;
    const st = d.remSettings || { settings: {}, channels: {} };
    const sim = st.mode === 'simulate';
    // Each channel's chip says whether it is actually used, not just whether the server could use it.
    const used = st.settings?.channels || ['inapp'];
    const chipState = (k, c) => (k !== 'inapp' && !c.configured ? 'not set up' : !used.includes(k) ? 'off' : k !== 'inapp' && sim ? 'preview only' : 'on');
    const channelInfo = Object.entries(st.channels || {}).map(([k, c]) => `<span class="chip ${chipState(k, c) === 'on' ? 'ok' : ''}">${h(label(k === 'inapp' ? 'in-app' : k))}: ${chipState(k, c)}</span>`).join(' ');
    // One line on every tab; which channels are set up is shown on the Settings tab.
    const banner = `<div class="notice ${sim ? 'warn' : ''}">${sim ? '<b>Preview mode:</b> only in-app messages are really delivered.' : '<b>Live:</b> approved messages are sent.'}</div>`;
    const tabs = `<div class="tab-row">${[['outbox', 'Outbox'], ['preview', 'Prepare'], ['templates', 'Templates'], ['settings', 'Settings']].map(([k, t]) => `<button class="tab-btn ${r.tab === k ? 'active' : ''}" data-action="set-state" data-key="reminders.tab" data-value="${k}">${t}</button>`).join('')}</div>`;
    let body = '';
    if (r.tab === 'outbox') {
      const msgs = d.outbox || [];
      const drafts = msgs.filter((m) => m.status === 'draft');
      body = `<div class="card filter-bar"><div class="form-grid cols-3">${field('Show', `<select data-ext-change="state" data-key="reminders.status">${[['', 'All'], ['draft', 'Drafts'], ['queued', 'Queued'], ['sent', 'Sent'], ['simulated', 'Simulated'], ['failed', 'Failed'], ['cancelled', 'Cancelled']].map(([v, t]) => opt(v, t, r.status)).join('')}</select>`)}</div></div>
        <form data-submit="outbox-approve">${drafts.length ? `<div class="form-actions"><button class="btn" type="submit">Approve & send selected</button><small class="muted">${drafts.length} draft(s) waiting. Nothing is sent until you approve.</small></div>` : ''}
        ${card('', table(['', 'Tenant', 'Channel', 'Message', 'Status', ''], msgs.map((m) => [
          m.status === 'draft' ? `<input type="checkbox" name="ids" value="${m.id}" checked aria-label="Select">` : '',
          h(m.tenantName), `${h(label(m.channel === 'inapp' ? 'in-app' : m.channel))}<br><small class="muted">${h(m.recipient)}</small>`,
          state.forms[`editmsg-${m.id}`] ? `<textarea name="body-${m.id}" rows="4" maxlength="1000">${h(m.body)}</textarea><button class="btn small" type="button" data-action="outbox-save" data-id="${m.id}">Save text</button>` : `<b>${h(m.subject || '')}</b><div class="msg-body">${h(m.body)}</div>`,
          stamp(m.status) + (m.lastError ? `<div class="flag">${h(m.lastError)}</div>` : '') + (m.attempts ? `<small class="muted">${m.attempts} attempt(s)</small>` : ''),
          `<div class="row-actions">${m.status === 'draft' ? `<button class="btn small secondary" type="button" data-toggle-form="editmsg-${m.id}">Edit</button>` : ''}${['draft', 'queued'].includes(m.status) ? `<button class="btn small secondary" type="button" data-action="outbox-cancel" data-id="${m.id}">Cancel</button>` : ''}${m.status === 'failed' ? `<button class="btn small" type="button" data-action="outbox-retry" data-id="${m.id}">Retry</button>` : ''}</div>`,
        ]), { emptyText: 'No messages. Use “Prepare” to make reminders.' }))}</form>`;
    } else if (r.tab === 'preview') {
      const p = d.preview || [];
      body = `<div class="card filter-bar"><div class="form-grid cols-3">${field('Reminder type', `<select data-ext-change="state" data-key="reminders.previewKind">${[['overdue', 'Overdue rent'], ['upcoming', 'Upcoming / due today'], ['lease_expiry', 'Lease ending'], ['all', 'All']].map(([v, t]) => opt(v, t, r.previewKind)).join('')}</select>`)}<div class="form-actions"><button class="btn" data-action="reminders-draft">Create drafts</button></div></div></div>
        ${card('Who would be reminded', table(['Tenant', 'Type', 'Amount', 'Channels', 'Message'], p.map((x) => [h(x.tenantName), h(TPL[x.key] || x.key), x.amount ? money(x.amount) : '—', x.reachable ? x.channels.map((c) => `<span class="chip">${h(c === 'inapp' ? 'in-app' : c)}</span>`).join(' ') : '<span class="flag">Can’t reach: no login and no consent for email/SMS/WhatsApp</span>', `<div class="msg-body">${h(x.body)}</div>`]), { emptyText: 'Nobody to remind for this type right now.' }))}`;
    } else if (r.tab === 'templates') {
      body = (d.templates || []).map((t) => {
        const key = `tpl-${t.key}-${t.language}`;
        return card(`${h(TPL[t.key] || t.key)} <small>${t.language === 'hi' ? 'हिन्दी' : 'English'}${t.customised ? ' · customised' : ''}</small>`, state.forms[key]
          ? `<form data-submit="template-save" data-key="${t.key}" data-lang="${t.language}"><div class="form-grid">${field('Subject', `<input name="subject" maxlength="200" value="${h(t.subject)}">`, '1 / -1')}${field('Message', `<textarea name="body" rows="4" maxlength="1000" required>${h(t.body)}</textarea>`, '1 / -1')}</div><p class="profile-note">Words in double braces are filled in for each tenant: {{tenantName}} {{amount}} {{dueDate}} {{bill}} {{bills}} {{daysOverdue}} {{property}} {{unit}} {{ownerName}} {{endDate}} {{daysLeft}}</p><div class="form-actions"><button class="btn small" type="submit">Save</button>${t.customised ? `<button class="btn small secondary" type="button" data-action="template-reset" data-key="${t.key}" data-lang="${t.language}">Restore default</button>` : ''}<button class="btn small secondary" type="button" data-toggle-form="${key}">Cancel</button></div></form>`
          : `<p class="tpl-example-label">How it reads (example)</p><p class="msg-body tpl-example" ${t.language === 'hi' ? 'lang="hi"' : ''} data-no-i18n><b>${sampleText(t.subject)}</b><br>${sampleText(t.body)}</p><button class="btn small secondary" data-toggle-form="${key}">Edit</button>`);
      }).join('');
    } else {
      const c = st.settings || {};
      const dis = isOwner() ? '' : 'disabled';
      body = card('Reminder settings', `<div class="chips">${channelInfo}</div>${sim ? '<p class="profile-note">Preview mode: email, SMS and WhatsApp messages are marked “simulated” and are not actually sent.</p>' : ''}<form data-submit="reminder-settings"><div class="form-grid cols-3">
        <label class="check"><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''} ${dis}> Prepare reminders automatically every day</label>
        <label class="check"><input type="checkbox" name="requireApproval" ${c.requireApproval !== false ? 'checked' : ''} ${dis}> Wait for my approval before sending (recommended)</label>
        <label class="check"><input type="checkbox" name="onDueDate" ${c.onDueDate ? 'checked' : ''} ${dis}> Remind on the due date</label>
        ${field('Days before due date', `<input type="number" name="upcomingDaysBefore" min="0" max="30" value="${c.upcomingDaysBefore ?? 3}" ${dis}>`)}
        ${field('Overdue reminder every (days)', `<input type="number" name="overdueEveryDays" min="1" max="30" value="${c.overdueEveryDays ?? 3}" ${dis}>`)}
        ${field('Maximum overdue reminders', `<input type="number" name="overdueMaxCount" min="0" max="10" value="${c.overdueMaxCount ?? 3}" ${dis}>`)}
        ${field('Lease ending reminders (days before, comma separated)', `<input name="leaseExpiryDays" value="${h((c.leaseExpiryDays || []).join(', '))}" ${dis}>`)}
        <fieldset class="check-group" ${dis}><legend>Channels</legend>${['inapp', 'email', 'sms', 'whatsapp'].map((ch) => `<label class="check"><input type="checkbox" name="ch-${ch}" ${(c.channels || []).includes(ch) ? 'checked' : ''}> ${ch === 'inapp' ? 'In-app' : label(ch)}</label>`).join('')}</fieldset>
      </div>${isOwner() ? '<div class="form-actions"><button class="btn" type="submit">Save settings</button></div>' : '<p class="profile-note">Only the owner can change these settings.</p>'}
      <p class="profile-note">Tenants only get email, SMS or WhatsApp if they have agreed to it (set on the tenant’s record or in their portal). In-app messages need a tenant login.</p></form>`);
    }
    return `${page('Reminders', 'Nothing is sent until you approve.')}${banner}${tabs}${body}`;
  };
  X.submits['outbox-approve'] = async (data, form) => {
    const ids = [...form.querySelectorAll('input[name=ids]:checked')].map((i) => i.value);
    if (!ids.length) throw new Error('Select at least one draft.');
    const r = await api('POST', '/api/outbox/approve', { ids });
    toast(`${r.approved} approved · ${r.delivery.sent || 0} sent${r.delivery.simulated ? `, ${r.delivery.simulated} simulated (preview mode)` : ''}${r.delivery.failed ? `, ${r.delivery.failed} failed` : ''}`);
  };
  X.actions['outbox-save'] = async (el) => {
    const body = document.querySelector(`textarea[name="body-${el.dataset.id}"]`).value;
    await api('PUT', `/api/outbox/${el.dataset.id}`, { body }); state.forms[`editmsg-${el.dataset.id}`] = false; toast('Message updated');
  };
  X.actions['outbox-cancel'] = async (el) => { await api('POST', `/api/outbox/${el.dataset.id}/cancel`, {}); toast('Message cancelled'); };
  X.actions['outbox-retry'] = async (el) => { await api('POST', `/api/outbox/${el.dataset.id}/retry`, {}); toast('Retrying'); };
  X.actions['reminders-draft'] = async () => {
    const r = await api('POST', '/api/reminders/drafts', { kind: s.reminders.previewKind });
    toast(`${r.created} draft(s) created${r.skippedDuplicates ? `, ${r.skippedDuplicates} already drafted today` : ''}${r.unreachable ? `, ${r.unreachable} unreachable` : ''}`);
    s.reminders.tab = 'outbox'; s.reminders.status = 'draft';
  };
  X.submits['template-save'] = async (data, form) => { await api('PUT', `/api/reminders/templates/${form.dataset.key}/${form.dataset.lang}`, data); state.forms[`tpl-${form.dataset.key}-${form.dataset.lang}`] = false; toast('Template saved'); };
  X.actions['template-reset'] = async (el) => { await api('PUT', `/api/reminders/templates/${el.dataset.key}/${el.dataset.lang}`, { reset: true }); state.forms[`tpl-${el.dataset.key}-${el.dataset.lang}`] = false; toast('Default restored'); };
  X.submits['reminder-settings'] = async (data) => {
    const reminders = {
      enabled: data.enabled === 'on', requireApproval: data.requireApproval === 'on', onDueDate: data.onDueDate === 'on',
      upcomingDaysBefore: Number(data.upcomingDaysBefore), overdueEveryDays: Number(data.overdueEveryDays), overdueMaxCount: Number(data.overdueMaxCount),
      leaseExpiryDays: String(data.leaseExpiryDays || '').split(/[,\s]+/).filter(Boolean).map(Number),
      channels: ['inapp', 'email', 'sms', 'whatsapp'].filter((c) => data[`ch-${c}`] === 'on'),
    };
    if (reminders.enabled && !reminders.requireApproval && !(await confirmDialog('Reminders will be sent every day without you reviewing them first.', { title: 'Send automatically?', confirmLabel: 'Yes, send automatically' }))) return false;
    await api('PUT', '/api/org', { settings: { reminders } }); toast('Reminder settings saved');
  };

  // ---------- maintenance ----------
  const MCAT = ['plumbing', 'electrical', 'appliance', 'carpentry', 'painting', 'cleaning', 'pest_control', 'security', 'internet', 'other'];
  const MSTATUS = { submitted: 'Submitted', under_review: 'Under review', approved: 'Approved', assigned: 'Assigned', in_progress: 'In progress', awaiting_tenant: 'Waiting for tenant', resolved: 'Resolved', closed: 'Closed' };
  X.loaders.maintenance = async () => {
    const m = s.maint;
    if (state.params?.id) m.id = state.params.id;
    if (m.id) d.maintDetail = await api('GET', `/api/maintenance/${m.id}`);
    else d.maint = await api('GET', `/api/maintenance${qs({ status: m.status, buildingId: m.buildingId })}`);
  };
  X.views.maintenance = () => {
    const m = s.maint;
    if (m.id && d.maintDetail) return maintenanceDetail(d.maintDetail);
    const form = state.forms.newMaint ? card('New repair request', `<form data-submit="maint-create"><div class="form-grid cols-3">
      ${field('Property *', `<select name="buildingId" required>${buildingOptions('', 'Choose property')}</select>`)}
      ${field('Room', `<select name="roomId">${roomOptions('')}</select>`)}
      ${field('Category', `<select name="category">${MCAT.map((c) => opt(c, label(c), 'other')).join('')}</select>`)}
      ${field('Title *', '<input name="title" required maxlength="120">')}
      ${field('Priority', `<select name="priority">${['low', 'normal', 'high', 'urgent'].map((p) => opt(p, label(p), 'normal')).join('')}</select>`)}
      ${field('Description', '<textarea name="description" rows="2" maxlength="2000"></textarea>', '1 / -1')}
    </div><div class="form-actions"><button class="btn" type="submit">Create request</button><button class="btn secondary" type="button" data-toggle-form="newMaint">Cancel</button></div></form>`, 'card-form') : '';
    const rows = (d.maint || []).map((r) => [`<button class="link-btn" data-action="maint-open" data-id="${r.id}"><b>${h(r.title)}</b></button><br><small class="muted">${h(label(r.category))}${r.createdByRole === 'tenant' ? ' · from tenant' : ''}</small>`, `${h(r.buildingName)} ${h(r.roomLabel)}`, h(r.tenantName || '—'), `<span class="prio ${h(r.priority)}">${h(r.priority)}</span>`, `<span class="stamp m-${h(r.status)}">${h(r.statusLabel)}</span>`, r.cost ? money(r.cost) : '—', h(r.updatedAt.slice(0, 10))]);
    return `${page('Repairs', 'Requests from tenants and your own tasks.', '<button class="btn" data-toggle-form="newMaint">New request</button>')}${form}
      <div class="card filter-bar"><div class="form-grid cols-3">${field('Status', `<select data-ext-change="state" data-key="maint.status">${[['open', 'Open'], ['', 'All'], ...Object.entries(MSTATUS)].map(([v, t]) => opt(v, t, m.status)).join('')}</select>`)}${field('Property', `<select data-ext-change="state" data-key="maint.buildingId">${buildingOptions(m.buildingId)}</select>`)}</div></div>
      ${card('', table(['Request', 'Where', 'Tenant', 'Priority', 'Status', 'Cost', 'Updated'], rows, { emptyText: 'No repair requests here.' }))}`;
  };
  function maintenanceDetail(r) {
    const timeline = r.timeline.map((e) => `<li class="${e.visibleToTenant ? '' : 'internal'}"><span class="when">${h(e.at.slice(0, 16).replace('T', ' '))}</span> <b>${h(e.by || label(e.role))}</b> ${e.type === 'status' ? `→ <span class="stamp m-${h(e.to)}">${h(e.toLabel)}</span>` : ''} ${e.comment ? `<div>${h(e.comment)}</div>` : ''}${e.visibleToTenant ? '' : '<small class="muted">internal note</small>'}</li>`).join('');
    const photos = r.attachments.map((a) => `<button class="link-btn" data-action="open-doc" data-id="${a.id}">📎 ${h(a.originalName)}</button>`).join(' ');
    return `${page(r.title, `${h(r.buildingName)} ${h(r.roomLabel)}${r.tenantName ? ` · ${h(r.tenantName)}` : ''} · ${h(label(r.category))} · <span class="prio ${h(r.priority)}">${h(r.priority)}</span>`, '<button class="btn secondary" data-action="maint-back">← All requests</button>')}
      <div class="two-col"><div>
        ${card(`Status: <span class="stamp m-${h(r.status)}">${h(r.statusLabel)}</span>`, `${r.description ? `<p>${h(r.description)}</p>` : ''}${r.nextStatuses?.length ? `<form data-submit="maint-status" data-id="${r.id}"><div class="form-grid cols-3">${field('Change status', `<select name="status">${r.nextStatuses.map((st) => opt(st, MSTATUS[st])).join('')}</select>`)}${field('Comment', '<input name="comment" maxlength="2000" placeholder="What happened? (shown to the tenant)">', 'span 2')}<label class="check"><input type="checkbox" name="internal"> Internal only (tenant won’t see it)</label></div><div class="form-actions"><button class="btn" type="submit">Update status</button></div></form>` : ''}`)}
        ${card('Timeline', `<ol class="timeline">${timeline}</ol><form data-submit="maint-comment" data-id="${r.id}" class="inline-form"><input name="comment" required maxlength="2000" placeholder="Add a comment"><label class="check"><input type="checkbox" name="internal"> Internal</label><button class="btn small" type="submit">Add</button></form>`)}
      </div><div>
        ${card('Assignment', `<form data-submit="maint-edit" data-id="${r.id}"><div class="form-grid">${field('Assigned to (vendor / staff)', `<input name="assignedTo" maxlength="120" value="${h(r.assignedTo || '')}">`, '1 / -1')}${field('Priority', `<select name="priority">${['low', 'normal', 'high', 'urgent'].map((p) => opt(p, label(p), r.priority)).join('')}</select>`)}${field('Resolution', `<input name="resolution" maxlength="2000" value="${h(r.resolution || '')}">`)}</div><div class="form-actions"><button class="btn small" type="submit">Save</button></div><p class="profile-note">Vendor details are not shown to the tenant.</p></form>`)}
        ${card('Photos & files', `${photos || '<p class="muted">None yet.</p>'}<form data-submit="maint-attach" data-id="${r.id}" class="inline-form"><input type="file" name="file" accept="image/*,application/pdf" required><label class="check"><input type="checkbox" name="visible" checked> Tenant can see</label><button class="btn small" type="submit">Upload</button></form>`)}
        ${card(`Costs <small>${money(r.cost)}</small>`, `${table(['Date', 'Vendor', 'Amount'], (r.expenses || []).map((e) => [h(e.spentOn), h(e.vendor), money(e.amount)]), { emptyText: 'No costs recorded.' })}${can('expenses.manage') ? `<form data-submit="maint-expense" data-id="${r.id}" data-building="${r.buildingId}" data-room="${r.roomId || ''}" class="inline-form"><input name="amount" type="number" min="0.01" step="0.01" required placeholder="₹ amount"><input name="vendor" maxlength="120" placeholder="Vendor"><input name="spentOn" type="date" value="${today()}"><button class="btn small" type="submit">Add cost</button></form>` : ''}`)}
      </div></div>`;
  }
  X.actions['maint-open'] = (el) => { s.maint.id = el.dataset.id; state.params = {}; };
  X.actions['maint-back'] = () => { s.maint.id = null; state.params = {}; d.maintDetail = null; };
  X.submits['maint-create'] = async (data) => { const r = await api('POST', '/api/maintenance', data); state.forms.newMaint = false; s.maint.id = r.id; toast('Request created'); };
  X.submits['maint-status'] = async (data, form) => { await api('POST', `/api/maintenance/${form.dataset.id}/status`, { status: data.status, comment: data.comment, visibleToTenant: data.internal !== 'on' }); toast('Status updated'); };
  X.submits['maint-comment'] = async (data, form) => { await api('POST', `/api/maintenance/${form.dataset.id}/comments`, { comment: data.comment, visibleToTenant: data.internal !== 'on' }); toast('Comment added'); };
  X.submits['maint-edit'] = async (data, form) => { await api('PUT', `/api/maintenance/${form.dataset.id}`, data); toast('Saved'); };
  X.submits['maint-attach'] = async (data, form) => { const up = await readFile(form.querySelector('input[type=file]').files[0], { types: UPLOAD_TYPES }); await api('POST', `/api/maintenance/${form.dataset.id}/attachments`, { ...up, visibleToTenant: data.visible === 'on' }); toast('File uploaded'); };
  X.submits['maint-expense'] = async (data, form) => { await api('POST', '/api/expenses', { buildingId: form.dataset.building, roomId: form.dataset.room || null, maintenanceRequestId: form.dataset.id, category: 'repairs', amount: data.amount, vendor: data.vendor, spentOn: data.spentOn, description: 'Maintenance cost' }); toast('Cost recorded as an expense'); };

  // ---------- expenses ----------
  const ECAT = ['maintenance', 'repairs', 'utilities', 'property_tax', 'insurance', 'management_fee', 'other'];
  X.loaders.expenses = async () => {
    const e = s.expenses;
    d.expenses = await api('GET', `/api/expenses${qs({ from: e.from ? `${e.from}-01` : '', to: e.to ? `${e.to}-31` : '', buildingId: e.buildingId, category: e.category })}`);
  };
  X.views.expenses = () => {
    const e = s.expenses;
    const list = d.expenses || [];
    const total = list.reduce((sum, x) => sum + x.amount, 0);
    const form = state.forms.newExpense ? card('Add expense', `<form data-submit="expense-create"><div class="form-grid cols-3">
      ${field('Property *', `<select name="buildingId" required>${buildingOptions('', 'Choose property')}</select>`)}
      ${field('Room', `<select name="roomId">${roomOptions('')}</select>`)}
      ${field('Category *', `<select name="category" required>${ECAT.map((c) => opt(c, label(c))).join('')}</select>`)}
      ${field('Amount (₹) *', '<input name="amount" type="number" min="0.01" step="0.01" required>')}
      ${field('Date', `<input name="spentOn" type="date" value="${today()}">`)}
      ${field('Vendor', '<input name="vendor" maxlength="120">')}
      ${field('Description', '<input name="description" maxlength="500">', 'span 2')}
      ${field('Receipt (optional)', '<input type="file" name="file" accept="image/*,application/pdf">')}
    </div><div class="form-actions"><button class="btn" type="submit">Save expense</button><button class="btn secondary" type="button" data-toggle-form="newExpense">Cancel</button></div></form>`, 'card-form') : '';
    const rows = list.map((x) => [h(x.spentOn), `${h(x.buildingName)} ${h(x.roomLabel)}`, h(label(x.category)), `${h(x.vendor)}${x.description ? `<br><small class="muted">${h(x.description)}</small>` : ''}${x.maintenanceTitle ? `<br><small>🔧 ${h(x.maintenanceTitle)}</small>` : ''}`, money(x.amount),
      `${x.receipts.map((r) => `<button class="link-btn" data-action="open-doc" data-id="${r.id}">📎</button>`).join('')}${isOwner() && !x.voided ? (state.forms[`evoid-${x.id}`] ? `<form class="inline-form" data-submit="expense-void" data-id="${x.id}"><input name="reason" required maxlength="300" placeholder="Reason"><button class="btn small danger" type="submit">Void</button></form>` : `<button class="btn small danger" data-toggle-form="evoid-${x.id}">Void</button>`) : ''}`]);
    return `${page('Expenses', `${list.length} entr${list.length === 1 ? 'y' : 'ies'} · total ${money(total)}`, `<button class="btn" data-toggle-form="newExpense">Add expense</button><button class="btn secondary" data-action="download" data-url="/api/expenses${qs({ format: 'csv', buildingId: e.buildingId, category: e.category })}" data-name="expenses.csv">CSV</button>`)}${form}
      <div class="card filter-bar"><div class="form-grid cols-3">${field('From month', `<input type="month" data-ext-change="state" data-key="expenses.from" value="${h(e.from)}">`)}${field('To month', `<input type="month" data-ext-change="state" data-key="expenses.to" value="${h(e.to)}">`)}${field('Property', `<select data-ext-change="state" data-key="expenses.buildingId">${buildingOptions(e.buildingId)}</select>`)}${field('Category', `<select data-ext-change="state" data-key="expenses.category"><option value="">All categories</option>${ECAT.map((c) => opt(c, label(c), e.category)).join('')}</select>`)}</div></div>
      ${card('', table(['Date', 'Where', 'Category', 'Vendor / details', 'Amount', ''], rows, { emptyText: 'No expenses recorded for these filters.' }))}
      <p class="basis-note">Amounts can’t be edited after saving; void a wrong entry and add the correct one. Voided entries stay in the audit log.</p>`;
  };
  X.submits['expense-create'] = async (data, form) => {
    const file = form.querySelector('input[type=file]').files[0];
    const up = file ? await readFile(file, { types: UPLOAD_TYPES }) : null;
    const { file: _f, ...body } = data;
    const created = await api('POST', '/api/expenses', body);
    if (up) await api('POST', '/api/documents', { entityType: 'expense', entityId: created.id, kind: 'receipt', ...up });
    state.forms.newExpense = false; toast('Expense saved');
  };
  X.submits['expense-void'] = async (data, form) => { await api('POST', `/api/expenses/${form.dataset.id}/void`, data); toast('Expense voided'); };

  // ---------- reports ----------
  const REPORTS = {
    'rent-collection': ['Rent collection', 'Rent billed and collected per room and month.'],
    outstanding: ['Outstanding dues', 'Every unpaid bill today, oldest first.'],
    payments: ['Payments received', 'All money received in the period, by method.'],
    'property-income': ['Property income & expenses', 'Billed, received, expenses and net per property.'],
    'cash-flow': ['Monthly cash flow', 'Money in and out, month by month.'],
    'lease-expiry': ['Lease expiries', 'Active leases and when they end.'],
    'maintenance-expenses': ['Expenses (incl. maintenance)', 'Every expense in the period.'],
    'deposit-settlements': ['Deposits & settlements', 'Deposits held, deductions and refunds.'],
  };
  X.loaders.reports = async () => {
    const r = s.reports;
    if (r.open) d.report = await api('GET', `/api/reports/${r.open}${qs({ from: r.from, to: r.to, buildingId: r.buildingId })}`);
  };
  X.views.reports = () => {
    const r = s.reports;
    const q = (extra) => qs({ from: r.from, to: r.to, buildingId: r.buildingId, ...extra });
    const list = Object.entries(REPORTS).map(([key, [title, sub]]) => `<div class="report-card ${r.open === key ? 'active' : ''}"><div><b>${h(title)}</b><small>${h(sub)}</small></div><div class="row-actions"><button class="btn small" data-action="report-open" data-key="${key}">View</button><button class="btn small secondary" data-action="open-page" data-url="/api/reports/${key}${q({ format: 'html' })}">Print / PDF</button><button class="btn small secondary" data-action="download" data-url="/api/reports/${key}${q({ format: 'csv' })}" data-name="${key}.csv">CSV</button></div></div>`).join('');
    const rep = r.open && d.report ? card(`${h(d.report.title)} <small>${h(d.report.range.from)} to ${h(d.report.range.to)}</small>`, table(d.report.columns, d.report.rows.map((row) => row.map((cell, i) => (d.report.moneyColumns.includes(i) ? money(cell) : h(cell))))), 'report-view') : '';
    return `${page('Reports', 'Print or save any report as PDF.')}
      <form class="card filter-bar" data-submit="report-range"><div class="form-grid cols-3">${field('From month', `<input type="month" name="from" value="${h(r.from)}">`)}${field('To month', `<input type="month" name="to" value="${h(r.to)}">`)}${field('Property', `<select name="buildingId">${buildingOptions(r.buildingId)}</select>`)}<div class="form-actions"><button class="btn" type="submit">Apply</button></div></div><p class="profile-note">Leave the months empty for the last 12 months.</p></form>
      <div class="report-list">${list}</div>${rep}`;
  };
  X.submits['report-range'] = (data) => { Object.assign(s.reports, { from: data.from, to: data.to, buildingId: data.buildingId }); };
  X.actions['report-open'] = (el) => { s.reports.open = el.dataset.key; };

  // ---------- assistant ----------
  const SUGGEST = ['Who is overdue?', 'Who hasn’t paid this month?', 'Leases expiring in 60 days', 'Expenses this month', 'Draft reminders for overdue tenants'];
  X.loaders.assistant = async () => {
    [d.aiStatus, d.aiHistory, d.aiActions] = await Promise.all([api('GET', '/api/assistant/status'), api('GET', '/api/assistant/history'), api('GET', '/api/assistant/actions?status=proposed')]);
  };
  function resultHtml(res) {
    const t = res.table;
    return `<div class="ai-result">${t && t.rows.length ? `<div class="ai-table-title">${h(t.title)}</div>${table(t.columns, t.rows.map((r) => r.map((c) => h(c))))}` : ''}${res.basis ? `<div class="ai-basis">Based on: ${h(res.basis)}</div>` : ''}${(res.links || []).map((l) => `<button class="btn small secondary" data-action="open-page" data-url="${h(l.href)}">${h(l.label)}</button>`).join('')}${res.action ? actionHtml(res.action) : ''}</div>`;
  }
  function actionHtml(a) {
    const live = (d.aiActions || []).find((x) => x.id === a.id) || a;
    if (live.status !== 'proposed') return `<div class="ai-action done">${stamp(live.status)} ${h(live.summary)}</div>`;
    let editor = '';
    if (live.type === 'send_reminders') {
      editor = live.payload.messages.map((m, i) => `<div class="ai-msg ${m.include === false ? 'excluded' : ''}"><div><b>${h(m.tenantName)}</b> · ${h(m.channel === 'inapp' ? 'in-app' : m.channel)}</div>${state.forms[`aimsg-${live.id}-${i}`] ? `<textarea data-ai-msg="${live.id}:${i}" rows="3" maxlength="1000">${h(m.body)}</textarea><button class="btn small" data-action="ai-msg-save" data-id="${live.id}" data-index="${i}">Save</button>` : `<div class="msg-body">${h(m.body)}</div><div class="row-actions"><button class="btn small secondary" data-toggle-form="aimsg-${live.id}-${i}">Edit</button><button class="btn small secondary" data-action="ai-msg-toggle" data-id="${live.id}" data-index="${i}" data-include="${m.include === false ? '1' : '0'}">${m.include === false ? 'Include' : 'Leave out'}</button></div>`}</div>`).join('');
    } else if (live.type === 'create_expense') {
      const p = live.payload;
      editor = `<form class="inline-form" data-submit="ai-expense-edit" data-id="${live.id}"><input name="amount" type="number" step="0.01" min="0.01" value="${p.amountPaise / 100}"><select name="category">${ECAT.map((c) => opt(c, label(c), p.category)).join('')}</select><input name="spentOn" type="date" value="${h(p.spentOn)}"><input name="vendor" placeholder="Vendor" value="${h(p.vendor)}"><button class="btn small secondary" type="submit">Update</button></form>`;
    } else if (live.type === 'create_maintenance') {
      const p = live.payload;
      editor = `<form class="inline-form" data-submit="ai-maint-edit" data-id="${live.id}"><input name="title" maxlength="120" value="${h(p.title)}"><select name="priority">${['low', 'normal', 'high', 'urgent'].map((x) => opt(x, label(x), p.priority)).join('')}</select><button class="btn small secondary" type="submit">Update</button></form>`;
    }
    return `<div class="ai-action"><div class="ai-action-head"><span class="stamp proposed">waiting for approval</span> <b>${h(live.summary)}</b></div>${editor}<div class="form-actions"><button class="btn small" data-action="ai-approve" data-id="${live.id}">Approve</button><button class="btn small danger" data-action="ai-reject" data-id="${live.id}">Reject</button></div></div>`;
  }
  X.views.assistant = () => {
    const st = d.aiStatus || { mode: 'basic', ai: {} };
    const modeText = st.mode === 'ai'
      ? `<b>AI mode</b> (${h(st.ai.provider)}). ${h(st.dataSharing || '')}`
      : `<b>Basic mode:</b> answers come from built-in rules.${st.ai.configured ? ` <span>${isOwner() ? 'You can turn on AI in Settings.' : 'The owner can turn on AI in Settings.'}</span>` : ''}`;
    const msgs = (d.aiHistory || []).map((m) => m.role === 'user'
      ? `<div class="chat-msg user"><div class="bubble">${h(m.text)}</div></div>`
      : `<div class="chat-msg bot"><div class="bubble">${m.notice ? `<div class="notice warn">${h(m.notice)}</div>` : ''}<div class="chat-text">${h(m.text).replace(/\n/g, '<br>')}</div>${(m.results || []).map(resultHtml).join('')}<small class="muted">${m.mode === 'ai' ? 'AI' : 'Basic'} · ${h((m.at || '').slice(11, 16))}</small></div></div>`).join('');
    const pendingIds = new Set((d.aiHistory || []).flatMap((m) => (m.results || []).map((r) => r.action?.id).filter(Boolean)));
    const orphan = (d.aiActions || []).filter((a) => !pendingIds.has(a.id));
    return `${page('Assistant', 'Ask about your records. It only prepares things for you to approve.', (d.aiHistory || []).length ? '<button class="btn secondary" data-action="ai-clear">Clear chat</button>' : '')}
      <div class="notice">${modeText}</div>
      ${orphan.length ? card(`Proposals waiting for approval <small>${orphan.length}</small>`, orphan.map(actionHtml).join('')) : ''}
      <div class="card chat"><div class="chat-log" id="chat-log">${msgs || '<p class="muted">Ask a question to get started.</p>'}</div>
        <div class="chips suggest">${SUGGEST.map((q) => `<button class="chip" data-action="ai-ask" data-q="${h(q)}">${h(q)}</button>`).join('')}</div>
        <form data-submit="ai-chat" class="chat-form"><input name="message" maxlength="1000" required placeholder="e.g. Which tenants haven't paid this month?" autocomplete="off"><button class="btn" type="submit">Ask</button></form></div>`;
  };
  X.afterRender = () => {
    const log = document.getElementById('chat-log'); if (log) log.scrollTop = log.scrollHeight;
    compactButtons(document.getElementById('app'));
    keepActiveInView();
    document.body.classList.remove('sheet-open');
    labelTables(document.getElementById('app'));
    fitTables();
    if (state.view === 'finance' && s.finance.tab === 'bills') updateBillBar();
  };

  // ---------- phones: tables that don't fit become cards ----------
  // Each cell gets its column name, so on a phone a row can show as a small
  // card ("Amount ₹11,000") instead of a table running off the screen.
  function labelTables(root) {
    if (!root) return;
    root.querySelectorAll('table').forEach((tbl) => {
      const tt = window.RL_I18N ? RL_I18N.t : (x) => x; // labels follow the chosen language
      const heads = [...tbl.querySelectorAll(':scope > thead th')].map((th) => tt(th.textContent.trim()));
      if (!heads.length) return;
      tbl.classList.add('has-labels');
      tbl.querySelectorAll(':scope > tbody > tr').forEach((tr) => {
        [...tr.children].forEach((td, i) => {
          if (!td.hasAttribute('data-label')) td.setAttribute('data-label', heads[i] || '');
          // Empty values ("—") are left out of phone cards so each card stays short.
          if (i > 0 && /^[—–-]?$/.test(td.textContent.trim()) && !td.querySelector('input, select, button, img, form')) td.classList.add('cell-empty');
          if (td.querySelector(':scope > .row-actions > .more-menu, :scope > .more-menu') && !td.querySelector('.row-actions > button')) td.classList.add('cell-menu');
        });
      });
    });
  }
  const phone = window.matchMedia('(max-width: 600px)');
  function fitTables() {
    document.querySelectorAll('#app table.has-labels').forEach((tbl) => {
      tbl.classList.remove('as-cards');
      if (!phone.matches) return;
      const box = tbl.closest('.table-wrap, .table-scroll') || tbl.parentElement;
      if (tbl.scrollWidth > box.clientWidth + 2) tbl.classList.add('as-cards');
    });
  }
  let fitTimer = null;
  window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitTables, 150); });
  // When the sidebar has to scroll, keep the section or room you're on in view.
  // (Only the sidebar's own scroll position changes, never the page's.)
  function keepActiveInView() {
    const box = document.querySelector('.sidebar-scroll');
    if (!box || box.scrollHeight <= box.clientHeight) return;
    const active = box.querySelector('.room-row.active') || box.querySelector('.side-link.active') || box.querySelector('.building-row.active');
    if (!active) return;
    const b = box.getBoundingClientRect(); const a = active.getBoundingClientRect();
    if (a.top < b.top) box.scrollTop -= b.top - a.top + 8;
    else if (a.bottom > b.bottom) box.scrollTop += a.bottom - b.bottom + 8;
  }

  // ---------- fewer buttons on screen ----------
  function buttonsOnly(box) { const kids = [...box.children]; return kids.length && kids.every((el) => el.tagName === 'BUTTON') ? kids : null; }
  function menuFor(buttons, { text, label: aria, cls }) {
    const menu = document.createElement('details');
    menu.className = `more-menu ${cls}`;
    const summary = document.createElement('summary');
    summary.className = `btn ${cls === 'page-more' ? '' : 'small'} secondary more-btn`;
    summary.textContent = text;
    summary.setAttribute('aria-label', aria);
    summary.title = aria;
    const list = document.createElement('div');
    list.className = 'more-list';
    buttons.forEach((b) => list.appendChild(b));
    menu.appendChild(summary);
    // The list floats above the page (tables scroll sideways and cards blur
    // their background, so it can't sit inside them). It stays inside #app so
    // its buttons work like any other.
    menu.addEventListener('toggle', () => {
      if (menu.open) { closeMenus(menu); (document.getElementById('app') || document.body).appendChild(list); placeMenu(summary, list); }
      else list.remove();
    });
    return menu;
  }
  const isMain = (b) => !b.classList.contains('secondary') && !b.classList.contains('danger');
  function compactButtons(root) {
    if (!root) return;
    // Tables: rows whose buttons are all secondary get one "⋯" menu. Once any
    // row in a table has a menu, single buttons in that table go in one too,
    // so the column looks the same on every row. A main (filled) first
    // button, like "Find match", stays in view.
    root.querySelectorAll('table').forEach((tbl) => {
      const rows = [...tbl.querySelectorAll(':scope > tbody > tr > td > .row-actions')].map((box) => ({ box, buttons: buttonsOnly(box) })).filter((r) => r.buttons);
      const anyMenu = rows.some((r) => !isMain(r.buttons[0]) && r.buttons.length >= 2);
      rows.forEach(({ box, buttons }) => {
        if (!isMain(buttons[0]) && (buttons.length >= 2 || anyMenu)) box.appendChild(menuFor(buttons, { text: '⋯', label: 'Actions', cls: 'row-more' }));
        else if (buttons.length >= 3) box.appendChild(menuFor(buttons.slice(1), { text: '⋯', label: 'More actions', cls: 'row-more' }));
      });
    });
    // Other button rows with three or more keep the first and put the rest in "⋯".
    root.querySelectorAll('.row-actions').forEach((box) => {
      if (box.closest('td')) return;
      const buttons = buttonsOnly(box);
      if (buttons && buttons.length >= 3) box.appendChild(menuFor(buttons.slice(1), { text: '⋯', label: 'More actions', cls: 'row-more' }));
    });
    // Page headers with three or more buttons keep the first and put the rest under "More".
    root.querySelectorAll('.page-actions').forEach((box) => {
      const buttons = buttonsOnly(box);
      if (buttons && buttons.length >= 3) box.appendChild(menuFor(buttons.slice(1), { text: 'More ▾', label: 'More actions', cls: 'page-more' }));
    });
  }
  function placeMenu(summary, list) {
    const r = summary.getBoundingClientRect();
    const w = list.offsetWidth; const ht = list.offsetHeight;
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w));
    // Stay clear of the phone's bottom tab bar.
    const bar = document.querySelector('.mnav');
    const floor = window.innerHeight - (bar && bar.offsetParent ? bar.offsetHeight + 16 : 0) - 8;
    let top = r.bottom + 6;
    if (top + ht > floor) top = Math.max(8, r.top - ht - 6);
    list.style.left = `${left}px`; list.style.top = `${top}px`;
  }
  function closeMenus(except) { document.querySelectorAll('details.more-menu[open]').forEach((m) => { if (m !== except) m.open = false; }); }
  document.addEventListener('click', (e) => {
    if (e.target.closest('.more-list button')) return closeMenus();
    if (!e.target.closest('.more-list')) closeMenus(e.target.closest('details.more-menu'));
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
  window.addEventListener('scroll', (e) => { if (!e.target.closest?.('.more-list')) closeMenus(); }, { passive: true, capture: true });
  window.addEventListener('resize', () => closeMenus());
  async function ask(message) {
    const out = await api('POST', '/api/assistant/chat', { message });
    if (out.notice) toast(out.notice, true);
  }
  X.submits['ai-chat'] = async (data) => { await ask(data.message); };
  X.actions['ai-ask'] = async (el) => { await ask(el.dataset.q); };
  X.actions['ai-clear'] = async () => { await api('DELETE', '/api/assistant/history'); };
  X.actions['ai-approve'] = async (el) => {
    if (!(await confirmDialog('This will be carried out now and recorded in the audit log.', { title: 'Approve this proposal?', confirmLabel: 'Approve' }))) return false;
    const a = await api('POST', `/api/assistant/actions/${el.dataset.id}/approve`, {});
    toast(a.type === 'send_reminders' ? `${a.result.queued} message(s) sent to the outbox for delivery` : 'Done');
  };
  X.actions['ai-reject'] = async (el) => { await api('POST', `/api/assistant/actions/${el.dataset.id}/reject`, {}); toast('Proposal rejected'); };
  X.actions['ai-msg-save'] = async (el) => {
    const body = document.querySelector(`[data-ai-msg="${el.dataset.id}:${el.dataset.index}"]`).value;
    await api('PUT', `/api/assistant/actions/${el.dataset.id}`, { messages: [{ index: Number(el.dataset.index), body }] });
    state.forms[`aimsg-${el.dataset.id}-${el.dataset.index}`] = false;
  };
  X.actions['ai-msg-toggle'] = async (el) => { await api('PUT', `/api/assistant/actions/${el.dataset.id}`, { messages: [{ index: Number(el.dataset.index), include: el.dataset.include === '1' }] }); };
  X.submits['ai-expense-edit'] = async (data, form) => { await api('PUT', `/api/assistant/actions/${form.dataset.id}`, data); toast('Proposal updated'); };
  X.submits['ai-maint-edit'] = async (data, form) => { await api('PUT', `/api/assistant/actions/${form.dataset.id}`, data); toast('Proposal updated'); };

  // ---------- insights ----------
  X.loaders.insights = async () => { [d.cash, d.alerts] = await Promise.all([api('GET', '/api/insights/cashflow'), api('GET', '/api/insights/anomalies')]); };
  X.views.insights = () => {
    const c = d.cash; const a = d.alerts;
    if (!c) return page('Insights', 'Loading…');
    const f = c.forecast;
    return `${page('Insights', 'Trends, plus an estimate for next month.')}
      <div class="two-col"><div>${card('Facts (today)', `<div class="mini-stats"><div><span>Outstanding</span><strong>${money(c.facts.outstanding)}</strong></div><div><span>Overdue</span><strong class="${c.facts.overdue ? 'is-due' : ''}">${money(c.facts.overdue)}</strong></div><div><span>Avg. monthly expenses</span><strong>${money(c.facts.averageMonthlyExpenses)}</strong></div></div>
        ${table(['Month', 'Billed', 'Collected', 'Rate'], c.facts.collectionHistory.map((m) => [h(m.month), money(m.billed), money(m.collected), m.rate === null ? '–' : `${m.rate}%`]))}`)}</div>
      <div>${card(`Forecast for ${h(f.month)} <small>estimate</small>`, `<div class="mini-stats"><div><span>Expected rent</span><strong>${money(f.expectedRent)}</strong></div><div><span>Likely collection</span><strong>${money(f.projectedCollection)}</strong></div><div><span>Net after typical expenses</span><strong class="${f.projectedNet < 0 ? 'is-due' : ''}">${money(f.projectedNet)}</strong></div></div>
        <p>Collection trend: <b>${h(f.collectionTrend)}</b>${f.possibleShortfall ? ' · <b class="is-due">possible shortfall</b>' : ''}</p><h4>Assumptions</h4><ul>${f.assumptions.map((x) => `<li>${h(x)}</li>`).join('')}</ul>`, 'forecast')}
      ${c.facts.leasesEndingWithin60Days.length ? card('Leases ending within 60 days', table(['Tenant', 'Room', 'Ends', 'Days left'], c.facts.leasesEndingWithin60Days.map((l) => [h(l.tenantName), h(l.roomLabel), h(l.endDate), l.daysLeft]))) : ''}</div></div>
      ${card(`Review alerts <small>${a.alerts.length}</small>`, `${a.alerts.length ? `<ul class="alerts">${a.alerts.map((x) => `<li class="${x.severity}"><b>${h(x.title)}</b><div>${h(x.detail)}</div></li>`).join('')}</ul>` : '<p class="muted">Nothing unusual found.</p>'}<p class="basis-note">${h(a.note)}</p>`)}`;
  };

  // ---------- notifications (staff) ----------
  X.loaders.notifications = async () => { d.notes = await api('GET', '/api/notifications'); };
  const noteLink = (link) => {
    const [view, id] = String(link || '').split(':');
    if (view === 'maintenance' && id) return `data-action="note-go" data-view="maintenance" data-id="${h(id)}"`;
    if (view === 'tenant' && id) return `data-nav="tenancy" data-id="${h(id)}"`;
    return '';
  };
  X.views.notifications = () => {
    const n = d.notes || { items: [] };
    return `${page('Notifications', `${n.unread} unread`, n.unread ? '<button class="btn secondary" data-action="notes-read">Mark all read</button>' : '')}
      ${card('', n.items.length ? `<ul class="note-list">${n.items.map((x) => `<li class="${x.read ? '' : 'unread'}" ${noteLink(x.link)}><b>${h(x.title)}</b><div>${h(x.body)}</div><small class="muted">${h(x.createdAt.slice(0, 16).replace('T', ' '))}</small></li>`).join('')}</ul>` : empty('No notifications yet.'))}`;
  };
  X.actions['notes-read'] = async () => { await api('POST', '/api/notifications/read-all', {}); };
  X.actions['note-go'] = (el) => { state.view = el.dataset.view; state.params = { id: el.dataset.id }; s.maint.id = el.dataset.id; };

  // ---------- settings, team, audit, backups ----------
  X.loaders.settings = async () => {
    const tab = s.settings.tab;
    d.org = await api('GET', '/api/org');
    if (tab === 'org' && can('assistant.use')) d.aiStatus = await api('GET', '/api/assistant/status').catch(() => null);
    if (tab === 'team' && isOwner()) d.team = await api('GET', '/api/team');
    if (tab === 'audit' && isOwner()) d.audit = await api('GET', '/api/audit?limit=200');
    if (tab === 'data' && isOwner()) d.backups = await api('GET', '/api/admin/backups');
  };
  X.views.settings = () => {
    const tab = s.settings.tab;
    const tabs = [['org', 'Organisation'], ...(isOwner() ? [['team', 'Team'], ['audit', 'Audit log'], ['data', 'Backups']] : [])];
    const o = d.org || { settings: {} };
    let body = '';
    if (tab === 'org') {
      const dis = isOwner() ? '' : 'disabled';
      const ai = d.aiStatus;
      body = card('Organisation', `<form data-submit="org-save"><div class="form-grid cols-3">
          ${field('Name', `<input name="name" maxlength="120" value="${h(o.name)}" ${dis}>`)}
          ${field('Time zone', `<input name="timeZone" value="${h(o.timeZone)}" ${dis} placeholder="Asia/Kolkata">`)}
          ${field('Default language for tenants', `<select name="defaultLanguage" ${dis}>${opt('en', 'English', o.defaultLanguage)}${opt('hi', 'हिन्दी (Hindi)', o.defaultLanguage)}</select>`)}
          ${field('Receipt footer', `<input name="footer" maxlength="300" value="${h(o.settings.receipts?.footer || '')}" ${dis} placeholder="e.g. Thank you!">`, 'span 2')}
          ${field('Anonymise former tenants after (days, 0 = never)', `<input type="number" name="retentionDays" min="0" max="3650" value="${o.settings.retention?.anonymizeFormerTenantsAfterDays ?? 0}" ${dis}>`)}
          ${field('How to pay (printed on bills)', `<textarea name="paymentDetails" rows="3" maxlength="600" ${dis} placeholder="UPI: yourname@upi&#10;Bank: name, account number, IFSC">${h(o.settings.bills?.paymentDetails || '')}</textarea>`, '1 / -1')}
        </div>
        <fieldset class="ai-setting"><legend>Rent Ledger AI</legend>
          <label class="check"><input type="checkbox" name="aiEnabled" ${o.settings.assistant?.aiEnabled ? 'checked' : ''} ${dis || (ai && !ai.ai.configured ? 'disabled' : '')}> Use the AI model for the assistant</label>
          <p class="profile-note">${ai?.ai.configured ? `Provider: <b>${h(ai.ai.provider)}</b> (${h(ai.ai.model)}). ` : 'No AI provider is set up on the server, so the assistant uses basic mode. '}When AI is on, your questions and the figures it looks up are sent to the provider. Phone numbers, emails, ID numbers and documents are never sent.</p>
        </fieldset>
        ${isOwner() ? '<div class="form-actions"><button class="btn" type="submit">Save</button></div>' : '<p class="profile-note">Only the owner can change organisation settings.</p>'}</form>`)
        + `<div class="two-col">${card('Language', `<p class="profile-note">For your screens on this device.</p>${window.RL_I18N ? RL_I18N.picker() : ''}`)}${typeof themePicker === 'function' ? themePicker() : ''}</div>`
        + (isOwner() && cache.dashboard && !cache.dashboard.onlinePaymentsEnabled ? card('Online payments', '<p class="profile-note">Tenants can’t pay online yet. To show a Pay button on their bills, add your Razorpay keys (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET) to the server settings in Railway.</p>') : '');
    } else if (tab === 'team') {
      const t = d.team || { members: [], invites: [] };
      body = card('Team', `${table(['Name', 'Contact', 'Role', 'Since', ''], t.members.map((m) => [h(m.name), h(m.contact), `${h(label(m.role))}${m.disabled ? ` ${stamp('void')}` : ''}`, h(m.createdAt.slice(0, 10)), m.role === 'manager' && !m.disabled ? `<button class="btn small danger" data-action="team-disable" data-id="${m.id}">Remove access</button>` : '']))}
        <h4>Pending invites</h4>${table(['Name', 'Expires', ''], t.invites.map((i) => [h(i.name), h(i.expires_at.slice(0, 10)), `<button class="btn small secondary" data-action="team-cancel-invite" data-id="${i.id}">Cancel</button>`]), { emptyText: 'No pending invites.' })}
        <form data-submit="team-invite"><h4>Invite a property manager</h4><div class="form-grid cols-3">${field('Name *', '<input name="name" required maxlength="120">')}${field('Their mobile or email *', '<input name="contact" required maxlength="200">')}<div class="form-actions"><button class="btn" type="submit">Create invite</button></div></div>
        <p class="profile-note">Managers can run day-to-day work (tenants, bills, payments, maintenance, reminders, reports) but can’t reverse payments, void or waive bills, settle deposits, manage the team, export data or see the audit log.</p></form>`);
    } else if (tab === 'audit') {
      body = card('Audit log <small>latest 200</small>', `<div class="form-actions"><button class="btn small secondary" data-action="download" data-url="/api/audit?format=csv&limit=1000" data-name="audit-log.csv">Download CSV</button></div>${table(['When', 'Who', 'Action', 'Record', 'Details'], (d.audit || []).map((a) => [h(a.at.slice(0, 16).replace('T', ' ')), `${h(a.actor)} <small class="muted">${h(a.role || '')}</small>`, h(a.action), h(a.entityType || ''), `<code class="details">${h(JSON.stringify(a.details).slice(0, 220))}</code>`]))}`);
    } else if (tab === 'data') {
      body = card('Backups', `<p class="profile-note">The server keeps automatic database backups (at every start-up and once a day). You can also make one now, or download all your records.</p><div class="form-actions"><button class="btn" data-action="backup-now">Back up now</button><button class="btn secondary" data-action="download-backup">Download all records (JSON)</button></div>${table(['Backup', 'Time'], (d.backups || []).map((b) => [h(b.name), h(b.at.slice(0, 16).replace('T', ' '))]), { emptyText: 'No backups yet.' })}<p class="profile-note">The download contains tenants’ personal details. Keep it private. Uploaded documents are not included.</p>`);
    }
    return `${page('Settings', '')}<div class="tab-row">${tabs.map(([k, t]) => `<button class="tab-btn ${tab === k ? 'active' : ''}" data-action="set-state" data-key="settings.tab" data-value="${k}">${t}</button>`).join('')}</div>${body}`;
  };
  X.submits['org-save'] = async (data) => {
    const body = { name: data.name, timeZone: data.timeZone, defaultLanguage: data.defaultLanguage, settings: { receipts: { footer: data.footer }, bills: { paymentDetails: data.paymentDetails || '' }, retention: { anonymizeFormerTenantsAfterDays: Number(data.retentionDays) || 0 }, assistant: { aiEnabled: data.aiEnabled === 'on' } } };
    if (data.aiEnabled === 'on' && !d.org.settings.assistant?.aiEnabled && !(await confirmDialog('Questions and the figures the assistant looks up will be sent to the AI provider configured on your server.', { title: 'Turn on AI?', confirmLabel: 'Turn on' }))) return false;
    await api('PUT', '/api/org', body); toast('Settings saved');
  };
  X.submits['team-invite'] = async (data) => {
    const r = await api('POST', '/api/team/invites', data);
    const msg = `You're invited to manage properties on Rent Ledger${isMobileApp ? '' : ` at ${location.origin}`}. Sign up as a manager with ${r.contact} and invite code ${r.code}. It expires on ${displayDate(r.expiresAt)}.`;
    if (await confirmDialog(`Invite code ${r.code}. It works once, for ${r.contact}, until ${displayDate(r.expiresAt)}. It won't be shown again.`, { title: 'Invite created', confirmLabel: 'Copy invite message' })) await copyText(msg);
  };
  X.actions['team-cancel-invite'] = async (el) => { await api('DELETE', `/api/team/invites/${el.dataset.id}`); toast('Invite cancelled'); };
  X.actions['team-disable'] = async (el) => {
    if (!(await confirmDialog('They are signed out everywhere and can no longer sign in. Their past actions stay in the audit log.', { title: 'Remove this manager’s access?', confirmLabel: 'Remove access', danger: true }))) return false;
    await api('POST', `/api/team/members/${el.dataset.id}/disable`, {}); toast('Access removed');
  };
  X.actions['backup-now'] = async () => { const r = await api('POST', '/api/admin/backups', {}); toast(`Backup created: ${r.name}`); };

  // ---------- tenancy: move-in/out, deposit, settlement ----------
  X.loaders.tenancy = async () => { d.tenancy = state.params?.id ? await api('GET', `/api/tenants/${state.params.id}/tenancy`) : null; };
  X.views.tenancy = () => {
    const t = d.tenancy;
    if (!t) return page('Tenancy', 'Choose a tenant from a room or from Finance → Tenant balances.');
    const tenant = cache.tenants.find((x) => x.id === t.tenantId) || { name: 'Tenant' };
    const room = cache.rooms.find((r) => r.id === tenant.roomId);
    const b = room && cache.buildings.find((x) => x.id === room.buildingId);
    const dep = t.deposit;
    const recordForm = (type) => {
      const r = t.records[type] || { checklist: t.defaultChecklists[type].map((item) => ({ item, done: false })), meterReadings: {}, keysCount: 0, conditionNotes: '', recordDate: '', proposedDate: '' };
      return `<form data-submit="move-record" data-type="${type}"><div class="form-grid cols-3">
        ${field(type === 'move_in' ? 'Move-in date' : 'Move-out date', `<input type="date" name="recordDate" value="${h(r.recordDate)}">`)}
        ${type === 'move_out' ? field('Proposed / notice date', `<input type="date" name="proposedDate" value="${h(r.proposedDate)}">`) : ''}
        ${field('Keys', `<input type="number" name="keysCount" min="0" max="50" value="${r.keysCount}">`)}
        ${field('Electricity meter reading', `<input type="number" step="0.01" name="m-electricity" value="${h(r.meterReadings.electricity ?? '')}">`)}
        ${field('Gas meter reading', `<input type="number" step="0.01" name="m-gas" value="${h(r.meterReadings.gas ?? '')}">`)}
        ${field('Water meter reading', `<input type="number" step="0.01" name="m-water" value="${h(r.meterReadings.water ?? '')}">`)}
        ${field('Condition notes', `<textarea name="conditionNotes" rows="2" maxlength="3000">${h(r.conditionNotes)}</textarea>`, '1 / -1')}
        <fieldset class="check-group checklist" style="grid-column:1/-1"><legend>Checklist</legend>${r.checklist.map((c, i) => `<label class="check"><input type="checkbox" name="c-${i}" ${c.done ? 'checked' : ''}><input type="hidden" name="ci-${i}" value="${h(c.item)}"> ${h(c.item)}</label>`).join('')}</fieldset>
      </div><div class="form-actions"><button class="btn small" type="submit">Save</button></div></form>
      ${t.records[type] ? `<div class="docs">${t.records[type].photos.map((p) => `<button class="link-btn" data-action="open-doc" data-id="${p.id}">📷 ${h(p.originalName)}</button>`).join(' ')}</div><form class="inline-form" data-submit="move-photo" data-id="${t.records[type].id}"><input type="file" name="file" accept="image/*,application/pdf" required><label class="check"><input type="checkbox" name="visible" checked> Tenant can see</label><button class="btn small secondary" type="submit">Add photo</button></form>` : '<p class="profile-note">Save the record first to add photos.</p>'}`;
    };
    const st = t.settlement;
    const deductions = X.dedRows || st?.deductions?.map((x) => ({ reason: x.reason, amount: x.amount })) || [];
    if (!X.dedRows) X.dedRows = deductions;
    const settlementBody = st && st.status !== 'draft'
      ? `<table class="ledger settle"><tbody><tr><td>Deposit held</td><td>${money(st.depositHeld)}</td></tr><tr><td>Less: dues</td><td>− ${money(st.outstandingDues)}</td></tr>${st.deductions.map((x) => `<tr><td>Less: ${h(x.reason)}</td><td>− ${money(x.amount)}</td></tr>`).join('')}<tr class="total"><td>Refund due to tenant</td><td>${money(st.refund)}</td></tr>${st.tenantOwesAfterDeposit ? `<tr><td>Still owed by tenant</td><td class="is-due">${money(st.tenantOwesAfterDeposit)}</td></tr>` : ''}</tbody></table>
        <p>Status: ${stamp(st.status)}${st.refundedAt ? ` · refunded ${h(st.refundedAt.slice(0, 10))} by ${h(label(st.refundMethod))}${st.refundReference ? ` (${h(st.refundReference)})` : ''}` : ''}</p>
        ${st.status === 'agreed' && isOwner() ? `<form data-submit="settle-refund" class="inline-form"><select name="method">${[['upi', 'UPI'], ['bank_transfer', 'Bank transfer'], ['cash', 'Cash'], ['cheque', 'Cheque']].map(([v, x]) => opt(v, x)).join('')}</select><input name="reference" maxlength="120" placeholder="Reference"><input type="date" name="date" value="${today()}"><button class="btn small" type="submit">Record refund of ${money(st.refund)}</button></form>` : ''}
        <button class="btn small secondary" data-action="open-page" data-url="/api/tenants/${t.tenantId}/settlement/statement">Settlement statement</button>`
      : `<form data-submit="settle-draft"><table class="ledger settle"><tbody><tr><td>Deposit held</td><td>${money(dep.held)}</td></tr><tr><td>Dues today (net of credit)</td><td>${money(Math.max(t.balance.netDue ?? t.balance.outstanding, 0))}</td></tr></tbody></table>
        <h4>Deductions (damage, cleaning, etc.)</h4>${deductions.map((x, i) => `<div class="inline-form"><input name="d-reason-${i}" maxlength="200" placeholder="Reason" value="${h(x.reason)}"><input name="d-amount-${i}" type="number" step="0.01" min="0.01" placeholder="₹" value="${h(x.amount)}"><button class="btn small secondary" type="button" data-action="ded-remove" data-index="${i}">Remove</button></div>`).join('')}
        <button class="btn small secondary" type="button" data-action="ded-add">+ Add deduction</button>
        ${field('Notes', `<textarea name="notes" rows="2" maxlength="2000">${h(st?.notes || '')}</textarea>`)}
        <div class="form-actions"><button class="btn small" type="submit">${st ? 'Update draft' : 'Prepare settlement'}</button>${st && isOwner() ? '<button class="btn small" type="button" data-action="settle-agree">Agree settlement</button>' : ''}${st ? `<button class="btn small secondary" type="button" data-action="open-page" data-url="/api/tenants/${t.tenantId}/settlement/statement">Preview statement</button>` : ''}</div>
        ${st ? `<p>Draft: refund <b>${money(st.refund)}</b>${st.tenantOwesAfterDeposit ? `, tenant still owes <b class="is-due">${money(st.tenantOwesAfterDeposit)}</b>` : ''}.</p>` : ''}
        <p class="profile-note">Nothing is deducted until the owner agrees. Agreeing turns deductions into damage bills, uses the deposit to pay what’s owed (recorded in the ledger) and fixes the refund. This is a record of what was agreed, not a legal determination.</p></form>`;
    return `${page(`${tenant.name}`, `${h(b?.name || '')} ${h(room?.label || '')} · ${t.active ? 'current tenant' : 'moved out'}`, `<button class="btn secondary" data-action="open-page" data-url="/api/ledger/tenants/${t.tenantId}/statement?format=html">Statement</button>${room ? `<button class="btn secondary" data-nav="room" data-id="${room.id}">Room</button>` : ''}`)}
      <div class="stat-grid"><div class="stat-card"><div class="stat-label">Outstanding</div><div class="stat-value">${money(t.balance.outstanding)}</div></div><div class="stat-card warn"><div class="stat-label">Overdue</div><div class="stat-value">${money(t.balance.overdue)}</div></div><div class="stat-card good"><div class="stat-label">Credit</div><div class="stat-value">${money(t.balance.credit)}</div></div><div class="stat-card"><div class="stat-label">Deposit held</div><div class="stat-value">${money(dep.held)}</div></div></div>
      <div class="two-col"><div>
        ${card(`Security deposit <small>agreed ${money(t.agreedDeposit)}</small>`, `${table(['Date', 'Type', 'Amount', 'Method', 'Ref'], dep.transactions.map((x) => [h(x.date), h(label(x.type)), money(x.amount), h(x.method), h(x.reference)]), { emptyText: 'No deposit recorded yet.' })}
          <form class="inline-form" data-submit="deposit-record"><select name="type">${opt('received', 'Received')}${isOwner() ? opt('refunded', 'Refunded') : ''}</select><input name="amount" type="number" step="0.01" min="0.01" required placeholder="₹ amount" value="${!dep.received ? t.agreedDeposit || '' : ''}"><input type="date" name="date" value="${today()}"><input name="method" maxlength="40" placeholder="Method"><input name="reference" maxlength="120" placeholder="Reference"><button class="btn small" type="submit">Record</button></form>
          <p class="profile-note">Deposits are held money, kept separate from rent income.</p>`)}
        ${card('Move-in record', recordForm('move_in'))}
        ${t.active && tenant.id ? card('Reminder consent', `<form data-submit="tenant-consent"><div class="form-grid">${field('Email', `<input name="email" type="email" value="${h(tenant.email || '')}">`, '1 / -1')}</div>
          <fieldset class="check-group"><legend>The tenant agreed to receive reminders by</legend><label class="check"><input type="checkbox" name="notifyEmail" ${tenant.notifyEmail ? 'checked' : ''}> Email</label><label class="check"><input type="checkbox" name="notifySms" ${tenant.notifySms ? 'checked' : ''}> SMS</label><label class="check"><input type="checkbox" name="notifyWhatsapp" ${tenant.notifyWhatsapp ? 'checked' : ''}> WhatsApp</label></fieldset>
          <p class="profile-note">Only tick a channel if the tenant has agreed to it. They can change this themselves in their portal.</p><div class="form-actions"><button class="btn small" type="submit">Save</button></div></form>`) : ''}
      </div><div>
        ${card('Move-out record', recordForm('move_out'))}
        ${card('Deposit settlement', settlementBody)}
      </div></div>`;
  };
  X.submits['move-record'] = async (data, form) => {
    const checklist = [];
    for (let i = 0; data[`ci-${i}`] !== undefined; i++) checklist.push({ item: data[`ci-${i}`], done: data[`c-${i}`] === 'on' });
    await api('PUT', `/api/tenants/${state.params.id}/move-records/${form.dataset.type}`, { recordDate: data.recordDate, proposedDate: data.proposedDate, keysCount: data.keysCount, conditionNotes: data.conditionNotes, meterReadings: { electricity: data['m-electricity'], gas: data['m-gas'], water: data['m-water'] }, checklist });
    toast('Record saved');
  };
  X.submits['tenant-consent'] = async (data) => { await api('PUT', `/api/tenants/${state.params.id}`, { email: data.email, notifyEmail: data.notifyEmail === 'on', notifySms: data.notifySms === 'on', notifyWhatsapp: data.notifyWhatsapp === 'on' }); toast('Reminder consent saved'); };
  X.submits['move-photo'] = async (data, form) => { const up = await readFile(form.querySelector('input[type=file]').files[0], { types: UPLOAD_TYPES }); await api('POST', '/api/documents', { entityType: 'move_record', entityId: form.dataset.id, kind: 'photo', visibleToTenant: data.visible === 'on', ...up }); toast('Photo added'); };
  X.submits['deposit-record'] = async (data) => { await api('POST', `/api/tenants/${state.params.id}/deposit`, data); toast('Deposit entry recorded'); };
  function readDeductions() {
    const form = document.querySelector('form[data-submit="settle-draft"]');
    if (!form) return;
    const data = Object.fromEntries(new FormData(form));
    X.dedRows = X.dedRows.map((x, i) => ({ reason: data[`d-reason-${i}`] ?? x.reason, amount: data[`d-amount-${i}`] ?? x.amount }));
  }
  X.actions['ded-add'] = () => { readDeductions(); X.dedRows.push({ reason: '', amount: '' }); };
  X.actions['ded-remove'] = (el) => { readDeductions(); X.dedRows.splice(Number(el.dataset.index), 1); };
  X.submits['settle-draft'] = async (data) => {
    readDeductions();
    const deductions = X.dedRows.filter((x) => String(x.reason).trim() || x.amount).map((x) => ({ reason: x.reason, amount: x.amount }));
    await api('PUT', `/api/tenants/${state.params.id}/settlement`, { deductions, notes: data.notes });
    X.dedRows = null; toast('Settlement draft saved');
  };
  X.actions['settle-agree'] = async () => {
    const st = d.tenancy.settlement;
    if (!(await confirmDialog(`Deductions become damage bills, the deposit pays what is owed, and the refund is fixed at ${money(st.refund)}. This can't be undone.`, { title: 'Agree this settlement?', confirmLabel: 'Agree settlement', danger: true }))) return false;
    await api('POST', `/api/tenants/${state.params.id}/settlement/agree`, {}); X.dedRows = null; toast('Settlement agreed');
  };
  X.submits['settle-refund'] = async (data) => { await api('POST', `/api/tenants/${state.params.id}/settlement/refund`, data); toast('Refund recorded'); };
  X.onNavigate = () => { X.dedRows = null; d.maintDetail = null; s.maint.id = state.params?.id && state.view === 'maintenance' ? state.params.id : null; };

  // Extra links on the room's tenant tab.
  X.tenantLinks = (tenant) => `<div class="card quick-links"><h3>More for ${h(tenant.name)}</h3><div class="row-actions">
    <button class="btn small" data-nav="tenancy" data-id="${tenant.id}">Tenancy, deposit & move-out</button>
    ${can('reports.view') ? `<button class="btn small secondary" data-action="open-page" data-url="/api/ledger/tenants/${tenant.id}/statement?format=html">Statement</button><button class="btn small secondary" data-action="ledger-tenant" data-id="${tenant.id}">Bills</button>` : ''}
    ${can('leases.manage') ? '<button class="btn small secondary" data-nav="leases">Leases</button>' : ''}</div></div>`;

  // ---------- tenant portal additions ----------
  X.tenantNav = () => {
    const items = [['home', 'Home'], ['maintenance', 'Maintenance'], ['documents', 'Documents'], ['messages', 'Messages'], ['notifications', 'Notifications'], ['profile', 'My profile']];
    return `<nav class="tenant-nav" aria-label="Sections">${items.map(([k, t]) => `<button type="button" class="${state.tenantView === k ? 'active' : ''}" data-tenant-nav="${k}">${h(t)}${k === 'notifications' && X.tenantUnread ? ` <span class="nav-count">${X.tenantUnread}</span>` : ''}</button>`).join('')}</nav>`;
  };
  X.beforeTenantRender = async () => {
    try { X.tenantUnread = (await api('GET', '/api/notifications')).unread; } catch { X.tenantUnread = 0; }
    if (state.tenantView === 'home') { try { d.tReceipts = await api('GET', '/api/tenant/receipts'); } catch { d.tReceipts = []; } }
    if (X.tenantLoaders[state.tenantView]) await X.tenantLoaders[state.tenantView]();
  };
  X.tenantHomeExtras = (p) => {
    const b = p.balance || {};
    const upcoming = (p.upcoming || []).map((u) => [h(u.label), h(u.dueDate), money(u.amount), u.overdue ? stamp('overdue') : stamp('due')]);
    const other = (p.other || []).filter((o) => o.status !== 'void').slice(0, 10).map((o) => [h(o.description || label(o.kind)), h(o.dueDate || ''), money(o.amount), money(o.outstanding), stamp(o.status)]);
    const receipts = (d.tReceipts || []).slice(0, 10).map((r) => [h(r.receivedOn), money(r.amount), h(label(r.method)), r.reversed ? stamp('void') : stamp(r.verification), `<button class="btn small secondary" data-action="open-page" data-url="/api/ledger/payments/${r.id}/receipt">Receipt</button>`]);
    const lease = p.lease ? `<article class="card"><h3>Your lease</h3><p>${h(p.lease.startDate)} → ${h(p.lease.endDate || 'no end date')} · rent ${money(p.lease.rent)} (${h(label(p.lease.frequency))}), due on day ${p.lease.dueDay}</p></article>` : '';
    return `<section class="tenant-balance"><div><span>Total outstanding</span><strong class="${b.outstanding ? 'is-due' : ''}">${money(b.outstanding)}</strong></div><div><span>Overdue</span><strong class="${b.overdue ? 'is-due' : ''}">${money(b.overdue)}</strong></div><div><span>Credit</span><strong>${money(b.credit)}</strong></div><div><button class="btn secondary" data-action="open-page" data-url="/api/tenant/statement?format=html">Download statement</button></div></section>
      <section class="tenant-bills">${card('Upcoming dues', table(['Bill', 'Due', 'Amount', ''], upcoming, { emptyText: 'Nothing due right now.' }))}${lease}
      ${other.length ? card('Other charges', table(['Charge', 'Due', 'Amount', 'Outstanding', 'Status'], other)) : ''}
      ${card('Payments & receipts', table(['Date', 'Amount', 'Method', 'Status', ''], receipts, { emptyText: 'No payments recorded yet.' }))}</section>`;
  };
  const tenantShell = (title, sub, body) => `<div class="tenant-shell"><header class="tenant-top"><div class="brand">Rent Ledger <span class="brand-mark">TENANT</span></div><div class="tenant-user">${window.RL_I18N ? RL_I18N.picker() : ''}${X.tenantBell()}<button class="logout" data-logout>Sign out</button></div></header><main class="tenant-main">${X.tenantNav()}<p class="kicker">${h(sub)}</p><h1>${h(title)}</h1>${body}</main></div>`;

  // Maintenance
  X.tenantLoaders.maintenance = async () => {
    if (s.tenantMaint.id) d.tMaintDetail = await api('GET', `/api/tenant/maintenance/${s.tenantMaint.id}`);
    else d.tMaint = await api('GET', '/api/tenant/maintenance');
  };
  X.tenantViews.maintenance = () => {
    if (s.tenantMaint.id && d.tMaintDetail) {
      const r = d.tMaintDetail;
      return tenantShell(r.title, 'MAINTENANCE', `<button class="btn small secondary" data-action="tmaint-back">← Your requests</button>
        ${card(`Status: <span class="stamp m-${h(r.status)}">${h(r.statusLabel)}</span>`, `<p>${h(r.description)}</p>${r.assignedTo ? `<p class="muted">${h(r.assignedTo)}</p>` : ''}
          ${r.status === 'resolved' ? `<div class="form-actions"><button class="btn" data-action="tmaint-confirm" data-id="${r.id}" data-fixed="1">It’s fixed</button><button class="btn secondary" data-action="tmaint-confirm" data-id="${r.id}" data-fixed="0">Not fixed yet</button></div>` : ''}`)}
        ${card('Timeline', `<ol class="timeline">${r.timeline.map((e) => `<li><span class="when">${h(e.at.slice(0, 16).replace('T', ' '))}</span> <b>${h(e.by || label(e.role))}</b> ${e.type === 'status' ? `→ ${h(e.toLabel)}` : ''}${e.comment ? `<div>${h(e.comment)}</div>` : ''}</li>`).join('')}</ol>
          <form data-submit="tmaint-comment" data-id="${r.id}" class="inline-form"><input name="comment" required maxlength="2000" placeholder="Add a comment"><button class="btn small" type="submit">Send</button></form>`)}
        ${card('Photos', `${r.attachments.map((a) => `<button class="link-btn" data-action="open-doc" data-id="${a.id}">📎 ${h(a.originalName)}</button>`).join(' ') || '<p class="muted">None.</p>'}<form data-submit="tmaint-photo" data-id="${r.id}" class="inline-form"><input type="file" name="file" accept="image/*,application/pdf" required><button class="btn small secondary" type="submit">Add photo</button></form>`)}`);
    }
    const list = (d.tMaint || []).map((r) => [`<button class="link-btn" data-action="tmaint-open" data-id="${r.id}"><b>${h(r.title)}</b></button>`, h(label(r.category)), `<span class="stamp m-${h(r.status)}">${h(r.statusLabel)}</span>`, h(r.updatedAt.slice(0, 10))]);
    return tenantShell('Maintenance', 'REPAIRS & REQUESTS', `${card('New request', `<form data-submit="tmaint-create"><div class="form-grid cols-3">
        ${field('What needs fixing? *', '<input name="title" required maxlength="120" placeholder="e.g. Kitchen tap leaking">')}
        ${field('Category', `<select name="category">${MCAT.map((c) => opt(c, label(c), 'other')).join('')}</select>`)}
        ${field('How urgent?', `<select name="priority">${['low', 'normal', 'high', 'urgent'].map((p) => opt(p, label(p), 'normal')).join('')}</select>`)}
        ${field('Details *', '<textarea name="description" required rows="3" maxlength="2000"></textarea>', '1 / -1')}
        ${field('Photo (optional)', '<input type="file" name="file" accept="image/*,application/pdf">')}
      </div><div class="form-actions"><button class="btn" type="submit">Submit request</button></div></form>`)}
      ${card('Your requests', table(['Request', 'Category', 'Status', 'Updated'], list, { emptyText: 'No requests yet.' }))}`);
  };
  X.submits['tmaint-create'] = async (data, form) => {
    const file = form.querySelector('input[type=file]').files[0];
    const photos = file ? [await readFile(file, { types: UPLOAD_TYPES })] : [];
    const r = await api('POST', '/api/tenant/maintenance', { title: data.title, category: data.category, priority: data.priority, description: data.description, photos });
    s.tenantMaint.id = r.id; toast('Request sent to your owner');
  };
  X.submits['tmaint-comment'] = async (data, form) => { await api('POST', `/api/tenant/maintenance/${form.dataset.id}/comments`, data); toast('Comment sent'); };
  X.submits['tmaint-photo'] = async (data, form) => { const up = await readFile(form.querySelector('input[type=file]').files[0], { types: UPLOAD_TYPES }); await api('POST', `/api/tenant/maintenance/${form.dataset.id}/attachments`, up); toast('Photo added'); };
  X.actions['tmaint-open'] = (el) => { s.tenantMaint.id = el.dataset.id; };
  X.actions['tmaint-back'] = () => { s.tenantMaint.id = null; d.tMaintDetail = null; };
  X.actions['tmaint-confirm'] = async (el) => { await api('POST', `/api/tenant/maintenance/${el.dataset.id}/confirm`, { fixed: el.dataset.fixed === '1' }); toast(el.dataset.fixed === '1' ? 'Thanks! Request closed.' : 'Reopened. Your owner has been told.'); };

  // Documents
  X.tenantLoaders.documents = async () => { d.tDocs = await api('GET', '/api/tenant/documents'); };
  X.tenantViews.documents = () => tenantShell('Documents', 'SHARED WITH YOU', card('', table(['Document', 'Added', ''], (d.tDocs || []).map((doc) => [h(doc.originalName), h((doc.createdAt || '').slice(0, 10)), `<button class="btn small secondary" data-action="open-doc" data-id="${doc.id}">Open</button>`]), { emptyText: 'Your owner hasn’t shared any documents yet.' })));

  // Messages
  X.tenantLoaders.messages = async () => { d.tMsgs = await api('GET', '/api/tenant/messages'); };
  X.tenantViews.messages = () => tenantShell('Messages', 'YOUR OWNER', `<div class="card chat"><div class="chat-log" id="chat-log">${(d.tMsgs || []).map((m) => `<div class="chat-msg ${m.direction === 'to_owner' ? 'user' : 'bot'}"><div class="bubble">${h(m.body)}<small class="muted">${h(m.createdAt.slice(0, 16).replace('T', ' '))}</small></div></div>`).join('') || '<p class="muted">No messages yet.</p>'}</div>
    <form data-submit="tmsg-send" class="chat-form"><input name="body" required maxlength="2000" placeholder="Write to your owner"><button class="btn" type="submit">Send</button></form></div>`);
  X.submits['tmsg-send'] = async (data) => { await api('POST', '/api/tenant/messages', data); };

  // Notifications
  X.tenantLoaders.notifications = async () => { d.tNotes = await api('GET', '/api/notifications'); };
  X.tenantViews.notifications = () => {
    const n = d.tNotes || { items: [] };
    return tenantShell('Notifications', `${n.unread} UNREAD`, `${n.unread ? '<div class="form-actions"><button class="btn secondary" data-action="notes-read">Mark all read</button></div>' : ''}${card('', n.items.length ? `<ul class="note-list">${n.items.map((x) => `<li class="${x.read ? '' : 'unread'}"><b>${h(x.title)}</b><div>${h(x.body)}</div><small class="muted">${h(x.createdAt.slice(0, 16).replace('T', ' '))}</small></li>`).join('')}</ul>` : empty('No notifications yet.'))}`);
  };

  // Profile extras: language and reminder consent.
  X.tenantProfileExtras = (p) => `<article class="card profile-card"><h3>Language & reminders</h3><form data-submit="tenant-prefs"><div class="form-grid">
      ${field('Language', `<select name="language">${opt('en', 'English', p.account.language || 'en')}${opt('hi', 'हिन्दी', p.account.language)}</select>`)}
      ${field('Email for reminders', `<input name="email" type="email" value="${h(p.tenant.email || '')}">`)}
    </div><fieldset class="check-group"><legend>Reminders by email, SMS or WhatsApp</legend>
      <label class="check"><input type="checkbox" name="notifyEmail" ${p.tenant.notifyEmail ? 'checked' : ''}> Email reminders</label>
      <label class="check"><input type="checkbox" name="notifySms" ${p.tenant.notifySms ? 'checked' : ''}> SMS reminders</label>
      <label class="check"><input type="checkbox" name="notifyWhatsapp" ${p.tenant.notifyWhatsapp ? 'checked' : ''}> WhatsApp reminders</label></fieldset>
    <p class="profile-note">You can change this any time. In-app notifications are always on.</p><div class="form-actions"><button class="btn" type="submit">Save preferences</button></div></form></article>`;
  X.submits['tenant-prefs'] = async (data) => {
    const r = await api('PUT', '/api/account/preferences', { language: data.language, email: data.email, notifyEmail: data.notifyEmail === 'on', notifySms: data.notifySms === 'on', notifyWhatsapp: data.notifyWhatsapp === 'on' });
    if (window.RL_I18N && data.language !== RL_I18N.lang) { RL_I18N.setLanguage(data.language); }
    session.user.language = r.user.language;
    try { localStorage.setItem('rentLedgerSession', JSON.stringify(session)); } catch {}
    cache.tenantProfile = null;
    toast('Preferences saved');
  };

  // Tenant-side event delegation (the tenant shell has no global handlers).
  X.attachTenant = () => {
    const app = document.getElementById('app');
    app.onclick = async (e) => {
      const lang = e.target.closest('[data-lang-pick]');
      if (lang) return X.pickLanguage(lang.dataset.langPick);
      const toggle = e.target.closest('[data-toggle-form]');
      if (toggle) { state.forms[toggle.dataset.toggleForm] = !state.forms[toggle.dataset.toggleForm]; return render(); }
      const actionEl = e.target.closest('[data-action]');
      if (actionEl && X.actions[actionEl.dataset.action]) {
        return withBusy(actionEl, async () => {
          try { const r = await X.actions[actionEl.dataset.action](actionEl); if (r !== false) { cache.tenantLoadedAt = 0; await render(); } } catch (err) { toast(err.message, true); }
        });
      }
    };
    app.onsubmit = async (e) => {
      const form = e.target.closest('form[data-submit]');
      if (!form) return;
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"], button:not([type])');
      if (!X.submits[form.dataset.submit]) return withBusy(btn || form, () => handleSubmit(form));
      return withBusy(btn || form, async () => {
        try { const r = await X.submits[form.dataset.submit](Object.fromEntries(new FormData(form).entries()), form); if (r !== false) { cache.tenantLoadedAt = 0; await render(); } } catch (err) { toast(err.message, true); }
      });
    };
  };

  X.pickLanguage = async (lang) => {
    if (!window.RL_I18N || lang === RL_I18N.lang) return;
    RL_I18N.setLanguage(lang);
    if (session?.token) {
      try { const r = await api('PUT', '/api/account/preferences', { language: lang }); session.user.language = r.user.language; localStorage.setItem('rentLedgerSession', JSON.stringify(session)); } catch {}
    }
    ui.pageKey = null;
    await render();
    document.querySelectorAll('[data-lang-pick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.langPick === lang)));
  };
  // A signed-in user's saved language wins over this device's last choice.
  if (window.RL_I18N && session?.user?.language && session.user.language !== RL_I18N.lang) RL_I18N.setLanguage(session.user.language);
  document.addEventListener('click', (e) => {
    const lang = e.target.closest('[data-lang-pick]');
    if (lang && !document.querySelector('.tenant-shell')) X.pickLanguage(lang.dataset.langPick);
  });
})();
