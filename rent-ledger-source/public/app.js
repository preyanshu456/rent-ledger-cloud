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

const cache = { buildings: [], rooms: [], tenants: [], authorities: [], dashboard: null, rent: [], electricity: [], gas: [], payments: [], buildingRent: [], profile: null, tenantPortal: null, tenantProfile: null, coreLoadedAt: 0, tenantLoadedAt: 0 };

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
    if (state.view === "dashboard") [cache.dashboard, cache.payments] = await Promise.all([api("GET", "/api/dashboard"), api("GET", "/api/payments?limit=8")]);
    if (state.view === "building" && state.buildingId) cache.buildingRent = await api("GET", `/api/rent?buildingId=${state.buildingId}`);
    if (state.view === "room" && state.roomId) {
      const [rent, electricity, gas] = await Promise.all([
        api("GET", `/api/rent?roomId=${state.roomId}`),
        api("GET", `/api/electricity?roomId=${state.roomId}`),
        api("GET", `/api/gas?roomId=${state.roomId}`),
      ]);
      cache.rent = rent.sort((a, b) => b.year - a.year || b.month - a.month);
      cache.electricity = electricity.sort((a, b) => b.year - a.year || b.month - a.month);
      cache.gas = gas.sort((a, b) => b.year - a.year || b.month - a.month);
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
  const d = cache.tenantPortal;
  const gasEntries = d.gas || [];
  const owed = (entry, type) => entry.status === 'paid' ? 0 : type === 'rent' ? Math.max((entry.rentAmount || 0) - (entry.amountPaid || 0), 0) : (entry.amount || 0);
  const rentDue = d.rent.reduce((s, x) => s + owed(x, 'rent'), 0);
  const elecDue = d.electricity.reduce((s, x) => s + owed(x, 'electricity'), 0);
  const gasDue = gasEntries.reduce((s, x) => s + owed(x, 'gas'), 0);
  const totalDue = rentDue + elecDue + gasDue;
  const canPayOnline = Boolean(d.payments?.enabled);
  const billRows = (entries, type) => entries.slice(0,6).map(e => {
    const due = owed(e, type);
    const payButton = canPayOnline && due > 0
      ? `<button class="btn small pay-btn" data-tenant-action="pay-bill" data-kind="${type}" data-entry-id="${e.id}">Pay ${fmtMoney(due)}</button>`
      : '';
    const proof = e.onlinePayment && e.status === 'paid'
      ? `<span class="paid-online" title="Razorpay ${esc(e.onlinePayment.paymentId || '')}">✓ Paid online</span>`
      : e.receipt
        ? `<button class="btn small secondary" data-tenant-action="view-receipt" data-receipt-id="${e.receipt.id}">View proof</button>`
        : `<button class="btn small secondary" data-tenant-action="upload-receipt" data-kind="${type}" data-entry-id="${e.id}">Add proof</button>`;
    return `<tr><td>${MONTHS[e.month]} ${e.year}${type === 'gas' ? gasSubtitle(e) : ''}</td><td>${type === 'rent' ? fmtMoney(e.rentAmount) : fmtMoney(e.amount)}</td><td><span class="stamp ${e.status}">${e.status}</span></td><td><div class="bill-actions">${payButton}${proof}</div></td></tr>`;
  }).join('') || `<tr><td colspan="4" class="text">No records yet</td></tr>`;
  const payAll = totalDue > 0
    ? (canPayOnline
      ? `<section class="card pay-all-card"><div><span class="kicker">TOTAL PENDING</span><strong>${fmtMoney(totalDue)}</strong><small>Rent, electricity and gas together · paid securely via Razorpay (UPI, cards, net banking)</small></div><button class="btn pay-btn" data-tenant-action="pay-all">Pay all ${fmtMoney(totalDue)}</button></section>`
      : `<section class="card pay-all-card muted"><div><span class="kicker">TOTAL PENDING</span><strong>${fmtMoney(totalDue)}</strong><small>Online payment isn't enabled by your owner yet. Pay them directly and add a payment proof below.</small></div></section>`)
    : '';
  const table = (title, entries, type) => `<article class="card"><h3><span>${title}</span><small>Last 6 entries</small></h3><table class="ledger tenant-ledger"><thead><tr><th>Period</th><th>Amount</th><th>Status</th><th>Payment</th></tr></thead><tbody>${billRows(entries, type)}</tbody></table></article>`;
  return `<div class="tenant-shell"><header class="tenant-top"><div class="brand">Rent Ledger <span class="brand-mark">TENANT</span></div><div class="tenant-user"><span>Welcome, <b>${esc(d.tenant.name)}</b></span><button class="tenant-profile-link" data-tenant-nav="profile">My profile</button><button class="logout" data-logout>Sign out</button></div></header><main class="tenant-main page-enter"><p class="kicker">YOUR HOME</p><h1>${esc(d.building.name)}</h1><p class="tenant-address">${esc(d.room.label)} · Floor ${d.room.floorNumber}</p><section class="tenant-hero"><div><span>Monthly rent</span><strong>${fmtMoney(d.room.monthlyRent)}</strong><small>Your fixed monthly rental</small></div><div><span>Rent outstanding</span><strong class="${rentDue ? 'is-due' : ''}">${fmtMoney(rentDue)}</strong><small>${rentDue ? 'Payment pending' : 'All caught up'}</small></div><div><span>Electricity outstanding</span><strong class="${elecDue ? 'is-due' : ''}">${fmtMoney(elecDue)}</strong><small>${elecDue ? 'Payment pending' : 'All caught up'}</small></div><div><span>Gas outstanding</span><strong class="${gasDue ? 'is-due' : ''}">${fmtMoney(gasDue)}</strong><small>${gasDue ? 'Payment pending' : 'All caught up'}</small></div></section>${payAll}<section class="tenant-bills">${table('Rent history', d.rent, 'rent')}${table('Electricity bills', d.electricity, 'electricity')}${table('Gas bills', gasEntries, 'gas')}</section><input type="file" data-receipt-file accept="image/jpeg,image/png,image/webp,application/pdf" hidden></main></div>`;
}

// ---------- online payments (Razorpay Checkout) ----------
let razorpayScriptPromise = null;
function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve();
  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = () => resolve();
      script.onerror = () => { razorpayScriptPromise = null; reject(new Error('Could not load Razorpay. Check your internet connection and try again.')); };
      document.head.appendChild(script);
    });
  }
  return razorpayScriptPromise;
}

// body is either { items: [{ kind, id }] } or { all: true }. The server works
// out the amount; the browser never sends one.
async function startTenantPayment(body, button) {
  if (button) button.disabled = true;
  try {
    const [order] = await Promise.all([api('POST', '/api/tenant/payments/order', body), loadRazorpayCheckout()]);
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      const checkout = new window.Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: order.name,
        description: order.description,
        prefill: order.prefill,
        theme: { color: '#0b5968' },
        handler: async (response) => {
          try {
            const result = await api('POST', '/api/tenant/payments/verify', response);
            toast(`Payment of ${fmtMoney(result.amount)} received. Thank you!`);
          } catch (error) { toast(error.message, true); }
          finish();
        },
        modal: { ondismiss: () => { toast('Payment was not completed.'); finish(); } },
      });
      checkout.on('payment.failed', (response) => toast(response?.error?.description || 'Payment failed. You can try again.', true));
      checkout.open();
    });
    cache.tenantLoadedAt = 0;
    render();
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
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
  document.querySelectorAll('[data-tenant-action="pay-bill"]').forEach((btn) => btn.onclick = () => {
    startTenantPayment({ items: [{ kind: btn.dataset.kind, id: btn.dataset.entryId }] }, btn);
  });
  document.querySelectorAll('[data-tenant-action="pay-all"]').forEach((btn) => btn.onclick = () => {
    startTenantPayment({ all: true }, btn);
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
      <div class="stat-card good"><div class="stat-label">Gas collected</div><div class="stat-value">${fmtMoney(d.gasCollected)}</div></div>
      <div class="stat-card warn"><div class="stat-label">Gas pending</div><div class="stat-value">${fmtMoney(d.gasPending)}</div></div>
      <div class="stat-card warn"><div class="stat-label">Open rent entries</div><div class="stat-value">${d.outstandingRentEntries ?? "–"}</div></div>
      <div class="stat-card warn"><div class="stat-label">Open electricity entries</div><div class="stat-value">${d.outstandingElectricityEntries ?? "–"}</div></div>
      <div class="stat-card warn"><div class="stat-label">Open gas entries</div><div class="stat-value">${d.outstandingGasEntries ?? "–"}</div></div>
    </div>

    ${renderGasToDoCard(d)}

    ${renderOnlinePaymentsCard(d)}

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
  if (r.electricityOnly && !["electricity", "gas"].includes(state.roomTab)) state.roomTab = 'electricity';

  const tabs = r.electricityOnly ? `
    <div class="tab-row">
      <button class="tab-btn ${state.roomTab === "electricity" ? "active" : ""}" data-room-tab="electricity">Electricity</button>
      <button class="tab-btn ${state.roomTab === "gas" ? "active" : ""}" data-room-tab="gas">Gas</button>
    </div>
  ` : `
    <div class="tab-row">
      <button class="tab-btn ${state.roomTab === "tenant" ? "active" : ""}" data-room-tab="tenant">Tenant</button>
      <button class="tab-btn ${state.roomTab === "rent" ? "active" : ""}" data-room-tab="rent">Rent</button>
      <button class="tab-btn ${state.roomTab === "electricity" ? "active" : ""}" data-room-tab="electricity">Electricity</button>
      <button class="tab-btn ${state.roomTab === "gas" ? "active" : ""}" data-room-tab="gas">Gas</button>
    </div>
  `;

  let body = "";
  if (state.roomTab === "gas") body = renderGasTab(r, r.electricityOnly ? null : tenant);
  else if (r.electricityOnly) body = renderElectricityTab(r, null);
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
                <td class="text">${MONTHS[e.month]} ${e.year}${onlinePaymentNote(e)}</td>
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

// Owner dashboard card: recent tenant payments received through Razorpay, or a
// reminder of how to switch online payments on.
function renderOnlinePaymentsCard(d) {
  if (!d.onlinePaymentsEnabled) {
    return `<div class="card"><h3>Online payments</h3><p class="profile-note">Tenants can't pay online yet. Add <code>RAZORPAY_KEY_ID</code> and <code>RAZORPAY_KEY_SECRET</code> from your Razorpay dashboard to your Railway variables to show a <strong>Pay</strong> button on every pending bill in the tenant portal. Payments settle to the bank account linked to your Razorpay account.</p></div>`;
  }
  const kindLabel = { rent: "Rent", electricity: "Electricity", gas: "Gas" };
  const rows = (cache.payments || []).map((p) => `
    <tr>
      <td class="text">${esc(new Date(p.paidAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }))}</td>
      <td class="text">${esc(p.tenantName)}${p.roomLabel ? `<br><small>${esc(p.roomLabel)}</small>` : ""}</td>
      <td class="text">${p.items.map((i) => `${kindLabel[i.kind] || i.kind} ${MONTHS[i.month] || ""} ${i.year || ""}`).map(esc).join("<br>")}</td>
      <td>${fmtMoney(p.amount)}</td>
      <td class="text"><small>${esc(p.method || "")}<br>${esc(p.razorpayPaymentId || "")}</small></td>
    </tr>`).join("");
  return `<div class="card"><h3>Online payments received <small style="font-weight:400">via Razorpay</small></h3>${rows ? `<table class="ledger"><thead><tr><th>Date</th><th>Tenant</th><th>Bills</th><th>Amount</th><th>Method / ID</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty-state">No online payments yet. Tenants will see a Pay button on each pending bill.</div>`}</div>`;
}

// Small note under a bill's period when the tenant paid it through Razorpay.
function onlinePaymentNote(e) {
  if (!e.onlinePayment) return "";
  return `<br><small class="paid-online">✓ Paid online · ${esc(e.onlinePayment.paymentId || "")}</small>`;
}

function renderElectricityTab(r, tenant) {
  const now = new Date();
  const lastReading = cache.electricity.length ? cache.electricity[0].currReading : 0;
  const editForms = cache.electricity.filter((entry) => state.forms[`editElec-${entry.id}`]).map((entry) => `<div class="card ledger-edit"><h3>Edit electricity entry · ${MONTHS[entry.month]} ${entry.year}</h3><form data-submit="edit-electricity" data-id="${entry.id}"><div class="form-grid cols-3"><div class="form-field"><label>Month *</label><select name="month" required>${MONTHS.slice(1).map((month, index) => `<option value="${index + 1}" ${index + 1 === Number(entry.month) ? 'selected' : ''}>${month}</option>`).join('')}</select></div><div class="form-field"><label>Year *</label><input name="year" type="number" required value="${entry.year}"></div><div class="form-field"><label>Rate per unit (₹)</label><input name="ratePerUnit" type="number" min="0" step="0.01" value="${entry.ratePerUnit}"></div><div class="form-field"><label>Previous reading</label><input name="prevReading" type="number" min="0" step="0.01" value="${entry.prevReading}"></div><div class="form-field"><label>Current reading *</label><input name="currReading" type="number" min="0" step="0.01" required value="${entry.currReading}"></div><div class="form-field"><label>Paid date</label><input name="paidDate" type="date" value="${esc(entry.paidDate || '')}"></div><div class="form-field" style="grid-column:span 3"><label>Notes</label><input name="notes" value="${esc(entry.notes || '')}"></div></div><div class="form-actions"><button class="btn" type="submit">Save changes</button><button class="btn secondary" type="button" data-toggle-form="editElec-${entry.id}">Cancel</button></div></form></div>`).join('');
  const addForm = state.forms.addElec ? `
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
  ` : "";

  return `
    ${addForm}${editForms}
    <div class="card">
      <h3>
        Electricity history
        <button class="btn small" data-toggle-form="addElec">+ Add reading</button>
      </h3>
      ${cache.electricity.length === 0 ? `<div class="empty-state">No electricity entries yet.</div>` : `
        <table class="ledger">
          <thead><tr><th>Period</th><th>Prev.</th><th>Current</th><th>Units</th><th>Rate</th><th>Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${cache.electricity.map((e) => `
              <tr>
                <td class="text">${MONTHS[e.month]} ${e.year}${onlinePaymentNote(e)}</td>
                <td>${e.prevReading}</td>
                <td>${e.currReading}</td>
                <td>${e.unitsConsumed}</td>
                <td>${fmtMoney(e.ratePerUnit)}</td>
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

// Gas meter ID + billing-authority link for a room. Gas is always billed
// directly by the linked authority (there's no meter-reading calculation
// mode) — the amount on each bill is whatever the owner reads off that
// authority's own bill/portal for this meter, entered by hand. The app has
// no official API into any gas provider's billing system, so this is not an
// automatic fetch, it's a manual due-amount entry that then shows as "due"
// in the tenant's gas section, same as the rent and electricity ledgers.
// "Indraprastha Gas Limited (IGL)" → "IGL"; names without an abbreviation stay as they are.
function authorityShortName(authority) {
  const match = /\(([^)]+)\)\s*$/.exec(authority?.name || "");
  return match ? match[1] : (authority?.name || "the supplier");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const field = document.createElement("textarea");
    field.value = text; field.setAttribute("readonly", ""); field.style.position = "fixed"; field.style.opacity = "0";
    document.body.appendChild(field); field.select();
    const ok = document.execCommand && document.execCommand("copy");
    field.remove();
    if (!ok) { toast(`Couldn't copy automatically. The number is ${text}`, true); return; }
  }
  toast(`Copied ${text}`);
}

// Dashboard to-do: linked gas meters with no bill entered for this month yet.
function renderGasToDoCard(d) {
  const rooms = d.gasBillsToEnter || [];
  if (!rooms.length) return "";
  const rows = rooms.map((room) => `
    <tr>
      <td class="text"><strong>${esc(room.roomLabel)}</strong><br><small>${esc(room.buildingName)}${room.tenantName ? ` · ${esc(room.tenantName)}` : ""}</small></td>
      <td class="text"><span class="meter-code">${esc(room.meterId)}</span> <button type="button" class="btn small secondary" data-action="copy-text" data-text="${esc(room.meterId)}">Copy</button></td>
      <td class="text">${room.billUrl ? `<a href="${esc(room.billUrl)}" target="_blank" rel="noopener noreferrer">${esc(authorityShortName({ name: room.authorityName }))} bill page ↗</a>` : `<small>${esc(room.authorityName)}</small>`}</td>
      <td><input class="gas-amount-input" type="number" min="0" step="0.01" inputmode="decimal" placeholder="₹ amount" aria-label="Amount due for ${esc(room.roomLabel)}" data-room-id="${room.roomId}" data-tenant-id="${room.tenantId || ""}" /></td>
    </tr>`).join("");
  return `<div class="card gas-todo">
    <h3>Gas bills to enter · ${MONTHS[d.month] || ""} ${d.year || ""} <small>${rooms.length} room${rooms.length === 1 ? "" : "s"}</small></h3>
    <p class="profile-note">Open each supplier's bill page, look up the meter number, and type the amount due. Tenants see the dues as soon as you save. Leave a box empty to skip that room for now.</p>
    <form data-submit="bulk-gas">
      <div class="table-scroll"><table class="ledger gas-todo-table"><thead><tr><th>Room</th><th>Meter</th><th>Bill page</th><th>Amount due (₹)</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="form-actions"><button class="btn" type="submit">Save entered bills</button></div>
    </form>
  </div>`;
}

function gasCard(r) {
  if (r.gasMeterId && r.gasAuthorityId) {
    const authority = cache.authorities.find((a) => a.id === r.gasAuthorityId);
    const editingLink = authority && (!authority.billUrl || state.forms[`billUrl-${authority.id}`]);
    const linkForm = editingLink ? `
      <form class="bill-link-form" data-submit="set-bill-url" data-authority-id="${authority.id}">
        <div class="form-field"><label for="bill-url-${authority.id}">Link to ${esc(authorityShortName(authority))}'s bill page</label><input id="bill-url-${authority.id}" name="billUrl" type="url" inputmode="url" required placeholder="https://…" value="${esc(authority.billUrl || "")}" /></div>
        <button class="btn small" type="submit">Save link</button>
        ${authority.billUrl ? `<button class="btn small secondary" type="button" data-toggle-form="billUrl-${authority.id}">Cancel</button>` : ""}
      </form>` : "";
    return `<div class="card meter-card">
      <h3>Gas meter &amp; billing authority</h3>
      <p class="profile-note">Meter <strong>${esc(r.gasMeterId)}</strong> · billed by <strong>${esc(authority ? authority.name : "an authority that's since been removed")}</strong>. Gas companies don't share bills with apps, so open their bill page, look up this meter, and enter the amount due below.</p>
      <div class="gas-actions">
        ${authority?.billUrl ? `<a class="btn small" href="${esc(authority.billUrl)}" target="_blank" rel="noopener noreferrer">Check bill on ${esc(authorityShortName(authority))} ↗</a>` : ""}
        <button class="btn small secondary" type="button" data-action="copy-text" data-text="${esc(r.gasMeterId)}">Copy meter ID</button>
        ${authority?.billUrl && !editingLink ? `<button class="btn small secondary" type="button" data-toggle-form="billUrl-${authority.id}">Edit bill link</button>` : ""}
        <button class="btn secondary small" data-action="unlink-gas-meter" data-room-id="${r.id}">Unlink gas meter</button>
      </div>
      ${linkForm}
    </div>`;
  }
  const options = cache.authorities.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  return `<div class="card meter-card">
    <h3>Gas meter &amp; billing authority</h3>
    <p class="profile-note">Link this room to a gas meter ID and a billing authority (gas board, LPG/PNG supplier, etc.) before adding gas bills.</p>
    <form data-submit="link-gas-meter" data-room-id="${r.id}">
      <div class="form-grid cols-3">
        <div class="form-field"><label>Meter ID *</label><input name="meterId" required placeholder="Consumer / BP number on the gas bill" /></div>
        <div class="form-field"><label>Billing authority *</label>
          <select name="authorityId" required data-authority-select>
            <option value="">Select authority</option>
            ${options}
            <option value="__new__">+ Add new authority…</option>
          </select>
        </div>
        <div class="form-field hidden" data-new-authority-field><label>New authority name</label><input name="newAuthorityName" placeholder="e.g. Indraprastha Gas Limited" /></div>
      </div>
      <div class="form-actions"><button class="btn" type="submit">Link meter</button></div>
    </form>
  </div>`;
}

function gasSubtitle(e) {
  const parts = [e.authorityName, e.meterId ? `Meter ${e.meterId}` : ""].filter(Boolean);
  return parts.length ? `<br><small style="color:var(--teal-mid);font-size:10px">${esc(parts.join(" · "))}</small>` : "";
}

function renderGasTab(r, tenant) {
  const now = new Date();
  const linked = Boolean(r.gasMeterId && r.gasAuthorityId);
  const editForms = cache.gas.filter((entry) => state.forms[`editGas-${entry.id}`]).map((entry) => `<div class="card ledger-edit"><h3>Edit bill · ${MONTHS[entry.month]} ${entry.year}</h3><form data-submit="edit-gas" data-id="${entry.id}"><div class="form-grid cols-3"><div class="form-field"><label>Month *</label><select name="month" required>${MONTHS.slice(1).map((month, index) => `<option value="${index + 1}" ${index + 1 === Number(entry.month) ? 'selected' : ''}>${month}</option>`).join('')}</select></div><div class="form-field"><label>Year *</label><input name="year" type="number" required value="${entry.year}"></div><div class="form-field"><label>Due amount (₹) *</label><input name="amount" type="number" min="0" step="0.01" required value="${entry.amount}"></div><div class="form-field"><label>Paid date</label><input name="paidDate" type="date" value="${esc(entry.paidDate || '')}"></div><div class="form-field" style="grid-column:span 3"><label>Notes</label><input name="notes" value="${esc(entry.notes || '')}"></div></div><div class="form-actions"><button class="btn" type="submit">Save changes</button><button class="btn secondary" type="button" data-toggle-form="editGas-${entry.id}">Cancel</button></div></form></div>`).join('');
  const addForm = state.forms.addGas && linked ? `
    <div class="card">
      <h3>Add gas bill</h3>
      <form data-submit="add-gas" data-room-id="${r.id}" data-tenant-id="${tenant ? tenant.id : ""}">
        <div class="form-grid cols-3">
          <div class="form-field"><label>Month *</label>
            <select name="month" required>${MONTHS.slice(1).map((m, i) => `<option value="${i + 1}" ${i + 1 === now.getMonth() + 1 ? "selected" : ""}>${m}</option>`).join("")}</select>
          </div>
          <div class="form-field"><label>Year *</label><input name="year" type="number" required value="${now.getFullYear()}" /></div>
          <div class="form-field"><label>Due amount (₹) *</label><input name="amount" type="number" min="0" step="0.01" required placeholder="e.g. 650" /></div>
          <div class="form-field"><label>Paid date</label><input name="paidDate" type="date" /></div>
          <div class="form-field" style="grid-column: span 3;"><label>Notes</label><input name="notes" placeholder="Optional" /></div>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">Save bill</button>
          <button class="btn secondary" type="button" data-toggle-form="addGas">Cancel</button>
        </div>
      </form>
    </div>
  ` : "";

  const curMonth = now.getMonth() + 1, curYear = now.getFullYear();
  const hasThisMonth = cache.gas.some((e) => Number(e.month) === curMonth && Number(e.year) === curYear);
  const quickCard = linked && !hasThisMonth ? `
    <div class="card gas-due-card">
      <h3>${MONTHS[curMonth]} ${curYear} bill not entered yet</h3>
      <p class="profile-note">Look up meter <strong>${esc(r.gasMeterId)}</strong> on the supplier's bill page and enter the amount due.${tenant ? ` ${esc(tenant.name)} will see it straight away.` : ""}</p>
      <form class="quick-gas-form" data-submit="quick-gas" data-room-id="${r.id}" data-tenant-id="${tenant ? tenant.id : ""}">
        <div class="form-field"><label for="quick-gas-${r.id}">Amount due (₹)</label><input id="quick-gas-${r.id}" name="amount" type="number" min="0" step="0.01" inputmode="decimal" required placeholder="e.g. 650" /></div>
        <button class="btn" type="submit">Save ${MONTHS[curMonth]} bill</button>
      </form>
    </div>` : "";

  return `
    ${gasCard(r)}
    ${quickCard}
    ${addForm}${editForms}
    <div class="card">
      <h3>
        Gas history
        <button class="btn small" data-toggle-form="addGas" ${linked ? "" : "disabled title=\"Link a gas meter first\""}>+ Add bill</button>
      </h3>
      ${cache.gas.length === 0 ? `<div class="empty-state">No gas entries yet.</div>` : `
        <table class="ledger">
          <thead><tr><th>Period</th><th>Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${cache.gas.map((e) => `
              <tr>
                <td class="text">${MONTHS[e.month]} ${e.year}${gasSubtitle(e)}${onlinePaymentNote(e)}</td>
                <td>${fmtMoney(e.amount)}</td>
                <td><span class="stamp ${e.status}">${e.status}</span></td>
                <td style="white-space:nowrap;">
                  ${e.receipt ? `<button class="btn small secondary" data-action="view-receipt" data-receipt-id="${e.receipt.id}">View proof</button>` : ""}
                  <button class="btn small secondary" data-toggle-form="editGas-${e.id}">Edit</button>
                  ${e.status !== "paid" ? `<button class="btn small secondary" data-action="mark-gas-paid" data-id="${e.id}">Mark paid</button>` : ""}
                  <button class="btn small danger" data-action="delete-gas" data-id="${e.id}">Delete</button>
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
    } else if (act === "copy-text") {
      await copyText(el.dataset.text || "");
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
    } else if (act === "mark-gas-paid") {
      await api("PUT", `/api/gas/${el.dataset.id}`, { paidDate: today() });
      toast("Gas bill marked as paid");
    } else if (act === "delete-gas") {
      if (!confirm("Delete this gas entry?")) return;
      await api("DELETE", `/api/gas/${el.dataset.id}`);
      toast("Entry deleted");
    } else if (act === "unlink-gas-meter") {
      if (!confirm("Unlink this gas meter? Past bill history is kept as-is.")) return;
      await api("DELETE", `/api/rooms/${el.dataset.roomId}/gas-meter`);
      toast("Gas meter unlinked");
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
    } else if (kind === "add-gas") {
      await api("POST", "/api/gas", { ...data, roomId: form.dataset.roomId, tenantId: form.dataset.tenantId || null });
      state.forms.addGas = false;
      toast("Gas bill added");
    } else if (kind === 'edit-gas') {
      await api('PUT', `/api/gas/${form.dataset.id}`, data);
      state.forms[`editGas-${form.dataset.id}`] = false;
      toast('Gas bill updated');
    } else if (kind === 'quick-gas') {
      const now = new Date();
      await api('POST', '/api/gas', { roomId: form.dataset.roomId, tenantId: form.dataset.tenantId || null, month: now.getMonth() + 1, year: now.getFullYear(), amount: data.amount });
      toast(`${MONTHS[now.getMonth() + 1]} gas bill saved`);
    } else if (kind === 'bulk-gas') {
      const now = new Date();
      const filled = [...form.querySelectorAll('input[data-room-id]')].filter((input) => input.value.trim() !== '');
      if (!filled.length) throw new Error('Enter the amount due for at least one room.');
      for (const input of filled) {
        await api('POST', '/api/gas', { roomId: input.dataset.roomId, tenantId: input.dataset.tenantId || null, month: now.getMonth() + 1, year: now.getFullYear(), amount: input.value });
      }
      toast(`Saved ${filled.length} gas bill${filled.length === 1 ? '' : 's'}`);
    } else if (kind === 'set-bill-url') {
      await api('PUT', `/api/authorities/${form.dataset.authorityId}`, { billUrl: data.billUrl });
      state.forms[`billUrl-${form.dataset.authorityId}`] = false;
      toast('Bill page link saved');
    } else if (kind === 'link-gas-meter') {
      let authorityId = data.authorityId;
      if (authorityId === '__new__') {
        const name = (data.newAuthorityName || '').trim();
        if (!name) throw new Error('Enter a name for the new authority.');
        const authority = await api('POST', '/api/authorities', { name });
        authorityId = authority.id;
      }
      if (!authorityId) throw new Error('Choose a billing authority.');
      await api('PUT', `/api/rooms/${form.dataset.roomId}/gas-meter`, { meterId: data.meterId, authorityId });
      toast('Gas meter linked');
    }
    invalidateData(); cache.profile = null; cache.tenantProfile = null;
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

render();  button.textContent = 'Install app';
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

const cache = { buildings: [], rooms: [], tenants: [], authorities: [], dashboard: null, rent: [], electricity: [], gas: [], payments: [], buildingRent: [], profile: null, tenantPortal: null, tenantProfile: null, coreLoadedAt: 0, tenantLoadedAt: 0 };

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
    if (state.view === "dashboard") [cache.dashboard, cache.payments] = await Promise.all([api("GET", "/api/dashboard"), api("GET", "/api/payments?limit=8")]);
    if (state.view === "building" && state.buildingId) cache.buildingRent = await api("GET", `/api/rent?buildingId=${state.buildingId}`);
    if (state.view === "room" && state.roomId) {
      const [rent, electricity, gas] = await Promise.all([
        api("GET", `/api/rent?roomId=${state.roomId}`),
        api("GET", `/api/electricity?roomId=${state.roomId}`),
        api("GET", `/api/gas?roomId=${state.roomId}`),
      ]);
      cache.rent = rent.sort((a, b) => b.year - a.year || b.month - a.month);
      cache.electricity = electricity.sort((a, b) => b.year - a.year || b.month - a.month);
      cache.gas = gas.sort((a, b) => b.year - a.year || b.month - a.month);
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
  const d = cache.tenantPortal;
  const gasEntries = d.gas || [];
  const owed = (entry, type) => entry.status === 'paid' ? 0 : type === 'rent' ? Math.max((entry.rentAmount || 0) - (entry.amountPaid || 0), 0) : (entry.amount || 0);
  const rentDue = d.rent.reduce((s, x) => s + owed(x, 'rent'), 0);
  const elecDue = d.electricity.reduce((s, x) => s + owed(x, 'electricity'), 0);
  const gasDue = gasEntries.reduce((s, x) => s + owed(x, 'gas'), 0);
  const totalDue = rentDue + elecDue + gasDue;
  const canPayOnline = Boolean(d.payments?.enabled);
  const billRows = (entries, type) => entries.slice(0,6).map(e => {
    const due = owed(e, type);
    const payButton = canPayOnline && due > 0
      ? `<button class="btn small pay-btn" data-tenant-action="pay-bill" data-kind="${type}" data-entry-id="${e.id}">Pay ${fmtMoney(due)}</button>`
      : '';
    const proof = e.onlinePayment && e.status === 'paid'
      ? `<span class="paid-online" title="Razorpay ${esc(e.onlinePayment.paymentId || '')}">✓ Paid online</span>`
      : e.receipt
        ? `<button class="btn small secondary" data-tenant-action="view-receipt" data-receipt-id="${e.receipt.id}">View proof</button>`
        : `<button class="btn small secondary" data-tenant-action="upload-receipt" data-kind="${type}" data-entry-id="${e.id}">Add proof</button>`;
    return `<tr><td>${MONTHS[e.month]} ${e.year}${type === 'gas' ? gasSubtitle(e) : ''}</td><td>${type === 'rent' ? fmtMoney(e.rentAmount) : fmtMoney(e.amount)}</td><td><span class="stamp ${e.status}">${e.status}</span></td><td><div class="bill-actions">${payButton}${proof}</div></td></tr>`;
  }).join('') || `<tr><td colspan="4" class="text">No records yet</td></tr>`;
  const payAll = totalDue > 0
    ? (canPayOnline
      ? `<section class="card pay-all-card"><div><span class="kicker">TOTAL PENDING</span><strong>${fmtMoney(totalDue)}</strong><small>Rent, electricity and gas together · paid securely via Razorpay (UPI, cards, net banking)</small></div><button class="btn pay-btn" data-tenant-action="pay-all">Pay all ${fmtMoney(totalDue)}</button></section>`
      : `<section class="card pay-all-card muted"><div><span class="kicker">TOTAL PENDING</span><strong>${fmtMoney(totalDue)}</strong><small>Online payment isn't enabled by your owner yet. Pay them directly and add a payment proof below.</small></div></section>`)
    : '';
  const table = (title, entries, type) => `<article class="card"><h3><span>${title}</span><small>Last 6 entries</small></h3><table class="ledger tenant-ledger"><thead><tr><th>Period</th><th>Amount</th><th>Status</th><th>Payment</th></tr></thead><tbody>${billRows(entries, type)}</tbody></table></article>`;
  return `<div class="tenant-shell"><header class="tenant-top"><div class="brand">Rent Ledger <span class="brand-mark">TENANT</span></div><div class="tenant-user"><span>Welcome, <b>${esc(d.tenant.name)}</b></span><button class="tenant-profile-link" data-tenant-nav="profile">My profile</button><button class="logout" data-logout>Sign out</button></div></header><main class="tenant-main page-enter"><p class="kicker">YOUR HOME</p><h1>${esc(d.building.name)}</h1><p class="tenant-address">${esc(d.room.label)} · Floor ${d.room.floorNumber}</p><section class="tenant-hero"><div><span>Monthly rent</span><strong>${fmtMoney(d.room.monthlyRent)}</strong><small>Your fixed monthly rental</small></div><div><span>Rent outstanding</span><strong class="${rentDue ? 'is-due' : ''}">${fmtMoney(rentDue)}</strong><small>${rentDue ? 'Payment pending' : 'All caught up'}</small></div><div><span>Electricity outstanding</span><strong class="${elecDue ? 'is-due' : ''}">${fmtMoney(elecDue)}</strong><small>${elecDue ? 'Payment pending' : 'All caught up'}</small></div><div><span>Gas outstanding</span><strong class="${gasDue ? 'is-due' : ''}">${fmtMoney(gasDue)}</strong><small>${gasDue ? 'Payment pending' : 'All caught up'}</small></div></section>${payAll}<section class="tenant-bills">${table('Rent history', d.rent, 'rent')}${table('Electricity bills', d.electricity, 'electricity')}${table('Gas bills', gasEntries, 'gas')}</section><input type="file" data-receipt-file accept="image/jpeg,image/png,image/webp,application/pdf" hidden></main></div>`;
}

// ---------- online payments (Razorpay Checkout) ----------
let razorpayScriptPromise = null;
function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve();
  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = () => resolve();
      script.onerror = () => { razorpayScriptPromise = null; reject(new Error('Could not load Razorpay. Check your internet connection and try again.')); };
      document.head.appendChild(script);
    });
  }
  return razorpayScriptPromise;
}

// body is either { items: [{ kind, id }] } or { all: true }. The server works
// out the amount; the browser never sends one.
async function startTenantPayment(body, button) {
  if (button) button.disabled = true;
  try {
    const [order] = await Promise.all([api('POST', '/api/tenant/payments/order', body), loadRazorpayCheckout()]);
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      const checkout = new window.Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: order.name,
        description: order.description,
        prefill: order.prefill,
        theme: { color: '#0b5968' },
        handler: async (response) => {
          try {
            const result = await api('POST', '/api/tenant/payments/verify', response);
            toast(`Payment of ${fmtMoney(result.amount)} received. Thank you!`);
          } catch (error) { toast(error.message, true); }
          finish();
        },
        modal: { ondismiss: () => { toast('Payment was not completed.'); finish(); } },
      });
      checkout.on('payment.failed', (response) => toast(response?.error?.description || 'Payment failed. You can try again.', true));
      checkout.open();
    });
    cache.tenantLoadedAt = 0;
    render();
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
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
  document.querySelectorAll('[data-tenant-action="pay-bill"]').forEach((btn) => btn.onclick = () => {
    startTenantPayment({ items: [{ kind: btn.dataset.kind, id: btn.dataset.entryId }] }, btn);
  });
  document.querySelectorAll('[data-tenant-action="pay-all"]').forEach((btn) => btn.onclick = () => {
    startTenantPayment({ all: true }, btn);
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
      <div class="stat-card good"><div class="stat-label">Gas collected</div><div class="stat-value">${fmtMoney(d.gasCollected)}</div></div>
      <div class="stat-card warn"><div class="stat-label">Gas pending</div><div class="stat-value">${fmtMoney(d.gasPending)}</div></div>
      <div class="stat-card warn"><div class="stat-label">Open rent entries</div><div class="stat-value">${d.outstandingRentEntries ?? "–"}</div></div>
      <div class="stat-card warn"><div class="stat-label">Open electricity entries</div><div class="stat-value">${d.outstandingElectricityEntries ?? "–"}</div></div>
      <div class="stat-card warn"><div class="stat-label">Open gas entries</div><div class="stat-value">${d.outstandingGasEntries ?? "–"}</div></div>
    </div>

    ${renderOnlinePaymentsCard(d)}

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
  if (r.electricityOnly && !["electricity", "gas"].includes(state.roomTab)) state.roomTab = 'electricity';

  const tabs = r.electricityOnly ? `
    <div class="tab-row">
      <button class="tab-btn ${state.roomTab === "electricity" ? "active" : ""}" data-room-tab="electricity">Electricity</button>
      <button class="tab-btn ${state.roomTab === "gas" ? "active" : ""}" data-room-tab="gas">Gas</button>
    </div>
  ` : `
    <div class="tab-row">
      <button class="tab-btn ${state.roomTab === "tenant" ? "active" : ""}" data-room-tab="tenant">Tenant</button>
      <button class="tab-btn ${state.roomTab === "rent" ? "active" : ""}" data-room-tab="rent">Rent</button>
      <button class="tab-btn ${state.roomTab === "electricity" ? "active" : ""}" data-room-tab="electricity">Electricity</button>
      <button class="tab-btn ${state.roomTab === "gas" ? "active" : ""}" data-room-tab="gas">Gas</button>
    </div>
  `;

  let body = "";
  if (state.roomTab === "gas") body = renderGasTab(r, r.electricityOnly ? null : tenant);
  else if (r.electricityOnly) body = renderElectricityTab(r, null);
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
                <td class="text">${MONTHS[e.month]} ${e.year}${onlinePaymentNote(e)}</td>
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

// Owner dashboard card: recent tenant payments received through Razorpay, or a
// reminder of how to switch online payments on.
function renderOnlinePaymentsCard(d) {
  if (!d.onlinePaymentsEnabled) {
    return `<div class="card"><h3>Online payments</h3><p class="profile-note">Tenants can't pay online yet. Add <code>RAZORPAY_KEY_ID</code> and <code>RAZORPAY_KEY_SECRET</code> from your Razorpay dashboard to your Railway variables to show a <strong>Pay</strong> button on every pending bill in the tenant portal. Payments settle to the bank account linked to your Razorpay account.</p></div>`;
  }
  const kindLabel = { rent: "Rent", electricity: "Electricity", gas: "Gas" };
  const rows = (cache.payments || []).map((p) => `
    <tr>
      <td class="text">${esc(new Date(p.paidAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }))}</td>
      <td class="text">${esc(p.tenantName)}${p.roomLabel ? `<br><small>${esc(p.roomLabel)}</small>` : ""}</td>
      <td class="text">${p.items.map((i) => `${kindLabel[i.kind] || i.kind} ${MONTHS[i.month] || ""} ${i.year || ""}`).map(esc).join("<br>")}</td>
      <td>${fmtMoney(p.amount)}</td>
      <td class="text"><small>${esc(p.method || "")}<br>${esc(p.razorpayPaymentId || "")}</small></td>
    </tr>`).join("");
  return `<div class="card"><h3>Online payments received <small style="font-weight:400">via Razorpay</small></h3>${rows ? `<table class="ledger"><thead><tr><th>Date</th><th>Tenant</th><th>Bills</th><th>Amount</th><th>Method / ID</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty-state">No online payments yet. Tenants will see a Pay button on each pending bill.</div>`}</div>`;
}

// Small note under a bill's period when the tenant paid it through Razorpay.
function onlinePaymentNote(e) {
  if (!e.onlinePayment) return "";
  return `<br><small class="paid-online">✓ Paid online · ${esc(e.onlinePayment.paymentId || "")}</small>`;
}

function renderElectricityTab(r, tenant) {
  const now = new Date();
  const lastReading = cache.electricity.length ? cache.electricity[0].currReading : 0;
  const editForms = cache.electricity.filter((entry) => state.forms[`editElec-${entry.id}`]).map((entry) => `<div class="card ledger-edit"><h3>Edit electricity entry · ${MONTHS[entry.month]} ${entry.year}</h3><form data-submit="edit-electricity" data-id="${entry.id}"><div class="form-grid cols-3"><div class="form-field"><label>Month *</label><select name="month" required>${MONTHS.slice(1).map((month, index) => `<option value="${index + 1}" ${index + 1 === Number(entry.month) ? 'selected' : ''}>${month}</option>`).join('')}</select></div><div class="form-field"><label>Year *</label><input name="year" type="number" required value="${entry.year}"></div><div class="form-field"><label>Rate per unit (₹)</label><input name="ratePerUnit" type="number" min="0" step="0.01" value="${entry.ratePerUnit}"></div><div class="form-field"><label>Previous reading</label><input name="prevReading" type="number" min="0" step="0.01" value="${entry.prevReading}"></div><div class="form-field"><label>Current reading *</label><input name="currReading" type="number" min="0" step="0.01" required value="${entry.currReading}"></div><div class="form-field"><label>Paid date</label><input name="paidDate" type="date" value="${esc(entry.paidDate || '')}"></div><div class="form-field" style="grid-column:span 3"><label>Notes</label><input name="notes" value="${esc(entry.notes || '')}"></div></div><div class="form-actions"><button class="btn" type="submit">Save changes</button><button class="btn secondary" type="button" data-toggle-form="editElec-${entry.id}">Cancel</button></div></form></div>`).join('');
  const addForm = state.forms.addElec ? `
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
  ` : "";

  return `
    ${addForm}${editForms}
    <div class="card">
      <h3>
        Electricity history
        <button class="btn small" data-toggle-form="addElec">+ Add reading</button>
      </h3>
      ${cache.electricity.length === 0 ? `<div class="empty-state">No electricity entries yet.</div>` : `
        <table class="ledger">
          <thead><tr><th>Period</th><th>Prev.</th><th>Current</th><th>Units</th><th>Rate</th><th>Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${cache.electricity.map((e) => `
              <tr>
                <td class="text">${MONTHS[e.month]} ${e.year}${onlinePaymentNote(e)}</td>
                <td>${e.prevReading}</td>
                <td>${e.currReading}</td>
                <td>${e.unitsConsumed}</td>
                <td>${fmtMoney(e.ratePerUnit)}</td>
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

// Gas meter ID + billing-authority link for a room. Gas is always billed
// directly by the linked authority (there's no meter-reading calculation
// mode) — the amount on each bill is whatever the owner reads off that
// authority's own bill/portal for this meter, entered by hand. The app has
// no official API into any gas provider's billing system, so this is not an
// automatic fetch, it's a manual due-amount entry that then shows as "due"
// in the tenant's gas section, same as the rent and electricity ledgers.
function gasCard(r) {
  if (r.gasMeterId && r.gasAuthorityId) {
    const authority = cache.authorities.find((a) => a.id === r.gasAuthorityId);
    return `<div class="card meter-card">
      <h3>Gas meter &amp; billing authority</h3>
      <p class="profile-note">Meter <strong>${esc(r.gasMeterId)}</strong> · billed by <strong>${esc(authority ? authority.name : "an authority that's since been removed")}</strong>. Enter each bill's due amount as shown by that authority below.</p>
      <button class="btn secondary small" data-action="unlink-gas-meter" data-room-id="${r.id}">Unlink gas meter</button>
    </div>`;
  }
  const options = cache.authorities.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  return `<div class="card meter-card">
    <h3>Gas meter &amp; billing authority</h3>
    <p class="profile-note">Link this room to a gas meter ID and a billing authority (gas board, LPG/PNG supplier, etc.) before adding gas bills.</p>
    <form data-submit="link-gas-meter" data-room-id="${r.id}">
      <div class="form-grid cols-3">
        <div class="form-field"><label>Meter ID *</label><input name="meterId" required placeholder="e.g. GAS-4521" /></div>
        <div class="form-field"><label>Billing authority *</label>
          <select name="authorityId" required data-authority-select>
            <option value="">Select authority</option>
            ${options}
            <option value="__new__">+ Add new authority…</option>
          </select>
        </div>
        <div class="form-field hidden" data-new-authority-field><label>New authority name</label><input name="newAuthorityName" placeholder="e.g. Indraprastha Gas Limited" /></div>
      </div>
      <div class="form-actions"><button class="btn" type="submit">Link meter</button></div>
    </form>
  </div>`;
}

function gasSubtitle(e) {
  const parts = [e.authorityName, e.meterId ? `Meter ${e.meterId}` : ""].filter(Boolean);
  return parts.length ? `<br><small style="color:var(--teal-mid);font-size:10px">${esc(parts.join(" · "))}</small>` : "";
}

function renderGasTab(r, tenant) {
  const now = new Date();
  const linked = Boolean(r.gasMeterId && r.gasAuthorityId);
  const editForms = cache.gas.filter((entry) => state.forms[`editGas-${entry.id}`]).map((entry) => `<div class="card ledger-edit"><h3>Edit bill · ${MONTHS[entry.month]} ${entry.year}</h3><form data-submit="edit-gas" data-id="${entry.id}"><div class="form-grid cols-3"><div class="form-field"><label>Month *</label><select name="month" required>${MONTHS.slice(1).map((month, index) => `<option value="${index + 1}" ${index + 1 === Number(entry.month) ? 'selected' : ''}>${month}</option>`).join('')}</select></div><div class="form-field"><label>Year *</label><input name="year" type="number" required value="${entry.year}"></div><div class="form-field"><label>Due amount (₹) *</label><input name="amount" type="number" min="0" step="0.01" required value="${entry.amount}"></div><div class="form-field"><label>Paid date</label><input name="paidDate" type="date" value="${esc(entry.paidDate || '')}"></div><div class="form-field" style="grid-column:span 3"><label>Notes</label><input name="notes" value="${esc(entry.notes || '')}"></div></div><div class="form-actions"><button class="btn" type="submit">Save changes</button><button class="btn secondary" type="button" data-toggle-form="editGas-${entry.id}">Cancel</button></div></form></div>`).join('');
  const addForm = state.forms.addGas && linked ? `
    <div class="card">
      <h3>Add gas bill</h3>
      <form data-submit="add-gas" data-room-id="${r.id}" data-tenant-id="${tenant ? tenant.id : ""}">
        <div class="form-grid cols-3">
          <div class="form-field"><label>Month *</label>
            <select name="month" required>${MONTHS.slice(1).map((m, i) => `<option value="${i + 1}" ${i + 1 === now.getMonth() + 1 ? "selected" : ""}>${m}</option>`).join("")}</select>
          </div>
          <div class="form-field"><label>Year *</label><input name="year" type="number" required value="${now.getFullYear()}" /></div>
          <div class="form-field"><label>Due amount (₹) *</label><input name="amount" type="number" min="0" step="0.01" required placeholder="e.g. 650" /></div>
          <div class="form-field"><label>Paid date</label><input name="paidDate" type="date" /></div>
          <div class="form-field" style="grid-column: span 3;"><label>Notes</label><input name="notes" placeholder="Optional" /></div>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">Save bill</button>
          <button class="btn secondary" type="button" data-toggle-form="addGas">Cancel</button>
        </div>
      </form>
    </div>
  ` : "";

  return `
    ${gasCard(r)}
    ${addForm}${editForms}
    <div class="card">
      <h3>
        Gas history
        <button class="btn small" data-toggle-form="addGas" ${linked ? "" : "disabled title=\"Link a gas meter first\""}>+ Add bill</button>
      </h3>
      ${cache.gas.length === 0 ? `<div class="empty-state">No gas entries yet.</div>` : `
        <table class="ledger">
          <thead><tr><th>Period</th><th>Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${cache.gas.map((e) => `
              <tr>
                <td class="text">${MONTHS[e.month]} ${e.year}${gasSubtitle(e)}${onlinePaymentNote(e)}</td>
                <td>${fmtMoney(e.amount)}</td>
                <td><span class="stamp ${e.status}">${e.status}</span></td>
                <td style="white-space:nowrap;">
                  ${e.receipt ? `<button class="btn small secondary" data-action="view-receipt" data-receipt-id="${e.receipt.id}">View proof</button>` : ""}
                  <button class="btn small secondary" data-toggle-form="editGas-${e.id}">Edit</button>
                  ${e.status !== "paid" ? `<button class="btn small secondary" data-action="mark-gas-paid" data-id="${e.id}">Mark paid</button>` : ""}
                  <button class="btn small danger" data-action="delete-gas" data-id="${e.id}">Delete</button>
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
    } else if (act === "mark-gas-paid") {
      await api("PUT", `/api/gas/${el.dataset.id}`, { paidDate: today() });
      toast("Gas bill marked as paid");
    } else if (act === "delete-gas") {
      if (!confirm("Delete this gas entry?")) return;
      await api("DELETE", `/api/gas/${el.dataset.id}`);
      toast("Entry deleted");
    } else if (act === "unlink-gas-meter") {
      if (!confirm("Unlink this gas meter? Past bill history is kept as-is.")) return;
      await api("DELETE", `/api/rooms/${el.dataset.roomId}/gas-meter`);
      toast("Gas meter unlinked");
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
    } else if (kind === "add-gas") {
      await api("POST", "/api/gas", { ...data, roomId: form.dataset.roomId, tenantId: form.dataset.tenantId || null });
      state.forms.addGas = false;
      toast("Gas bill added");
    } else if (kind === 'edit-gas') {
      await api('PUT', `/api/gas/${form.dataset.id}`, data);
      state.forms[`editGas-${form.dataset.id}`] = false;
      toast('Gas bill updated');
    } else if (kind === 'link-gas-meter') {
      let authorityId = data.authorityId;
      if (authorityId === '__new__') {
        const name = (data.newAuthorityName || '').trim();
        if (!name) throw new Error('Enter a name for the new authority.');
        const authority = await api('POST', '/api/authorities', { name });
        authorityId = authority.id;
      }
      if (!authorityId) throw new Error('Choose a billing authority.');
      await api('PUT', `/api/rooms/${form.dataset.roomId}/gas-meter`, { meterId: data.meterId, authorityId });
      toast('Gas meter linked');
    }
    invalidateData(); cache.profile = null; cache.tenantProfile = null;
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

render();
