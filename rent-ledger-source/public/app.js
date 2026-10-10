// ---------- tiny state machine ----------
const state = {
  view: "dashboard", // dashboard | building | room | profile
  buildingId: null,
  roomId: null,
  roomTab: "tenant", // tenant | rent | electricity
  tenantView: "home", // home | profile
  forms: {}, // toggle flags e.g. forms.addBuilding = true
};

// ---------- colour themes ----------
// The palettes themselves live in style.css (html[data-theme]); this list is
// for the picker swatches and the browser bar colour.
const THEMES = [
  { id: 'indigo', name: 'Indigo', bar: '#424591', sidebar: '#32325d', primary: '#4e58af', warm: '#f69769' },
  { id: 'teal', name: 'Teal', bar: '#0b5968', sidebar: '#0c3e4c', primary: '#146f7b', warm: '#e7a25e' },
  { id: 'ocean', name: 'Ocean', bar: '#185188', sidebar: '#1a385d', primary: '#1b66a3', warm: '#e8a25f' },
  { id: 'forest', name: 'Forest', bar: '#175d3e', sidebar: '#0b422d', primary: '#2a734b', warm: '#d1af52' },
  { id: 'plum', name: 'Plum', bar: '#74365d', sidebar: '#53263f', primary: '#8c4676', warm: '#e2a559' },
  { id: 'slate', name: 'Graphite', bar: '#445061', sidebar: '#303845', primary: '#546477', warm: '#eaa059' },
];
const DEFAULT_THEME = 'indigo';
function themeInfo(id) { return THEMES.find((t) => t.id === id) || THEMES.find((t) => t.id === DEFAULT_THEME); }
function currentThemeId() { return themeInfo(document.documentElement.dataset.theme).id; }
function applyTheme(id) {
  const theme = themeInfo(id);
  document.documentElement.dataset.theme = theme.id;
  let bar = document.querySelector('meta[name="theme-color"]');
  if (!bar) { bar = document.createElement('meta'); bar.name = 'theme-color'; document.head.appendChild(bar); }
  bar.content = theme.bar;
  return theme;
}
function savedTheme() { try { return localStorage.getItem('rentLedgerTheme') || DEFAULT_THEME; } catch { return DEFAULT_THEME; } }
applyTheme(savedTheme());
// Scenery behind the glass: sky, sun, clouds, city skyline and glass bubbles. Decorative only.
(() => {
  if (document.querySelector('.scenery')) return;
  const scene = document.createElement('div');
  scene.className = 'scenery';
  scene.setAttribute('aria-hidden', 'true');
  scene.innerHTML = '<div class="sc-sky"></div><div class="sc-sun"></div><div class="sc-cloud c1"></div><div class="sc-cloud c2"></div><div class="sc-cloud c3"></div><div class="sc-city back"></div><div class="sc-city front"></div><div class="sc-haze"></div><div class="sc-orb o1"></div><div class="sc-orb o2"></div><div class="sc-orb o3"></div><div class="sc-grain"></div>';
  document.body.prepend(scene);
})();
function themeSwatchStyle(t) { return `background:linear-gradient(135deg, ${t.sidebar}, ${t.primary});--sw-warm:${t.warm}`; }
function themePicker() {
  const active = currentThemeId();
  return `<article class="card profile-card appearance-card"><h3>Appearance <small>this device</small></h3><p class="profile-note">Choose a colour theme. It changes the whole app on this device and is remembered next time.</p><div class="theme-grid" role="group" aria-label="Colour theme">${THEMES.map((t) => `<button type="button" class="theme-option" data-theme-pick="${t.id}" aria-pressed="${t.id === active}"><span class="theme-swatch" style="${themeSwatchStyle(t)}"></span><span class="theme-name">${t.name}</span></button>`).join('')}</div></article>`;
}
function pickTheme(id) {
  if (id === currentThemeId()) return;
  try { localStorage.setItem('rentLedgerTheme', id); } catch {}
  const swap = () => {
    const theme = applyTheme(id);
    document.querySelectorAll('[data-theme-pick]').forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.themePick === theme.id)));
  };
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (document.startViewTransition && !reduce) {
    root.classList.add('vt-theme');
    try { document.startViewTransition(swap).finished.finally(() => root.classList.remove('vt-theme')); }
    catch { root.classList.remove('vt-theme'); swap(); }
  } else {
    swap();
  }
  toast(`${themeInfo(id).name} theme on`);
}
// Liquid glass: a soft highlight follows the pointer across glass surfaces.
(() => {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  const GLASS = '.card, .stat-card, .building-card, .room-card, .profile-card';
  let frame = 0, last = null;
  addEventListener('pointermove', (event) => {
    last = event;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const el = last.target instanceof Element ? last.target.closest(GLASS) : null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${(((last.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
      el.style.setProperty('--my', `${(((last.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
    });
  }, { passive: true });
})();
document.addEventListener('click', (event) => {
  const pick = event.target.closest('[data-theme-pick]');
  if (pick) pickTheme(pick.dataset.themePick);
});
// Remember whether the dashboard's "Show details" is open across re-renders.
document.addEventListener('toggle', (event) => {
  if (event.target.matches?.('.dash-details')) state.dashDetails = event.target.open;
}, true);

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
// The Android and iPhone apps carry the screens inside the app and talk to
// the live server. (A different server can still be set for testing by
// saving 'rentLedgerApiBase' in the app's storage.)
const DEFAULT_API_BASE = 'https://rent-ledger.up.railway.app';
function apiBase() {
  if (!isMobileApp) return '';
  try { return localStorage.getItem('rentLedgerApiBase') || DEFAULT_API_BASE; } catch { return DEFAULT_API_BASE; }
}
function apiUrl(url) { return apiBase() ? apiBase().replace(/\/$/, '') + url : url; }

const cache = { buildings: [], rooms: [], tenants: [], authorities: [], dashboard: null, rent: [], electricity: [], gas: [], payments: [], buildingRent: [], profile: null, tenantPortal: null, tenantProfile: null, coreLoadedAt: 0, tenantLoadedAt: 0 };

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------- API helpers ----------
async function api(method, url, body) {
  const res = await fetch(apiUrl(url), {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('The Mac server address is incorrect. Run “npm start” on your Mac and enter the exact http://…:4000 Wi-Fi link shown in Terminal.');
  }
  if (res.status === 401 && session?.token && !url.startsWith('/api/auth/')) {
    // The session expired or was ended (e.g. password changed on another device).
    try { sessionStorage.setItem('rentLedgerNotice', 'Your session has ended. Please sign in again.'); } catch {}
    localStorage.removeItem('rentLedgerSession');
    location.reload();
    return new Promise(() => {});
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
  // In the Android / iPhone app the file goes to the phone's share sheet / viewer.
  if (isMobileApp && window.RL_EXT?.helpers?.openAuthed) return RL_EXT.helpers.openAuthed(`/api/receipts/${receiptId}`);
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
  if (!root) return;
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.innerHTML = `<span class="toast-icon" aria-hidden="true">${isError ? "!" : "✓"}</span><span class="toast-text"></span>`;
  el.querySelector(".toast-text").textContent = msg;
  root.appendChild(el);
  const leave = () => {
    if (el.classList.contains("is-leaving")) return;
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 260);
  };
  const timer = setTimeout(leave, isError ? 5200 : 3400);
  el.onclick = () => { clearTimeout(timer); leave(); };
  // Keep the stack short: the oldest toast steps aside when a fourth arrives.
  const visible = root.querySelectorAll(".toast:not(.is-leaving)");
  if (visible.length > 3) { visible[0].classList.add("is-leaving"); setTimeout(() => visible[0].remove(), 260); }
}

// ---------- motion & feedback ----------
// The whole app re-renders from HTML strings, so motion is applied deliberately:
// page transitions only when the page actually changes, scroll kept in place on
// in-page updates, newly opened forms slide in, and every click gets feedback.
const ui = { pageKey: null, tabKey: null, formKeys: new Set(), tabIndicator: null, mounted: false, renderSeq: 0 };
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function currentPageKey() {
  if (!session) return "auth";
  if (session.user.role === "tenant") return `tenant:${state.tenantView}`;
  return `owner:${state.view}:${state.buildingId || ""}:${state.roomId || ""}:${state.params?.id || ""}`;
}

// Thin bar along the top while the app waits on the server. It only appears if
// the wait is noticeable, so quick updates don't flicker.
let progressTimer = null;
function progressStart() {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    let bar = document.getElementById("progress-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "progress-bar";
      bar.setAttribute("aria-hidden", "true");
      document.body.appendChild(bar);
    }
    bar.className = "is-active";
  }, 140);
}
function progressDone() {
  clearTimeout(progressTimer);
  const bar = document.getElementById("progress-bar");
  if (bar && bar.className === "is-active") {
    bar.className = "is-done";
    setTimeout(() => { if (bar.className === "is-done") bar.className = ""; }, 450);
  }
}

// Disables a button and shows a small spinner until the work behind it settles.
async function withBusy(el, work) {
  if (!el || el.classList.contains("is-busy")) return;
  const wasDisabled = el.disabled;
  el.classList.add("is-busy");
  el.setAttribute("aria-busy", "true");
  if ("disabled" in el) el.disabled = true;
  try {
    return await work();
  } finally {
    if (el.isConnected) {
      el.classList.remove("is-busy");
      el.removeAttribute("aria-busy");
      if ("disabled" in el) el.disabled = wasDisabled;
    }
  }
}

// In-app replacement for the browser's confirm box: animated, keyboard
// friendly, and clear about what will happen.
function confirmDialog(message, { title = "Are you sure?", confirmLabel = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "confirm-backdrop";
    wrap.innerHTML = `<div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
      <span class="confirm-mark ${danger ? "is-danger" : ""}" aria-hidden="true">${danger ? "!" : "?"}</span>
      <h2 id="confirm-title"></h2>
      <p id="confirm-message"></p>
      <div class="confirm-actions">
        <button type="button" class="btn secondary" data-confirm="no">Cancel</button>
        <button type="button" class="btn ${danger ? "danger-solid" : ""}" data-confirm="yes"></button>
      </div>
    </div>`;
    wrap.querySelector("#confirm-title").textContent = title;
    wrap.querySelector("#confirm-message").textContent = message;
    wrap.querySelector('[data-confirm="yes"]').textContent = confirmLabel;
    document.body.appendChild(wrap);
    const buttons = [...wrap.querySelectorAll("button")];
    const close = (answer) => {
      document.removeEventListener("keydown", onKey, true);
      wrap.classList.add("is-leaving");
      setTimeout(() => wrap.remove(), 200);
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      if (e.key === "Tab") {
        const i = buttons.indexOf(document.activeElement);
        e.preventDefault();
        buttons[(i + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
      }
    };
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) return close(false);
      const btn = e.target.closest("[data-confirm]");
      if (btn) close(btn.dataset.confirm === "yes");
    });
    document.addEventListener("keydown", onKey, true);
    requestAnimationFrame(() => wrap.querySelector(danger ? '[data-confirm="no"]' : '[data-confirm="yes"]').focus());
  });
}

// Placeholder layout shown on the very first load instead of a blank page.
function paintSkeleton(kind) {
  const app = document.getElementById("app");
  const sk = (w, h, radius = 10) => `<span class="sk" style="width:${w};height:${h};border-radius:${radius}px"></span>`;
  if (kind === "tenant") {
    app.innerHTML = `<div class="tenant-shell" aria-busy="true"><header class="tenant-top"><div class="brand">Rent Ledger <span class="brand-mark">TENANT</span></div></header><main class="tenant-main"><span class="sr-only">Loading your home…</span><div class="sk-stack">${sk("90px", "12px")}${sk("min(420px, 80%)", "40px")}${sk("180px", "14px")}</div><div class="sk-block">${sk("100%", "124px", 20)}</div><div class="sk-grid">${sk("100%", "220px", 16).repeat(3)}</div></main></div>`;
  } else {
    app.innerHTML = `<div class="sidebar"><div class="brand">Rent Ledger</div><div class="sk-stack sk-dark">${sk("85%", "34px", 9).repeat(4)}</div></div><div class="main" aria-busy="true"><span class="sr-only">Loading your dashboard…</span><div class="sk-stack">${sk("220px", "36px")}${sk("280px", "12px")}</div><div class="sk-grid sk-stats">${sk("100%", "96px", 16).repeat(4)}</div><div class="sk-block">${sk("100%", "240px", 16)}</div></div>`;
  }
}

function formKey(form) {
  return [form.dataset.submit, form.dataset.id, form.dataset.roomId, form.dataset.authorityId].join("|");
}


// Sliding underline for the room tabs; glides from the previous tab when switching.
function placeTabIndicator(root, animateFromPrevious) {
  const row = root.querySelector(".tab-row");
  const active = row?.querySelector(".tab-btn.active");
  if (!row || !active) { ui.tabIndicator = null; return; }
  const bar = document.createElement("span");
  bar.className = "tab-indicator";
  bar.setAttribute("aria-hidden", "true");
  row.appendChild(bar);
  row.classList.add("has-indicator");
  const target = { x: active.offsetLeft, w: active.offsetWidth };
  const from = animateFromPrevious && ui.tabIndicator ? ui.tabIndicator : target;
  bar.style.width = `${from.w}px`;
  bar.style.transform = `translateX(${from.x}px)`;
  if (from !== target) {
    void bar.offsetWidth;
    bar.classList.add("is-moving");
    bar.style.width = `${target.w}px`;
    bar.style.transform = `translateX(${target.x}px)`;
  }
  ui.tabIndicator = target;
}

// Swaps in new markup with the right amount of motion for what changed.
// The sidebar is kept in place between renders when only its highlighted
// item changed, so it doesn't flash, lose its scroll position or redraw its
// scrollbar on every click. Anything else (new building, unread count, more
// rooms) rebuilds it as before.
const sidebarKey = (html) => `${window.RL_I18N?.lang || "en"}|${html.replace(/\s(class|aria-expanded|aria-pressed)="[^"]*"/g, "")}`;
function patchSidebar(oldSide, html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  const fresh = tpl.content.firstElementChild;
  if (!fresh) return false;
  const a = [oldSide, ...oldSide.querySelectorAll("*")];
  const b = [fresh, ...fresh.querySelectorAll("*")];
  if (a.length !== b.length || a.some((el, i) => el.tagName !== b[i].tagName)) return false;
  a.forEach((el, i) => {
    for (const attr of ["class", "aria-expanded", "aria-pressed"]) {
      const v = b[i].getAttribute(attr);
      if (el.getAttribute(attr) !== v) { if (v === null) el.removeAttribute(attr); else el.setAttribute(attr, v); }
    }
  });
  return true;
}

function paint(html, { pageChanged, tabChanged, after, sideHtml, mainHtml, extraHtml = "" }) {
  const app = document.getElementById("app");
  const animate = !reducedMotion();
  // On computers the page scrolls inside <body> (see style.css); on phones it's the window.
  const scroller = ["auto", "scroll"].includes(getComputedStyle(document.body).overflowY) ? document.body : (document.scrollingElement || document.documentElement);
  const scrollY = scroller.scrollTop;
  const sideScroll = app.querySelector(".sidebar-scroll");
  const sideTop = sideScroll ? sideScroll.scrollTop : 0;
  const sideLeft = sideScroll ? sideScroll.scrollLeft : 0;
  const firstMount = !ui.mounted;
  const previousForms = ui.formKeys;
  const useTransition = pageChanged && !firstMount && animate && typeof document.startViewTransition === "function";

  const swap = () => {
    const oldSide = app.querySelector(":scope > .sidebar");
    const oldMain = app.querySelector(":scope > .main");
    const reuse = sideHtml && mainHtml && oldSide && oldMain && ui.sideKey === sidebarKey(sideHtml);
    if (reuse && patchSidebar(oldSide, sideHtml)) {
      app.querySelectorAll(":scope > .more-list, :scope > .mnav, :scope > .msheet").forEach((el) => el.remove());
      oldMain.outerHTML = mainHtml;
      if (extraHtml) app.insertAdjacentHTML("beforeend", extraHtml);
    } else {
      app.innerHTML = html;
    }
    ui.sideKey = sideHtml ? sidebarKey(sideHtml) : null;
    const side = app.querySelector(".sidebar");
    if (side && firstMount && animate) side.classList.add("sidebar-enter");
    const newSide = app.querySelector(".sidebar-scroll");
    if (newSide) { newSide.scrollTop = sideTop; newSide.scrollLeft = sideLeft; }
    scroller.scrollTo({ top: pageChanged ? 0 : scrollY, left: 0, behavior: "instant" });
    const main = app.querySelector(".main, .tenant-main");

    // Page-level entrance: fade the page in and let its cards rise in sequence.
    if (pageChanged && main && animate) {
      if (!useTransition) main.classList.add("page-enter");
      main.classList.add("is-entering");
      setTimeout(() => main.classList.remove("is-entering"), 900);
    }
    if (tabChanged && animate) app.querySelector(".tab-panel")?.classList.add("tab-enter");
    // Translate now (not after this frame) so the tab underline fits the Hindi labels.
    if (window.RL_I18N?.lang === "hi") app.querySelectorAll(".tab-row").forEach((row) => RL_I18N.translate(row));
    placeTabIndicator(app, tabChanged && animate);

    // Keyboard access for the clickable rows and cards that aren't real buttons.
    app.querySelectorAll("[data-nav]:not(button):not(a)").forEach((el) => {
      el.setAttribute("tabindex", "0");
      el.setAttribute("role", "button");
    });

    // Forms that just opened slide in, come into view, and get focus.
    const forms = [...app.querySelectorAll("form[data-submit]")];
    if (!pageChanged && !tabChanged && !firstMount) {
      const opened = forms.filter((form) => !previousForms.has(formKey(form)));
      opened.forEach((form) => (form.closest(".card") || form).classList.add("card-enter"));
      const first = opened[0];
      if (first) {
        (first.closest(".card") || first).scrollIntoView({ block: "nearest", behavior: animate ? "smooth" : "auto" });
        first.querySelector("input:not([type=hidden]):not([type=file]), select, textarea")?.focus({ preventScroll: true });
      }
    }
    ui.formKeys = new Set(forms.map(formKey));
    ui.mounted = true;
    if (after) after();
  };

  if (useTransition) {
    // The page area gets its own transition name only while a transition runs.
    const root = document.documentElement;
    root.classList.add("vt-page");
    try {
      const transition = document.startViewTransition(swap);
      transition.finished.finally(() => root.classList.remove("vt-page"));
    } catch {
      root.classList.remove("vt-page");
      swap();
    }
  } else {
    swap();
  }
}

// ---------- formatting ----------
function fmtMoney(n) {
  const v = Number(n) || 0;
  // Whole rupees stay whole (₹12,000); anything with paise always shows two digits (₹30,442.10).
  const whole = Math.abs(Math.round(v * 100)) % 100 === 0;
  return "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
}
// The local calendar date (YYYY-MM-DD). toISOString() alone gives the UTC date,
// which is yesterday's date in India before 05:30.
function today() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- data loading ----------
// After any change (save, delete, payment…) everything is fetched fresh.
// Between changes, pages open straight away from what was loaded last time
// and refresh in the background, so taps don't wait on the network.
function invalidateData() { cache.coreLoadedAt = 0; cache.tenantLoadedAt = 0; ui.dataEpoch = (ui.dataEpoch || 0) + 1; }
async function loadCore() {
  if (cache.coreLoadedAt && Date.now() - cache.coreLoadedAt < 60_000) return;
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
// ---------- back button (Android phones, browsers) ----------
// Each page opened is added to the history, so the phone's Back button goes
// to the previous page (closing the More panel or a dialog first) instead of
// leaving the app.
const navHistory = { applying: false, started: false };
function pageSnapshot() {
  return { view: state.view, buildingId: state.buildingId, roomId: state.roomId, roomTab: state.roomTab, params: state.params, tenantView: state.tenantView };
}
function rememberPage() {
  if (!session) return;
  const entry = { rl: pageSnapshot() };
  try {
    if (navHistory.applying) return;
    if (!navHistory.started) { history.replaceState(entry, ''); navHistory.started = true; }
    else history.pushState(entry, '');
  } catch {}
}
addEventListener('popstate', (event) => {
  const sheet = document.querySelector('.msheet:not([hidden])');
  const dialog = document.querySelector('.confirm-backdrop [data-confirm="no"]');
  if (sheet || dialog) {
    if (sheet) { sheet.hidden = true; document.body.classList.remove('sheet-open'); }
    if (dialog) dialog.click();
    try { history.pushState({ rl: pageSnapshot() }, ''); } catch {}
    return;
  }
  const snap = event.state?.rl;
  if (!snap || !session) return;
  Object.assign(state, snap);
  state.forms = {};
  navHistory.applying = true;
  Promise.resolve(render()).finally(() => { navHistory.applying = false; });
});

async function render() {
  const seq = ++ui.renderSeq;
  const pageKey = currentPageKey();
  const tabKey = `${pageKey}:${state.roomTab}`;
  const pageChanged = pageKey !== ui.pageKey;
  const tabChanged = !pageChanged && tabKey !== ui.tabKey;
  const settle = () => { ui.pageKey = pageKey; ui.tabKey = tabKey; if (pageChanged) rememberPage(); };

  if (!session) {
    document.getElementById('app').innerHTML = renderAuth();
    attachAuthHandlers();
    try { const notice = sessionStorage.getItem('rentLedgerNotice'); if (notice) { sessionStorage.removeItem('rentLedgerNotice'); toast(notice); } } catch {}
    settle();
    return;
  }
  if (session.user.role === 'tenant') {
    if (!cache.tenantPortal) paintSkeleton('tenant');
    progressStart();
    try {
      if (!cache.tenantPortal || !cache.tenantLoadedAt || Date.now() - cache.tenantLoadedAt > 4_000) {
        cache.tenantPortal = await api('GET', '/api/tenant/portal');
        cache.tenantLoadedAt = Date.now();
      }
      if (state.tenantView === 'profile' && !cache.tenantProfile) cache.tenantProfile = await api('GET', '/api/account/profile');
      if (window.RL_EXT) await RL_EXT.beforeTenantRender();
    }
    catch (e) { progressDone(); toast(e.message, true); logout(); return; }
    progressDone();
    if (seq !== ui.renderSeq) return;
    const tenantExt = window.RL_EXT?.tenantViews[state.tenantView];
    const tenantPhoneNav = window.RL_EXT?.tenantMobileNav ? RL_EXT.tenantMobileNav() : '';
    paint((tenantExt ? tenantExt() : state.tenantView === 'profile' ? renderTenantProfile() : renderTenantPortal()) + tenantPhoneNav, { pageChanged, tabChanged: false, after: () => { attachTenantHandlers(); window.RL_EXT?.afterRender?.(); } });
    settle();
    return;
  }
  if (!ui.mounted) paintSkeleton('owner');
  const loadKey = pageKey;
  const epoch = ui.dataEpoch || 0;
  // A page seen before (and nothing changed since) opens instantly from
  // memory; fresh data follows a moment later.
  const cached = pageChanged && ui.mounted && ui.loaded?.[loadKey] === epoch && cache.coreLoadedAt;
  if (cached) paintOwner(pageChanged, tabChanged);
  else if (pageChanged && ui.mounted) paintMainSkeleton();
  progressStart();
  try {
    await loadOwnerData();
    ui.loaded = { ...(ui.loaded || {}), [loadKey]: ui.dataEpoch || 0 };
  } catch (e) {
    toast(e.message, true);
  }
  progressDone();
  if (seq !== ui.renderSeq) return;
  paintOwner(cached ? false : pageChanged, cached ? false : tabChanged);
  settle();
}

// Everything a page needs, fetched at the same time rather than one after another.
async function loadOwnerData() {
  const jobs = [loadCore()];
  if (window.RL_EXT) jobs.push(RL_EXT.beforeOwnerRender());
  if (state.view === 'profile') jobs.push(api('GET', '/api/account/profile').then((p) => { cache.profile = p; }));
  if (state.view === "dashboard") jobs.push(Promise.all([api("GET", "/api/dashboard"), api("GET", "/api/payments?limit=8"), window.RL_EXT?.loadDashboardExtras()]).then(([dash, payments]) => { cache.dashboard = dash; cache.payments = payments; }));
  if (window.RL_EXT?.views[state.view]) jobs.push(RL_EXT.load(state.view));
  if (state.view === "building" && state.buildingId) jobs.push(api("GET", `/api/rent?buildingId=${state.buildingId}`).then((r) => { cache.buildingRent = r; }));
  if (state.view === "room" && state.roomId) {
    // The owner's preferred way of recording rent (Settings → Organisation).
    if (!cache.org) jobs.push(api("GET", "/api/org").then((o) => { cache.org = o; }).catch(() => {}));
    jobs.push(Promise.all([
      api("GET", `/api/rent?roomId=${state.roomId}`),
      api("GET", `/api/electricity?roomId=${state.roomId}`),
      api("GET", `/api/gas?roomId=${state.roomId}`),
    ]).then(([rent, electricity, gas]) => {
      cache.rent = rent.sort((a, b) => b.year - a.year || b.month - a.month);
      cache.electricity = electricity.sort((a, b) => b.year - a.year || b.month - a.month);
      cache.gas = gas.sort((a, b) => b.year - a.year || b.month - a.month);
    }));
  }
  await Promise.all(jobs);
}

function paintOwner(pageChanged, tabChanged) {
  const sideHtml = renderSidebar();
  const mainHtml = `<div class="main">${renderMain()}</div>`;
  const extraHtml = window.RL_EXT?.mobileNav ? RL_EXT.mobileNav() : "";
  paint(sideHtml + mainHtml + extraHtml, { pageChanged, tabChanged, sideHtml, mainHtml, extraHtml, after: () => { attachHandlers(); window.RL_EXT?.afterRender?.(); } });
}

// While a new page loads for the first time: keep the bars, show a placeholder.
function paintMainSkeleton() {
  const main = document.querySelector("#app > .main");
  if (!main) return;
  const sk = (w, h, radius = 10) => `<span class="sk" style="width:${w};height:${h};border-radius:${radius}px"></span>`;
  main.setAttribute("aria-busy", "true");
  main.innerHTML = `<span class="sr-only">Loading…</span><div class="sk-stack">${sk("200px", "34px")}${sk("240px", "12px")}</div><div class="sk-block">${sk("100%", "120px", 16)}</div><div class="sk-block">${sk("100%", "220px", 16)}</div>`;
  const scroller = ["auto", "scroll"].includes(getComputedStyle(document.body).overflowY) ? document.body : (document.scrollingElement || document.documentElement);
  scroller.scrollTo({ top: 0, left: 0, behavior: "instant" });
}

function loginMarkup(role = 'owner') {
  return `<p class="kicker">WELCOME BACK</p><h2>Sign in as ${role === 'owner' ? 'owner' : 'tenant'}</h2><p class="auth-muted">${role === 'owner' ? 'Your complete property workspace awaits.' : 'View your rent and electricity bill in one place.'}</p><form data-auth="login"><input type="hidden" name="role" value="${role}"><label>Mobile number or email<input name="contact" required placeholder="you@example.com"></label><label>Password<input name="password" type="password" required placeholder="••••••••"></label><button class="btn auth-submit">Sign in <span>→</span></button></form><p class="auth-alt"><button data-auth-toggle="request-password-reset">Forgot password?</button></p><p class="auth-alt">New here? <button data-auth-toggle="signup">Create an account</button></p>`;
}

function renderAuth() {
  const serverSetup = '';
  const installGuide = isMobileApp ? '' : `<div class="install-guide"><div><span class="install-guide-icon">⇩</span><div><strong>Use Rent Ledger like an app</strong><small>${esc(installHelpText())}</small></div></div><button type="button" data-install-app>Install app</button></div>`;
  return `<div class="auth-shell"><section class="auth-art"><div class="brand auth-brand">Rent Ledger <span class="brand-mark">HOME</span></div><div class="auth-copy"><p class="kicker">PROPERTY, SIMPLIFIED</p><h1>A calmer way to manage every key.</h1><p>Keep rent, electricity, rooms and tenant records in one considered place.</p><div class="auth-pills"><span>◈ Owner command centre</span><span>◌ Private tenant billing</span></div></div><div class="auth-foot">Made for modern rental homes</div></section><section class="auth-panel"><div class="auth-card"><div class="role-switch" data-active="owner"><button class="role-btn active" data-role="owner">Owner</button><button class="role-btn" data-role="tenant">Tenant</button></div><div id="auth-form">${loginMarkup()}</div>${installGuide}${serverSetup}</div></section></div>`;
}

function authForm(mode, role) {
  const form = document.getElementById('auth-form');
  if (mode === 'signup') {
    form.innerHTML = `<p class="kicker">CREATE ACCOUNT</p><h2>Join as a ${role}</h2><p class="auth-muted">${role === 'tenant' ? 'Use the mobile number your owner saved for you and the invite code they shared.' : 'Create your private owner workspace.'}</p><form data-auth="signup"><input type="hidden" name="role" value="${role}"><label>Full name<input name="name" required placeholder="Your name" autocomplete="name"></label><label>${role === 'tenant' ? 'Registered mobile number' : 'Mobile number or email'}<input name="contact" required autocomplete="username"></label>${role === 'tenant' ? '<label>Invite code<input name="inviteCode" required autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-2345"></label>' : '<label>Setup code <small>(only if your server asks for one)</small><input name="setupCode" autocomplete="off"></label>'}<label>Create password<input name="password" type="password" minlength="8" required placeholder="At least 8 characters" autocomplete="new-password"></label><button class="btn auth-submit">Create account <span>→</span></button></form><p class="auth-alt">Already have access? <button data-auth-toggle="login">Sign in</button></p>`;
  } else if (mode === 'request-password-reset') {
    form.innerHTML = `<p class="kicker">PASSWORD RESET</p><h2>Get a one-time code</h2><p class="auth-muted">Enter the mobile number or email used for your account. We will send a 6-digit verification code.</p><form data-auth="request-password-reset"><input type="hidden" name="role" value="${role}"><label>Mobile number or email<input name="contact" required placeholder="you@example.com"></label><button class="btn auth-submit">Send code <span>→</span></button></form><p class="auth-alt"><button data-auth-toggle="login">Back to sign in</button></p>`;
  } else if (mode === 'reset-password') {
    form.innerHTML = `<p class="kicker">VERIFY CODE</p><h2>Create a new password</h2><p class="auth-muted">Enter the 6-digit code sent to you. It expires after 10 minutes.</p><form data-auth="reset-password"><input type="hidden" name="role" value="${role}"><input type="hidden" name="contact" value="${esc(authState.resetContact)}"><label>Verification code<input name="otp" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required placeholder="123456"></label><label>New password<input name="password" type="password" minlength="8" required placeholder="At least 8 characters" autocomplete="new-password"></label><button class="btn auth-submit">Reset password <span>→</span></button></form><p class="auth-alt"><button data-auth-toggle="request-password-reset">Send a new code</button></p>`;
  } else {
    form.innerHTML = loginMarkup(role);
  }
  form.classList.remove('auth-swap');
  void form.offsetWidth;
  form.classList.add('auth-swap');
  // The form markup is dynamically replaced, so bind its new submit/toggle controls immediately.
  attachAuthHandlers();
}

function renderTenantPortal() {
  const d = cache.tenantPortal;
  const gasEntries = d.gas || [];
  const owed = (entry, type) => entry.outstanding !== undefined ? entry.outstanding : entry.status === 'paid' ? 0 : type === 'rent' ? Math.max((entry.rentAmount || 0) - (entry.amountPaid || 0), 0) : (entry.amount || 0);
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
      ? `<span class="paid-online" title="${esc(e.onlinePayment.paymentId || '')}">✓ Paid online</span>`
      : e.receipt
        ? `<button class="btn small secondary" data-tenant-action="view-receipt" data-receipt-id="${e.receipt.id}">View proof</button>`
        : `<button class="btn small secondary" data-tenant-action="upload-receipt" data-kind="${type}" data-entry-id="${e.id}">Add proof</button>`;
    return `<tr><td>${MONTHS[e.month]} ${e.year}${type === 'gas' ? gasSubtitle(e) : ''}</td><td>${type === 'rent' ? fmtMoney(e.rentAmount) : fmtMoney(e.amount)}</td><td><span class="stamp ${e.status}">${e.status}</span></td><td><div class="bill-actions">${payButton}${proof}</div></td></tr>`;
  }).join('') || `<tr><td colspan="4" class="text">No records yet</td></tr>`;
  const payAll = totalDue > 0
    ? (canPayOnline
      ? `<section class="card pay-all-card"><div><span class="kicker">TOTAL PENDING</span><strong>${fmtMoney(totalDue)}</strong><small>Rent, electricity and gas together · pay with any UPI app (Google Pay, PhonePe, Paytm, BHIM…) straight to your owner</small></div><button class="btn pay-btn" data-tenant-action="pay-all">Pay all ${fmtMoney(totalDue)}</button></section>`
      : `<section class="card pay-all-card muted"><div><span class="kicker">TOTAL PENDING</span><strong>${fmtMoney(totalDue)}</strong><small>Your owner hasn't added a UPI ID yet. Pay them directly and add a payment proof below.</small></div></section>`)
    : '';
  const table = (title, entries, type) => `<article class="card"><h3><span>${title}</span><small>Last 6 entries</small></h3><table class="ledger tenant-ledger"><thead><tr><th>Period</th><th>Amount</th><th>Status</th><th>Payment</th></tr></thead><tbody>${billRows(entries, type)}</tbody></table></article>`;
  return `<div class="tenant-shell"><header class="tenant-top"><div class="brand">Rent Ledger <span class="brand-mark">TENANT</span></div><div class="tenant-user"><span>Welcome, <b>${esc(d.tenant.name)}</b></span>${window.RL_I18N ? RL_I18N.picker() : ''}${window.RL_EXT?.tenantBell ? RL_EXT.tenantBell() : ''}<button class="logout" data-logout>Sign out</button></div></header><main class="tenant-main">${window.RL_EXT ? RL_EXT.tenantNav() : ''}<p class="kicker">YOUR HOME</p><h1>${esc(d.building.name)}</h1><p class="tenant-address">${esc(d.room.label)} · Floor ${d.room.floorNumber}</p><section class="tenant-hero"><div><span>Monthly rent</span><strong>${fmtMoney(d.room.monthlyRent)}</strong><small>Your fixed monthly rental</small></div><div><span>Rent outstanding</span><strong class="${rentDue ? 'is-due' : ''}">${fmtMoney(rentDue)}</strong><small>${rentDue ? 'Payment pending' : 'All caught up'}</small></div><div><span>Electricity outstanding</span><strong class="${elecDue ? 'is-due' : ''}">${fmtMoney(elecDue)}</strong><small>${elecDue ? 'Payment pending' : 'All caught up'}</small></div><div><span>Gas outstanding</span><strong class="${gasDue ? 'is-due' : ''}">${fmtMoney(gasDue)}</strong><small>${gasDue ? 'Payment pending' : 'All caught up'}</small></div></section>${payAll}${renderPendingUpi(d.payments)}${window.RL_EXT ? RL_EXT.tenantHomeExtras(d) : ''}<section class="tenant-bills">${table('Rent history', d.rent, 'rent')}${table('Electricity bills', d.electricity, 'electricity')}${table('Gas bills', gasEntries, 'gas')}</section><input type="file" data-receipt-file accept="image/jpeg,image/png,image/webp,application/pdf" hidden></main></div>`;
}

// ---------- UPI payments (UPI Intent, no gateway) ----------
// The server works out the amount and the owner's UPI ID; the browser only
// says which bills. On a phone the tenant taps their UPI app (Google Pay,
// PhonePe, Paytm, BHIM) or "Other UPI app" (the plain upi:// link). On a computer a QR
// code is shown to scan with any UPI app. Nothing here marks a bill as paid:
// the payment stays pending until the owner confirms they received it.
const isPhone = () => isMobileApp || (navigator.userAgentData ? navigator.userAgentData.mobile : /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

// Android remembers one app (often WhatsApp) as the default for every upi://
// link and then stops showing the chooser. So the tenant picks their app here:
// an intent:// link naming the app's package opens exactly that app, with the
// same server-built payment details (UPI ID, amount, reference). If the app
// isn't installed, Android offers it in the Play Store. "Other UPI app" is the
// plain upi:// link, which opens the phone's default UPI app or chooser.
const UPI_APPS = [
  { name: 'Google Pay', android: 'com.google.android.apps.nbu.paisa.user', ios: 'tez://upi/' },
  { name: 'PhonePe', android: 'com.phonepe.app', ios: 'phonepe://' },
  { name: 'Paytm', android: 'net.one97.paytm', ios: 'paytmmp://' },
  { name: 'BHIM', android: 'in.org.npci.upiapp', ios: '' },
];
function upiAppLinks(uri) {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const android = !ios && /Android/i.test(ua);
  // The installed app's web view can't open intent:// links: keep the plain link there.
  if (isMobileApp || (!ios && !android) || !/^upi:\/\/pay\?/.test(uri)) return [];
  const rest = uri.slice('upi://'.length); // "pay?pa=…&am=…"
  return UPI_APPS.filter((a) => (android ? a.android : a.ios)).map((a) => ({
    name: a.name,
    href: android ? `intent://${rest}#Intent;scheme=upi;package=${a.android};end` : `${a.ios}${rest}`,
  }));
}

// body is either { items: [{ kind, id }] } or { all: true }.
async function startTenantPayment(body, button) {
  if (button) button.disabled = true;
  try {
    const pay = await api('POST', '/api/tenant/payments/upi', body);
    await showUpiSheet(pay);
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
    cache.tenantLoadedAt = 0;
    render();
  }
}

function showUpiSheet(pay) {
  return new Promise((resolve) => {
    const phone = isPhone();
    const apps = phone ? upiAppLinks(pay.uri) : [];
    const previous = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'confirm-backdrop upi-backdrop';
    const kind = { rent: 'Rent', electricity: 'Electricity', gas: 'Gas' };
    const bills = pay.items.map((i) => `<li><span>${esc(kind[i.kind] || i.kind)} ${i.month ? `${MONTHS[i.month]} ${i.year}` : ''}</span><b>${fmtMoney(i.amount)}</b></li>`).join('');
    wrap.innerHTML = `<div class="confirm-dialog upi-dialog" role="dialog" aria-modal="true" aria-labelledby="upi-title">
      <button type="button" class="upi-close" data-upi="close" aria-label="Close">×</button>
      <p class="kicker">PAY BY UPI</p>
      <h2 id="upi-title">${fmtMoney(pay.amount)}</h2>
      <p class="upi-to">To <b data-no-i18n>${esc(pay.payee.name)}</b><br><code data-no-i18n>${esc(pay.payee.upiId)}</code></p>
      <ul class="upi-bills">${bills}</ul>
      ${pay.warning ? `<p class="upi-warning">${esc(pay.warning)}</p>` : ''}
      <div class="upi-step" data-upi-step="start">
        ${phone && apps.length ? `<h3 class="upi-pick">Pay with</h3>
          <div class="upi-apps">${apps.map((a) => `<a class="btn upi-app" href="${esc(a.href)}" data-upi="open" data-no-i18n>${esc(a.name)}</a>`).join('')}<a class="btn secondary upi-app" href="${esc(pay.uri)}" data-upi="open">Other UPI app</a></div>
          <p class="profile-note">Tap the app you use, check the amount and enter your UPI PIN. “Other UPI app” opens your phone's usual UPI app (for example WhatsApp or your bank's app).</p>` : ''}
        ${phone && !apps.length ? `<a class="btn upi-open" href="${esc(pay.uri)}" data-upi="open">Open UPI app</a>
          <p class="profile-note">Choose Google Pay, PhonePe, Paytm, BHIM or your bank's app, check the amount and enter your UPI PIN.</p>` : ''}
        <div class="upi-qr ${phone ? 'is-collapsed' : ''}" data-upi-qr>
          ${phone ? '<button type="button" class="btn small secondary" data-upi="show-qr">Show QR code instead</button>' : ''}
          <div class="upi-qr-box" ${phone ? 'hidden' : ''}>${pay.qrSvg}<p class="profile-note">${phone ? 'Scan this from another phone, or take a screenshot and open it in your UPI app.' : 'Scan with any UPI app on your phone (Google Pay, PhonePe, Paytm, BHIM…), check the amount and enter your UPI PIN.'}</p></div>
        </div>
        <div class="upi-copy"><button type="button" class="btn small secondary" data-upi="copy-id">Copy UPI ID</button><button type="button" class="btn small secondary" data-upi="copy-amount">Copy amount</button></div>
        <p class="upi-missing" data-upi-missing hidden>No UPI app opened? Install a UPI app, or scan the QR code / pay the UPI ID above from any UPI app.</p>
      </div>
      <div class="upi-step" data-upi-step="back" hidden>
        <h3>Did you finish the payment?</h3>
        <p class="profile-note">We can't see your UPI app, so tell us. Your owner will check that the money arrived.</p>
      </div>
      <p class="upi-ref">Reference <code data-no-i18n>${esc(pay.reference)}</code></p>
      <p class="upi-pending-note">Your bills stay <b>pending</b> until your owner confirms the money reached them. This can take a while.</p>
      <div class="confirm-actions">
        <button type="button" class="btn secondary" data-upi="cancel">I didn't pay</button>
        <button type="button" class="btn" data-upi="reported">I've paid</button>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    const $ = (sel) => wrap.querySelector(sel);
    let done = false;
    let leftPage = false;
    let missingTimer = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(missingTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('keydown', onKey, true);
      wrap.classList.add('is-leaving');
      setTimeout(() => wrap.remove(), 200);
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
      resolve();
    };
    const showQr = () => { const box = $('.upi-qr-box'); if (box) box.hidden = false; $('[data-upi="show-qr"]')?.remove(); };
    // The UPI app opening hides this page. If it's still showing after a few
    // seconds, there is probably no UPI app: offer the QR code and UPI ID.
    const launch = () => {
      leftPage = false;
      clearTimeout(missingTimer);
      missingTimer = setTimeout(() => {
        if (!leftPage && document.visibilityState === 'visible') { $('[data-upi-missing]').hidden = false; showQr(); }
      }, 2500);
    };
    function onVisibility() {
      if (document.visibilityState === 'hidden') { leftPage = true; clearTimeout(missingTimer); return; }
      // Back from the UPI app: we don't know if they paid, so ask.
      if (leftPage) { $('[data-upi-step="back"]').hidden = false; $('[data-upi-missing]').hidden = true; }
    }
    function onKey(event) { if (event.key === 'Escape') { event.preventDefault(); finish(); } }
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('click', async (event) => {
      if (event.target === wrap) return finish();
      const action = event.target.closest('[data-upi]')?.dataset.upi;
      if (!action) return;
      if (action === 'open') return launch(); // the link itself opens the UPI app
      if (action === 'close') return finish();
      if (action === 'show-qr') return showQr();
      if (action === 'copy-id') { await copyText(pay.payee.upiId); return toast('UPI ID copied'); }
      if (action === 'copy-amount') { await copyText(String(pay.amount)); return toast('Amount copied'); }
      const button = event.target.closest('button');
      if (action === 'reported') {
        await withBusy(button, async () => {
          try {
            await api('POST', `/api/tenant/payments/upi/${pay.id}/reported`, {});
            toast('Thanks! Your owner has been told. The bill stays pending until they confirm it.');
            finish();
          } catch (error) { toast(error.message, true); }
        });
      }
      if (action === 'cancel') {
        await withBusy(button, async () => {
          try { await api('POST', `/api/tenant/payments/upi/${pay.id}/cancel`, { reason: leftPage ? 'Not completed in UPI app' : 'Cancelled by tenant' }); } catch (error) { toast(error.message, true); return; }
          toast('Payment not made. You can try again any time.');
          finish();
        });
      }
    });
    // Nothing opens by itself: the tenant chooses the app (opening the default
    // straight away sent everyone to whichever app the phone remembered).
    (phone ? $('.upi-app, .upi-open') : $('[data-upi="reported"]'))?.focus({ preventScroll: true });
  });
}

// Tenant home: UPI payments started but not yet confirmed by the owner.
function renderPendingUpi(payments) {
  const list = payments?.pending || [];
  if (!list.length) return '';
  const rows = list.map((p) => `<li><span><b>${fmtMoney(p.amount)}</b> · ${esc(displayDate(p.createdAt))} · <code data-no-i18n>${esc(p.reference)}</code></span><span class="stamp ${p.reportedAt ? 'partial' : 'due'}">${p.reportedAt ? 'Waiting for owner' : 'Not finished'}</span></li>`).join('');
  return `<section class="card upi-pending-card"><h3>UPI payments not yet confirmed</h3><p class="profile-note">These stay pending until your owner confirms the money reached them. Bills are not marked paid automatically.</p><ul>${rows}</ul></section>`;
}

function displayDate(value) { return value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not provided'; }
function profileCard(title, rows) { return `<article class="card profile-card"><h3>${title}</h3><dl class="profile-list">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join('')}</dl></article>`; }
function passwordCard() {
  const form = state.forms.changePassword ? `<form class="profile-password-form" data-submit="change-password"><label>Current password<input name="currentPassword" type="password" required autocomplete="current-password"></label><label>New password<input name="newPassword" type="password" minlength="8" required autocomplete="new-password" placeholder="At least 8 characters"></label><label>Confirm new password<input name="confirmPassword" type="password" minlength="8" required autocomplete="new-password"></label><div class="form-actions"><button class="btn" type="submit">Update password</button><button class="btn secondary" type="button" data-toggle-form="changePassword">Cancel</button></div></form>` : `<p class="profile-note">For your security, passwords are never displayed. You can update yours at any time.</p><button class="btn secondary" data-toggle-form="changePassword">Change password</button>`;
  return `<article class="card profile-card"><h3>Password & security</h3>${form}</article>`;
}
function renderTenantProfile() {
  const p = cache.tenantProfile;
  return `<div class="tenant-shell"><header class="tenant-top"><div class="brand">Rent Ledger <span class="brand-mark">TENANT</span></div><div class="tenant-user">${window.RL_I18N ? RL_I18N.picker() : ''}${window.RL_EXT?.tenantBell ? RL_EXT.tenantBell() : ''}<button class="logout" data-logout>Sign out</button></div></header><main class="tenant-main">${window.RL_EXT ? RL_EXT.tenantNav() : ''}<p class="kicker">ACCOUNT</p><h1>My profile</h1><p class="tenant-address">Your account, tenancy and security settings.</p><section class="profile-grid">${profileCard('Account information', [['Name', esc(p.account.name)], ['Sign-in contact', esc(p.account.contact)], ['Account type', 'Tenant'], ['Member since', esc(displayDate(p.account.createdAt))]])}${profileCard('Your tenancy', [['Building', esc(p.home.buildingName)], ['Address', esc(p.home.buildingAddress || 'Not provided')], ['Room', esc(`${p.home.roomLabel} · Floor ${p.home.floorNumber}`)], ['Monthly rent', fmtMoney(p.home.monthlyRent)], ['Security deposit', fmtMoney(p.tenant.deposit)], ['Move-in date', esc(displayDate(p.tenant.moveInDate))]])}${profileCard('Contact & identity', [['Mobile number', esc(p.tenant.mobile || 'Not provided')], ['Alternative mobile', esc(p.tenant.altMobile || 'Not provided')], ['Email', esc(p.tenant.email || 'Not provided')], ['ID proof type', esc(p.tenant.idProofType || 'Not provided')]])}${window.RL_EXT ? RL_EXT.tenantProfileExtras(p) : ''}${passwordCard()}${themePicker()}</section><button class="btn secondary tenant-signout" data-logout>Sign out</button></main></div>`;
}

async function logout() {
  const token = session?.token;
  localStorage.removeItem('rentLedgerSession');
  if (token) {
    try { await fetch(apiUrl('/api/auth/logout'), { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch {}
  }
  location.reload();
}
function attachAuthHandlers() {
  document.querySelectorAll('[data-install-app]').forEach(btn => btn.onclick = requestAppInstall);
  document.querySelectorAll('[data-role]').forEach(btn => btn.onclick = () => {
    if (btn.classList.contains('active')) return;
    document.querySelectorAll('[data-role]').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    const roleSwitch = btn.closest('.role-switch');
    if (roleSwitch) roleSwitch.dataset.active = btn.dataset.role;
    authForm('login', btn.dataset.role);
  });
  document.querySelectorAll('[data-auth-toggle]').forEach(btn => btn.onclick = () => authForm(btn.dataset.authToggle, document.querySelector('.role-btn.active')?.dataset.role || 'owner'));
  document.querySelectorAll('form[data-auth]').forEach(form => form.onsubmit = e => {
    e.preventDefault();
    return withBusy(form.querySelector('button'), () => submitAuthForm(form));
  });
  async function submitAuthForm(form) {
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
  }
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
  window.RL_EXT?.attachTenant();
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
      <div class="side-top">
        <div class="brand" data-nav="dashboard" style="cursor:pointer">Rent Ledger</div>
        ${window.RL_EXT?.sidebarBell ? RL_EXT.sidebarBell() : ""}
      </div>
      <div class="sidebar-scroll">
        ${window.RL_EXT ? RL_EXT.sidebarNav() : ""}
        <div class="side-group-label">Properties</div>
        ${buildingsHtml || `<div style="opacity:.6; font-size:13px; padding:8px;">No buildings yet.</div>`}
        <button class="side-add" data-action="add-building">+ Add building</button>
      </div>
      <div class="side-foot">
        <button class="side-foot-btn ${state.view === 'profile' ? 'active' : ''}" data-nav="profile">Profile</button>
        <button class="side-foot-btn" data-action="logout">Sign out</button>
      </div>
    </div>
  `;
}

// ---------- main dispatch ----------
function renderMain() {
  if (window.RL_EXT?.views[state.view]) return RL_EXT.views[state.view]();
  if (state.view === "profile") return renderOwnerProfile();
  if (state.view === "building" && state.buildingId) return renderBuildingView();
  if (state.view === "room" && state.roomId) return renderRoomView();
  return renderDashboard();
}

function backupCard() {
  return `<article class="card profile-card"><h3>Data backup</h3><p class="profile-note">Download a copy of all your records (buildings, tenants and every bill). Receipt images are not included. Keep the file somewhere private, because it contains tenants' personal details. The server also keeps automatic daily backups.</p><button class="btn secondary" data-action="download-backup">Download backup</button></article>`;
}

async function downloadBackup() {
  const res = await fetch(apiUrl('/api/admin/export'), { headers: { Authorization: `Bearer ${session?.token || ''}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Download failed' }));
    throw new Error(data.error || 'Download failed');
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'rent-ledger-backup.json';
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  toast('Backup downloaded');
}

function renderOwnerProfile() {
  const p = cache.profile || { account: session.user, buildings: [] };
  const buildings = p.buildings.length ? p.buildings.map((building) => `<div class="profile-building"><div><strong>${esc(building.name)}</strong><span>${esc(building.address || 'No address on file')}</span></div><div><b>${building.occupiedRooms}/${building.rooms}</b><small>occupied · ${building.totalFloors || '—'} floors</small></div></div>`).join('') : '<p class="profile-note">No buildings added yet.</p>';
  // Colours and language live in Settings, and buildings on Home, so Profile is just about you.
  void buildings;
  return `<div class="page-title">Your profile</div><div class="page-sub">Your account and security.</div><section class="profile-grid owner-profile-grid">${profileCard('Account information', [['Name', esc(p.account.name)], ['Sign-in contact', esc(p.account.contact)], ['Account type', 'Owner'], ['Member since', esc(displayDate(p.account.createdAt))]])}${passwordCard()}${backupCard()}</section><button class="btn secondary tenant-signout owner-signout" data-logout>Sign out</button>`;
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

  // Four headline numbers; the rent / electricity / gas split is one click away.
  const addRupees = (...values) => Math.round(values.reduce((sum, v) => sum + (Number(v) || 0), 0) * 100) / 100;
  const collected = addRupees(d.rentCollected, d.elecCollected, d.gasCollected);
  const pending = addRupees(d.rentPending, d.elecPending, d.gasPending);
  const splitRow = (name, got, owed, open) => `<tr><td class="text">${name}</td><td>${fmtMoney(got)}</td><td>${fmtMoney(owed)}</td><td>${open ?? "–"}</td></tr>`;
  const details = `
    <details class="card dash-details" ${state.dashDetails ? "open" : ""}>
      <summary>Show details</summary>
      <div class="table-scroll"><table class="ledger dash-split"><thead><tr><th>This month's bills</th><th>Collected</th><th>Still to collect</th><th>Open bills (all months)</th></tr></thead><tbody>
        ${splitRow("Rent", d.rentCollected, d.rentPending, d.outstandingRentEntries)}
        ${splitRow("Electricity", d.elecCollected, d.elecPending, d.outstandingElectricityEntries)}
        ${splitRow("Gas", d.gasCollected, d.gasPending, d.outstandingGasEntries)}
      </tbody></table></div>
      <p class="dash-more"><span class="dm-item">Buildings <b>${d.totalBuildings ?? "–"}</b></span><span class="dm-item">Vacant rooms <b>${d.vacantRooms ?? "–"}</b></span>${window.RL_EXT ? RL_EXT.dashboardExtras() : ""}</p>
    </details>`;

  return `
    <div class="page-title">Dashboard</div>
    <div class="page-sub">${MONTHS[d.month] || ""} ${d.year || ""}</div>

    <div class="stat-grid stat-grid-4">
      <div class="stat-card good"><div class="stat-label">Rooms occupied</div><div class="stat-value">${d.occupiedRooms ?? "–"} / ${d.totalRooms ?? "–"}</div></div>
      <div class="stat-card good"><div class="stat-label">Received this month</div><div class="stat-value">${fmtMoney(d.receivedThisMonth ?? collected)}</div></div>
      <div class="stat-card warn"><div class="stat-label">Still to collect</div><div class="stat-value">${fmtMoney(pending)}</div></div>
      <div class="stat-card warn"><div class="stat-label">Overdue</div><div class="stat-value ${d.overdueTotal ? "is-due" : ""}">${fmtMoney(d.overdueTotal)}</div></div>
    </div>

    ${details}

    ${d.onlinePaymentsEnabled ? renderOnlinePaymentsCard(d) : ""}

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
    return `<div class="floor-control"><div><strong>Floor ${floorNumber}</strong><span>${floorRooms.length} room${floorRooms.length === 1 ? '' : 's'} · ${rentableRooms.length ? (rents.length === 1 ? `${fmtMoney(currentRent)}/room` : 'mixed room rents') : 'no rent collection'}</span></div>${rentEditor}<button type="button" class="floor-delete" data-action="delete-floor" data-building-id="${b.id}" data-floor-number="${floorNumber}" data-room-count="${floorRooms.length}">Delete floor ${floorNumber}…</button></div>`;
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

    ${floors.length ? (state.forms.floorManager
      ? `<div class="card floor-manager"><h3>Floor rent <button class="btn small secondary" data-toggle-form="floorManager">Done</button></h3><p class="profile-note">A new floor rent applies to every room on that floor from now on. Past bills don't change.</p>${floorControls}</div>`
      : `<button type="button" class="btn secondary floor-manager-open" data-toggle-form="floorManager">Change floor rent or remove a floor</button>`) : ''}

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
    <div class="tab-panel">${body}</div>
  `;
}

// Tenant login status, and invite codes the owner shares so the tenant can sign up.
function tenantLoginCard(tenant) {
  const login = tenant.login || {};
  if (login.hasAccount) {
    return `<div class="card"><h3>Tenant login</h3><p class="profile-note">✓ ${esc(tenant.name)} has a login and can see their bills in the tenant portal.</p></div>`;
  }
  const active = login.inviteExpiresAt && new Date(login.inviteExpiresAt) > new Date();
  const body = active
    ? `<p class="profile-note">An invite code is active until <strong>${esc(displayDate(login.inviteExpiresAt))}</strong>. Codes are shown only once. If it was lost, create a new one (the old code stops working).</p><div class="form-actions"><button class="btn small" data-action="create-invite" data-id="${tenant.id}">Create new code</button><button class="btn small secondary" data-action="cancel-invite" data-id="${tenant.id}">Cancel invite</button></div>`
    : `<p class="profile-note">${esc(tenant.name)} doesn't have a login yet. Create an invite code and share it with them. They sign up as a tenant using their mobile number (${esc(tenant.mobile || 'not set')}) and the code.</p><div class="form-actions"><button class="btn small" data-action="create-invite" data-id="${tenant.id}">Create invite code</button></div>`;
  return `<div class="card"><h3>Tenant login</h3>${body}</div>`;
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
      ${previousTenantsCard(r)}
    `;
  }

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
    ${tenantLoginCard(tenant)}
    ${window.RL_EXT ? RL_EXT.tenantLinks(tenant) : ""}
    ${previousTenantsCard(r)}
  `;
}

// Former tenants of a room: shown whether or not the room is occupied, so
// the deposit settlement stays reachable after a move-out.
function previousTenantsCard(r) {
  const history = cache.tenants.filter((t) => t.roomId === r.id && !t.active);
  if (!history.length) return "";
  return `
      <div class="card">
        <h3>Previous tenants</h3>
        <table class="ledger">
          <thead><tr><th>Name</th><th>Mobile</th><th>Moved in</th><th>Moved out</th><th></th></tr></thead>
          <tbody>
            ${history.map((t) => `<tr><td class="text">${esc(t.name)}</td><td>${esc(t.mobile || '—')}</td><td>${esc(t.moveInDate)}</td><td>${esc(t.moveOutDate)}</td><td><div class="row-actions"><button class="btn small secondary" data-nav="tenancy" data-id="${t.id}">Deposit & settlement</button><button class="btn small danger" data-action="delete-tenant" data-id="${t.id}">Remove record</button></div></td></tr>`).join("")}
          </tbody>
        </table>
      </div>`;
}

const rentMode = () => (cache.org?.settings?.bills?.rentMode === "instalments" ? "instalments" : "simple");
const METHOD_LABELS = { cash: "Cash", upi: "UPI", bank_transfer: "Bank transfer", cheque: "Cheque", razorpay: "Paid online", other: "Other", deposit_adjustment: "From deposit" };

// Instalments: set the total rent once, then add each amount as it comes in.
// Shows received and remaining for every month.
function renderRentInstalments(r, tenant) {
  const now = new Date();
  const editForms = cache.rent.filter((entry) => state.forms[`editRent-${entry.id}`]).map((entry) => `<div class="card ledger-edit"><h3>Edit rent entry · ${MONTHS[entry.month]} ${entry.year}</h3><form data-submit="edit-rent" data-id="${entry.id}"><div class="form-grid cols-3"><div class="form-field"><label>Month *</label><select name="month" required>${MONTHS.slice(1).map((month, index) => `<option value="${index + 1}" ${index + 1 === Number(entry.month) ? 'selected' : ''}>${month}</option>`).join('')}</select></div><div class="form-field"><label>Year *</label><input name="year" type="number" required value="${entry.year}"></div><div class="form-field"><label>Total rent (₹) *</label><input name="rentAmount" type="number" min="0" step="0.01" required value="${entry.rentAmount}"></div><div class="form-field"><label>Due date</label><input name="dueDate" type="date" value="${esc(entry.dueDate || '')}"></div><div class="form-field" style="grid-column:span 2"><label>Notes</label><input name="notes" value="${esc(entry.notes || '')}"></div></div><p class="profile-note">Amounts received are added one by one with “Add amount received”.</p><div class="form-actions"><button class="btn" type="submit">Save changes</button><button class="btn secondary" type="button" data-toggle-form="editRent-${entry.id}">Cancel</button></div></form></div>`).join('');
  const addForm = state.forms.addRent ? `
    <div class="card">
      <h3>Add rent for a month</h3>
      <form data-submit="add-rent" data-room-id="${r.id}" data-tenant-id="${tenant ? tenant.id : ""}">
        <div class="form-grid cols-3">
          <div class="form-field"><label>Month *</label>
            <select name="month" required>${MONTHS.slice(1).map((m, i) => `<option value="${i + 1}" ${i + 1 === now.getMonth() + 1 ? "selected" : ""}>${m}</option>`).join("")}</select>
          </div>
          <div class="form-field"><label>Year *</label><input name="year" type="number" required value="${now.getFullYear()}" /></div>
          <div class="form-field"><label>Total rent (₹) *</label><input name="rentAmount" type="number" min="0" step="0.01" required value="${r.monthlyRent || ""}" /></div>
          <div class="form-field"><label>Received now (₹)</label><input name="amountPaid" type="number" min="0" step="0.01" placeholder="0" /></div>
          <div class="form-field"><label>Received on</label><input name="paidDate" type="date" value="${today()}" /></div>
          <div class="form-field"><label>Due date</label><input name="dueDate" type="date" /></div>
          <div class="form-field" style="grid-column: span 3;"><label>Notes</label><input name="notes" placeholder="Optional" /></div>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">Save</button>
          <button class="btn secondary" type="button" data-toggle-form="addRent">Cancel</button>
        </div>
      </form>
    </div>
  ` : "";
  const totalRemaining = cache.rent.reduce((sum, e) => sum + Number(e.outstanding || 0), 0);
  const fmtDay = (d) => { try { return new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); } catch { return d; } };
  const cards = cache.rent.map((e) => {
    const total = Number(e.rentAmount) || 0;
    const received = Number(e.amountPaid) || 0;
    const remaining = Number(e.outstanding) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 100;
    const formOpen = state.forms[`receive-${e.id}`];
    const receiveForm = formOpen ? `<form class="instal-form" data-submit="receive-rent" data-id="${e.id}">
        <div class="form-grid cols-3">
          <div class="form-field"><label>Amount received (₹) *</label><input name="amount" type="number" min="0.01" step="0.01" max="${remaining}" required placeholder="Up to ${fmtMoney(remaining)}" autofocus></div>
          <div class="form-field"><label>Paid by</label><select name="method"><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque</option><option value="other">Other</option></select></div>
          <div class="form-field"><label>Received on</label><input name="receivedOn" type="date" value="${today()}"></div>
          <div class="form-field" style="grid-column: span 3;"><label>Reference / note</label><input name="reference" maxlength="120" placeholder="UTR, cheque no. (optional)"></div>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Add amount</button><button class="btn secondary" type="button" data-toggle-form="receive-${e.id}">Cancel</button></div>
      </form>` : "";
    const list = (e.receipts || []).length
      ? `<ul class="instal-list">${e.receipts.map((x) => `<li><span>${fmtMoney(x.amount)}</span><span class="muted">${esc(METHOD_LABELS[x.method] || x.method)}${x.reference ? ` · ${esc(x.reference)}` : ""}</span><span class="muted">${esc(fmtDay(x.receivedOn))}</span></li>`).join("")}</ul>`
      : `<p class="profile-note">Nothing received yet.</p>`;
    return `<div class="instal-card">
      <div class="instal-head"><b>${MONTHS[e.month]} ${e.year}</b>${onlinePaymentNote(e)}<span class="stamp ${e.status}">${e.status}</span></div>
      <div class="instal-figures">
        <div><span>Total rent</span><strong>${fmtMoney(total)}</strong></div>
        <div><span>Received</span><strong class="is-paid">${fmtMoney(received)}</strong></div>
        <div><span>Remaining</span><strong class="${remaining > 0 ? "is-due" : "is-paid"}">${fmtMoney(remaining)}</strong></div>
      </div>
      <div class="instal-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Received ${pct}%"><i style="width:${pct}%"></i></div>
      ${list}
      ${receiveForm}
      <div class="instal-actions">
        ${remaining > 0 && !formOpen ? `<button class="btn small" data-toggle-form="receive-${e.id}">+ Add amount received</button>` : ""}
        ${e.receipt ? `<button class="btn small secondary" data-action="view-receipt" data-receipt-id="${e.receipt.id}">View proof</button>` : ""}
        <button class="btn small secondary" data-toggle-form="editRent-${e.id}">Edit</button>
        <button class="btn small danger" data-action="delete-rent" data-id="${e.id}">Delete</button>
      </div>
    </div>`;
  }).join("");
  return `
    ${!tenant ? `<div class="card"><div class="empty-state">No active tenant — you can still log rent history for this room.</div></div>` : ""}
    ${addForm}${editForms}
    <div class="card">
      <h3>
        Rent received
        <button class="btn small" data-toggle-form="addRent">+ Add month</button>
      </h3>
      <p class="profile-note">Instalments: set the total rent, then add each amount as you receive it.${totalRemaining > 0 ? ` <b>Still to receive for this room: ${fmtMoney(totalRemaining)}</b>` : ""}</p>
      ${cache.rent.length === 0 ? `<div class="empty-state">No rent entries yet.</div>` : `<div class="instal-grid">${cards}</div>`}
    </div>
  `;
}

function renderRentTab(r, tenant) {
  if (rentMode() === "instalments") return renderRentInstalments(r, tenant);
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

// Owner dashboard card: UPI payments tenants started (not verified yet) and
// any older online payments, or a reminder of how to switch UPI payments on.
function renderOnlinePaymentsCard(d) {
  if (!d.onlinePaymentsEnabled) {
    return `<div class="card"><h3>UPI payments</h3><p class="profile-note">Tenants can't pay by UPI yet. Add your UPI ID in <strong>Settings → UPI payments</strong> to show a <strong>Pay</strong> button on every pending bill. Money goes straight to your UPI ID.</p></div>`;
  }
  const kindLabel = { rent: "Rent", electricity: "Electricity", gas: "Gas" };
  const day = (v) => new Date(v).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  const rows = (cache.payments || []).map((p) => `
    <tr>
      <td class="text">${esc(day(p.paidAt || p.createdAt))}</td>
      <td class="text">${esc(p.tenantName)}${p.roomLabel ? `<br><small>${esc(p.roomLabel)}</small>` : ""}</td>
      <td class="text">${p.items.map((i) => `${kindLabel[i.kind] || i.kind} ${MONTHS[i.month] || ""} ${i.year || ""}`).map(esc).join("<br>")}</td>
      <td>${fmtMoney(p.amount)}</td>
      <td class="text">${p.provider === "upi"
        ? `<span class="stamp ${p.reportedAt ? "partial" : "due"}">${p.reportedAt ? "Tenant says paid" : "Started"}</span><br><small>Not verified · <code data-no-i18n>${esc(p.reference)}</code></small>`
        : `<span class="stamp paid">paid</span><br><small>${esc(p.method || "")} ${esc(p.providerPaymentId || "")}</small>`}</td>
    </tr>`).join("");
  return `<div class="card"><h3>UPI payments <small style="font-weight:400">from tenants</small></h3><p class="profile-note">Rent Ledger can't see your bank, so these are <b>not verified</b>. When the money shows in your UPI or bank app, record it as usual (Payments → Record payment) and quote the reference.</p>${rows ? `<table class="ledger"><thead><tr><th>Date</th><th>Tenant</th><th>Bills</th><th>Amount</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty-state">No UPI payments started yet. Tenants see a Pay button on each pending bill.</div>`}</div>`;
}

// Small note under a bill's period when it was paid online (older Razorpay payments).
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
      // Answer the tap straight away: light up what was tapped and close the More panel.
      if (nav.matches(".mnav-btn, .side-link, .msheet-grid button, .msheet-row")) {
        document.querySelectorAll(".mnav-btn.active, .side-link.active, .msheet-grid button.active").forEach((el) => el.classList.remove("active"));
        nav.classList.add("active");
        if (nav.closest(".msheet")) { nav.closest(".msheet").hidden = true; document.body.classList.remove("sheet-open"); }
      }
      state.forms = {};
      if (type === "dashboard") { state.view = "dashboard"; state.buildingId = null; state.roomId = null; }
      if (type === "building") { state.view = "building"; state.buildingId = nav.dataset.id; state.roomId = null; }
      if (type === "room") { state.view = "room"; state.roomId = nav.dataset.id; state.roomTab = cache.rooms.find((room) => room.id === nav.dataset.id)?.electricityOnly ? "electricity" : "tenant"; }
      if (type === "profile") { state.view = "profile"; state.buildingId = null; state.roomId = null; }
      if (window.RL_EXT?.views[type]) { state.view = type; state.buildingId = null; state.roomId = null; }
      state.params = { id: nav.dataset.id || null };
      window.RL_EXT?.onNavigate?.();
      return render();
    }

    const toggle = e.target.closest("[data-toggle-form]");
    if (toggle) {
      const key = toggle.dataset.toggleForm;
      const closingCard = state.forms[key] ? toggle.closest(".card") : null;
      if (closingCard && closingCard.querySelector("form") && !reducedMotion()) {
        closingCard.classList.add("card-leave");
        await new Promise((resolve) => setTimeout(resolve, 170));
      }
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
    if (action) return withBusy(action, () => handleAction(action));
  };

  app.onchange = (e) => {
    const el = e.target.closest("[data-ext-change]");
    if (el && window.RL_EXT?.changes[el.dataset.extChange]) { RL_EXT.changes[el.dataset.extChange](el); state.forms = {}; render(); }
  };

  app.onkeydown = (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-nav]:not(button):not(a)")) {
      e.preventDefault();
      e.target.click();
    }
  };

  app.onsubmit = async (e) => {
    const form = e.target.closest("[data-submit]");
    if (!form) return;
    e.preventDefault();
    const submitButton = form.querySelector('button[type="submit"], button:not([type])');
    return withBusy(submitButton || form, () => handleSubmit(form));
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
    if (window.RL_EXT?.actions[act]) {
      if ((await RL_EXT.actions[act](el)) === false) return;
      invalidateData();
      await render();
      return;
    }
    if (act === "logout") {
      logout();
      return;
    } else if (act === "add-building") {
      // The form lives on the dashboard, so go there and open it.
      state.view = "dashboard"; state.buildingId = null; state.roomId = null; state.params = {};
      state.forms = { addBuilding: true };
      await render();
      return;
    } else if (act === "copy-text") {
      await copyText(el.dataset.text || "");
      return;
    } else if (act === "delete-building") {
      if (!(await confirmDialog("Every floor, room, tenant record, ledger entry and payment proof in this building will be removed. This can't be undone.", { title: "Delete this building?", confirmLabel: "Delete building", danger: true }))) return;
      await api("DELETE", `/api/buildings/${el.dataset.id}`);
      state.view = "dashboard"; state.buildingId = null;
      toast("Building deleted");
    } else if (act === "move-out") {
      if (!(await confirmDialog("Their login, mobile numbers, email and ID-proof number will be removed permanently. Rent and bill history is kept.", { title: "Mark this tenant as moved out?", confirmLabel: "Move out", danger: true }))) return;
      await api("POST", `/api/tenants/${el.dataset.id}/move-out`, { moveOutDate: today() });
      toast("Tenant moved out; login and personal identifiers removed");
    } else if (act === 'create-invite') {
      const invite = await api('POST', `/api/tenants/${el.dataset.id}/invite`);
      const tenant = cache.tenants.find((t) => t.id === el.dataset.id);
      const until = displayDate(invite.expiresAt);
      const appLink = isMobileApp ? '' : ` at ${location.origin}`;
      const shareText = `Your Rent Ledger invite code is ${invite.code}. Sign up as a tenant${appLink} with your mobile number ${invite.mobile} and this code. It works once and expires on ${until}.`;
      const copy = await confirmDialog(`Invite code ${invite.code} for ${tenant?.name || 'this tenant'}. It works once, with mobile ${invite.mobile}, until ${until}. It won't be shown again, so copy it now and send it to the tenant.`, { title: 'Invite code created', confirmLabel: 'Copy invite message' });
      if (copy) await copyText(shareText);
    } else if (act === 'cancel-invite') {
      if (!(await confirmDialog("The current invite code will stop working.", { title: "Cancel this invite?", confirmLabel: "Cancel invite", danger: true }))) return;
      await api('DELETE', `/api/tenants/${el.dataset.id}/invite`);
      toast('Invite cancelled');
    } else if (act === 'download-backup') {
      await downloadBackup();
      return;
    } else if (act === 'delete-tenant') {
      if (!(await confirmDialog("Their login is removed. Rent and bill history stays, but will no longer be linked to this tenant.", { title: "Remove this previous tenant?", confirmLabel: "Remove record", danger: true }))) return;
      await api('DELETE', `/api/tenants/${el.dataset.id}`);
      toast('Previous tenant record removed');
    } else if (act === 'delete-floor') {
      const count = Number(el.dataset.roomCount) || 0;
      if (!(await confirmDialog(`All ${count} room${count === 1 ? '' : 's'} on this floor, with their tenant records, ledgers and payment proofs, will be permanently removed.`, { title: `Delete Floor ${el.dataset.floorNumber}?`, confirmLabel: 'Delete floor', danger: true }))) return;
      await api('DELETE', `/api/buildings/${el.dataset.buildingId}/floors/${el.dataset.floorNumber}`);
      toast(`Floor ${el.dataset.floorNumber} deleted`);
    } else if (act === "view-receipt") {
      await openReceipt(el.dataset.receiptId);
    } else if (act === "mark-rent-paid") {
      await api("PUT", `/api/rent/${el.dataset.id}`, { amountPaid: Number(el.dataset.amount), paidDate: today() });
      toast("Rent marked as paid");
    } else if (act === "delete-rent") {
      if (!(await confirmDialog("This rent entry and any payment proof attached to it will be removed.", { title: "Delete this rent entry?", confirmLabel: "Delete", danger: true }))) return;
      await api("DELETE", `/api/rent/${el.dataset.id}`);
      toast("Entry deleted");
    } else if (act === "mark-elec-paid") {
      await api("PUT", `/api/electricity/${el.dataset.id}`, { paidDate: today() });
      toast("Electricity bill marked as paid");
    } else if (act === "delete-electricity") {
      if (!(await confirmDialog("This electricity entry and any payment proof attached to it will be removed.", { title: "Delete this electricity entry?", confirmLabel: "Delete", danger: true }))) return;
      await api("DELETE", `/api/electricity/${el.dataset.id}`);
      toast("Entry deleted");
    } else if (act === "mark-gas-paid") {
      await api("PUT", `/api/gas/${el.dataset.id}`, { paidDate: today() });
      toast("Gas bill marked as paid");
    } else if (act === "delete-gas") {
      if (!(await confirmDialog("This gas bill and any payment proof attached to it will be removed.", { title: "Delete this gas bill?", confirmLabel: "Delete", danger: true }))) return;
      await api("DELETE", `/api/gas/${el.dataset.id}`);
      toast("Entry deleted");
    } else if (act === "unlink-gas-meter") {
      if (!(await confirmDialog("You'll need to link a meter again before adding new gas bills. Past bills are kept as they are.", { title: "Unlink this gas meter?", confirmLabel: "Unlink meter" }))) return;
      await api("DELETE", `/api/rooms/${el.dataset.roomId}/gas-meter`);
      toast("Gas meter unlinked");
    }
    invalidateData(); cache.profile = null; cache.tenantProfile = null;
    await render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function handleSubmit(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const kind = form.dataset.submit;
  try {
    if (window.RL_EXT?.submits[kind]) {
      if ((await RL_EXT.submits[kind](data, form)) === false) return;
      invalidateData();
      await render();
      return;
    }
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
    } else if (kind === "receive-rent") {
      await api("POST", `/api/rent/${form.dataset.id}/receive`, { amount: Number(data.amount), method: data.method, receivedOn: data.receivedOn, reference: data.reference || "" });
      state.forms[`receive-${form.dataset.id}`] = false;
      toast("Amount added");
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
    await render();
  } catch (err) {
    toast(err.message, true);
  }
}

// Start once every script (i18n, modules) has loaded.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => render()); else render();
