// ---------- tiny state machine ----------
const state = {
  view: "dashboard", // dashboard | building | room | profile
  buildingId: null,
  roomId: null,
  roomTab: "tenant", // tenant | rent | electricity
  tenantView: "home", // home | profile
  forms: {}, // toggle flags e.g. forms.addBuilding = true
};

const session = JSON.parse(localStorage.getItem('rentLedgerSession') || 'null');
const authState = { resetContact: '' };
const tenantReceiptState = { kind: '', entryId: '' };
let deferredInstallPrompt = null;
const isMobileApp = Boolean(window.Capacitor?.isNativePlatform?.()) || window.location.protocol === 'capacitor:' || window.location.protocol === 'file:';
const browserPlatform = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : /Windows/i.test(navigator.userAgent) ? 'windows' : /Macintosh/i.test(navigator.userAgent) ? 'macos' : 'web';
document.documentElement.dataset.platform = browserPlatform;
document.documentElement.dataset.formFactor = matchMedia('(max-width: 860px)').matches ? 'phone' : matchMedia('(max-width: 1180px)').matches ? 'tablet' : 'desktop';
addEventListener('resize', () => { document.documentElement.dataset.formFactor = matchMedia('(max-width: 860px)').matches ? 'phone' : matchMedia('(max-width: 1180px)').matches ? 'tablet' : 'desktop'; });
addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  showInstallOption();
});
addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  document.getElementById('install-app-button')?.remove();
  toast('Rent Ledger is installed on this device.');
});

function showInstallOption() {
  if (!deferredInstallPrompt || isMobileApp || document.getElementById('install-app-button')) return;
  const button = document.createElement('button');
  button.id = 'install-app-button';
  button.className = 'install-app-button';
  button.type = 'button';
  button.textContent = 'Install app';
  button.onclick = async () => {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    button.remove();
  };
  document.body.appendChild(button);
}

function installHelpText() {
  if (browserPlatform === 'ios') return 'On iPhone/iPad: open this page in Safari, tap Share, then Add to Home Screen.';
  if (browserPlatform === 'android') return 'On Android: use Chrome’s ⋮ menu, then tap Install app or Add to Home screen.';
  if (browserPlatform === 'windows' || browserPlatform === 'macos') return 'On a computer: open this page in Chrome or Edge, then use the install icon in the address bar.';
  return 'Open this page in Chrome or Edge, then use its Install app option.';
}

async function requestAppInstall() {
  if (!deferredInstallPrompt) return toast(installHelpText());
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.getElementById('install-app-button')?.remove();
}
function apiBase() { return isMobileApp ? (localStorage.getItem('rentLedgerApiBase') || '') : ''; }
function apiUrl(url) { return apiBase() ? apiBase().replace(/\/$/, '') + url : url; }

const cache = { buildings: [], rooms: [], tenants: [], authorities: [], dashboard: null, rent: [], electricity: [], buildingRent: [], profile: null, tenantPortal: null, tenantProfile: null, coreLoadedAt: 0, tenantLoadedAt: 0 };

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------- API helpers ----------
async function api(method, url, body) {
  if (isMobileApp && !apiBase()) throw new Error('Enter your Mac’s Wi-Fi address below and tap “Save server address” before signing in.');
  const res = await fetch(apiUrl(url), {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('The Mac server address is incorrect. Run “npm start” on your Mac and enter the exact http://…:4000 Wi-Fi link shown in Terminal.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || "Request failed");
  }
  return res.status === 204 ? null : res.json();
}

async function uploadReceipt(kind, entryId, file) {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (!allowedTypes.includes(file.type)) throw new Error('Choose a JPG, PNG, WEBP image or PDF receipt.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Receipt must be 10 MB or smaller.');
  const encodedFile = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('The selected file could not be read.'));
    reader.readAsDataURL(file);
  });
  const res = await fetch(apiUrl(`/api/tenant/${kind}/${entryId}/receipt`), {
    method: 'POST', headers: { Authorization: `Bearer ${session?.token || ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: encodedFile, mimeType: file.type, originalName: file.name }),
  });
  const data = await res.json().catch(() => ({ error: 'Upload failed' }));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

async function openReceipt(receiptId) {
  const res = await fetch(apiUrl(`/api/receipts/${receiptId}`), { headers: { Authorization: `Bearer ${session?.token || ''}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Unable to open receipt' }));
    throw new Error(data.error || 'Unable to open receipt');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const receiptWindow = window.open(url, '_blank', 'noopener');
  if (!receiptWindow) throw new Error('Allow pop-ups in your browser to view the receipt.');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function toast(msg, isError) {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------- formatting ----------
function fmtMoney(n) {
  const v = Number(n) || 0;
  return "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
function today() { return new Date().toISOString().slice(0, 10); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- data loading ----------
function invalidateData() { cache.coreLoadedAt = 0; cache.tenantLoadedAt = 0; }
async function loadCore() {
  if (cache.coreLoadedAt && Date.now() - cache.coreLoadedAt < 4_000) return;
  const [buildings, rooms, tenants, authorities] = await Promise.all([
    api("GET", "/api/buildings"),
    api("GET", "/api/rooms"),
    api("GET", "/api/tenants"),
    api("GET", "/api/authorities"),
  ]);
  cache.buildings = buildings;
  cache.rooms = rooms;
  cache.tenants = tenants;
  cache.authorities = authorities;
  cache.coreLoadedAt = Date.now();
}

// ---------- render dispatch ----------
async function render() {
  if (!session) { document.getElementById('app').innerHTML = renderAuth(); attachAuthHandlers(); return; }
  if (session.user.role === 'tenant') {
    try {
      if (!cache.tenantPortal || !cache.tenantLoadedAt || Date.now() - cache.tenantLoadedAt > 4_000) {
        cache.tenantPortal = await api('GET', '/api/tenant/portal');
        cache.tenantLoadedAt = Date.now();
      }
      if (state.tenantView === 'profile' && !cache.tenantProfile) cache.tenantProfile = await api('GET', '/api/account/profile');
    }
    catch (e) { toast(e.message, true); logout(); return; }
    document.getElementById('app').innerHTML = state.tenantView === 'profile' ? renderTenantProfile() : renderTenantPortal(); attachTenantHandlers(); return;
  }
  try {
    await loadCore();
    if (state.view === 'profile' && !cache.profile) cache.profile = await api('GET', '/api/account/profile');
    if (state.view === "dashboard") cache.dashboard = await api("GET", "/api/dashboard");
    if (state.view === "building" && state.buildingId) cache.buildingRent = await api("GET", `/api/rent?buildingId=${state.buildingId}`);
    if (state.view === "room" && state.roomId) {
      const [rent, electricity] = await Promise.all([
        api("GET", `/api/rent?roomId=${state.roomId}`),
        api("GET", `/api/electricity?roomId=${state.roomId}`),
      ]);
      cache.rent = rent.sort((a, b) => b.year - a.year || b.month - a.month);
      cache.electricity = electricity.sort((a, b) => b.year - a.year || b.month - a.month);
    }
  } catch (e) {
    toast(e.message, true);
  }

  const app = document.getElementById("app");
  app.innerHTML = renderSidebar() + `<div class="main page-enter">${renderMain()}</div>`;
  attachHandlers();
}

function loginMarkup(role = 'owner') {
  return `<p class="kicker">WELCOME BACK</p><h2>Sign in as ${role === 'owner' ? 'owner' : 'tenant'}</h2><p class="auth-muted">${role === 'owner' ? 'Your complete property workspace awaits.' : 'View your rent and electricity bill in one place.'}</p><form data-auth="login"><input type="hidden" name="role" value="${role}"><label>Mobile number or email<input name="contact" required placeholder="you@example.com"></label><label>Password<input name="password" type="password" required placeholder="••••••••"></label><button class="btn auth-submit">Sign in <span>→</span></button></form><p class="auth-alt"><button data-auth-toggle="request-password-reset">Forgot password?</button></p><p class="auth-alt">New here? <button data-auth-toggle="signup">Create an account</button></p>`;
}

function renderAuth() {
  const serverSetup = isMobileApp ? `<form class="server-setup" data-server-url><label>Mac server address<input name="serverUrl" required value="${esc(apiBase())}" placeholder="http://192.168.1.20:4000"></label><button class="link-btn">Save server address</button><small>Connect your phone and Mac to the same Wi-Fi.</small></form>` : '';
  const installGuide = isMobileApp ? '' : `<div class="install-guide"><div><span class="install-guide-icon">⇩</span><div><strong>Use Rent Ledger like an app</strong><small>${esc(installHelpText())}</small></div></div><button type="button" data-install-app>Install app</button></div>`;
  return `<div class="auth-shell"><section class="auth-art"><div class="brand auth-brand">Rent Ledger <span class="brand-mark">HOME</span></div><div class="auth-copy"><p class="kicker">PROPERTY, SIMPLIFIED</p><h1>A calmer way to manage every key.</h1><p>Keep rent, electricity, rooms and tenant records in one considered place.</p><div class="auth-pills"><span>◈ Owner command centre</span><span>◌ Private tenant billing</span></div></div><div class="auth-foot">Made for modern rental homes</div></section><section class="auth-panel"><div class="auth-card"><div class="role-switch"><button class="role-btn active" data-role="owner">Owner</button><button class="role-btn" data-role="tenant">Tenant</button></div><div id="auth-form">${loginMarkup()}</div>${installGuide}${serverSetup}</div></section></div>`;
}

function authForm(mode, role) {
  const form = document.getElementById('auth-form');
  if (mode === 'signup') {
    form.innerHTML = `<p class="kicker">CREATE ACCOUNT</p><h2>Join as a ${role}</h2><p class="auth-muted">${role === 'tenant' ? 'Use the mobile number your owner saved for you.' : 'Create your private owner workspace.'}</p><form data-auth="signup"><input type="hidden" name="role" value="${role}"><label>Full name<input name="name" required placeholder="Your name"></label><label>${role === 'tenant' ? 'Registered mobile number' : 'Mobile number or email'}<input name="contact" required></label><label>Create password<input name="password" type="password" minlength="4" required placeholder="At least 4 characters"></label><button class="btn auth-submit">Create account <span>→</span></button></form><p class="auth-alt">Already have access? <button data-auth-toggle="login">Sign in</button></p>`;
  } else if (mode === 'request-password-reset') {
    form.innerHTML = `<p class="kicker">PASSWORD RESET</p><h2>Get a one-time code</h2><p class="auth-muted">Enter the mobile number or email used for your account. We will send a 6-digit verification code.</p><form data-auth="request-password-reset"><input type="hidden" name="role" value="${role}"><label>Mobile number or email<input name="contact" required placeholder="you@example.com"></label><button class="btn auth-submit">Send code <span>→</span></button></form><p class="auth-alt"><button data-auth-toggle="login">Back to sign in</button></p>`;
  } else if (mode === 'reset-password') {
    form.innerHTML = `<p class="kicker">VERIFY CODE</p><h2>Create a new password</h2><p class="auth-muted">Enter the 6-digit code sent to you. It expires after 10 minutes.</p><form data-auth="reset-password"><input type="hidden" name="role" value="${role}"><input type="hidden" name="contact" value="${esc(authState.resetContact)}"><label>Verification code<input name="otp" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required placeholder="123456"></label><label>New password<input name="password" type="password" minlength="4" required placeholder="At least 4 characters"></label><button class="btn auth-submit">Reset password <span>→</span></button></form><p class="auth-alt"><button data-auth-toggle="request-password-reset">Send a new code</button></p>`;
  } else {
    form.innerHTML = loginMarkup(role);
  }
  // The form markup is dynamically replaced, so bind its new submit/toggle controls immediately.
  attachAuthHandlers();
}

function renderTenantPortal() {
  const d = cache.tenantPortal, rentDue = d.rent.filter(x => x.status !== 'paid').reduce((s,x) => s + Math.max(x.rentAmount-x.amountPaid,0),0), elecDue = d.electricity.filter(x => x.status !== 'paid').reduce((s,x) => s + x.amount,0);
  const billRows = (entries, type) => entries.slice(0,6).map(e => {
    const proof = e.receipt
      ? `<button class="btn small secondary" data-tenant-action="view-receipt" data-receipt-id="${e.receipt.id}">View proof</button>`
      : `<button class="btn small secondary" data-tenant-action="upload-receipt" data-kind="${type}" data-entry-id="${e.id}">Add proof</button>`;
    return `<tr><td>${MONTHS[e.month]} ${e.year}${type === 'electricity' ? meterSubtitle(e) : ''}</td><td>${type === 'rent' ? fmtMoney(e.rentAmount) : fmtMoney(e.amount)}</td><td><span class="stamp ${e.status}">${e.status}</span></td><td>${proof}</td></tr>`;
  }).join('') || `<tr><td colspan="4" class="text">No records yet</td></tr>`;
  return `<div class="tenant-shell"><header class="tenant-top"><div class="brand">Rent Ledger <span class="brand-mark">TENANT</span></div><div class="tenant-user"><span>Welcome, <b>${esc(d.tenant.name)}</b></span><button class="tenant-profile-link" data-tenant-nav="profile">My profile</button><button class="logout" data-logout>Sign out</button></div></header><main class="tenant-main page-enter"><p class="kicker">YOUR HOME</p><h1>${esc(d.building.name)}</h1><p class="tenant-address">${esc(d.room.label)} · Floor ${d.room.floorNumber}</p><section class="tenant-hero"><div><span>Monthly rent</span><strong>${fmtMoney(d.room.monthlyRent)}</strong><small>Your fixed monthly rental</small></div><div><span>Rent outstanding</span><strong class="${rentDue ? 'is-due' : ''}">${fmtMoney(rentDue)}</strong><small>${rentDue ? 'Payment pending' : 'All caught up'}</small></div><div><span>Electricity outstanding</span><strong class="${elecDue ? 'is-due' : ''}">${fmtMoney(elecDue)}</strong><small>${elecDue ? 'Payment pending' : 'All caught up'}</small></div></section><section class="tenant-bills"><article class="card"><h3><span>Rent history</span><small>Last 6 entries</small></h3><table class="ledger tenant-ledger"><thead><tr><th>Period</th><th>Amount</th><th>Status</th><th>Payment proof</th></tr></thead><tbody>${billRows(d.rent,'rent')}</tbody></table></article><article class="card"><h3><span>Electricity bills</span><small>Last 6 entries</small></h3><table class="ledger tenant-ledger"><thead><tr><th>Period</th><th>Amount</th><th>Status</th><th>Payment proof</th></tr></thead><tbody>${billRows(d.electricity,'electricity')}</tbody></table></article></section><input type="file" data-receipt-file accept="image/jpeg,image/png,image/webp,application/pdf" hidden></main></div>`;
}

function displayDate(value) { return value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not provided'; }
function profileCard(title, rows) { return `<article class="card profile-card"><h3>${title}</h3><dl class="profile-list">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join('')}</dl></article>`; }
function passwordCard() {
  const form = state.forms.changePassword ? `<form class="profile-password-form" data-submit="change-password"><label>Current password<input name="currentPassword" type="password" required autocomplete="current-password"></label><label>New password<input name="newPassword" type="password" minlength="4" required autocomplete="new-password"></label><label>Confirm new password<input name="confirmPassword" type="password" minlength="4" required autocomplete="new-password"></label><div class="form-actions"><button class="btn" type="submit">Update password</button><button class="btn secondary" type="button" data-toggle-form="changePassword">Cancel</button></div></form>` : `<p class="profile-note">For your security, passwords are never displayed. You can update yours at any time.</p><button class="btn secondary" data-toggle-form="changePassword">Change password</button>`;
  return `<article class="card profile-card"><h3>Password & security</h3>${form}</article>`;
}
function renderTenantProfile() {
  const p = cache.tenantProfile;
  return `<div class="tenant-shell"><header class="tenant-top"><div class="brand">Rent Ledger <span class="brand-mark">TENANT</span></div><div class="tenant-user"><button class="tenant-profile-link" data-tenant-nav="home">← My home</button><button class="logout" data-logout>Sign out</button></div></header><main class="tenant-main page-enter"><p class="kicker">ACCOUNT</p><h1>My profile</h1><p class="tenant-address">Your account, tenancy and security settings.</p><section class="profile-grid">${profileCard('Account information', [['Name', esc(p.account.name)], ['Sign-in contact', esc(p.account.contact)], ['Account type', 'Tenant'], ['Member since', esc(displayDate(p.account.createdAt))]])}${profileCard('Your tenancy', [['Building', esc(p.home.buildingName)], ['Address', esc(p.home.buildingAddress || 'Not provided')], ['Room', esc(`${p.home.roomLabel} · Floor ${p.home.floorNumber}`)], ['Monthly rent', fmtMoney(p.home.monthlyRent)], ['Security deposit', fmtMoney(p.tenant.deposit)], ['Move-in date', esc(displayDate(p.tenant.moveInDate))]])}${profileCard('Contact & identity', [['Mobile number', esc(p.tenant.mobile || 'Not provided')], ['Alternative mobile', esc(p.tenant.altMobile || 'Not provided')], ['Email', esc(p.tenant.email || 'Not provided')], ['ID proof type', esc(p.tenant.idProofType || 'Not provided')]])}${passwordCard()}</section></main></div>`;
}

function logout() { localStorage.removeItem('rentLedgerSession'); location.reload(); }
function attachAuthHandlers() {
  document.querySelectorAll('[data-install-app]').forEach(btn => btn.onclick = requestAppInstall);
  document.querySelectorAll('[data-role]').forEach(btn => btn.onclick = () => { document.querySelectorAll('[data-role]').forEach(x => x.classList.remove('active')); btn.classList.add('active'); authForm('login', btn.dataset.role); });
  document.querySelectorAll('[data-auth-toggle]').forEach(btn => btn.onclick = () => authForm(btn.dataset.authToggle, document.querySelector('.role-btn.active')?.dataset.role || 'owner'));
  document.querySelectorAll('form[data-auth]').forEach(form => form.onsubmit = async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      if (form.dataset.auth === 'request-password-reset') {
        const result = await api('POST', '/api/auth/request-password-reset', data);
        authState.resetContact = data.contact.trim();
        toast(result.message);
        return authForm('reset-password', data.role || 'owner');
      }
      if (form.dataset.auth === 'reset-password') {
        const result = await api('POST', '/api/auth/reset-password', data);
        toast(result.message);
        return authForm('login', data.role || 'owner');
      }
      const result = await api('POST', '/api/auth/' + form.dataset.auth, data);
      localStorage.setItem('rentLedgerSession', JSON.stringify(result));
      location.reload();
    } catch (err) { toast(err.message, true); }
  });
  document.querySelectorAll('form[data-server-url]').forEach(form => form.onsubmit = e => { e.preventDefault(); localStorage.setItem('rentLedgerApiBase', new FormData(form).get('serverUrl').trim()); toast('Server address saved'); });
  document.querySelectorAll('[data-logout]').forEach(btn => btn.onclick = logout);
}

function attachTenantHandlers() {
  document.querySelectorAll('[data-logout]').forEach(btn => btn.onclick = logout);
  document.querySelectorAll('[data-tenant-nav]').forEach((btn) => btn.onclick = () => {
    state.tenantView = btn.dataset.tenantNav;
    render();
  });
  document.querySelectorAll('[data-tenant-action="upload-receipt"]').forEach((btn) => btn.onclick = () => {
    tenantReceiptState.kind = btn.dataset.kind;
    tenantReceiptState.entryId = btn.dataset.entryId;
    document.querySelector('[data-receipt-file]').click();
  });
  document.querySelectorAll('[data-tenant-action="view-receipt"]').forEach((btn) => btn.onclick = async () => {
    try { await openReceipt(btn.dataset.receiptId); } catch (error) { toast(error.message, true); }
  });
  const receiptInput = document.querySelector('[data-receipt-file]');
  if (receiptInput) receiptInput.onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!tenantReceiptState.kind || !tenantReceiptState.entryId) return toast('Choose a bill before uploading proof.', true);
    try {
      await uploadReceipt(tenantReceiptState.kind, tenantReceiptState.entryId, file);
      toast('Payment proof uploaded for owner review');
      tenantReceiptState.kind = ''; tenantReceiptState.entryId = '';
      render();
    } catch (error) { toast(error.message, true); }
    finally { event.target.value = ''; }
  };
}

// ---------- sidebar ----------
function renderSidebar() {
  const buildingsHtml = cache.buildings.map((b) => {
    const rooms = cache.rooms.filter((r) => r.buildingId === b.id);
    const occ = rooms.filter((r) => r.status === "occupied").length;
    const isActive = state.buildingId === b.id;
    const floors = {};
    rooms.forEach((r) => {
      floors[r.floorNumber] = floors[r.floorNumber] || [];
      floors[r.floorNumber].push(r);
    });
    const floorNums = Object.keys(floors).map(Number).sort((a, b2) => a - b2);

    const floorsHtml = isActive
      ? floorNums.map((fn) => `
          <div class="floor-group">
            <div class="floor-label">Floor ${fn}</div>
            ${floors[fn].map((r) => `
              <div class="room-row ${state.roomId === r.id ? "active" : ""}" data-nav="room" data-id="${r.id}">
                <span class="dot ${r.status}"></span>
                <span>${esc(r.label)}</span>
              </div>
            `).join("")}
          </div>
        `).join("")
      : "";

    return `
      <div class="building-block">
        <div class="building-row ${isActive ? "active" : ""}" data-nav="building" data-id="${b.id}">
          <span class="b-name">${esc(b.name)}</span>
          <span class="b-meta">${occ}/${rooms.length}</span>
        </div>
        ${floorsHtml}
      </div>
    `;
  }).join("");

  return `
    <div class="sidebar">
      <div class="brand" data-nav="dashboard" style="cursor:pointer">
        Rent Ledger <span class="brand-mark">v1</span>
      </div>
      <div class="sidebar-scroll">
        ${buildingsHtml || `<div style="opacity:.6; font-size:13px; padding:8px;">No buildings yet.</div>`}
      </div>
      <button class="sidebar-add" data-toggle-form="addBuilding">+ Add building</button>
      <button class="sidebar-profile ${state.view === 'profile' ? 'active' : ''}" data-nav="profile">◉ View your profile</button>
      <button class="sidebar-logout" data-action="logout">↪ Sign out</button>
    </div>
  `;
}

// ---------- main dispatch ----------
function renderMain() {
  if (state.view === "profile") return renderOwnerProfile();
  if (state.view === "building" && state.buildingId) return renderBuildingView();
  if (state.view === "room" && state.roomId) return renderRoomView();
  return renderDashboard();
}

function renderOwnerProfile() {
  const p = cache.profile || { account: session.user, buildings: [] };
  const buildings = p.buildings.length ? p.buildings.map((building) => `<div class="profile-building"><div><strong>${esc(building.name)}</strong><span>${esc(building.address || 'No address on file')}</span></div><div><b>${building.occupiedRooms}/${building.rooms}</b><small>occupied · ${building.totalFloors || '—'} floors</small></div></div>`).join('') : '<p class="profile-note">No buildings added yet.</p>';
  return `<div class="page-title">Your profile</div><div class="page-sub">Your account, buildings and security settings.</div><section class="profile-grid owner-profile-grid">${profileCard('Account information', [['Name', esc(p.account.name)], ['Sign-in contact', esc(p.account.contact)], ['Account type', 'Owner'], ['Member since', esc(displayDate(p.account.createdAt))]])}${passwordCard()}<article class="card profile-card profile-buildings"><h3>Your buildings <small>${p.buildings.length}</small></h3>${buildings}</article></section>`;
}

// ---------- dashboard ----------
function renderDashboard() {
  const d = cache.dashboard || {};
  const addBuildingForm = state.forms.addBuilding ? `
    <div class="card">
      <h3>Add a building</h3>
      <form data-submit="add-building">
        <div class="form-grid cols-3">
          <div class="form-field"><label>Building name *</label><input name="name" required placeholder="e.g. Sunrise Apartments" /></div>
          <div class="form-field"><label>Address</label><input name="address" placeholder="Street, city" /></div>
          <div class="form-field"><label>Total floors</label><input name="totalFloors" type="number" min="0" placeholder="e.g. 3" /></div>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">Save building</button>
          <button class="btn secondary" type="button" data-toggle-form="addBuilding">Cancel</button>
        </div>
      </form>
    </div>
  ` : "";

  return `
    <div class="page-title">Dashboard</div>
    <div class="page-sub">${MONTHS[d.month] || ""} ${d.year || ""} · overview across all buildings</div>

    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">Buildings</div><div class="stat-value">${d.totalBuildings ?? "–"}</div></div>
      <div class="stat-card good"><div class="stat-label">Occupied rooms</div><div class="stat-value">${d.occupiedRooms ?? "–"} / ${d.totalRooms ?? "–"}</div></div>
      <div class="stat-card good"><div class="stat-label">Rent collected (this mo.)</div><div class="stat-value">${fmtMoney(d.rentCollected)}</div></div>
      <div class="stat-card warn"><div class="stat-label">Rent pending (this mo.)</div><div class="stat-value">${fmtMoney(d.rentPending)}</div></div>
      <div class="stat-card good"><div class="stat-label">Electricity collected</div><div class="stat-value">${fmtMoney(d.elecCollected)}</div></div>
      <div class="stat-card warn"><div class="stat-label">Electricity pending</div><div class="stat-value">${fmtMoney(d.elecPending)}</div></div>
      <div class="stat-card warn"><div class="stat-label">Open rent entries</div><div class="stat-value">${d.outstandingRentEntries ?? "–"}</div></div>
      <div class="stat-card warn"><div class="stat-label">Open electricity entries</div><div class="stat-value">${d.outstandingElectricityEntries ?? "–"}</div></div>
    </div>

    ${addBuildingForm}

    <div class="card">
      <h3>Buildings</h3>
      ${cache.buildings.length === 0 ? `
        <div class="empty-state">
          <div class="es-icon">🏢</div>
          <div>No buildings yet. Add your first building to start tracking floors and rooms.</div>
        </div>
      ` : `
        <div class="building-grid">
          ${cache.buildings.map((b) => {
            const rooms = cache.rooms.filter((r) => r.buildingId === b.id);
            const occ = rooms.filter((r) => r.status === "occupied").length;
            return `
              <div class="building-card" data-nav="building" data-id="${b.id}">
                <div class="bc-name">${esc(b.name)}</div>
                <div class="bc-addr">${esc(b.address || "No address on file")}</div>
                <div class="bc-occ">${occ} occupied · ${rooms.length - occ} vacant · ${rooms.length} total</div>
              </div>
            `;
          }).join("")}
        </div>
      `}
    </div>
  `;
}

// ---------- building view ----------
function renderBuildingView() {
  const b = cache.buildings.find((x) => x.id === state.buildingId);
  if (!b) { state.view = "dashboard"; return renderDashboard(); }
  const rooms = cache.rooms.filter((r) => r.buildingId === b.id).sort((a, c) => a.floorNumber - c.floorNumber || a.label.localeCompare(c.label));
  const rentEntries = (cache.buildingRent || []).filter((entry) => !cache.rooms.find((room) => room.id === entry.roomId)?.electricityOnly);
  const totalRentCollected = rentEntries.reduce((sum, entry) => sum + (Number(entry.amountPaid) || 0), 0);
  const totalRentDue = rentEntries.reduce((sum, entry) => sum + (Number(entry.rentAmount) || 0), 0);
  const floors = [...new Set(rooms.map((room) => Number(room.floorNumber)))].sort((a, b2) => a - b2);
  const floorControls = floors.map((floorNumber) => {
    const floorRooms = rooms.filter((room) => Number(room.floorNumber) === floorNumber);
    const rentableRooms = floorRooms.filter((room) => !room.electricityOnly);
    const rents = [...new Set(rentableRooms.map((room) => Number(room.monthlyRent) || 0))];
    const currentRent = rents.length === 1 ? rents[0] : '';
    const rentEditor = rentableRooms.length ? `<form data-submit="update-floor-rent" data-building-id="${b.id}" data-floor-number="${floorNumber}"><input name="monthlyRent" type="number" min="0" step="0.01" required value="${currentRent}" placeholder="Monthly rent"><button class="btn small secondary" type="submit">Update rent</button></form>` : `<span class="owner-floor-note">Owner floor · electricity only</span>`;
    return `<div class="floor-control"><div><strong>Floor ${floorNumber}</strong><span>${floorRooms.length} room${floorRooms.length === 1 ? '' : 's'} · ${rentableRooms.length ? (rents.length === 1 ? `${fmtMoney(currentRent)}/room` : 'mixed room rents') : 'no rent collection'}</span></div>${rentEditor}<button class="btn small danger" data-action="delete-floor" data-building-id="${b.id}" data-floor-number="${floorNumber}" data-room-count="${floorRooms.length}">Delete floor</button></div>`;
  }).join('');

  const addRoomForm = state.forms.addRoom ? `
    <div class="card">
      <h3>Add a floor / room</h3>
      <form data-submit="add-room">
        <div class="form-grid cols-3">
          <div class="form-field"><label>Floor number *</label><input name="floorNumber" type="number" min="0" required placeholder="e.g. 1" /></div>
          <div class="form-field"><label>Room / unit label *</label><input name="label" required placeholder="e.g. 1A or Room 3" /></div>
          <div class="form-field"><label>Monthly rent (₹)</label><input name="monthlyRent" type="number" min="0" step="0.01" placeholder="e.g. 12000" /></div>
          <div class="form-field"><label>Security deposit (₹)</label><input name="deposit" type="number" min="0" step="0.01" placeholder="e.g. 24000" /></div>
          <div class="form-field" style="grid-column: span 2;"><label>Notes</label><input name="notes" placeholder="Optional" /></div>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">Save room</button>
          <button class="btn secondary" type="button" data-toggle-form="addRoom">Cancel</button>
        </div>
      </form>
    </div>
  ` : "";
  const addOwnerFloorForm = state.forms.addOwnerFloor ? `
    <div class="card">
      <h3>Add owner floor</h3>
      <p class="profile-note">This floor records electricity only. It cannot have a tenant or rent entry, and is excluded from rent totals.</p>
      <form data-submit="add-owner-floor">
        <div class="form-grid cols-3">
          <div class="form-field"><label>Floor number *</label><input name="floorNumber" type="number" min="0" required placeholder="e.g. 0" /></div>
          <div class="form-field"><label>Floor label *</label><input name="label" required value="Owner residence" /></div>
          <div class="form-field"><label>Notes</label><input name="notes" placeholder="Optional" /></div>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Add electricity-only floor</button><button class="btn secondary" type="button" data-toggle-form="addOwnerFloor">Cancel</button></div>
      </form>
    </div>
  ` : "";

  return `
    <div class="nav-crumb" data-nav="dashboard">← All buildings</div>
    <div class="page-title">${esc(b.name)}</div>
    <div class="page-sub">${esc(b.address || "No address on file")} · ${rooms.length} room${rooms.length === 1 ? "" : "s"} across ${b.totalFloors || "?"} floor(s)</div>

    <div class="stat-grid building-stats">
      <div class="stat-card good"><div class="stat-label">Total rent collected</div><div class="stat-value">${fmtMoney(totalRentCollected)}</div></div>
      <div class="stat-card"><div class="stat-label">Rent billed</div><div class="stat-value">${fmtMoney(totalRentDue)}</div></div>
      <div class="stat-card ${totalRentDue - totalRentCollected > 0 ? "warn" : "good"}"><div class="stat-label">Rent outstanding</div><div class="stat-value">${fmtMoney(Math.max(totalRentDue - totalRentCollected, 0))}</div></div>
    </div>

    ${addRoomForm}${addOwnerFloorForm}

    ${floors.length ? `<div class="card floor-manager"><h3>Floor rent settings</h3><p class="profile-note">Updating a floor rent applies the amount to every room on that floor. It does not change past ledger entries.</p>${floorControls}</div>` : ''}

    <div class="card">
      <h3>
        Floors &amp; rooms
        <button class="btn small" data-toggle-form="addRoom">+ Add room</button>
        <button class="btn small secondary" data-toggle-form="addOwnerFloor">+ Add owner floor</button>
      </h3>
      ${rooms.length === 0 ? `
        <div class="empty-state">
          <div class="es-icon">🚪</div>
          <div>No rooms added yet. Add each floor/room you rent out, then attach a tenant to it.</div>
        </div>
      ` : `
        <div class="room-grid">
          ${rooms.map((r) => `
            <div class="room-card" data-nav="room" data-id="${r.id}">
              <div class="rc-status"><span class="stamp ${r.status}">${r.electricityOnly ? 'owner' : r.status}</span></div>
              <div class="rc-floor">Floor ${r.floorNumber}</div>
              <div class="rc-label">${esc(r.label)}</div>
              <div class="rc-rent">${r.electricityOnly ? 'Electricity only' : `${fmtMoney(r.monthlyRent)}/mo`}</div>
            </div>
          `).join("")}
        </div>
      `}
    </div>

    <div class="card">
      <h3>Building details</h3>
      <form data-submit="edit-building" data-id="${b.id}">
        <div class="form-grid cols-3">
          <div class="form-field"><label>Building name</label><input name="name" value="${esc(b.name)}" required /></div>
          <div class="form-field"><label>Address</label><input name="address" value="${esc(b.address || "")}" /></div>
          <div class="form-field"><label>Total floors</label><input name="totalFloors" type="number" min="0" value="${b.totalFloors || 0}" /></div>
        </div>
        <div class="form-actions">
          <button class="btn secondary" type="submit">Save changes</button>
          <button class="btn danger" type="button" data-action="delete-building" data-id="${b.id}">Delete building</button>
        </div>
      </form>
    </div>
  `;
}

// ---------- room view ----------
function renderRoomView() {
  const r = cache.rooms.find((x) => x.id === state.roomId);
  if (!r) { state.view = "dashboard"; return renderDashboard(); }
  const b = cache.buildings.find((x) => x.id === r.buildingId);
  const tenant = cache.tenants.find((t) => t.roomId === r.id && t.active);
  if (r.electricityOnly && state.roomTab !== 'electricity') state.roomTab = 'electricity';

  const tabs = r.electricityOnly ? `<div class="tab-row"><button class="tab-btn active" data-room-tab="electricity">Electricity</button></div>` : `
    <div class="tab-row">
      <button class="tab-btn ${state.roomTab === "tenant" ? "active" : ""}" data-room-tab="tenant">Tenant</button>
      <button class="tab-btn ${state.roomTab === "rent" ? "active" : ""}" data-room-tab="rent">Rent</button>
      <button class="tab-btn ${state.roomTab === "electricity" ? "active" : ""}" data-room-tab="electricity">Electricity</button>
    </div>
  `;

  let body = "";
  if (r.electricityOnly) body = renderElectricityTab(r, null);
  else if (state.roomTab === "tenant") body = renderTenantTab(r, tenant);
  else if (state.roomTab === "rent") body = renderRentTab(r, tenant);
  else body = renderElectricityTab(r, tenant);

  return `
    <div class="nav-crumb" data-nav="building" data-id="${b ? b.id : ""}">← ${esc(b ? b.name : "Building")}</div>
    <div class="page-title">${esc(r.label)} <span class="stamp ${r.status}" style="font-size:11px; vertical-align:middle; margin-left:8px;">${r.electricityOnly ? 'owner floor' : r.status}</span></div>
    <div class="page-sub">${r.electricityOnly ? `Floor ${r.floorNumber} · owner residence · electricity tracking only` : `Floor ${r.floorNumber} · ${fmtMoney(r.monthlyRent)}/mo rent · ${fmtMoney(r.deposit)} deposit`}</div>
    ${tabs}
    ${body}
  `;
}

function renderTenantTab(r, tenant) {
  if (!tenant) {
    const form = state.forms.addTenant ? `
      <div class="card">
        <h3>Add tenant</h3>
        <form data-submit="add-tenant" data-room-id="${r.id}">
          <div class="form-grid">
            <div class="form-field"><label>Full name *</label><input name="name" required /></div>
            <div class="form-field"><label>Mobile number *</label><input name="mobile" required placeholder="10-digit mobile" /></div>
            <div class="form-field"><label>Alternate mobile</label><input name="altMobile" /></div>
            <div class="form-field"><label>Email</label><input name="email" type="email" /></div>
            <div class="form-field"><label>ID proof type</label><input name="idProofType" placeholder="Aadhaar / PAN / Passport" /></div>
            <div class="form-field"><label>ID proof number</label><input name="idProofNumber" /></div>
            <div class="form-field"><label>Move-in date</label><input name="moveInDate" type="date" value="${today()}" /></div>
            <div class="form-field"><label>Notes</label><input name="notes" placeholder="Optional" /></div>
          </div>
          <div class="form-actions">
            <button class="btn" type="submit">Save tenant</button>
            <button class="btn secondary" type="button" data-toggle-form="addTenant">Cancel</button>
          </div>
        </form>
      </div>
    ` : "";
    return `
      <div class="card">
        <div class="empty-state">
          <div class="es-icon">🔑</div>
          <div>This room is vacant. Add a tenant to start tracking rent and electricity.</div>
          <div style="margin-top:14px;"><button class="btn" data-toggle-form="addTenant">+ Add tenant</button></div>
        </div>
      </div>
      ${form}
    `;
  }

  const history = cache.tenants.filter((t) => t.roomId === r.id && !t.active);

  return `
    <div class="card">
      <div class="tenant-card">
        <div>
          <div class="t-name">${esc(tenant.name)}</div>
          <div class="t-detail"><span class="lbl">Mobile</span>${esc(tenant.mobile)}</div>
          ${tenant.altMobile ? `<div class="t-detail"><span class="lbl">Alt.</span>${esc(tenant.altMobile)}</div>` : ""}
          ${tenant.email ? `<div class="t-detail"><span class="lbl">Email</span>${esc(tenant.email)}</div>` : ""}
          ${tenant.idProofType ? `<div class="t-detail"><span class="lbl">ID proof</span>${esc(tenant.idProofType)} ${esc(tenant.idProofNumber || "")}</div>` : ""}
          <div class="t-detail"><span class="lbl">Moved in</span>${esc(tenant.moveInDate || "—")}</div>
          ${tenant.notes ? `<div class="t-detail"><span class="lbl">Notes</span>${esc(tenant.notes)}</div>` : ""}
        </div>
        <button class="btn danger small" data-action="move-out" data-id="${tenant.id}">Mark moved out</button>
      </div>
    </div>
    ${history.length ? `
      <div class="card">
        <h3>Previous tenants</h3>
        <table class="ledger">
          <thead><tr><th>Name</th><th>Mobile</th><th>Moved in</th><th>Moved out</th><th></th></tr></thead>
          <tbody>
            ${history.map((t) => `<tr><td class="text">${esc(t.name)}</td><td>${esc(t.mobile || '—')}</td><td>${esc(t.moveInDate)}</td><td>${esc(t.moveOutDate)}</td><td><button class="btn small danger" data-action="delete-tenant" data-id="${t.id}">Remove record</button></td></tr>`).join("")}
          </tbody>
        </table>
      </div>
    ` : ""}
  `;
}

function renderRentTab(r, tenant) {
  const now = new Date();
  const editForms = cache.rent.filter((entry) => state.forms[`editRent-${entry.id}`]).map((entry) => `<div class="card ledger-edit"><h3>Edit rent entry · ${MONTHS[entry.month]} ${entry.year}</h3><form data-submit="edit-rent" data-id="${entry.id}"><div class="form-grid cols-3"><div class="form-field"><label>Month *</label><select name="month" required>${MONTHS.slice(1).map((month, index) => `<option value="${index + 1}" ${index + 1 === Number(entry.month) ? 'selected' : ''}>${month}</option>`).join('')}</select></div><div class="form-field"><label>Year *</label><input name="year" type="number" required value="${entry.year}"></div><div class="form-field"><label>Rent amount (₹) *</label><input name="rentAmount" type="number" min="0" step="0.01" required value="${entry.rentAmount}"></div><div class="form-field"><label>Amount paid (₹)</label><input name="amountPaid" type="number" min="0" step="0.01" value="${entry.amountPaid}"></div><div class="form-field"><label>Due date</label><input name="dueDate" type="date" value="${esc(entry.dueDate || '')}"></div><div class="form-field"><label>Paid date</label><input name="paidDate" type="date" value="${esc(entry.paidDate || '')}"></div><div class="form-field" style="grid-column:span 3"><label>Notes</label><input name="notes" value="${esc(entry.notes || '')}"></div></div><div class="form-actions"><button class="btn" type="submit">Save changes</button><button class="btn secondary" type="button" data-toggle-form="editRent-${entry.id}">Cancel</button></div></form></div>`).join('');
  const addForm = state.forms.addRent ? `
    <div class="card">
      <h3>Add rent entry</h3>
      <form data-submit="add-rent" data-room-id="${r.id}" data-tenant-id="${tenant ? tenant.id : ""}">
        <div class="form-grid cols-3">
          <div class="form-field"><label>Month *</label>
            <select name="month" required>${MONTHS.slice(1).map((m, i) => `<option value="${i + 1}" ${i + 1 === now.getMonth() + 1 ? "selected" : ""}>${m}</option>`).join("")}</select>
          </div>
          <div class="form-field"><label>Year *</label><input name="year" type="number" required value="${now.getFullYear()}" /></div>
          <div class="form-field"><label>Rent amount (₹) *</label><input name="rentAmount" type="number" min="0" step="0.01" required value="${r.monthlyRent || ""}" /></div>
          <div class="form-field"><label>Amount paid (₹)</label><input name="amountPaid" type="number" min="0" step="0.01" value="0" /></div>
          <div class="form-field"><label>Due date</label><input name="dueDate" type="date" /></div>
          <div class="form-field"><label>Paid date</label><input name="paidDate" type="date" /></div>
          <div class="form-field" style="grid-column: span 3;"><label>Notes</label><input name="notes" placeholder="Optional" /></div>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">Save entry</button>
          <button class="btn secondary" type="button" data-toggle-form="addRent">Cancel</button>
        </div>
      </form>
    </div>
  ` : "";

  return `
    ${!tenant ? `<div class="card"><div class="empty-state">No active tenant — you can still log rent history for this room.</div></div>` : ""}
    ${addForm}${editForms}
    <div class="card">
      <h3>
        Rent history
        <button class="btn small" data-toggle-form="addRent">+ Add entry</button>
      </h3>
      ${cache.rent.length === 0 ? `<div class="empty-state">No rent entries yet.</div>` : `
        <table class="ledger">
          <thead><tr><th>Period</th><th>Due</th><th>Paid</th><th>Status</th><th>Paid on</th><th></th></tr></thead>
          <tbody>
            ${cache.rent.map((e) => `
              <tr>
                <td class="text">${MONTHS[e.month]} ${e.year}</td>
                <td>${fmtMoney(e.rentAmount)}</td>
                <td>${fmtMoney(e.amountPaid)}</td>
                <td><span class="stamp ${e.status}">${e.status}</span></td>
                <td class="text">${esc(e.paidDate || "—")}</td>
                <td style="white-space:nowrap;">
                  ${e.receipt ? `<button class="btn small secondary" data-action="view-receipt" data-receipt-id="${e.receipt.id}">View proof</button>` : ""}
                  <button class="btn small secondary" data-toggle-form="editRent-${e.id}">Edit</button>
                  ${e.status !== "paid" ? `<button class="btn small secondary" data-action="mark-rent-paid" data-id="${e.id}" data-amount="${e.rentAmount}">Mark paid</button>` : ""}
                  <button class="btn small danger" data-action="delete-rent" data-id="${e.id}">Delete</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `}
    </div>
  `;
}

// Meter ID + billing-authority link for a room. Once linked, new electricity
// bills for this room are entered as a direct amount from that authority
// instead of being calculated from meter readings.
function meterCard(r) {
  if (r.meterId && r.authorityId) {
    const authority = cache.authorities.find((a) => a.id === r.authorityId);
    return `<div class="card meter-card">
      <h3>Meter &amp; billing authority</h3>
      <p class="profile-note">Meter <strong>${esc(r.meterId)}</strong> · billed by <strong>${esc(authority ? authority.name : "an authority that's since been removed")}</strong>. New electricity bills for this room are entered as a direct amount — no meter readings needed.</p>
      <button class="btn secondary small" data-action="unlink-meter" data-room-id="${r.id}">Unlink meter</button>
    </div>`;
  }
  const options = cache.authorities.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  return `<div class="card meter-card">
    <h3>Meter &amp; billing authority</h3>
    <p class="profile-note">Link this room to a meter ID and a billing authority (electricity board, utility company, etc.) to enter bills as a direct amount instead of meter readings.</p>
    <form data-submit="link-meter" data-room-id="${r.id}">
      <div class="form-grid cols-3">
        <div class="form-field"><label>Meter ID *</label><input name="meterId" required placeholder="e.g. EB-4521" /></div>
        <div class="form-field"><label>Billing authority *</label>
          <select name="authorityId" required data-authority-select>
            <option value="">Select authority</option>
            ${options}
            <option value="__new__">+ Add new authority…</option>
          </select>
        </div>
        <div class="form-field hidden" data-new-authority-field><label>New authority name</label><input name="newAuthorityName" placeholder="e.g. State Electricity Board" /></div>
      </div>
      <div class="form-actions"><button class="btn" type="submit">Link meter</button></div>
    </form>
  </div>`;
}

function meterSubtitle(e) {
  if (e.billingMode !== "authority") return "";
  const parts = [e.authorityName, e.meterId ? `Meter ${e.meterId}` : ""].filter(Boolean);
  return parts.length ? `<br><small style="color:var(--teal-mid);font-size:10px">${esc(parts.join(" · "))}</small>` : "";
}

function renderElectricityTab(r, tenant) {
  const now = new Date();
  const lastReading = cache.electricity.length ? cache.electricity[0].currReading : 0;
  const linked = Boolean(r.meterId && r.authorityId);
  const editForms = cache.electricity.filter((entry) => state.forms[`editElec-${entry.id}`]).map((entry) => entry.billingMode === "authority" ? `<div class="card ledger-edit"><h3>Edit bill · ${MONTHS[entry.month]} ${entry.year}</h3><form data-submit="edit-electricity" data-id="${entry.id}"><div class="form-grid cols-3"><div class="form-field"><label>Month *</label><select name="month" required>${MONTHS.slice(1).map((month, index) => `<option value="${index + 1}" ${index + 1 === Number(entry.month) ? 'selected' : ''}>${month}</option>`).join('')}</select></div><div class="form-field"><label>Year *</label><input name="year" type="number" required value="${entry.year}"></div><div class="form-field"><label>Bill amount (₹) *</label><input name="amount" type="number" min="0" step="0.01" required value="${entry.amount}"></div><div class="form-field"><label>Paid date</label><input name="paidDate" type="date" value="${esc(entry.paidDate || '')}"></div><div class="form-field" style="grid-column:span 3"><label>Notes</label><input name="notes" value="${esc(entry.notes || '')}"></div></div><div class="form-actions"><button class="btn" type="submit">Save changes</button><button class="btn secondary" type="button" data-toggle-form="editElec-${entry.id}">Cancel</button></div></form></div>` : `<div class="card ledger-edit"><h3>Edit electricity entry · ${MONTHS[entry.month]} ${entry.year}</h3><form data-submit="edit-electricity" data-id="${entry.id}"><div class="form-grid cols-3"><div class="form-field"><label>Month *</label><select name="month" required>${MONTHS.slice(1).map((month, index) => `<option value="${index + 1}" ${index + 1 === Number(entry.month) ? 'selected' : ''}>${month}</option>`).join('')}</select></div><div class="form-field"><label>Year *</label><input name="year" type="number" required value="${entry.year}"></div><div class="form-field"><label>Rate per unit (₹)</label><input name="ratePerUnit" type="number" min="0" step="0.01" value="${entry.ratePerUnit}"></div><div class="form-field"><label>Previous reading</label><input name="prevReading" type="number" min="0" step="0.01" value="${entry.prevReading}"></div><div class="form-field"><label>Current reading *</label><input name="currReading" type="number" min="0" step="0.01" required value="${entry.currReading}"></div><div class="form-field"><label>Paid date</label><input name="paidDate" type="date" value="${esc(entry.paidDate || '')}"></div><div class="form-field" style="grid-column:span 3"><label>Notes</label><input name="notes" value="${esc(entry.notes || '')}"></div></div><div class="form-actions"><button class="btn" type="submit">Save changes</button><button class="btn secondary" type="button" data-toggle-form="editElec-${entry.id}">Cancel</button></div></form></div>`).join('');
  const addForm = state.forms.addElec ? (linked ? `
    <div class="card">
      <h3>Add electricity bill</h3>
      <form data-submit="add-electricity" data-room-id="${r.id}" data-tenant-id="${tenant ? tenant.id : ""}">
        <div class="form-grid cols-3">
          <div class="form-field"><label>Month *</label>
            <select name="month" required>${MONTHS.slice(1).map((m, i) => `<option value="${i + 1}" ${i + 1 === now.getMonth() + 1 ? "selected" : ""}>${m}</option>`).join("")}</select>
          </div>
          <div class="form-field"><label>Year *</label><input name="year" type="number" required value="${now.getFullYear()}" /></div>
          <div class="form-field"><label>Bill amount (₹) *</label><input name="amount" type="number" min="0" step="0.01" required placeholder="e.g. 1450" /></div>
          <div class="form-field"><label>Paid date</label><input name="paidDate" type="date" /></div>
          <div class="form-field" style="grid-column: span 3;"><label>Notes</label><input name="notes" placeholder="Optional" /></div>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">Save bill</button>
          <button class="btn secondary" type="button" data-toggle-form="addElec">Cancel</button>
        </div>
      </form>
    </div>
  ` : `
    <div class="card">
      <h3>Add electricity entry</h3>
      <form data-submit="add-electricity" data-room-id="${r.id}" data-tenant-id="${tenant ? tenant.id : ""}">
        <div class="form-grid cols-3">
          <div class="form-field"><label>Month *</label>
            <select name="month" required>${MONTHS.slice(1).map((m, i) => `<option value="${i + 1}" ${i + 1 === now.getMonth() + 1 ? "selected" : ""}>${m}</option>`).join("")}</select>
          </div>
          <div class="form-field"><label>Year *</label><input name="year" type="number" required value="${now.getFullYear()}" /></div>
          <div class="form-field"><label>Rate per unit (₹)</label><input name="ratePerUnit" type="number" min="0" step="0.01" placeholder="e.g. 8" /></div>
          <div class="form-field"><label>Previous reading</label><input name="prevReading" type="number" min="0" step="0.01" value="${lastReading}" /></div>
          <div class="form-field"><label>Current reading *</label><input name="currReading" type="number" min="0" step="0.01" required /></div>
          <div class="form-field"><label>Paid date</label><input name="paidDate" type="date" /></div>
          <div class="form-field" style="grid-column: span 3;"><label>Notes</label><input name="notes" placeholder="Optional" /></div>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">Save entry</button>
          <button class="btn secondary" type="button" data-toggle-form="addElec">Cancel</button>
        </div>
      </form>
    </div>
  `) : "";

  return `
    ${meterCard(r)}
    ${addForm}${editForms}
    <div class="card">
      <h3>
        Electricity history
        <button class="btn small" data-toggle-form="addElec">+ Add ${linked ? "bill" : "reading"}</button>
      </h3>
      ${cache.electricity.length === 0 ? `<div class="empty-state">No electricity entries yet.</div>` : `
        <table class="ledger">
          <thead><tr><th>Period</th><th>Prev.</th><th>Current</th><th>Units</th><th>Rate</th><th>Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${cache.electricity.map((e) => `
              <tr>
                <td class="text">${MONTHS[e.month]} ${e.year}${meterSubtitle(e)}</td>
                <td>${e.billingMode === "authority" ? "—" : e.prevReading}</td>
                <td>${e.billingMode === "authority" ? "—" : e.currReading}</td>
                <td>${e.billingMode === "authority" ? "—" : e.unitsConsumed}</td>
                <td>${e.billingMode === "authority" ? "—" : fmtMoney(e.ratePerUnit)}</td>
                <td>${fmtMoney(e.amount)}</td>
                <td><span class="stamp ${e.status}">${e.status}</span></td>
                <td style="white-space:nowrap;">
                  ${e.receipt ? `<button class="btn small secondary" data-action="view-receipt" data-receipt-id="${e.receipt.id}">View proof</button>` : ""}
                  <button class="btn small secondary" data-toggle-form="editElec-${e.id}">Edit</button>
                  ${e.status !== "paid" ? `<button class="btn small secondary" data-action="mark-elec-paid" data-id="${e.id}">Mark paid</button>` : ""}
                  <button class="btn small danger" data-action="delete-electricity" data-id="${e.id}">Delete</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `}
    </div>
  `;
}

// ---------- event handling ----------
function attachHandlers() {
  const app = document.getElementById("app");

  app.onclick = async (e) => {
    const nav = e.target.closest("[data-nav]");
    if (nav) {
      const type = nav.dataset.nav;
      state.forms = {};
      if (type === "dashboard") { state.view = "dashboard"; state.buildingId = null; state.roomId = null; }
      if (type === "building") { state.view = "building"; state.buildingId = nav.dataset.id; state.roomId = null; }
      if (type === "room") { state.view = "room"; state.roomId = nav.dataset.id; state.roomTab = cache.rooms.find((room) => room.id === nav.dataset.id)?.electricityOnly ? "electricity" : "tenant"; }
      if (type === "profile") { state.view = "profile"; state.buildingId = null; state.roomId = null; }
      return render();
    }

    const toggle = e.target.closest("[data-toggle-form]");
    if (toggle) {
      const key = toggle.dataset.toggleForm;
      state.forms[key] = !state.forms[key];
      return render();
    }

    const roomTab = e.target.closest("[data-room-tab]");
    if (roomTab) {
      state.roomTab = roomTab.dataset.roomTab;
      state.forms = {};
      return render();
    }

    const action = e.target.closest("[data-action]");
    if (action) return handleAction(action);
  };

  app.onsubmit = async (e) => {
    const form = e.target.closest("[data-submit]");
    if (!form) return;
    e.preventDefault();
    return handleSubmit(form);
  };

  document.querySelectorAll('[data-authority-select]').forEach((select) => {
    select.onchange = () => {
      const field = select.closest('form')?.querySelector('[data-new-authority-field]');
      if (field) field.classList.toggle('hidden', select.value !== '__new__');
    };
  });
}

async function handleAction(el) {
  const act = el.dataset.action;
  try {
    if (act === "logout") {
      logout();
      return;
    } else if (act === "delete-building") {
      if (!confirm("Delete this building and everything in it? This cannot be undone.")) return;
      await api("DELETE", `/api/buildings/${el.dataset.id}`);
      state.view = "dashboard"; state.buildingId = null;
      toast("Building deleted");
    } else if (act === "move-out") {
      if (!confirm("Mark this tenant as moved out? Their login account, mobile numbers, email and ID-proof number will be removed permanently. Rent and bill history will be kept.")) return;
      await api("POST", `/api/tenants/${el.dataset.id}/move-out`, { moveOutDate: today() });
      toast("Tenant moved out; login and personal identifiers removed");
    } else if (act === 'delete-tenant') {
      if (!confirm('Remove this previous tenant record permanently? Their login is removed. Rent and electricity history stays, but will no longer be linked to this tenant.')) return;
      await api('DELETE', `/api/tenants/${el.dataset.id}`);
      toast('Previous tenant record removed');
    } else if (act === 'delete-floor') {
      const count = Number(el.dataset.roomCount) || 0;
      if (!confirm(`Delete Floor ${el.dataset.floorNumber} and its ${count} room${count === 1 ? '' : 's'}? All tenant records, rent/electricity ledgers and payment proofs in this floor will be permanently removed.`)) return;
      await api('DELETE', `/api/buildings/${el.dataset.buildingId}/floors/${el.dataset.floorNumber}`);
      toast(`Floor ${el.dataset.floorNumber} deleted`);
    } else if (act === "view-receipt") {
      await openReceipt(el.dataset.receiptId);
    } else if (act === "mark-rent-paid") {
      await api("PUT", `/api/rent/${el.dataset.id}`, { amountPaid: Number(el.dataset.amount), paidDate: today() });
      toast("Rent marked as paid");
    } else if (act === "delete-rent") {
      if (!confirm("Delete this rent entry?")) return;
      await api("DELETE", `/api/rent/${el.dataset.id}`);
      toast("Entry deleted");
    } else if (act === "mark-elec-paid") {
      await api("PUT", `/api/electricity/${el.dataset.id}`, { paidDate: today() });
      toast("Electricity bill marked as paid");
    } else if (act === "delete-electricity") {
      if (!confirm("Delete this electricity entry?")) return;
      await api("DELETE", `/api/electricity/${el.dataset.id}`);
      toast("Entry deleted");
    } else if (act === "unlink-meter") {
      if (!confirm("Unlink this meter? New bills will go back to meter-reading entry. Past bill history is kept as-is.")) return;
      await api("DELETE", `/api/rooms/${el.dataset.roomId}/meter`);
      toast("Meter unlinked");
    }
    invalidateData(); cache.profile = null; cache.tenantProfile = null;
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function handleSubmit(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const kind = form.dataset.submit;
  try {
    if (kind === 'change-password') {
      if (data.newPassword !== data.confirmPassword) throw new Error('The new password and confirmation do not match.');
      const result = await api('PUT', '/api/account/password', { currentPassword: data.currentPassword, newPassword: data.newPassword });
      toast(result.message);
      setTimeout(logout, 900);
      return;
    } else if (kind === "add-building") {
      await api("POST", "/api/buildings", data);
      state.forms.addBuilding = false;
      toast("Building added");
    } else if (kind === "edit-building") {
      await api("PUT", `/api/buildings/${form.dataset.id}`, data);
      toast("Building updated");
    } else if (kind === 'update-floor-rent') {
      const result = await api('PUT', `/api/buildings/${form.dataset.buildingId}/floors/${form.dataset.floorNumber}`, data);
      toast(`Rent updated for ${result.roomsUpdated} room${result.roomsUpdated === 1 ? '' : 's'} on Floor ${result.floorNumber}`);
    } else if (kind === "add-room") {
      await api("POST", "/api/rooms", { ...data, buildingId: state.buildingId });
      state.forms.addRoom = false;
      toast("Room added");
    } else if (kind === 'add-owner-floor') {
      await api('POST', '/api/rooms', { ...data, buildingId: state.buildingId, electricityOnly: true, monthlyRent: 0, deposit: 0 });
      state.forms.addOwnerFloor = false;
      toast('Owner electricity-only floor added');
    } else if (kind === "add-tenant") {
      await api("POST", "/api/tenants", { ...data, roomId: form.dataset.roomId });
      state.forms.addTenant = false;
      toast("Tenant added");
    } else if (kind === "add-rent") {
      await api("POST", "/api/rent", { ...data, roomId: form.dataset.roomId, tenantId: form.dataset.tenantId || null });
      state.forms.addRent = false;
      toast("Rent entry added");
    } else if (kind === 'edit-rent') {
      await api('PUT', `/api/rent/${form.dataset.id}`, data);
      state.forms[`editRent-${form.dataset.id}`] = false;
      toast('Rent entry updated');
    } else if (kind === "add-electricity") {
      await api("POST", "/api/electricity", { ...data, roomId: form.dataset.roomId, tenantId: form.dataset.tenantId || null });
      state.forms.addElec = false;
      toast("Electricity entry added");
    } else if (kind === 'edit-electricity') {
      await api('PUT', `/api/electricity/${form.dataset.id}`, data);
      state.forms[`editElec-${form.dataset.id}`] = false;
      toast('Electricity entry updated');
    } else if (kind === 'link-meter') {
      let authorityId = data.authorityId;
      if (authorityId === '__new__') {
        const name = (data.newAuthorityName || '').trim();
        if (!name) throw new Error('Enter a name for the new authority.');
        const authority = await api('POST', '/api/authorities', { name });
        authorityId = authority.id;
      }
      if (!authorityId) throw new Error('Choose a billing authority.');
      await api('PUT', `/api/rooms/${form.dataset.roomId}/meter`, { meterId: data.meterId, authorityId });
      toast('Meter linked');
    }
    invalidateData(); cache.profile = null; cache.tenantProfile = null;
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

render();
