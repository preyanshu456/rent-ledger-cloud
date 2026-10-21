// Rent Ledger — beds and occupancy, leads and bookings, the dues engine,
// WhatsApp reminders, the public property page, and the Hostel window.
//
// Built on the same hooks as modules.js (window.RL_EXT): views, loaders,
// actions, submits and changes, and the same api(), esc(), fmtMoney(),
// toast() and confirmDialog() helpers from app.js.
(() => {
  const X = window.RL_EXT;
  if (!X) return;
  const { s, d } = X;

  // ---------- helpers ----------
  const h = (v) => esc(v);
  const money = (v) => fmtMoney(v);
  const isOwner = () => session?.user?.role === 'owner';
  const can = (perm) => isOwner() || (session?.user?.role === 'manager' && (X.me?.permissions || []).includes(perm));
  const label = (str) => String(str || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const qs = (obj) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(obj)) if (v !== '' && v !== null && v !== undefined) p.set(k, v); const q = p.toString(); return q ? `?${q}` : ''; };
  const opt = (value, text, selected) => `<option value="${h(value)}" ${String(selected) === String(value) ? 'selected' : ''}>${h(text)}</option>`;
  const page = (title, sub, actions = '') => `<div class="page-head"><div><div class="page-title">${h(title)}</div>${sub ? `<div class="page-sub">${sub}</div>` : ''}</div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</div>`;
  const card = (title, body, extra = '') => `<article class="card ${extra}">${title ? `<h3>${title}</h3>` : ''}${body}</article>`;
  const field = (lbl, input, span = '') => `<div class="form-field" ${span ? `style="grid-column:${span}"` : ''}><label>${h(lbl)}</label>${input}</div>`;
  const table = (cols, rows, o) => X.helpers.table(cols, rows, o);
  const stamp = (status, text) => `<span class="stamp ${h(status)}">${h(text || label(status))}</span>`;
  const tabs = (view, key, items) => `<div class="tab-row" role="tablist">${items.map(([v, t, n]) => `<button type="button" class="tab-btn ${s[view][key] === v ? 'active' : ''}" data-action="set-state" data-key="${view}.${key}" data-value="${v}">${h(t)}${n ? ` <span class="nav-count">${n}</span>` : ''}</button>`).join('')}</div>`;
  const buildingOptions = (selected, blank) => `${blank ? `<option value="">${h(blank)}</option>` : ''}${(cache.buildings || []).filter((b) => b.status !== 'archived').map((b) => opt(b.id, b.name, selected)).join('')}`;
  const firstBuilding = () => (cache.buildings || []).find((b) => b.status !== 'archived')?.id || '';
  const tenantOptions = (selected, filter = () => true, blank = 'Choose tenant') => `<option value="">${h(blank)}</option>` + (cache.tenants || []).filter((t) => t.active && filter(t)).map((t) => {
    const room = cache.rooms.find((r) => r.id === t.roomId);
    return opt(t.id, `${t.name} · ${room?.label || ''}${t.bedLabel && (room?.bedCount || 1) > 1 ? ` ${t.bedLabel}` : ''}`, selected);
  }).join('');
  const tenantsOfBuilding = (buildingId) => (t) => cache.rooms.find((r) => r.id === t.roomId)?.buildingId === buildingId;
  const plus = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const nowLocal = () => { const n = new Date(); return new Date(n.getTime() - n.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
  const openLink = (url) => { const w = window.open(url, '_blank', 'noopener'); if (!w) location.href = url; };
  const isNative = () => Boolean(window.Capacitor?.isNativePlatform?.());
  const waIcon = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" style="vertical-align:-2px"><path fill="currentColor" d="M12 2.2a9.7 9.7 0 0 0-8.3 14.8L2.4 21.8l4.9-1.3A9.7 9.7 0 1 0 12 2.2zm0 17.7c-1.5 0-2.9-.4-4.1-1.1l-.3-.2-2.9.8.8-2.8-.2-.3A8 8 0 1 1 12 19.9zm4.4-6c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.8.9c-.1.2-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.1 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 0 0-.7.3 2.8 2.8 0 0 0-.9 2.1c0 1.2.9 2.4 1 2.6.1.2 1.8 2.7 4.3 3.8 1.6.7 2.2.7 3 .6.5-.1 1.4-.6 1.6-1.2.2-.6.2-1.1.1-1.2l-.5-.4z"/></svg>';

  Object.assign(s, {
    occ: { buildingId: '' },
    leads: { tab: 'leads', stage: 'open', q: '', open: null, bookBed: '', fromLead: '' },
    dues: { tab: 'whatsapp', buildingId: '', language: '', discountTenant: '', billPkg: null },
    site: { buildingId: '' },
    hostel: { tab: 'today', buildingId: '', date: '', assetCondition: '' },
  });

  // ---------- navigation ----------
  X.NAV_MORE.unshift(['occupancy', 'Occupancy', null], ['leads', 'Leads & bookings', 'tenants.manage'], ['dues', 'Dues & late fees', 'bills.manage'], ['site', 'Property page', 'properties.manage']);
  X.NAV_MAIN.splice(X.NAV_MAIN.length - 1, 0, ['hostel', 'Hostel', 'hostel.manage']);
  Object.assign(X.ICONS, {
    occupancy: '<rect x="3.5" y="5" width="7" height="6" rx="1.2"/><rect x="13.5" y="5" width="7" height="6" rx="1.2"/><rect x="3.5" y="13" width="7" height="6" rx="1.2"/><rect x="13.5" y="13" width="7" height="6" rx="1.2"/>',
    leads: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><path d="M17 8v6M14 11h6"/>',
    dues: '<path d="M6 4h12M6 9h12M9 4c3.5 0 5 2 5 5s-2 5-5 5H6l8 6"/>',
    site: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.2-3.8-8.5S9.4 5.9 12 3.5z"/>',
    hostel: '<path d="M4 20V10l8-5.5L20 10v10"/><path d="M9 20v-5h6v5M4 20h16"/>',
  });
  Object.assign(X.REPORTS, {
    occupancy: ['Occupancy (beds)', 'Every bed: who is in it, who is leaving, who is booked.'],
    'rent-roll': ['Rent roll', 'Active tenants with bed, rent, deposit held, dues and advance.'],
    defaulters: ['Defaulters', 'Tenants with overdue bills, longest overdue first.'],
    'late-fees-discounts': ['Late fees & discounts', 'Late fees added and discounts given in the period.'],
    'package-charges': ['Package & shared bills', 'Laundry, mess, maintenance packages and split bills.'],
    leads: ['Leads', 'Enquiries in the period, by source and stage.'],
    bookings: ['Bookings', 'Upcoming and past bookings with tokens.'],
    'hostel-attendance': ['Hostel attendance', 'Days present, late, absent and on leave per tenant.'],
    'meal-counts': ['Meal counts', 'Meals asked for, served and rated per day.'],
  });

  // ---------- beds on the room page ----------
  X.bedsCard = (r, current) => {
    if (r.electricityOnly) return '';
    const beds = r.beds || [];
    const live = beds.filter((b) => !b.disabled);
    const manage = can('properties.manage');
    const addBedForm = state.forms[`addBed-${r.id}`] ? `<form class="inline-form" data-submit="add-beds" data-id="${r.id}"><input name="count" type="number" min="1" max="30" value="1" aria-label="How many beds"><input name="monthlyRent" type="number" min="0" step="0.01" placeholder="Rent per bed (blank = room rent)"><button class="btn small" type="submit">Add</button><button class="btn small secondary" type="button" data-toggle-form="addBed-${r.id}">Cancel</button></form>` : '';
    const tagsForm = state.forms[`tags-${r.id}`] ? `<form class="inline-form" data-submit="room-tags" data-id="${r.id}"><input name="tags" value="${h((r.tags || []).join(', '))}" placeholder="AC, Attached washroom, Girls only" style="min-width:240px"><button class="btn small" type="submit">Save tags</button><button class="btn small secondary" type="button" data-toggle-form="tags-${r.id}">Cancel</button></form>` : '';
    if (beds.length <= 1) {
      return `<div class="card bed-strip"><div class="bed-strip-row"><span class="muted">${h(r.sharing || 'Private')} room · 1 bed${(r.tags || []).length ? ` · ${r.tags.map(h).join(', ')}` : ''}</span>${manage ? `<span class="row-actions"><button class="btn small secondary" data-toggle-form="addBed-${r.id}">+ Add beds (sharing)</button><button class="btn small secondary" data-toggle-form="tags-${r.id}">Tags</button></span>` : ''}</div>${addBedForm}${tagsForm}</div>`;
    }
    const rows = beds.map((b) => {
      const edit = state.forms[`bed-${b.id}`] ? `<form class="inline-form" data-submit="edit-bed" data-id="${b.id}"><input name="label" value="${h(b.label)}" maxlength="40" required><input name="monthlyRent" type="number" min="0" step="0.01" value="${b.ownRent ? b.monthlyRent : ''}" placeholder="Rent (blank = room rent)"><button class="btn small" type="submit">Save</button><button class="btn small secondary" type="button" data-toggle-form="bed-${b.id}">Cancel</button></form>` : '';
      const who = b.tenant ? `<button type="button" class="link-btn ${current?.id === b.tenant.id ? 'strong' : ''}" data-action="pick-room-tenant" data-id="${b.tenant.id}">${h(b.tenant.name)}</button>${b.tenant.leavingOn ? ` <small class="muted">leaves ${h(b.tenant.leavingOn)}</small>` : ''}` : b.booking ? `<span class="muted">Booked: ${h(b.booking.name)} from ${h(b.booking.joiningOn)}</span>` : '<span class="muted">—</span>';
      const actions = [];
      if ((b.status === 'vacant' || b.status === 'booked') && can('tenants.manage')) actions.push(`<button class="btn small" data-action="bed-add-tenant" data-id="${b.id}">Add tenant</button>`);
      if (b.status === 'vacant' && can('tenants.manage')) actions.push(`<button class="btn small secondary" data-action="book-bed" data-id="${b.id}">Book</button>`);
      if (manage) {
        actions.push(`<button class="btn small secondary" data-toggle-form="bed-${b.id}">Edit</button>`);
        if (!b.tenant) actions.push(`<button class="btn small secondary" data-action="bed-disable" data-id="${b.id}" data-disabled="${b.disabled ? '0' : '1'}">${b.disabled ? 'Rent it again' : 'Not for rent'}</button>`);
        if (!b.tenant && live.length > 1) actions.push(`<button class="btn small danger" data-action="bed-delete" data-id="${b.id}">Delete</button>`);
      }
      return [`<b>${h(b.label)}</b>${edit}`, bedStamp(b.status), who, money(b.monthlyRent), `<div class="row-actions">${actions.join('')}</div>`];
    });
    return card(`<span>Beds · ${h(r.sharing)} <small>${live.length - (r.freeBeds || 0)}/${live.length} taken</small></span>${manage ? `<span class="row-actions"><button class="btn small secondary" data-toggle-form="addBed-${r.id}">+ Add bed</button><button class="btn small secondary" data-toggle-form="tags-${r.id}">Tags</button></span>` : ''}`,
      `${addBedForm}${tagsForm}${(r.tags || []).length ? `<div class="chips">${r.tags.map((t) => `<span class="chip">${h(t)}</span>`).join('')}</div>` : ''}${table(['Bed', 'Status', 'Tenant', 'Rent', ''], rows)}`, 'beds-card');
  };
  const BED_TEXT = { occupied: 'Occupied', notice: 'On notice', booked: 'Booked', vacant: 'Vacant', disabled: 'Not for rent' };
  const bedStamp = (status) => `<span class="stamp bed-${h(status)}">${h(BED_TEXT[status] || status)}</span>`;

  X.actions['pick-room-tenant'] = (el) => { state.roomTenantPick = { roomId: state.roomId, tenantId: el.dataset.id }; render(); return false; };
  X.actions['bed-add-tenant'] = (el) => { state.addTenantBedId = el.dataset.id; state.forms.addTenant = true; render(); return false; };
  X.actions['book-bed'] = (el) => { Object.assign(s.leads, { tab: 'bookings', bookBed: el.dataset.id }); state.view = 'leads'; state.buildingId = null; state.roomId = null; state.forms = { newBooking: true }; render(); return false; };
  X.actions['bed-disable'] = async (el) => { await api('PUT', `/api/beds/${el.dataset.id}`, { disabled: el.dataset.disabled === '1' }); toast(el.dataset.disabled === '1' ? 'Bed marked as not for rent' : 'Bed is for rent again'); };
  X.actions['bed-delete'] = async (el) => {
    if (!(await confirmDialog('Delete this bed? Beds with any tenant or booking history are kept; mark them "Not for rent" instead.', { title: 'Delete bed?', confirmLabel: 'Delete', danger: true }))) return false;
    await api('DELETE', `/api/beds/${el.dataset.id}`); toast('Bed deleted');
  };
  X.submits['add-beds'] = async (data, form) => { await api('POST', `/api/rooms/${form.dataset.id}/beds`, data); state.forms[`addBed-${form.dataset.id}`] = false; toast('Beds added'); };
  X.submits['edit-bed'] = async (data, form) => { await api('PUT', `/api/beds/${form.dataset.id}`, data); state.forms[`bed-${form.dataset.id}`] = false; toast('Bed updated'); };
  X.submits['room-tags'] = async (data, form) => { await api('PUT', `/api/rooms/${form.dataset.id}/tags`, data); state.forms[`tags-${form.dataset.id}`] = false; toast('Tags saved'); };

  // ---------- tenant: notice, move bed, WhatsApp, deposit/advance ----------
  const baseTenantLinks = X.tenantLinks;
  X.tenantLinks = (tenant) => {
    const freeBeds = (cache.rooms || []).filter((r) => !r.electricityOnly && r.status !== 'archived').flatMap((r) => (r.beds || []).filter((b) => b.status === 'vacant' || b.status === 'booked').map((b) => ({ ...b, room: r })));
    const noticeForm = state.forms[`notice-${tenant.id}`] ? `<form class="inline-form" data-submit="give-notice" data-id="${tenant.id}"><label class="muted">Leaving on</label><input type="date" name="leavingOn" required min="${today()}"><button class="btn small" type="submit">Save notice</button><button class="btn small secondary" type="button" data-toggle-form="notice-${tenant.id}">Cancel</button></form>` : '';
    const moveForm = state.forms[`moveBed-${tenant.id}`] ? `<form class="inline-form" data-submit="move-bed" data-id="${tenant.id}"><select name="bedId" required><option value="">Choose a free bed</option>${freeBeds.map((b) => { const bld = cache.buildings.find((x) => x.id === b.room.buildingId); return opt(b.id, `${bld?.name || ''} · ${b.room.label} · ${b.label}${b.status === 'booked' ? ' (booked)' : ''}`); }).join('')}</select><button class="btn small" type="submit">Move</button><button class="btn small secondary" type="button" data-toggle-form="moveBed-${tenant.id}">Cancel</button></form>` : '';
    const mine = `<div class="card quick-links"><h3>Notice, bed and money</h3>
      <p class="profile-note">${tenant.leavingOn ? `Gave notice${tenant.noticeGivenOn ? ` on ${h(tenant.noticeGivenOn)}` : ''}; leaving on <b>${h(tenant.leavingOn)}</b>. The bed shows "On notice" and can be booked from that date.` : 'When the tenant tells you they are leaving, record it here. The bed then shows as "On notice" so you can book it for the next person.'}</p>
      <div class="row-actions">
        ${can('tenants.manage') ? (tenant.leavingOn ? `<button class="btn small secondary" data-action="withdraw-notice" data-id="${tenant.id}">Withdraw notice</button>` : `<button class="btn small secondary" data-toggle-form="notice-${tenant.id}">Record notice</button>`) : ''}
        ${can('tenants.manage') ? `<button class="btn small secondary" data-toggle-form="moveBed-${tenant.id}">Move to another bed</button>` : ''}
        ${can('reminders.manage') && tenant.mobile ? `<button class="btn small secondary" data-action="wa-remind-one" data-id="${tenant.id}">${waIcon} Payment reminder</button>` : ''}
        ${can('payments.record') ? `<button class="btn small secondary" data-action="apply-advance" data-id="${tenant.id}">Use advance for bills</button>` : ''}
        ${isOwner() ? `<button class="btn small secondary" data-action="use-deposit" data-id="${tenant.id}">Pay dues from deposit</button>` : ''}
      </div>${noticeForm}${moveForm}</div>`;
    return baseTenantLinks(tenant) + mine;
  };
  X.submits['give-notice'] = async (data, form) => { await api('POST', `/api/tenants/${form.dataset.id}/notice`, data); state.forms[`notice-${form.dataset.id}`] = false; toast('Notice recorded'); };
  X.actions['withdraw-notice'] = async (el) => { await api('DELETE', `/api/tenants/${el.dataset.id}/notice`); toast('Notice withdrawn'); };
  X.submits['move-bed'] = async (data, form) => {
    const t = await api('POST', `/api/tenants/${form.dataset.id}/move-bed`, data);
    state.forms[`moveBed-${form.dataset.id}`] = false;
    state.roomId = t.roomId; state.roomTenantPick = { roomId: t.roomId, tenantId: t.id };
    toast(`Moved to ${t.bedLabel}`);
  };
  X.actions['wa-remind-one'] = async (el) => {
    const list = await api('GET', '/api/dues/whatsapp');
    const row = list.find((x) => x.tenantId === el.dataset.id);
    if (!row) { toast('This tenant owes nothing right now.'); return false; }
    openLink(row.link); return false;
  };
  X.actions['apply-advance'] = async (el) => {
    const r = await api('POST', `/api/dues/tenants/${el.dataset.id}/apply-advance`);
    toast(r.applied ? `${money(r.applied)} of advance used for open bills` : 'No advance to use, or no open bills.');
  };
  X.actions['use-deposit'] = async (el) => {
    const m = await api('GET', `/api/dues/tenants/${el.dataset.id}/money`);
    if (!m.depositHeld) { toast('No deposit is recorded as held. Record it under Tenancy, deposit & move-out first.', true); return false; }
    if (!m.outstanding) { toast('There are no unpaid bills.'); return false; }
    const amount = Math.min(m.depositHeld, m.outstanding);
    if (!(await confirmDialog(`Use ${money(amount)} of the ${money(m.depositHeld)} deposit to pay the unpaid bills (${money(m.outstanding)})? The deposit held goes down by the same amount.`, { title: 'Pay dues from deposit?', confirmLabel: 'Use deposit' }))) return false;
    const r = await api('POST', `/api/dues/tenants/${el.dataset.id}/use-deposit`, { amount });
    toast(`${money(r.amount)} paid from deposit · ${money(r.depositLeft)} left`);
  };

  // ---------- occupancy ----------
  X.loaders.occupancy = async () => { d.occ = await api('GET', `/api/occupancy${qs({ buildingId: s.occ.buildingId })}`); };
  X.views.occupancy = () => {
    const o = d.occ;
    if (!o) return page('Occupancy', '');
    const sm = o.summary;
    const tile = (lbl, value, cls = '') => `<div class="stat-card ${cls}"><div class="stat-label">${h(lbl)}</div><div class="stat-value">${value}</div></div>`;
    const legend = `<div class="bed-legend">${['occupied', 'notice', 'booked', 'vacant', 'disabled'].map((st) => `<span><i class="bed-dot bed-${st}"></i>${h(BED_TEXT[st])}</span>`).join('')}</div>`;
    const buildings = o.buildings.map((b) => `<section class="card occ-building"><h3>${h(b.name)} <small>${b.summary.occupied}/${b.summary.beds} beds · ${b.summary.occupancyRate}%</small></h3>
      ${b.floors.map((f) => `<div class="occ-floor"><div class="occ-floor-label">Floor ${f.floorNumber}</div><div class="occ-rooms">${f.rooms.map((r) => `
        <div class="occ-room occ-${r.status}" data-nav="room" data-id="${r.id}" role="button" tabindex="0" aria-label="Room ${h(r.label)}, ${h(r.sharing)}, ${h(r.status)}">
          <div class="occ-room-top"><b>${h(r.label)}</b><small>${h(r.sharing)}</small></div>
          <div class="occ-beds">${r.beds.map((bed) => `<span class="bed-dot bed-${bed.status}" title="${h(`${bed.label}: ${BED_TEXT[bed.status]}${bed.tenant ? ` · ${bed.tenant.name}` : ''}${bed.tenant?.leavingOn ? ` (leaves ${bed.tenant.leavingOn})` : ''}${bed.booking ? ` · booked by ${bed.booking.name} from ${bed.booking.joiningOn}` : ''}`)}"></span>`).join('')}</div>
          <div class="occ-room-foot">${money(r.monthlyRent)}${r.tags.length ? ` · ${h(r.tags.slice(0, 2).join(', '))}` : ''}</div>
        </div>`).join('')}</div></div>`).join('') || '<p class="muted">No rooms yet.</p>'}</section>`).join('');
    return `${page('Occupancy', 'Every bed at a glance. Tap a room to open it.', `<select data-ext-change="state" data-key="occ.buildingId" aria-label="Property">${buildingOptions(s.occ.buildingId, 'All properties')}</select>`)}
      <div class="stat-grid occ-stats">${tile('Occupancy', `${sm.occupancyRate}%`, sm.occupancyRate >= 90 ? 'good' : '')}${tile('Beds occupied', `${sm.occupied}/${sm.beds}`)}${tile('Vacant beds', sm.vacant, sm.vacant ? 'warn' : 'good')}${tile('On notice', sm.notice)}${tile('Booked', sm.booked)}${tile('Rooms full', `${sm.fullRooms}/${sm.rooms}`)}</div>
      ${legend}${buildings || card('', '<p class="muted">Add a property and rooms to see occupancy.</p>')}`;
  };

  // ---------- leads & bookings ----------
  const STAGE_TEXT = { new: 'New', contacted: 'Contacted', visit_scheduled: 'Visit booked', visited: 'Visited', token_paid: 'Token paid', won: 'Moved in', lost: 'Lost' };
  const NEXT_STAGE = { new: 'contacted', contacted: 'visit_scheduled', visit_scheduled: 'visited', visited: 'token_paid' };
  const SOURCE_TEXT = { walk_in: 'Walk-in', phone: 'Phone call', whatsapp: 'WhatsApp', website: 'Property page', referral: 'Referral', broker: 'Broker', online_listing: 'Online listing', other: 'Other' };
  X.loaders.leads = async () => {
    const l = s.leads;
    const jobs = [];
    if (l.tab === 'leads') jobs.push(api('GET', `/api/leads${qs({ stage: l.stage, q: l.q })}`).then((r) => { d.leads = r; }));
    if (l.tab === 'leads' && l.open) jobs.push(api('GET', `/api/leads/${l.open}`).then((r) => { d.lead = r; }).catch(() => { l.open = null; }));
    if (l.tab === 'bookings') jobs.push(api('GET', '/api/bookings').then((r) => { d.bookings = r; }), api('GET', '/api/occupancy').then((r) => { d.occAll = r; }));
    await Promise.all(jobs);
  };
  const bedChoices = (selected) => {
    const out = [];
    for (const b of d.occAll?.buildings || []) for (const f of b.floors) for (const r of f.rooms) for (const bed of r.beds) {
      if (!['vacant', 'notice'].includes(bed.status)) continue;
      out.push(opt(bed.id, `${b.name} · ${r.label} · ${bed.label} · ${fmtMoney(bed.monthlyRent)}${bed.status === 'notice' ? ` (free from ${bed.tenant?.leavingOn})` : ''}`, selected));
    }
    return out.join('');
  };
  X.views.leads = () => {
    const l = s.leads;
    const head = page('Leads & bookings', 'Track enquiries until they move in. Bookings hold a bed for a future date.');
    const t = tabs('leads', 'tab', [['leads', 'Leads'], ['bookings', 'Bookings', (d.bookings || []).filter((b) => ['pending', 'confirmed'].includes(b.status)).length || '']]);
    if (l.tab === 'bookings') return head + t + bookingsView();
    const data = d.leads || { leads: [], counts: {} };
    const stageChips = `<div class="chip-row">${[['open', 'Open'], ...Object.entries(STAGE_TEXT)].map(([k, txt]) => `<button type="button" class="chip-btn ${l.stage === k ? 'active' : ''}" data-action="set-state" data-key="leads.stage" data-value="${k}">${h(txt)}${k !== 'open' && data.counts[k] ? ` <b>${data.counts[k]}</b>` : ''}</button>`).join('')}</div>`;
    const form = state.forms.addLead ? card('New lead', `<form data-submit="add-lead"><div class="form-grid cols-3">
      ${field('Name *', '<input name="name" required maxlength="120">')}${field('Mobile', '<input name="mobile" inputmode="tel" placeholder="10-digit mobile">')}${field('Source', `<select name="source">${Object.entries(SOURCE_TEXT).map(([k, v]) => opt(k, v, 'walk_in')).join('')}</select>`)}
      ${field('Property', `<select name="buildingId">${buildingOptions(firstBuilding(), 'Any')}</select>`)}${field('Visit date', '<input type="date" name="visitOn">')}${field('Wants to move in from', '<input type="date" name="moveInFrom">')}
      ${field('Budget per month (₹)', '<input type="number" name="budget" min="0" step="1">')}${field('Looking for', '<input name="preference" maxlength="200" placeholder="e.g. single room with AC">')}${field('Next follow-up', '<input type="date" name="nextFollowUp">')}
      ${field('Notes', '<input name="notes" maxlength="1000">', '1 / -1')}</div>
      <div class="form-actions"><button class="btn" type="submit">Save lead</button><button class="btn secondary" type="button" data-toggle-form="addLead">Cancel</button></div></form>`) : '';
    const rows = data.leads.map((x) => {
      const actions = [];
      if (x.whatsapp) actions.push(`<a class="btn small secondary" href="${h(x.whatsapp)}" target="_blank" rel="noopener">${waIcon}</a>`);
      if (NEXT_STAGE[x.stage]) actions.push(`<button class="btn small secondary" data-action="lead-stage" data-id="${x.id}" data-stage="${NEXT_STAGE[x.stage]}">→ ${h(STAGE_TEXT[NEXT_STAGE[x.stage]])}</button>`);
      if (!['won', 'lost'].includes(x.stage) && !x.booking) actions.push(`<button class="btn small" data-action="lead-book" data-id="${x.id}">Book a bed</button>`);
      if (!['won', 'lost'].includes(x.stage)) actions.push(`<button class="btn small secondary" data-action="lead-lost" data-id="${x.id}">Lost</button>`);
      actions.push(`<button class="btn small secondary" data-action="lead-open" data-id="${x.id}">${l.open === x.id ? 'Close' : 'Notes'}</button>`);
      return [`<b>${h(x.name)}</b><br><small class="muted">${h(x.mobile || x.email)}</small>`, h(x.buildingName || '—'), h(SOURCE_TEXT[x.source] || x.source),
        `${stamp(`lead-${x.stage}`, STAGE_TEXT[x.stage])}${x.booking ? `<br><small class="muted">Booked from ${h(x.booking.joiningOn)}</small>` : ''}`,
        `${h(x.visitOn || '—')}${x.followUpDue ? `<br>${stamp('overdue', `Follow up ${x.nextFollowUp}`)}` : x.nextFollowUp ? `<br><small class="muted">Follow up ${h(x.nextFollowUp)}</small>` : ''}`,
        h(x.preference || ''), `<div class="row-actions">${actions.join('')}</div>`];
    });
    const detail = l.open && d.lead ? card(`${h(d.lead.name)} <small>${h(STAGE_TEXT[d.lead.stage])}</small>`, `
      <form class="inline-form" data-submit="lead-note" data-id="${d.lead.id}"><select name="kind">${[['note', 'Note'], ['call', 'Call'], ['visit', 'Visit']].map(([k, v]) => opt(k, v)).join('')}</select><input name="body" required maxlength="1000" placeholder="What happened?" style="flex:1;min-width:200px"><button class="btn small" type="submit">Add</button></form>
      <form class="inline-form" data-submit="lead-followup" data-id="${d.lead.id}"><label class="muted">Next follow-up</label><input type="date" name="nextFollowUp" value="${h(d.lead.nextFollowUp)}"><button class="btn small secondary" type="submit">Save</button></form>
      <ul class="timeline">${d.lead.events.map((e) => `<li><small class="muted">${h(e.createdAt.slice(0, 16).replace('T', ' '))}${e.author ? ` · ${h(e.author)}` : ''}</small><div>${h(e.body)}</div></li>`).join('')}</ul>`, 'lead-detail') : '';
    return `${head}${t}${stageChips}
      <div class="filter-line"><form class="inline-form" data-submit="lead-search"><input name="q" value="${h(l.q)}" placeholder="Search name or mobile"><button class="btn small secondary" type="submit">Search</button></form><button class="btn" data-toggle-form="addLead">+ New lead</button></div>
      ${form}${detail}${card('', table(['Name', 'Property', 'Source', 'Stage', 'Visit', 'Looking for', ''], rows, { emptyText: 'No leads here. Share your property page to get enquiries.' }))}`;
  };
  function bookingsView() {
    const l = s.leads;
    const lead = l.fromLead ? (d.leads?.leads || []).find((x) => x.id === l.fromLead) : null;
    const form = state.forms.newBooking ? card('New booking', `<form data-submit="add-booking"><input type="hidden" name="leadId" value="${h(l.fromLead || '')}"><div class="form-grid cols-3">
      ${field('Bed *', `<select name="bedId" required><option value="">Choose a free bed</option>${bedChoices(l.bookBed)}</select>`, '1 / -1')}
      ${field('Name *', `<input name="name" required maxlength="120" value="${h(lead?.name || '')}">`)}${field('Mobile *', `<input name="mobile" required inputmode="tel" value="${h(lead?.mobile || '')}">`)}${field('Joining date *', `<input type="date" name="joiningOn" required value="${h(lead?.moveInFrom || today())}">`)}
      ${field('Monthly rent (₹)', '<input type="number" name="monthlyRent" min="0" step="0.01" placeholder="Blank = bed rent">')}${field('Deposit (₹)', '<input type="number" name="deposit" min="0" step="0.01" placeholder="Blank = room deposit">')}${field('Token received (₹)', '<input type="number" name="token" min="0" step="0.01" value="0">')}
      ${field('Token paid by', `<select name="tokenMethod">${[['', '—'], ['upi', 'UPI'], ['cash', 'Cash'], ['bank_transfer', 'Bank transfer'], ['cheque', 'Cheque']].map(([k, v]) => opt(k, v)).join('')}</select>`)}${field('Token reference / UTR', '<input name="tokenReference" maxlength="120">')}${field('Notes', '<input name="notes" maxlength="1000">')}
      </div><p class="profile-note">The token is kept as an advance and used for the first bills when they move in.</p>
      <div class="form-actions"><button class="btn" type="submit">Save booking</button><button class="btn secondary" type="button" data-toggle-form="newBooking">Cancel</button></div></form>`) : '';
    const rows = (d.bookings || []).map((b) => {
      const open = ['pending', 'confirmed'].includes(b.status);
      const actions = [];
      if (b.whatsapp) actions.push(`<a class="btn small secondary" href="${h(b.whatsapp)}" target="_blank" rel="noopener">${waIcon}</a>`);
      if (open) actions.push(`<button class="btn small" data-action="booking-move-in" data-id="${b.id}" ${b.bedFreeNow ? '' : 'disabled title="The bed is still occupied"'}>Move in</button>`, `<button class="btn small secondary" data-action="booking-cancel" data-id="${b.id}">Cancel</button>`);
      if (b.status === 'moved_in' && b.tenantId) actions.push(`<button class="btn small secondary" data-nav="tenancy" data-id="${b.tenantId}">Tenancy</button>`);
      return [`${h(b.joiningOn)}${b.dueToMoveIn ? `<br>${stamp('due', 'Due to move in')}` : ''}`, `<b>${h(b.name)}</b><br><small class="muted">${h(b.mobile)}</small>`, `${h(b.buildingName)} · ${h(b.roomLabel)} · ${h(b.bedLabel)}${b.currentOccupant ? `<br><small class="muted">${h(b.currentOccupant.name)} leaves ${h(b.currentOccupant.leavingOn)}</small>` : ''}`,
        money(b.monthlyRent), b.token ? money(b.token) : '—', stamp(`booking-${b.status}`, label(b.status === 'moved_in' ? 'moved in' : b.status)), `<div class="row-actions">${actions.join('')}</div>`];
    });
    return `<div class="filter-line"><span class="muted">A booked bed shows as "Booked" on Occupancy and can't be given to someone else.</span><button class="btn" data-toggle-form="newBooking">+ New booking</button></div>${form}${card('', table(['Joining', 'Name', 'Bed', 'Rent', 'Token', 'Status', ''], rows, { emptyText: 'No bookings yet.' }))}`;
  }
  X.submits['lead-search'] = (data) => { s.leads.q = data.q || ''; };
  X.submits['add-lead'] = async (data) => { await api('POST', '/api/leads', data); state.forms.addLead = false; s.leads.stage = 'open'; toast('Lead saved'); };
  X.submits['lead-note'] = async (data, form) => { await api('POST', `/api/leads/${form.dataset.id}/notes`, data); toast('Added'); };
  X.submits['lead-followup'] = async (data, form) => { await api('PUT', `/api/leads/${form.dataset.id}`, data); toast('Follow-up saved'); };
  X.actions['go-bookings'] = () => { s.leads.tab = 'bookings'; state.view = 'leads'; state.forms = {}; render(); return false; };
  X.actions['lead-open'] = (el) => { s.leads.open = s.leads.open === el.dataset.id ? null : el.dataset.id; };
  X.actions['lead-stage'] = async (el) => { await api('PUT', `/api/leads/${el.dataset.id}`, { stage: el.dataset.stage }); toast(`Moved to ${STAGE_TEXT[el.dataset.stage]}`); };
  X.actions['lead-lost'] = async (el) => {
    const reason = window.prompt('Why was this lead lost? (optional)', '');
    if (reason === null) return false;
    await api('PUT', `/api/leads/${el.dataset.id}`, { stage: 'lost', lostReason: reason || 'Not given' }); toast('Marked as lost');
  };
  X.actions['lead-book'] = (el) => { Object.assign(s.leads, { tab: 'bookings', fromLead: el.dataset.id, bookBed: '' }); state.forms = { newBooking: true }; };
  X.submits['add-booking'] = async (data) => {
    await api('POST', '/api/bookings', data);
    state.forms.newBooking = false; Object.assign(s.leads, { fromLead: '', bookBed: '' });
    toast('Booking saved. The bed now shows as booked.');
  };
  X.actions['booking-cancel'] = async (el) => {
    const reason = window.prompt('Reason for cancelling (optional)', '');
    if (reason === null) return false;
    const r = await api('POST', `/api/bookings/${el.dataset.id}/cancel`, { reason });
    toast(r.tokenToRefund ? `Booking cancelled. Remember to settle the ${money(r.tokenToRefund)} token.` : 'Booking cancelled');
  };
  X.actions['booking-move-in'] = async (el) => {
    if (!(await confirmDialog('Move this person in today? This adds them as a tenant on the booked bed, keeps the token as an advance and prepares a draft lease.', { title: 'Move in?', confirmLabel: 'Move in' }))) return false;
    const r = await api('POST', `/api/bookings/${el.dataset.id}/move-in`, { moveInDate: today() });
    toast(r.draftLeaseId ? `${r.tenant.name} moved in. A draft lease is waiting in Leases: activate it to start monthly rent.` : `${r.tenant.name} moved in.`);
  };

  // ---------- dues & late fees ----------
  X.loaders.dues = async () => {
    const t = s.dues.tab;
    if (t === 'whatsapp') d.wa = await api('GET', `/api/dues/whatsapp${qs({ buildingId: s.dues.buildingId, language: s.dues.language })}`);
    if (t === 'packages') d.pkgs = await api('GET', '/api/dues/packages');
    if (t === 'late') d.late = await api('GET', '/api/dues/late-fees');
    if (t === 'discounts') {
      d.discounts = await api('GET', '/api/dues/discounts');
      d.discountBills = s.dues.discountTenant ? (await api('GET', `/api/ledger/charges${qs({ tenantId: s.dues.discountTenant, status: 'open' })}`)) : [];
    }
  };
  X.views.dues = () => {
    const t = s.dues.tab;
    const head = page('Dues & late fees', 'Extra charges, shared bills, late fees, discounts and WhatsApp reminders.');
    const tb = tabs('dues', 'tab', [['whatsapp', 'WhatsApp reminders'], ['packages', 'Packages'], ['split', 'Split a bill'], ['late', 'Late fees'], ['discounts', 'Discounts']]);
    let body = '';
    if (t === 'whatsapp') {
      const rows = (d.wa || []).map((x) => [`<b>${h(x.name)}</b><br><small class="muted">${h(x.mobile || 'no mobile')}</small>`, `${h(x.buildingName)} · ${h(x.roomLabel)}`, money(x.due), x.overdue ? `<span class="is-due">${money(x.overdue)}</span>` : '—',
        `<a class="btn small wa-btn" href="${h(x.link)}" target="_blank" rel="noopener">${waIcon} Send</a>${x.hasNumber ? '' : ' <small class="muted">add a mobile number</small>'}`]);
      body = `<div class="filter-line"><select data-ext-change="state" data-key="dues.buildingId" aria-label="Property">${buildingOptions(s.dues.buildingId, 'All properties')}</select><select data-ext-change="state" data-key="dues.language" aria-label="Language">${[['', 'Each tenant’s language'], ['en', 'English'], ['hi', 'हिन्दी']].map(([k, v]) => opt(k, v, s.dues.language)).join('')}</select></div>
        <p class="profile-note">Each button opens WhatsApp with the message and amount filled in. It is free: nothing is sent until you press send in WhatsApp. Your UPI ID is added if it is set in Settings.</p>
        ${card('', table(['Tenant', 'Room', 'Due', 'Overdue', ''], rows, { emptyText: 'Nobody owes anything right now.' }))}`;
    } else if (t === 'packages') {
      const form = state.forms.addPkg ? card('New package', `<form data-submit="add-package"><div class="form-grid cols-3">
        ${field('Name *', '<input name="name" required maxlength="80" placeholder="Laundry, Mess, Parking…">')}${field('Charged as', `<select name="billingMode">${opt('fixed', 'Fixed amount')}${opt('per_unit', 'Per unit used')}</select>`)}${field('Amount or rate (₹) *', '<input type="number" name="rate" min="0" step="0.01" required>')}
        ${field('Unit (per unit only)', '<input name="unitLabel" maxlength="30" placeholder="load, plate, kg, kWh">')}${field('Minimum bill (₹)', '<input type="number" name="minBill" min="0" step="0.01" value="0">')}${field('Type', `<select name="category">${opt('other', 'Other charge')}${opt('maintenance', 'Maintenance')}</select>`)}
        ${field('Property', `<select name="buildingId">${buildingOptions('', 'All properties')}</select>`)}${field('Due day of month', '<input type="number" name="dueDay" min="1" max="28" value="5">')}
        <div class="form-field"><label><input type="checkbox" name="autoMonthly" value="true"> Add to every tenant automatically each month (fixed amount only)</label></div>
        </div><div class="form-actions"><button class="btn" type="submit">Save package</button><button class="btn secondary" type="button" data-toggle-form="addPkg">Cancel</button></div></form>`) : '';
      const billForm = (p) => state.forms[`bill-${p.id}`] ? `<tr class="sub-row"><td colspan="6"><form class="inline-form wrap" data-submit="bill-package" data-id="${p.id}">
        <select name="target" required><option value="">Who pays?</option><optgroup label="Tenant">${tenantOptions('', () => true, '').replace('<option value=""></option>', '')}</optgroup><optgroup label="Whole room (shared)">${cache.rooms.filter((r) => (r.bedCount || 1) - (r.freeBeds || 0) > 0 && !r.electricityOnly).map((r) => opt(`room:${r.id}`, `${cache.buildings.find((b) => b.id === r.buildingId)?.name || ''} · ${r.label}`)).join('')}</optgroup></select>
        ${p.billingMode === 'per_unit' ? `<input type="number" name="units" min="0" step="0.01" placeholder="${h(p.unitLabel || 'units')} used" required>` : ''}
        <select name="split" title="For a whole room">${opt('each', 'Each person pays the full amount')}${opt('equal', 'Split equally in the room')}</select>
        <input type="date" name="dueDate" value="${today()}"><button class="btn small" type="submit">Add charge</button><button class="btn small secondary" type="button" data-toggle-form="bill-${p.id}">Cancel</button></form></td></tr>` : '';
      const rows = (d.pkgs || []).map((p) => `<tr><td><b>${h(p.name)}</b>${p.description ? `<br><small class="muted">${h(p.description)}</small>` : ''}</td><td>${p.billingMode === 'per_unit' ? `${money(p.rate)} per ${h(p.unitLabel)}${p.minBill ? `, min ${money(p.minBill)}` : ''}` : money(p.rate)}</td><td>${p.autoMonthly ? `Every month (due ${p.dueDay})` : 'When you add it'}</td><td>${h(p.buildingId ? cache.buildings.find((b) => b.id === p.buildingId)?.name || '' : 'All')}</td><td>${p.active ? stamp('paid', 'On') : stamp('void', 'Off')}</td>
        <td><div class="row-actions">${p.active ? `<button class="btn small" data-toggle-form="bill-${p.id}">Add charge</button>` : ''}<button class="btn small secondary" data-action="pkg-toggle" data-id="${p.id}" data-active="${p.active ? '0' : '1'}">${p.active ? 'Switch off' : 'Switch on'}</button></div></td></tr>${billForm(p)}`).join('');
      body = `<div class="filter-line"><span class="muted">A package is a charge you add often: laundry per load, mess per month, parking…</span><button class="btn" data-toggle-form="addPkg">+ New package</button></div>${form}
        ${card('', rows ? `<div class="table-wrap"><table class="ledger"><thead><tr><th>Package</th><th>Price</th><th>Added</th><th>Property</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty-state"><div>No packages yet.</div></div>')}`;
    } else if (t === 'split') {
      const shared = cache.rooms.filter((r) => !r.electricityOnly && (r.bedCount || 1) - (r.freeBeds || 0) > 1);
      body = card('Split one bill between the tenants of a room', `<p class="profile-note">For a shared room's electricity, water or Wi-Fi bill. Each tenant gets their own bill for their share, so each can pay separately.</p>
        <form data-submit="split-bill"><div class="form-grid cols-3">
        ${field('Room *', `<select name="roomId" required><option value="">Choose a shared room</option>${shared.map((r) => opt(r.id, `${cache.buildings.find((b) => b.id === r.buildingId)?.name || ''} · ${r.label} (${(r.bedCount || 1) - (r.freeBeds || 0)} tenants)`)).join('')}</select>`)}
        ${field('Bill type', `<select name="kind">${[['electricity', 'Electricity'], ['other', 'Other'], ['maintenance', 'Maintenance'], ['gas', 'Gas']].map(([k, v]) => opt(k, v)).join('')}</select>`)}${field('Total amount (₹) *', '<input type="number" name="amount" min="0.01" step="0.01" required>')}
        ${field('Description', '<input name="description" maxlength="120" placeholder="e.g. Electricity, March">')}${field('Due date', `<input type="date" name="dueDate" value="${today()}">`)}
        ${field('Split', `<select name="mode">${opt('equal', 'Equally')}${opt('days', 'By days stayed in the period')}</select>`)}
        ${field('Period from (for days)', '<input type="date" name="periodStart">')}${field('Period to (for days)', '<input type="date" name="periodEnd">')}
        </div><div class="form-actions"><button class="btn" type="submit">Split and add bills</button></div></form>${shared.length ? '' : '<p class="muted">No room has more than one tenant right now.</p>'}`);
    } else if (t === 'late') {
      const st = d.late?.settings || {};
      const kinds = st.kinds || ['rent'];
      body = card('Late fees', `<form data-submit="late-fees"><div class="form-grid cols-3">
        <div class="form-field"><label><input type="checkbox" name="enabled" value="true" ${st.enabled ? 'checked' : ''} ${isOwner() ? '' : 'disabled'}> Add late fees automatically</label></div>
        ${field('Grace days after the due date', `<input type="number" name="graceDays" min="0" max="60" value="${st.graceDays ?? 5}">`)}
        ${field('Fee', `<select name="mode">${opt('flat', 'One fee', st.mode)}${opt('daily', 'Per day late', st.mode)}</select>`)}
        ${field('Amount (₹)', `<input type="number" name="amount" min="0" step="0.01" value="${st.amount ?? 100}">`)}${field('Maximum per bill (₹, 0 = no limit)', `<input type="number" name="maxAmount" min="0" step="0.01" value="${st.maxAmount ?? 0}">`)}
        <div class="form-field"><label>On these bills</label><div class="check-row">${[['rent', 'Rent'], ['electricity', 'Electricity'], ['gas', 'Gas'], ['maintenance', 'Maintenance'], ['other', 'Other']].map(([k, v]) => `<label><input type="checkbox" name="kind_${k}" value="1" ${kinds.includes(k) ? 'checked' : ''}> ${v}</label>`).join('')}</div></div>
        </div><p class="profile-note">Checked every hour. Each overdue bill gets one late-fee bill; a per-day fee grows each day until the bill is paid or the maximum is reached. Late fees go through the ledger like any other bill, so you can waive one from Bills & payments.</p>
        ${isOwner() ? '<div class="form-actions"><button class="btn" type="submit">Save</button><button class="btn secondary" type="button" data-action="dues-run">Check now</button></div>' : '<p class="muted">Only the owner can change these settings.</p>'}</form>`)
        + card('Recent late fees', table(['Tenant', 'Type', 'Days', 'Amount', 'Status'], (d.late?.recent || []).map((r) => [h(r.tenantName), h(r.mode === 'daily' ? 'Per day' : 'One fee'), r.mode === 'daily' ? r.days : '—', money(r.amount), stamp(r.status)]), { emptyText: 'No late fees yet.' }));
    } else if (t === 'discounts') {
      const bills = (d.discountBills || []).map((c) => opt(c.id, `${c.description || label(c.kind)}${c.month ? ` ${c.month}/${c.year}` : ''} · due ${c.dueDate || '—'} · ${fmtMoney(c.outstanding)} open`)).join('');
      body = card('Give a discount', `<form data-submit="give-discount"><div class="form-grid cols-3">
        ${field('Tenant', `<select data-ext-change="state" data-key="dues.discountTenant" name="tenant">${tenantOptions(s.dues.discountTenant)}</select>`)}
        ${field('Bill *', `<select name="chargeId" required ${s.dues.discountTenant ? '' : 'disabled'}><option value="">${s.dues.discountTenant ? (bills ? 'Choose a bill' : 'No open bills') : 'Choose a tenant first'}</option>${bills}</select>`)}
        ${field('Discount (₹) *', '<input type="number" name="amount" min="0.01" step="0.01" required>')}
        ${field('Only if paid by (optional)', '<input type="date" name="validUntil">')}${field('Reason', '<input name="reason" maxlength="300" placeholder="e.g. Early payment">', 'span 2')}
        </div><p class="profile-note">With a "paid by" date, the discount is taken back automatically if the bill is still unpaid after that date.</p><div class="form-actions"><button class="btn" type="submit">Give discount</button></div></form>`)
        + card('Discounts with a deadline', table(['Given', 'Tenant', 'Amount', 'Pay by', 'Status', ''], (d.discounts || []).map((o) => [h(o.createdAt.slice(0, 10)), h(o.tenantName), money(o.amount), h(o.validUntil), stamp(o.status === 'active' ? 'due' : o.status === 'used' ? 'paid' : 'void', label(o.status)), o.status === 'active' ? `<button class="btn small secondary" data-action="discount-cancel" data-id="${o.id}">Withdraw</button>` : '']), { emptyText: 'None yet.' }));
    }
    return head + tb + body;
  };
  X.submits['add-package'] = async (data) => { await api('POST', '/api/dues/packages', { ...data, autoMonthly: data.autoMonthly === 'true' }); state.forms.addPkg = false; toast('Package saved'); };
  X.actions['pkg-toggle'] = async (el) => { await api('PUT', `/api/dues/packages/${el.dataset.id}`, { active: el.dataset.active === '1' }); toast(el.dataset.active === '1' ? 'Package switched on' : 'Package switched off'); };
  X.submits['bill-package'] = async (data, form) => {
    const body = { units: data.units, split: data.split, dueDate: data.dueDate };
    if (String(data.target).startsWith('room:')) body.roomId = data.target.slice(5); else body.tenantIds = [data.target];
    const r = await api('POST', `/api/dues/packages/${form.dataset.id}/bill`, body);
    state.forms[`bill-${form.dataset.id}`] = false;
    toast(`${r.created} charge${r.created === 1 ? '' : 's'} added`);
  };
  X.submits['split-bill'] = async (data) => { const r = await api('POST', '/api/dues/split', data); toast(`Split into ${r.created} bills`); };
  X.submits['late-fees'] = async (data) => {
    const kinds = ['rent', 'electricity', 'gas', 'maintenance', 'other'].filter((k) => data[`kind_${k}`]);
    await api('PUT', '/api/dues/late-fees', { enabled: data.enabled === 'true', graceDays: data.graceDays, mode: data.mode, amount: data.amount, maxAmount: data.maxAmount, kinds });
    toast('Late-fee settings saved');
  };
  X.actions['dues-run'] = async () => {
    const r = await api('POST', '/api/dues/run');
    toast(`Checked: ${r.lateFees.created} new late fee${r.lateFees.created === 1 ? '' : 's'}, ${r.packages} monthly charge${r.packages === 1 ? '' : 's'}, ${r.discounts.expired} discount${r.discounts.expired === 1 ? '' : 's'} expired`);
  };
  X.submits['give-discount'] = async (data) => {
    const r = await api('POST', `/api/dues/charges/${data.chargeId}/discount`, data);
    toast(r.offer ? `Discount given until ${r.offer.validUntil}` : 'Discount given');
  };
  X.actions['discount-cancel'] = async (el) => { await api('POST', `/api/dues/discounts/${el.dataset.id}/cancel`); toast('Discount withdrawn'); };

  // ---------- property page ----------
  X.loaders.site = async () => {
    if (!cache.coreLoadedAt) await loadCore();
    if (!s.site.buildingId) s.site.buildingId = firstBuilding();
    d.site = s.site.buildingId ? await api('GET', `/api/sites/${s.site.buildingId}`) : null;
  };
  X.views.site = () => {
    const head = page('Property page', 'A free page for each property that you can share on WhatsApp, Instagram or Google. Enquiries arrive in Leads.', `<select data-ext-change="state" data-key="site.buildingId" aria-label="Property">${buildingOptions(s.site.buildingId)}</select>`);
    const p = d.site;
    if (!p) return head + card('', '<p class="muted">Add a property first.</p>');
    const url = `${location.origin}/p/${p.slug}`;
    const share = p.published ? card('Your page is live', `<p><a href="/p/${h(p.slug)}" target="_blank" rel="noopener"><b>${h(url)}</b></a> · ${p.views} view${p.views === 1 ? '' : 's'}</p>
      <div class="row-actions"><button class="btn small" data-action="copy-text" data-text="${h(url)}">Copy link</button><a class="btn small secondary" href="https://wa.me/?text=${encodeURIComponent(`${p.buildingName}: rooms available. See photos, rent and free beds: ${url}`)}" target="_blank" rel="noopener">${waIcon} Share on WhatsApp</a><a class="btn small secondary" href="/p/${h(p.slug)}" target="_blank" rel="noopener">Open page</a></div>`, 'site-live') : '';
    const photos = card(`Photos <small>${p.photos.length}/12</small>`, `${p.exists ? `<label class="btn small secondary file-btn">Add photo<input type="file" accept="image/jpeg,image/png,image/webp" data-site-photo hidden></label>` : '<p class="muted">Save the page once to add photos.</p>'}
      <div class="site-photos">${p.photos.map((ph) => `<figure><img src="${h(ph.url)}" alt="" loading="lazy"><button class="btn small danger" data-action="site-photo-delete" data-id="${ph.id}">Remove</button></figure>`).join('')}</div>`);
    const form = card('Page details', `<form data-submit="save-site"><div class="form-grid cols-3">
      <div class="form-field"><label><input type="checkbox" name="published" value="true" ${p.published ? 'checked' : ''}> Page is public</label></div>
      ${field('Page address', `<div class="input-prefix"><span>/p/</span><input name="slug" value="${h(p.slug)}" pattern="[a-z0-9-]{3,60}" required></div>`)}
      ${field('Who can stay', `<select name="gender">${[['any', 'Everyone'], ['boys', 'Boys only'], ['girls', 'Girls only'], ['family', 'Families']].map(([k, v]) => opt(k, v, p.gender)).join('')}</select>`)}
      ${field('Headline', `<input name="headline" maxlength="120" value="${h(p.headline)}" placeholder="e.g. Fully furnished rooms 5 minutes from the metro">`, '1 / -1')}
      ${field('About the property', `<textarea name="about" rows="4" maxlength="3000">${h(p.about)}</textarea>`, '1 / -1')}
      ${field('House rules', `<textarea name="houseRules" rows="3" maxlength="2000">${h(p.houseRules)}</textarea>`, '1 / -1')}
      ${field('Contact name', `<input name="contactName" maxlength="80" value="${h(p.contactName)}">`)}${field('Contact phone (WhatsApp)', `<input name="contactPhone" inputmode="tel" value="${h(p.contactPhone)}">`)}${field('Google Maps link', `<input name="mapLink" value="${h(p.mapLink)}" placeholder="https://maps.app.goo.gl/…">`)}
      ${field('Token to reserve a bed (₹, 0 = off)', `<input type="number" name="token" min="0" step="1" value="${p.token}">`)}
      <div class="form-field"><label><input type="checkbox" name="showRent" value="true" ${p.showRent ? 'checked' : ''}> Show rent</label><label><input type="checkbox" name="showVacancy" value="true" ${p.showVacancy ? 'checked' : ''}> Show free beds</label></div>
      </div><p class="profile-note">Rooms, rent, free beds and amenities come from your property automatically. The token is paid by UPI to the UPI ID in Settings.</p>
      <div class="form-actions"><button class="btn" type="submit">Save page</button></div></form>`);
    return head + share + form + photos;
  };
  X.submits['save-site'] = async (data) => {
    await api('PUT', `/api/sites/${s.site.buildingId}`, { ...data, published: data.published === 'true', showRent: data.showRent === 'true', showVacancy: data.showVacancy === 'true' });
    toast(data.published === 'true' ? 'Page saved and public' : 'Page saved (not public yet)');
  };
  X.actions['site-photo-delete'] = async (el) => { await api('DELETE', `/api/sites/${s.site.buildingId}/photos/${el.dataset.id}`); toast('Photo removed'); };
  X.actions['copy-text'] = async (el) => { try { await navigator.clipboard.writeText(el.dataset.text); toast('Link copied'); } catch { window.prompt('Copy this link', el.dataset.text); } return false; };
  document.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-site-photo]');
    if (!input?.files?.[0]) return;
    try {
      const upload = await X.helpers.readFile(input.files[0], { types: ['image/jpeg', 'image/png', 'image/webp'] });
      await api('POST', `/api/sites/${s.site.buildingId}/photos`, upload);
      toast('Photo added');
      invalidateData(); await render();
    } catch (err) { toast(err.message, true); } finally { input.value = ''; }
  });

  // ---------- dashboard additions ----------
  const baseDashboardExtras = X.dashboardExtras;
  const baseLoadDashboardExtras = X.loadDashboardExtras;
  X.loadDashboardExtras = async () => {
    await Promise.all([baseLoadDashboardExtras(), api('GET', '/api/occupancy').then((o) => { d.dashOcc = o.summary; }).catch(() => { d.dashOcc = null; }),
      can('tenants.manage') ? api('GET', '/api/bookings?status=open').then((b) => { d.dashBookings = b; }).catch(() => { d.dashBookings = []; }) : null]);
  };
  X.dashboardExtras = () => {
    const o = d.dashOcc;
    const due = (d.dashBookings || []).filter((b) => b.dueToMoveIn).length;
    return `${o && o.beds ? `<span class="dm-item">Beds occupied <b>${o.occupied}/${o.beds}</b> (${o.occupancyRate}%)</span><span class="dm-item"><button type="button" class="link-btn" data-nav="occupancy">Occupancy →</button></span>` : ''}${due ? `<span class="dm-item"><button type="button" class="link-btn" data-action="go-bookings">${due} to move in today →</button></span>` : ''}${baseDashboardExtras()}`;
  };

  // ================= Hostel window =================
  const MEAL_TEXT = { breakfast: 'Breakfast', lunch: 'Lunch', snacks: 'Snacks', dinner: 'Dinner' };
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ATT = [['present', 'P', 'Present'], ['late', 'L', 'Late'], ['absent', 'A', 'Absent'], ['leave', 'Lv', 'On leave']];
  const hs = () => s.hostel;
  const hDate = () => hs().date || today();
  X.loaders.hostel = async () => {
    // Opened straight into the Hostel (its own window): properties may not be loaded yet.
    if (!cache.coreLoadedAt) await loadCore();
    const H = hs();
    if (!H.buildingId) H.buildingId = (cache.buildings || []).find((b) => b.propertyType === 'pg_hostel' && b.status !== 'archived')?.id || firstBuilding();
    if (!H.buildingId) return;
    const b = H.buildingId, date = hDate();
    const jobs = [api('GET', `/api/hostel/overview${qs({ buildingId: b, date })}`).then((r) => { d.hOverview = r; })];
    if (H.tab === 'food') jobs.push(api('GET', `/api/hostel/meals${qs({ buildingId: b, date })}`).then((r) => { d.hMeals = r; }), api('GET', `/api/hostel/menu/${b}`).then((r) => { d.hMenu = r; }));
    if (H.tab === 'attendance') jobs.push(api('GET', `/api/hostel/attendance${qs({ buildingId: b, date })}`).then((r) => { d.hAtt = r; }), state.forms.attMonth ? api('GET', `/api/hostel/attendance/month${qs({ buildingId: b, month: date.slice(0, 7) })}`).then((r) => { d.hAttMonth = r; }) : null);
    if (H.tab === 'leave') jobs.push(api('GET', `/api/hostel/leaves${qs({ buildingId: b })}`).then((r) => { d.hLeaves = r; }), api('GET', `/api/hostel/passes${qs({ buildingId: b })}`).then((r) => { d.hPasses = r; }));
    if (H.tab === 'gate') jobs.push(api('GET', `/api/hostel/gate-log${qs({ buildingId: b, date })}`).then((r) => { d.hGate = r; }), api('GET', `/api/hostel/passes${qs({ buildingId: b, status: 'active' })}`).then((r) => { d.hPasses = r; }));
    if (H.tab === 'tasks') jobs.push(api('GET', `/api/hostel/tasks${qs({ buildingId: b })}`).then((r) => { d.hTasks = r; }));
    if (H.tab === 'assets') jobs.push(api('GET', `/api/hostel/assets${qs({ buildingId: b, condition: H.assetCondition })}`).then((r) => { d.hAssets = r; }));
    if (H.tab === 'notices') jobs.push(api('GET', `/api/hostel/notices${qs({ buildingId: b })}`).then((r) => { d.hNotices = r; }));
    if (H.tab === 'settings') jobs.push(api('GET', `/api/hostel/settings/${b}`).then((r) => { d.hSettings = r; }));
    await Promise.all(jobs);
  };

  X.views.hostel = () => {
    const H = hs();
    const o = d.hOverview;
    const inWindow = document.body.classList.contains('hostel-window');
    const top = `<header class="hostel-top">
      <div class="hostel-title"><span class="hostel-mark">${X.ICONS.hostel ? `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${X.ICONS.hostel}</svg>` : ''}</span><div><b>Hostel</b><small>${h(o?.building?.name || '')}</small></div></div>
      <div class="hostel-controls"><select data-ext-change="state" data-key="hostel.buildingId" aria-label="Property">${buildingOptions(H.buildingId)}</select><input type="date" value="${h(hDate())}" data-ext-change="state" data-key="hostel.date" aria-label="Date">
      ${!inWindow && !isNative() ? '<button class="btn small secondary" data-action="hostel-new-window" title="Open the Hostel in its own browser window">Open in new window ↗</button>' : ''}
      ${inWindow ? '' : '<button class="btn small secondary" data-nav="dashboard">← Back to Rent Ledger</button>'}</div></header>`;
    const counts = o ? { leave: o.pendingLeaves + o.pendingPasses || '', tasks: o.tasksDue || '' } : {};
    const tb = tabs('hostel', 'tab', [['today', 'Today'], ['food', 'Food'], ['attendance', 'Attendance'], ['leave', 'Leave & passes', counts.leave], ['gate', 'Gate register'], ['tasks', 'Tasks', counts.tasks], ['assets', 'Assets'], ['notices', 'Notices'], ['settings', 'Settings']]);
    if (!H.buildingId) return `<div class="hostel-shell">${top}${card('', '<p class="muted">Add a property first.</p>')}</div>`;
    const body = ({ today: hToday, food: hFood, attendance: hAttendance, leave: hLeave, gate: hGate, tasks: hTasks, assets: hAssets, notices: hNotices, settings: hSettings }[H.tab] || hToday)();
    return `<div class="hostel-shell">${top}${tb}<div class="hostel-body">${body}</div></div>`;
  };

  function hToday() {
    const o = d.hOverview;
    if (!o) return '';
    const tile = (lbl, value, tab, cls = '') => `<button type="button" class="stat-card hostel-tile ${cls}" data-action="set-state" data-key="hostel.tab" data-value="${tab}"><div class="stat-label">${h(lbl)}</div><div class="stat-value">${value}</div></button>`;
    const meals = Object.entries(o.meals).map(([m, x]) => `<div class="meal-mini"><b>${h(MEAL_TEXT[m])}</b> <small class="muted">${h(x.time)}</small><div><span class="big">${x.expected}</span> to cook for</div><small class="muted">${x.going} said yes · ${x.notGoing} no · ${x.unmarked} not marked · ${x.onLeave} on leave${x.served ? ` · ${x.served} served` : ''}</small></div>`).join('');
    return `${o.enabledForTenants ? '' : `<div class="notice-strip">Tenants don't see the Hostel tab yet. Save <button class="link-btn" data-action="set-state" data-key="hostel.tab" data-value="settings">Settings</button> once to turn it on for this property.</div>`}
      <div class="stat-grid hostel-stats">
      ${tile('Residents', o.residents, 'attendance')}
      ${tile('Attendance marked', `${o.attendance.marked}/${o.residents}`, 'attendance', o.attendance.marked < o.residents ? 'warn' : 'good')}
      ${tile('Absent', o.attendance.absent, 'attendance', o.attendance.absent ? 'warn' : '')}
      ${tile('On leave today', o.onLeaveToday, 'leave')}
      ${tile('Waiting for approval', o.pendingLeaves + o.pendingPasses, 'leave', o.pendingLeaves + o.pendingPasses ? 'warn' : '')}
      ${tile('Out on a gate pass', o.outNow, 'gate')}
      ${tile('Visitors inside', o.visitorsInside, 'gate')}
      ${tile('Tasks due', o.tasksDue, 'tasks', o.tasksDue ? 'warn' : '')}
      ${tile('Items needing repair', o.assetsNeedingRepair, 'assets', o.assetsNeedingRepair ? 'warn' : '')}
      </div>
      ${o.overdueReturns.length ? card('Not back on time', table(['Name', 'Was due back'], o.overdueReturns.map((r) => [h(r.tenantName), h(r.returnBy.replace('T', ' '))])), 'warn-card') : ''}
      ${card(`Meals on ${h(o.date)}`, meals ? `<div class="meal-minis">${meals}</div>` : '<p class="muted">No meals switched on. Turn them on in Settings.</p>')}
      <p class="profile-note">Curfew ${h(o.settings.curfew)} · roll call ${h(o.settings.rollCallTime)}</p>`;
  }

  function hFood() {
    const m = d.hMeals, menu = d.hMenu;
    if (!m || !menu) return '';
    const mealCards = Object.entries(m.meals).map(([meal, x]) => card(`${h(MEAL_TEXT[meal])} <small>${h(x.time)} · cut-off ${h(x.cutoff)}</small>`, `
      <p><b>${h(m.menu?.[meal] || 'Menu not set')}</b></p>
      <div class="meal-counts"><span><b>${x.expected}</b> to cook</span><span>${x.going} yes</span><span>${x.notGoing} no</span><span>${x.unmarked} not marked</span><span>${x.onLeave} on leave</span><span>${x.served} served</span>${x.averageRating ? `<span>★ ${x.averageRating}</span>` : ''}${x.served && x.wasted ? `<span class="muted">${x.wasted} cooked but not served</span>` : ''}</div>
      ${state.forms[`serve-${meal}`] ? table(['Name', 'Room', 'Said', 'Served'], x.list.map((p) => [h(p.name), `${h(p.room)}${p.bed ? ` · ${h(p.bed)}` : ''}`, h({ going: 'Yes', not_going: 'No', unmarked: '—', leave: 'On leave' }[p.status]), `<button class="btn small ${p.served ? '' : 'secondary'}" data-action="meal-served" data-tenant="${p.tenantId}" data-meal="${meal}" data-served="${p.served ? '0' : '1'}">${p.served ? '✓ Served' : 'Mark served'}</button>`])) : ''}
      <button class="btn small secondary" data-toggle-form="serve-${meal}">${state.forms[`serve-${meal}`] ? 'Hide list' : 'Show list / mark served'}</button>`)).join('');
    const meals = Object.keys(MEAL_TEXT).filter((k) => menu.settings.meals[k]?.on);
    const editor = state.forms.menuEdit ? `<form data-submit="save-menu"><div class="table-wrap"><table class="ledger menu-table"><thead><tr><th>Day</th>${meals.map((k) => `<th>${h(MEAL_TEXT[k])}</th>`).join('')}</tr></thead><tbody>${menu.week.map((row) => `<tr><td><b>${h(DAYS[row.weekday])}</b></td>${meals.map((k) => `<td><input name="m_${row.weekday}_${k}" value="${h(row[k] || '')}" maxlength="300"></td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="form-actions"><button class="btn" type="submit">Save menu</button><button class="btn secondary" type="button" data-toggle-form="menuEdit">Cancel</button></div></form>`
      : table(['Day', ...meals.map((k) => MEAL_TEXT[k])], menu.week.map((row) => [`<b>${h(DAYS[row.weekday])}</b>`, ...meals.map((k) => h(row[k] || '—'))]));
    const others = (cache.buildings || []).filter((b) => b.id !== hs().buildingId && b.status !== 'archived');
    return `${mealCards}${card(`Weekly menu ${state.forms.menuEdit ? '' : '<button class="btn small secondary" data-toggle-form="menuEdit">Edit</button>'}`, `${editor}${others.length && !state.forms.menuEdit ? `<form class="inline-form" data-submit="copy-menu"><label class="muted">Copy this menu to</label><select name="target">${others.map((b) => opt(b.id, b.name)).join('')}</select><button class="btn small secondary" type="submit">Copy</button></form>` : ''}`)}`;
  }

  function hAttendance() {
    const a = d.hAtt;
    if (!a) return '';
    const rows = a.list.map((p) => [`<b>${h(p.name)}</b>${p.onApprovedLeave ? ' <small class="muted">(approved leave)</small>' : ''}`, `${h(p.room)}${p.bed ? ` · ${h(p.bed)}` : ''}`,
      `<div class="att-btns" role="group" aria-label="Attendance for ${h(p.name)}">${ATT.map(([k, short, full]) => `<button type="button" class="att-btn att-${k} ${p.status === k ? 'active' : ''}" data-action="att-mark" data-tenant="${p.tenantId}" data-status="${p.status === k ? '' : k}" title="${full}" aria-pressed="${p.status === k}">${short}</button>`).join('')}</div>`,
      p.mobile ? `<a class="btn small secondary" href="tel:${h(p.mobile)}">Call</a>` : '']);
    const done = a.list.filter((p) => p.status).length;
    const month = state.forms.attMonth && d.hAttMonth ? card(`Month ${h(d.hAttMonth.month)}`, table(['Name', 'Room', 'Present', 'Late', 'Absent', 'Leave'], d.hAttMonth.list.map((x) => [h(x.name), h(x.room), x.present, x.late, x.absent, x.leave]))) : '';
    return `<div class="filter-line"><span><b>${done}/${a.list.length}</b> marked for ${h(a.date)}</span><span class="row-actions"><button class="btn" data-action="att-all-present">Mark everyone else present</button><button class="btn secondary" data-toggle-form="attMonth">${state.forms.attMonth ? 'Hide month' : 'Month summary'}</button></span></div>
      ${card('', table(['Name', 'Room', 'P · Late · A · Leave', ''], rows, { emptyText: 'No residents in this property.' }))}${month}`;
  }

  function hLeave() {
    const leaves = d.hLeaves || [], passes = d.hPasses || [];
    const residents = tenantsOfBuilding(hs().buildingId);
    const leaveRows = leaves.map((l) => [h(l.tenantName), `${h(l.fromDate)} → ${h(l.toDate)}`, h([l.reason, l.goingTo && `to ${l.goingTo}`].filter(Boolean).join(' · ') || '—'), stamp(l.status === 'approved' ? 'paid' : l.status === 'pending' ? 'due' : 'void', label(l.status)),
      l.status === 'pending' ? `<div class="row-actions"><button class="btn small" data-action="leave-decide" data-id="${l.id}" data-approve="1">Approve</button><button class="btn small secondary" data-action="leave-decide" data-id="${l.id}" data-approve="0">Reject</button></div>` : '']);
    const passRows = passes.map((p) => [h(p.tenantName), h(p.purpose || '—'), `${h(p.outAt.replace('T', ' '))} → ${h(p.returnBy.replace('T', ' '))}`, `${stamp(p.overdue ? 'overdue' : p.status === 'out' ? 'partial' : p.status === 'returned' ? 'paid' : p.status === 'pending' ? 'due' : p.status === 'approved' ? 'paid' : 'void', p.overdue ? 'Late' : label(p.status))}${p.late ? ' <small class="muted">came back late</small>' : ''}`, `<code>${h(p.code)}</code>`, passActions(p)]);
    return `<div class="filter-line"><span class="row-actions"><button class="btn secondary" data-toggle-form="addLeave">+ Leave for a tenant</button><button class="btn secondary" data-toggle-form="addPass">+ Gate pass for a tenant</button></span></div>
      ${state.forms.addLeave ? card('Leave', `<form data-submit="hostel-add-leave"><div class="form-grid cols-3">${field('Tenant *', `<select name="tenantId" required>${tenantOptions('', residents)}</select>`)}${field('From *', `<input type="date" name="fromDate" required value="${today()}">`)}${field('To *', `<input type="date" name="toDate" required value="${today()}">`)}${field('Reason', '<input name="reason" maxlength="300">')}${field('Going to', '<input name="goingTo" maxlength="200">')}</div><div class="form-actions"><button class="btn" type="submit">Save (approved)</button></div></form>`) : ''}
      ${state.forms.addPass ? card('Gate pass', `<form data-submit="hostel-add-pass"><div class="form-grid cols-3">${field('Tenant *', `<select name="tenantId" required>${tenantOptions('', residents)}</select>`)}${field('Going out *', `<input type="datetime-local" name="outAt" required value="${nowLocal()}">`)}${field('Back by *', '<input type="datetime-local" name="returnBy" required>')}${field('Purpose', '<input name="purpose" maxlength="200">', '1 / -1')}</div><div class="form-actions"><button class="btn" type="submit">Save (approved)</button></div></form>`) : ''}
      ${card('Leave requests', table(['Name', 'Dates', 'Reason', 'Status', ''], leaveRows, { emptyText: 'No leave requests.' }))}
      ${card('Gate passes', table(['Name', 'Purpose', 'Out → back by', 'Status', 'Code', ''], passRows, { emptyText: 'No gate passes.' }))}`;
  }
  const passActions = (p) => {
    const a = [];
    if (p.status === 'pending') a.push(`<button class="btn small" data-action="pass-decide" data-id="${p.id}" data-approve="1">Approve</button>`, `<button class="btn small secondary" data-action="pass-decide" data-id="${p.id}" data-approve="0">Reject</button>`);
    if (p.status === 'approved') a.push(`<button class="btn small" data-action="pass-move" data-id="${p.id}" data-move="out">Gone out</button>`);
    if (p.status === 'out') a.push(`<button class="btn small" data-action="pass-move" data-id="${p.id}" data-move="in">Came back</button>`);
    return `<div class="row-actions">${a.join('')}</div>`;
  };

  function hGate() {
    const passes = (d.hPasses || []).filter((p) => ['approved', 'out'].includes(p.status));
    const residents = tenantsOfBuilding(hs().buildingId);
    return `<div class="gate-grid">
      ${card('Check a gate pass', `<form class="inline-form" data-submit="pass-code"><input name="code" inputmode="numeric" maxlength="6" placeholder="6-digit code" required><button class="btn small" type="submit">Find</button></form>
        ${d.hFoundPass ? `<div class="found-pass"><b>${h(d.hFoundPass.tenantName)}</b> · ${h(d.hFoundPass.purpose || '')}<br><small class="muted">${h(d.hFoundPass.outAt.replace('T', ' '))} → back by ${h(d.hFoundPass.returnBy.replace('T', ' '))}</small> ${stamp(d.hFoundPass.status)}${passActions(d.hFoundPass)}</div>` : ''}
        ${passes.length ? table(['Name', 'Back by', 'Status', ''], passes.map((p) => [h(p.tenantName), h(p.returnBy.replace('T', ' ')), stamp(p.overdue ? 'overdue' : p.status === 'out' ? 'partial' : 'paid', p.overdue ? 'Late' : label(p.status)), passActions(p)])) : ''}`)}
      ${card('Record entry or exit', `<form data-submit="gate-log"><div class="form-grid">
        ${field('Resident', `<select name="tenantId">${tenantOptions('', residents, 'A visitor (fill in below)')}</select>`)}${field('In or out', `<select name="direction">${opt('in', 'Coming in')}${opt('out', 'Going out')}</select>`)}
        ${field('Visitor name', '<input name="visitorName" maxlength="120">')}${field('Visitor mobile', '<input name="visitorMobile" inputmode="tel">')}${field('Visiting', '<input name="visiting" maxlength="120" placeholder="Who or which room">')}${field('Note', '<input name="note" maxlength="200">')}
        </div><div class="form-actions"><button class="btn" type="submit">Record</button></div></form>`)}
      </div>${card(`Register for ${h(hDate())}`, table(['Time', 'Who', '', 'Details'], (d.hGate || []).map((g) => [h(g.at.slice(11, 16)), `${h(g.who)}${g.isVisitor ? ' <small class="muted">visitor</small>' : ''}`, stamp(g.direction === 'in' ? 'paid' : 'partial', g.direction === 'in' ? 'In' : 'Out'), h([g.visiting && `visiting ${g.visiting}`, g.visitorMobile, g.note].filter(Boolean).join(' · '))]), { emptyText: 'Nothing recorded on this day.' }))}`;
  }

  function hTasks() {
    const all = d.hTasks || [];
    const open = all.filter((t) => t.status === 'open'), done = all.filter((t) => t.status === 'done').slice(0, 30);
    const due = (t) => t.dueOn && t.dueOn < today() ? stamp('overdue', `Due ${t.dueOn}`) : t.dueOn ? h(t.dueOn) : '—';
    return `<div class="filter-line"><span class="muted">Cleaning rounds, repairs and checks for your staff. Repeating tasks come back by themselves when marked done.</span><button class="btn" data-toggle-form="addTask">+ New task</button></div>
      ${state.forms.addTask ? card('New task', `<form data-submit="hostel-add-task"><div class="form-grid cols-3">${field('Task *', '<input name="title" required maxlength="160" placeholder="e.g. Clean washrooms, 2nd floor">')}${field('Assigned to', '<input name="assignee" maxlength="80">')}${field('Due', `<input type="date" name="dueOn" value="${today()}">`)}${field('Repeat', `<select name="repeat">${[['none', 'Once'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month']].map(([k, v]) => opt(k, v)).join('')}</select>`)}${field('Details', '<input name="details" maxlength="1000">', 'span 2')}</div><div class="form-actions"><button class="btn" type="submit">Save</button><button class="btn secondary" type="button" data-toggle-form="addTask">Cancel</button></div></form>`) : ''}
      ${card(`To do <small>${open.length}</small>`, table(['Task', 'Who', 'Due', 'Repeats', ''], open.map((t) => [`<b>${h(t.title)}</b>${t.details ? `<br><small class="muted">${h(t.details)}</small>` : ''}`, h(t.assignee || '—'), due(t), h({ none: '—', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[t.repeat]), `<div class="row-actions"><button class="btn small" data-action="task-done" data-id="${t.id}">Done</button><button class="btn small secondary" data-action="task-delete" data-id="${t.id}">Delete</button></div>`]), { emptyText: 'Nothing to do.' }))}
      ${done.length ? card('Done recently', table(['Task', 'Who', 'Done on', 'Note'], done.map((t) => [h(t.title), h(t.assignee || '—'), h((t.doneAt || '').slice(0, 10)), h(t.doneNote || '')]))) : ''}`;
  }

  const COND_TEXT = { good: 'Good', needs_repair: 'Needs repair', broken: 'Broken', in_storage: 'In storage', retired: 'Retired' };
  function hAssets() {
    const rooms = cache.rooms.filter((r) => r.buildingId === hs().buildingId);
    const list = d.hAssets || [];
    const total = list.reduce((sum, a) => sum + a.quantity, 0);
    return `<div class="filter-line"><select data-ext-change="state" data-key="hostel.assetCondition" aria-label="Condition"><option value="">All conditions</option>${Object.entries(COND_TEXT).map(([k, v]) => opt(k, v, hs().assetCondition)).join('')}</select><button class="btn" data-toggle-form="addAsset">+ Add item</button></div>
      ${state.forms.addAsset ? card('New item', `<form data-submit="hostel-add-asset"><div class="form-grid cols-3">${field('Item *', '<input name="name" required maxlength="120" placeholder="Ceiling fan, Mattress, AC…">')}${field('Category', '<input name="category" maxlength="40" placeholder="Furniture, Electrical…">')}${field('Quantity', '<input type="number" name="quantity" min="0" value="1">')}
        ${field('Room', `<select name="roomId"><option value="">Common area</option>${rooms.map((r) => opt(r.id, r.label)).join('')}</select>`)}${field('Condition', `<select name="condition">${Object.entries(COND_TEXT).map(([k, v]) => opt(k, v, 'good')).join('')}</select>`)}${field('Brand', '<input name="brand" maxlength="80">')}
        ${field('Bought on', '<input type="date" name="purchasedOn">')}${field('Cost (₹)', '<input type="number" name="cost" min="0" step="0.01">')}${field('Warranty until', '<input type="date" name="warrantyUntil">')}</div>
        <div class="form-actions"><button class="btn" type="submit">Save</button><button class="btn secondary" type="button" data-toggle-form="addAsset">Cancel</button></div></form>`) : ''}
      ${card(`Items <small>${total} in total</small>`, table(['Item', 'Room', 'Qty', 'Condition', 'Warranty', ''], list.map((a) => [`<b>${h(a.name)}</b>${a.brand ? ` <small class="muted">${h(a.brand)}</small>` : ''}<br><small class="muted">${h(a.category)}</small>`, h(a.roomLabel || 'Common'), a.quantity,
        `<select data-asset-condition="${a.id}" aria-label="Condition">${Object.entries(COND_TEXT).map(([k, v]) => opt(k, v, a.condition)).join('')}</select>`, a.warrantyUntil ? (a.warrantyUntil < today() ? stamp('void', `Ended ${a.warrantyUntil}`) : h(a.warrantyUntil)) : '—',
        `<button class="btn small secondary" data-action="asset-delete" data-id="${a.id}">Delete</button>`]), { emptyText: 'No items recorded yet.' }))}`;
  }

  function hNotices() {
    return `${card('Post a notice', `<form data-submit="hostel-notice"><div class="form-grid cols-3">${field('Title *', '<input name="title" required maxlength="120">')}${field('For', `<select name="buildingId">${buildingOptions(hs().buildingId)}<option value="">Every property</option></select>`)}${field('Show until', '<input type="date" name="expiresOn">')}${field('Notice', '<textarea name="body" rows="3" maxlength="3000"></textarea>', '1 / -1')}<div class="form-field"><label><input type="checkbox" name="pinned" value="true"> Pin to the top</label></div></div>
      <p class="profile-note">Tenants see it in their Hostel tab and get an in-app alert.</p><div class="form-actions"><button class="btn" type="submit">Post</button></div></form>`)}
      ${card('Notices', table(['Posted', 'Title', 'For', 'Until', ''], (d.hNotices || []).map((n) => [h(n.createdAt.slice(0, 10)), `${n.pinned ? '📌 ' : ''}<b>${h(n.title)}</b>${n.body ? `<br><small class="muted">${h(n.body.slice(0, 160))}</small>` : ''}`, h(n.buildingId ? cache.buildings.find((b) => b.id === n.buildingId)?.name || '' : 'All'), h(n.expiresOn || '—'), `<button class="btn small secondary" data-action="notice-delete" data-id="${n.id}">Delete</button>`]), { emptyText: 'No notices yet.' }))}`;
  }

  function hSettings() {
    const st = d.hSettings;
    if (!st) return '';
    return card('Hostel settings', `<form data-submit="hostel-settings"><div class="table-wrap"><table class="ledger"><thead><tr><th>Meal</th><th>Served</th><th>Time</th><th>Tenants can change until</th></tr></thead><tbody>
      ${Object.keys(MEAL_TEXT).map((m) => `<tr><td><b>${MEAL_TEXT[m]}</b></td><td><input type="checkbox" name="on_${m}" value="1" ${st.meals[m].on ? 'checked' : ''} aria-label="${MEAL_TEXT[m]} served"></td><td><input type="time" name="time_${m}" value="${h(st.meals[m].time)}"></td><td><input type="time" name="cutoff_${m}" value="${h(st.meals[m].cutoff)}"></td></tr>`).join('')}
      </tbody></table></div><div class="form-grid cols-3">
      ${field('If a tenant doesn’t say', `<select name="mealDefault">${opt('going', 'Count them as eating', st.mealDefault)}${opt('not_going', 'Count them as not eating', st.mealDefault)}</select>`)}
      ${field('Curfew', `<input type="time" name="curfew" value="${h(st.curfew)}">`)}${field('Roll call', `<input type="time" name="rollCallTime" value="${h(st.rollCallTime)}">`)}
      <div class="form-field"><label><input type="checkbox" name="gatePassApproval" value="true" ${st.gatePassApproval ? 'checked' : ''}> Gate passes need approval</label></div></div>
      <p class="profile-note">Saving also turns on the Hostel tab for tenants of this property (menu, meals, leave, gate passes and notices).</p>
      <div class="form-actions"><button class="btn" type="submit">Save settings</button></div></form>`);
  }

  // Hostel actions
  X.actions['hostel-new-window'] = () => { const w = window.open(`${location.origin}/?window=hostel`, 'rent-ledger-hostel', 'popup,width=1240,height=860'); if (!w) toast('Allow pop-ups to open the Hostel in its own window.', true); return false; };
  X.actions['meal-served'] = async (el) => { await api('POST', '/api/hostel/meals/mark', { tenantId: el.dataset.tenant, meal: el.dataset.meal, date: hDate(), served: el.dataset.served === '1' }); };
  X.submits['save-menu'] = async (data) => {
    const items = [];
    for (const [k, v] of Object.entries(data)) { const m = /^m_(\d)_(\w+)$/.exec(k); if (m) items.push({ weekday: Number(m[1]), meal: m[2], items: v }); }
    await api('PUT', `/api/hostel/menu/${hs().buildingId}`, { items }); state.forms.menuEdit = false; toast('Menu saved');
  };
  X.submits['copy-menu'] = async (data) => { await api('POST', `/api/hostel/menu/${hs().buildingId}/copy-to/${data.target}`); toast('Menu copied'); };
  X.actions['att-mark'] = async (el) => { await api('POST', '/api/hostel/attendance', { buildingId: hs().buildingId, date: hDate(), marks: [{ tenantId: el.dataset.tenant, status: el.dataset.status }] }); };
  X.actions['att-all-present'] = async () => { const r = await api('POST', '/api/hostel/attendance', { buildingId: hs().buildingId, date: hDate(), allPresent: true }); toast(`${r.saved} marked`); };
  X.actions['leave-decide'] = async (el) => { await api('POST', `/api/hostel/leaves/${el.dataset.id}/decide`, { approve: el.dataset.approve === '1' }); toast(el.dataset.approve === '1' ? 'Leave approved' : 'Leave rejected'); };
  X.actions['pass-decide'] = async (el) => { await api('POST', `/api/hostel/passes/${el.dataset.id}/decide`, { approve: el.dataset.approve === '1' }); d.hFoundPass = null; toast(el.dataset.approve === '1' ? 'Gate pass approved' : 'Gate pass rejected'); };
  X.actions['pass-move'] = async (el) => { const p = await api('POST', `/api/hostel/passes/${el.dataset.id}/${el.dataset.move}`); d.hFoundPass = null; toast(el.dataset.move === 'out' ? `${p.tenantName} went out` : p.late ? `${p.tenantName} came back late` : `${p.tenantName} is back`); };
  X.submits['pass-code'] = async (data) => { try { d.hFoundPass = await api('GET', `/api/hostel/passes/by-code/${encodeURIComponent(data.code)}`); } catch { d.hFoundPass = null; toast('No active gate pass with that code.', true); } };
  X.submits['hostel-add-leave'] = async (data) => { await api('POST', '/api/hostel/leaves', data); state.forms.addLeave = false; toast('Leave saved'); };
  X.submits['hostel-add-pass'] = async (data) => { await api('POST', '/api/hostel/passes', data); state.forms.addPass = false; toast('Gate pass saved'); };
  X.submits['gate-log'] = async (data) => { await api('POST', '/api/hostel/gate-log', { ...data, buildingId: hs().buildingId }); toast('Recorded'); };
  X.submits['hostel-add-task'] = async (data) => { await api('POST', '/api/hostel/tasks', { ...data, buildingId: hs().buildingId }); state.forms.addTask = false; toast('Task added'); };
  X.actions['task-done'] = async (el) => { const r = await api('POST', `/api/hostel/tasks/${el.dataset.id}/done`); toast(r.nextTask ? `Done. Next one due ${r.nextTask.dueOn}` : 'Done'); };
  X.actions['task-delete'] = async (el) => { await api('DELETE', `/api/hostel/tasks/${el.dataset.id}`); toast('Task deleted'); };
  X.submits['hostel-add-asset'] = async (data) => { await api('POST', '/api/hostel/assets', { ...data, buildingId: hs().buildingId }); state.forms.addAsset = false; toast('Item added'); };
  X.actions['asset-delete'] = async (el) => { if (!(await confirmDialog('Delete this item from the list?', { title: 'Delete item?', confirmLabel: 'Delete', danger: true }))) return false; await api('DELETE', `/api/hostel/assets/${el.dataset.id}`); toast('Item deleted'); };
  document.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-asset-condition]');
    if (!sel) return;
    try { await api('PUT', `/api/hostel/assets/${sel.dataset.assetCondition}`, { condition: sel.value }); toast('Condition updated'); } catch (err) { toast(err.message, true); }
  });
  X.submits['hostel-notice'] = async (data, form) => { await api('POST', '/api/hostel/notices', { ...data, pinned: data.pinned === 'true' }); form.reset(); toast('Notice posted'); };
  X.actions['notice-delete'] = async (el) => { await api('DELETE', `/api/hostel/notices/${el.dataset.id}`); toast('Notice deleted'); };
  X.submits['hostel-settings'] = async (data) => {
    const meals = {};
    for (const m of Object.keys(MEAL_TEXT)) meals[m] = { on: Boolean(data[`on_${m}`]), time: data[`time_${m}`], cutoff: data[`cutoff_${m}`] };
    await api('PUT', `/api/hostel/settings/${hs().buildingId}`, { meals, mealDefault: data.mealDefault, curfew: data.curfew, rollCallTime: data.rollCallTime, gatePassApproval: data.gatePassApproval === 'true' });
    toast('Hostel settings saved');
  };

  // The Hostel as its own window: /?window=hostel opens straight into it,
  // without the rest of the app around it.
  const params = new URLSearchParams(location.search);
  if (params.get('window') === 'hostel') {
    document.body.classList.add('hostel-window');
    state.view = 'hostel';
    document.title = 'Hostel · Rent Ledger';
  }
  const baseAfterRender = X.afterRender;
  X.afterRender = () => {
    baseAfterRender?.();
    document.body.classList.toggle('hostel-mode', state.view === 'hostel' && session?.user?.role !== 'tenant');
  };

  // ================= tenant: Hostel tab =================
  const baseTenantNav = X.tenantNav;
  X.tenantNav = () => {
    const html = baseTenantNav();
    if (!X.tenantHostel) return html;
    return html.replace('</nav>', `<button type="button" class="${state.tenantView === 'hostel' ? 'active' : ''}" data-tenant-nav="hostel">Hostel</button></nav>`);
  };
  const baseBeforeTenant = X.beforeTenantRender;
  X.beforeTenantRender = async () => {
    await baseBeforeTenant();
    if (X.tenantHostel === undefined || state.tenantView === 'hostel') {
      try { const r = await api('GET', '/api/tenant/hostel'); X.tenantHostel = r.enabled; d.tHostel = r; } catch { X.tenantHostel = false; }
    }
  };
  // Phones: Hostel replaces Documents in the bottom bar when it is on (Documents stays in the top tabs).
  const baseTenantMobileNav = X.tenantMobileNav;
  X.tenantMobileNav = () => {
    const html = baseTenantMobileNav();
    if (!X.tenantHostel) return html;
    return html.replace(/<button type="button" class="mnav-btn[^"]*" data-tenant-nav="documents">[\s\S]*?<\/button>/, `<button type="button" class="mnav-btn ${state.tenantView === 'hostel' ? 'active' : ''}" data-tenant-nav="hostel"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${X.ICONS.hostel}</svg><span>Hostel</span></button>`);
  };
  const tenantShell = (title, sub, body) => `<div class="tenant-shell"><header class="tenant-top"><div class="brand">Rent Ledger <span class="brand-mark">TENANT</span></div><div class="tenant-user">${window.RL_I18N ? RL_I18N.picker() : ''}${X.tenantBell()}<button class="logout" data-logout>Sign out</button></div></header><main class="tenant-main">${X.tenantNav()}<p class="kicker">${h(sub)}</p><h1>${h(title)}</h1>${body}</main></div>`;
  X.tenantViews.hostel = () => {
    const t = d.tHostel;
    if (!t) return tenantShell('Hostel', 'YOUR HOSTEL', '<p class="muted">Not available.</p>');
    const notices = t.notices.length ? card('Notices', t.notices.map((n) => `<div class="notice-item">${n.pinned ? '📌 ' : ''}<b>${h(n.title)}</b> <small class="muted">${h(n.createdAt.slice(0, 10))}</small>${n.body ? `<p>${h(n.body)}</p>` : ''}</div>`).join('')) : '';
    const days = t.days.map((day) => card(`${h(day.date === today() ? 'Today' : day.date === plus(today(), 1) ? 'Tomorrow' : DAYS[day.weekday])} <small>${h(day.date)}</small>${day.onLeave ? ' <small class="muted">· on leave</small>' : ''}`, day.meals.map((m) => `<div class="tmeal"><div><b>${h(MEAL_TEXT[m.meal])}</b> <small class="muted">${h(m.time)}</small><div class="muted">${h(m.menu || 'Menu not set')}</div></div>
      <div class="tmeal-act">${m.choice === 'leave' ? '<span class="muted">On leave</span>' : m.served ? (m.rating ? `<span>★ ${m.rating}</span>` : `<span class="rate">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="chip-btn" data-action="t-meal-rate" data-date="${day.date}" data-meal="${m.meal}" data-rating="${n}" aria-label="${n} stars">★${n}</button>`).join('')}</span>`) : m.canChange
        ? `<button type="button" class="chip-btn ${m.choice === 'going' ? 'active' : ''}" data-action="t-meal" data-date="${day.date}" data-meal="${m.meal}" data-going="1">I'll eat</button><button type="button" class="chip-btn ${m.choice === 'not_going' ? 'active' : ''}" data-action="t-meal" data-date="${day.date}" data-meal="${m.meal}" data-going="0">Skip</button>`
        : `<span class="muted">${m.choice === 'going' ? 'Eating' : m.choice === 'not_going' ? 'Skipping' : m.defaultChoice === 'going' ? 'Counted as eating' : 'Not marked'} · closed at ${h(m.cutoff)}</span>`}</div></div>`).join('') || '<p class="muted">No meals today.</p>', 'tmeal-card')).join('');
    const leaveForm = state.forms.tLeave ? `<form data-submit="t-leave"><div class="form-grid">${field('From *', `<input type="date" name="fromDate" required min="${today()}" value="${today()}">`)}${field('To *', `<input type="date" name="toDate" required min="${today()}" value="${today()}">`)}${field('Reason', '<input name="reason" maxlength="300">')}${field('Going to', '<input name="goingTo" maxlength="200">')}</div><div class="form-actions"><button class="btn" type="submit">Ask for leave</button><button class="btn secondary" type="button" data-toggle-form="tLeave">Cancel</button></div></form>` : '<button class="btn small" data-toggle-form="tLeave">Ask for leave</button>';
    const passForm = state.forms.tPass ? `<form data-submit="t-pass"><div class="form-grid">${field('Going out *', `<input type="datetime-local" name="outAt" required value="${nowLocal()}">`)}${field('Back by *', '<input type="datetime-local" name="returnBy" required>')}${field('Purpose', '<input name="purpose" maxlength="200">')}</div><div class="form-actions"><button class="btn" type="submit">${t.settings.gatePassApproval ? 'Ask for a gate pass' : 'Get a gate pass'}</button><button class="btn secondary" type="button" data-toggle-form="tPass">Cancel</button></div></form>` : '<button class="btn small" data-toggle-form="tPass">Gate pass</button>';
    const leaves = table(['Dates', 'Reason', 'Status', ''], t.leaves.map((l) => [`${h(l.fromDate)} → ${h(l.toDate)}`, h(l.reason || '—'), stamp(l.status === 'approved' ? 'paid' : l.status === 'pending' ? 'due' : 'void', label(l.status)), ['pending', 'approved'].includes(l.status) && l.fromDate >= today() ? `<button class="btn small secondary" data-action="t-cancel" data-kind="leaves" data-id="${l.id}">Cancel</button>` : '']), { emptyText: 'No leave requests.' });
    const passes = table(['When', 'Status', 'Code', ''], t.passes.map((p) => [`${h(p.outAt.replace('T', ' '))} → ${h(p.returnBy.replace('T', ' '))}${p.purpose ? `<br><small class="muted">${h(p.purpose)}</small>` : ''}`, stamp(p.status === 'approved' || p.status === 'returned' ? 'paid' : p.status === 'pending' ? 'due' : p.status === 'out' ? 'partial' : 'void', label(p.status)), p.status === 'approved' || p.status === 'out' ? `<code class="pass-code">${h(p.code)}</code>` : '—', ['pending', 'approved'].includes(p.status) ? `<button class="btn small secondary" data-action="t-cancel" data-kind="passes" data-id="${p.id}">Cancel</button>` : '']), { emptyText: 'No gate passes.' });
    const att = t.attendance.length ? `<div class="att-history">${t.attendance.map((a) => `<span class="att-day att-${a.status}" title="${h(a.date)}: ${h(label(a.status))}">${h(a.date.slice(8))}</span>`).join('')}</div>` : '<p class="muted">No attendance recorded yet.</p>';
    return tenantShell('Hostel', `CURFEW ${t.settings.curfew}`, `${notices}<h2 class="t-sub">Meals</h2><div class="tmeal-grid">${days}</div>
      <section class="tenant-bills">${card('Leave', `${leaveForm}${leaves}`)}${card('Gate passes', `<p class="profile-note">Show the code to the guard when you go out.</p>${passForm}${passes}`)}${card('Attendance (last 30 days)', att)}</section>`);
  };
  X.actions['t-meal'] = async (el) => { await api('POST', '/api/tenant/hostel/meals', { date: el.dataset.date, meal: el.dataset.meal, going: el.dataset.going === '1' }); };
  X.actions['t-meal-rate'] = async (el) => { await api('POST', '/api/tenant/hostel/meals/rate', { date: el.dataset.date, meal: el.dataset.meal, rating: Number(el.dataset.rating) }); toast('Thanks for rating'); };
  X.actions['t-cancel'] = async (el) => { await api('POST', `/api/tenant/hostel/${el.dataset.kind}/${el.dataset.id}/cancel`); toast('Cancelled'); };
  X.submits['t-leave'] = async (data) => { await api('POST', '/api/tenant/hostel/leaves', data); state.forms.tLeave = false; toast('Leave request sent'); };
  X.submits['t-pass'] = async (data) => { const p = await api('POST', '/api/tenant/hostel/passes', data); state.forms.tPass = false; toast(p.status === 'pending' ? 'Gate pass request sent' : `Gate pass ready. Code ${p.code}`); };
})();
