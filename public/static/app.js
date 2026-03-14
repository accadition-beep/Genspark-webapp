// ╔══════════════════════════════════════════════════════════════════════╗
// ║  ADITION ELECTRIC SOLUTION — PWA Frontend v9                        ║
// ║  "iQOO 13 Flagship Edition"                                          ║
// ║  · 10ms debounce search · passive:true touch · touch-action:pan-y   ║
// ║  · Strict RBAC: staff sees NO prices / NO share / NO mobiles        ║
// ║  · Per-machine Repair Amount · real-time itemized balance            ║
// ║  · Audio recorder (Web Audio API) hardware-accelerated              ║
// ║  · Canvas image compression 1080px before R2 upload                 ║
// ║  · html2canvas allowTaint+useCORS for R2 images in 9:16 JPG         ║
// ║  · visualViewport resize → inputs above Android keyboard            ║
// ║  · will-change:transform,opacity on cards/modals → 144Hz GPU        ║
// ║  · Assignment request flow: staff→request→admin approve/deny        ║
// ║  · Smart JPG: itemized prices, hide 25d notice if Delivered          ║
// ╚══════════════════════════════════════════════════════════════════════╝
;(function () {
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
const S = {
  token  : localStorage.getItem('AES_TOKEN') || null,
  user   : (() => { try { return JSON.parse(localStorage.getItem('AES_USER') || 'null') } catch { return null } })(),
  view   : 'login',
  jobId  : null,
  jobs   : [],
  job    : null,
  staff  : [],
  requests: [],
  filter : new URLSearchParams(window.location.search).get('status') || 'under_repair',
  search : '',
  audioStream  : null,
  audioRecorder: null,
  audioChunks  : [],
};

const CARD_H = 88;

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────
const API = axios.create({ baseURL: '/' });
API.interceptors.request.use(cfg => {
  if (S.token) cfg.headers.Authorization = 'Bearer ' + S.token;
  return cfg;
});
API.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401) logout();
  return Promise.reject(err);
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const isAdmin = () => S.user?.role === 'admin';
const fmtRs   = n => '₹' + (parseFloat(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '';
const esc     = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const STATUS_COLOR = { under_repair:'#E53935', repaired:'#43A047', returned:'#B8860B', delivered:'#1E88E5' };
const STATUS_BG    = { under_repair:'#FFEBEE', repaired:'#E8F5E9', returned:'#FFF8E1', delivered:'#E3F2FD' };
const STATUS_LABEL = { under_repair:'Under Repair', repaired:'Repaired', returned:'Returned', delivered:'Delivered' };
const sc = s => STATUS_COLOR[s] || '#888';
const sb = s => STATUS_BG[s]    || '#f5f5f5';
const sl = s => STATUS_LABEL[s] || s;

// 10ms debounce (iQOO 13 lag killer for search/filter)
function debounce(fn, ms = 10) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Toast
function toast(msg, type = 'info') {
  document.querySelectorAll('.aes-toast').forEach(t => t.remove());
  const el = Object.assign(document.createElement('div'), { className: 'aes-toast', textContent: msg });
  const bg = type === 'error' ? '#C62828' : type === 'success' ? '#2E7D32' : '#1565C0';
  el.style.cssText = `position:fixed;bottom:82px;left:50%;transform:translateX(-50%);
    background:${bg};color:#fff;padding:11px 22px;border-radius:12px;z-index:9999;
    font-size:14px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.35);
    max-width:90vw;text-align:center;animation:toastIn .22s ease;pointer-events:none;
    will-change:transform,opacity;`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// Scroll lock
function lockScroll()   { document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden'; }
function unlockScroll() { document.body.style.overflow = ''; document.documentElement.style.overflow = ''; }

// Modal
function showModal(html) {
  closeModal();
  lockScroll();
  const ov = document.createElement('div');
  ov.id = 'aes-modal';
  ov.innerHTML = `<div class="modal-sheet" style="will-change:transform,opacity">${html}</div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
  ov.querySelector('.modal-sheet')?.addEventListener('touchmove', e => e.stopPropagation(), { passive: false });
  // Animate in
  requestAnimationFrame(() => {
    const sheet = ov.querySelector('.modal-sheet');
    if (sheet) { sheet.style.transform = 'translateY(0)'; sheet.style.opacity = '1'; }
  });
}
function closeModal() {
  document.getElementById('aes-modal')?.remove();
  unlockScroll();
  stopAudioRecorder();
}

function setFilter(s) {
  S.filter = s;
  const u = new URL(window.location);
  s ? u.searchParams.set('status', s) : u.searchParams.delete('status');
  history.replaceState({}, '', u);
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE COMPRESSION (canvas, max 1080px, before R2 upload)
// ─────────────────────────────────────────────────────────────────────────────
function compressImage(file, maxW = 1080, quality = 0.82) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(1, maxW / Math.max(img.width, img.height));
        const w = Math.round(img.width  * ratio);
        const h = Math.round(img.height * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(blob => {
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
        }, 'image/jpeg', quality);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO RECORDER (hardware-accelerated Web Audio API)
// ─────────────────────────────────────────────────────────────────────────────
async function startAudioRecorder(onData) {
  try {
    S.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    S.audioChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
    S.audioRecorder = new MediaRecorder(S.audioStream, { mimeType });
    S.audioRecorder.ondataavailable = e => { if (e.data.size > 0) S.audioChunks.push(e.data); };
    S.audioRecorder.onstop = () => {
      const blob = new Blob(S.audioChunks, { type: mimeType });
      if (onData) onData(blob, mimeType);
      S.audioStream?.getTracks().forEach(t => t.stop());
      S.audioStream = null;
    };
    S.audioRecorder.start(250);
    return true;
  } catch (err) {
    toast('Microphone access denied', 'error');
    return false;
  }
}

function stopAudioRecorder() {
  if (S.audioRecorder && S.audioRecorder.state !== 'inactive') S.audioRecorder.stop();
  S.audioStream?.getTracks().forEach(t => t.stop());
  S.audioStream = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// VISUAL VIEWPORT — keeps inputs above Android keyboard
// ─────────────────────────────────────────────────────────────────────────────
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) {
        focused.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      // Adjust modal sheet height for keyboard
      const sheet = document.querySelector('.modal-sheet');
      if (sheet) {
        const vvh = window.visualViewport.height;
        sheet.style.maxHeight = (vvh * 0.92) + 'px';
      }
    });
  }, { passive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
async function login(email, password) {
  try {
    const r = await API.post('/api/auth/login', { email, password });
    S.token = r.data.token; S.user = r.data.user;
    localStorage.setItem('AES_TOKEN', S.token);
    localStorage.setItem('AES_USER', JSON.stringify(S.user));
    navigate('dashboard');
  } catch (e) {
    toast(e.response?.data?.error || 'Login failed', 'error');
  }
}
function logout() {
  S.token = null; S.user = null; S.jobs = []; S.job = null; S.staff = []; S.requests = [];
  localStorage.removeItem('AES_TOKEN'); localStorage.removeItem('AES_USER');
  navigate('login');
}

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────────────────────────────────────
function navigate(view, params = {}) {
  S.view = view;
  if (params.jobId) S.jobId = params.jobId;
  render();
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER ROOT
// ─────────────────────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  if (!app) return;
  if (!S.token || !S.user) {
    app.innerHTML = loginHTML();
    bindLogin();
    return;
  }
  app.innerHTML = `
    <div class="app-shell">
      ${headerHTML()}
      <div id="view-root">${viewHTML()}</div>
      ${bottomNavHTML()}
    </div>`;
  bindView();
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────────────────────
function loginHTML() {
  return `
  <div class="login-bg">
    <div class="login-card">
      <div class="login-logo">
        <div class="logo-icon"><i class="fas fa-bolt"></i></div>
        <h1 class="login-title">ADITION ELECTRIC</h1>
        <p class="login-sub">Service Management System</p>
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input id="l-email" type="email" class="form-input" placeholder="admin@example.com"
               value="bilalkhan1108@gmail.com" autocomplete="username">
      </div>
      <div class="form-group">
        <label class="form-label">Password</label>
        <input id="l-pass" type="password" class="form-input" placeholder="••••••••"
               value="0010" autocomplete="current-password">
      </div>
      <button id="l-btn" class="btn-primary btn-full">
        <i class="fas fa-sign-in-alt"></i> Sign In
      </button>
      <p class="login-hint">Admin: bilalkhan1108@gmail.com / 0010</p>
    </div>
    <p class="login-footer">✨ adition™ since 1984 · Gheekanta, Ahmedabad</p>
  </div>`;
}
function bindLogin() {
  const go = () => login(
    document.getElementById('l-email').value.trim(),
    document.getElementById('l-pass').value
  );
  document.getElementById('l-btn')?.addEventListener('click', go);
  document.getElementById('l-pass')?.addEventListener('keypress', e => { if (e.key === 'Enter') go(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// HEADER
// ─────────────────────────────────────────────────────────────────────────────
function headerHTML() {
  const titles = {
    dashboard:'Jobs Dashboard', newjob:'New Job',
    detail:'Job Details', staff:'Staff Panel',
    reports:'Reports', settings:'Settings', requests:'Requests'
  };
  const backBtn = S.view === 'detail'
    ? `<button class="hdr-back" id="hdr-back-btn"><i class="fas fa-arrow-left"></i></button>` : '';
  const subtitle = S.view === 'detail' && S.job
    ? `<div class="hdr-job-id">${S.job.id} · ${esc(S.job.snap_name)}</div>`
    : `<div class="hdr-sub">ADITION ELECTRIC SOLUTION</div>`;
  return `
  <header class="app-header" style="will-change:transform">
    <div class="hdr-left">
      ${backBtn}
      <div>
        <div class="hdr-title">${titles[S.view] || 'AES'}</div>
        ${subtitle}
      </div>
    </div>
    <div class="hdr-right">
      <span class="role-badge ${isAdmin()?'role-admin':'role-staff'}">${esc((S.user?.name||'').split(' ')[0])}</span>
      <button class="icon-btn" id="hdr-logout-btn" title="Sign out"><i class="fas fa-sign-out-alt"></i></button>
    </div>
  </header>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOTTOM NAV
// ─────────────────────────────────────────────────────────────────────────────
function bottomNavHTML() {
  const tabs = [
    { id:'dashboard', icon:'fa-list-ul',    label:'Jobs'    },
    { id:'newjob',    icon:'fa-plus-circle', label:'New Job' },
    ...(isAdmin() ? [{ id:'requests', icon:'fa-bell', label:'Requests' }] : []),
    ...(isAdmin() ? [{ id:'staff',    icon:'fa-users',     label:'Staff'   }] : []),
    ...(isAdmin() ? [{ id:'reports',  icon:'fa-chart-bar', label:'Reports' }] : []),
    { id:'settings',  icon:'fa-cog',         label:'More'    },
  ];
  return `
  <nav class="bottom-nav">
    ${tabs.map(t => `
    <button class="nav-btn ${S.view===t.id?'nav-active':''}" data-nav="${t.id}">
      <i class="fas ${t.icon} nav-icon"></i>
      <span class="nav-label">${t.label}</span>
    </button>`).join('')}
  </nav>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// VIEW DISPATCH
// ─────────────────────────────────────────────────────────────────────────────
function viewHTML() {
  switch (S.view) {
    case 'dashboard': return dashboardHTML();
    case 'newjob':    return newJobHTML();
    case 'detail':    return `<div id="detail-root" class="view-pad"><div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div></div>`;
    case 'staff':     return isAdmin() ? staffHTML()    : deniedHTML();
    case 'reports':   return isAdmin() ? reportsHTML()  : deniedHTML();
    case 'requests':  return isAdmin() ? requestsHTML() : deniedHTML();
    case 'settings':  return settingsHTML();
    default:          return dashboardHTML();
  }
}
const deniedHTML = () => `<div class="empty-state"><i class="fas fa-lock fa-3x"></i><p>Access Denied</p></div>`;

function bindView() {
  document.getElementById('hdr-back-btn')?.addEventListener('click', () => navigate('dashboard'));
  document.getElementById('hdr-logout-btn')?.addEventListener('click', logout);
  document.querySelectorAll('[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.nav), { passive: true });
  });

  switch (S.view) {
    case 'dashboard': loadJobs();                                               break;
    case 'newjob':    bindNewJob();                                             break;
    case 'detail':    loadDetail();                                             break;
    case 'staff':     if (isAdmin()) loadStaff();                              break;
    case 'reports':   if (isAdmin()) { loadStaffForSelects(); bindReports(); } break;
    case 'requests':  if (isAdmin()) loadRequests();                           break;
    case 'settings':  bindSettings();                                           break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD — virtual-scroll list
// ─────────────────────────────────────────────────────────────────────────────
function dashboardHTML() {
  const filters = [
    { s:'',             label:'All' },
    { s:'under_repair', label:'Under Repair' },
    { s:'repaired',     label:'Repaired' },
    { s:'returned',     label:'Returned' },
    ...(isAdmin() ? [{ s:'delivered', label:'Delivered' }] : []),
  ];
  return `
  <div style="display:flex;flex-direction:column;height:100%">
    <div class="filter-bar">
      ${filters.map(f => `
      <button class="filter-chip ${S.filter===f.s?'chip-active':''}"
        style="--chip-color:${f.s ? sc(f.s) : '#1a1a2e'}"
        data-filter="${f.s}">${f.label}</button>`).join('')}
    </div>
    <div class="search-wrap">
      <i class="fas fa-search search-icon"></i>
      <input id="dash-search" type="search" class="search-input"
             placeholder="Search name, mobile, job ID…" value="${esc(S.search)}"
             autocomplete="off" autocorrect="off" spellcheck="false">
    </div>
    <div id="vlist-wrap" class="vlist-wrap" style="flex:1"></div>
  </div>`;
}

async function loadJobs() {
  const wrap = document.getElementById('vlist-wrap');
  if (wrap) wrap.innerHTML = `<div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div>`;
  try {
    const params = {};
    if (S.filter) params.status = S.filter;
    if (S.search) params.q = S.search;
    const r = await API.get('/api/jobs', { params });
    S.jobs = r.data;
    renderVList();
  } catch {
    if (wrap) wrap.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-circle fa-2x" style="color:#e53935"></i><p>Error loading jobs</p></div>`;
  }

  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      setFilter(btn.dataset.filter);
      render();
    }, { passive: true });
  });

  const dSearch = debounce(() => {
    S.search = document.getElementById('dash-search')?.value.trim() || '';
    loadJobs();
  }, 10);
  document.getElementById('dash-search')?.addEventListener('input', dSearch);
}

function renderVList() {
  const wrap = document.getElementById('vlist-wrap');
  if (!wrap) return;
  if (!S.jobs.length) {
    wrap.innerHTML = `<div class="empty-state"><i class="fas fa-inbox fa-3x"></i><p>No jobs found</p><p class="empty-sub">Tap <b>New Job</b> to create one</p></div>`;
    return;
  }
  const total = S.jobs.length;
  const wrapH = wrap.clientHeight || (window.innerHeight - 200);

  function paint() {
    const scrollTop = wrap.scrollTop;
    const startIdx  = Math.max(0, Math.floor(scrollTop / CARD_H) - 4);
    const endIdx    = Math.min(total - 1, startIdx + Math.ceil(wrapH / CARD_H) + 8);
    const topH      = startIdx * CARD_H;
    const botH      = Math.max(0, (total - endIdx - 1) * CARD_H);
    const visible   = S.jobs.slice(startIdx, endIdx + 1);

    wrap.innerHTML =
      `<div style="height:${topH}px;pointer-events:none"></div>` +
      visible.map(j => jobRowHTML(j)).join('') +
      `<div style="height:${botH}px;pointer-events:none"></div>`;

    wrap.querySelectorAll('.job-row').forEach(row => {
      row.addEventListener('click', () => navigate('detail', { jobId: row.dataset.id }), { passive: true });
    });
  }

  paint();
  wrap.addEventListener('scroll', paint, { passive: true });
}

function jobRowHTML(j) {
  const color   = sc(j.status);
  const bg      = sb(j.status);
  const balance = Math.max(0, (j.total_charges || 0) - (j.received_amount || 0));
  return `
  <div class="job-row" data-id="${j.id}" style="border-left-color:${color};will-change:transform,opacity">
    <div class="job-row-thumb">
      ${j.thumb
        ? `<img src="${j.thumb}" class="thumb-img" loading="lazy" onerror="this.parentElement.innerHTML='<i class=\\'fas fa-tools\\' style=\\'color:#bbb;font-size:22px\\'></i>'">`
        : `<i class="fas fa-tools" style="color:#bbb;font-size:22px"></i>`}
    </div>
    <div class="job-row-body">
      <div class="job-row-top">
        <span class="job-id">${j.id}</span>
        <span class="status-chip" style="background:${bg};color:${color};border-color:${color}">${sl(j.status)}</span>
      </div>
      <div class="job-name">${esc(j.snap_name)}</div>
      <div class="job-row-foot">
        <span class="job-meta"><i class="fas fa-tools"></i> ${j.machine_count || 0}</span>
        ${isAdmin()
          ? `<span class="job-balance" style="color:${balance>0?'#E53935':'#43A047'}">Bal: ${fmtRs(balance)}</span>`
          : `<span class="job-balance" style="color:${balance>0?'#E53935':'#43A047'}">Due: ${fmtRs(balance)}</span>`}
      </div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW JOB FORM — includes product image upfront + per-machine charges
// ─────────────────────────────────────────────────────────────────────────────
function newJobHTML() {
  return `
  <div class="view-pad">
    <div class="card">
      <h2 class="section-title"><i class="fas fa-user-circle" style="color:#E53935"></i> Customer Details</h2>
      <div class="form-row-2">
        <div class="form-group">
          <label class="form-label">Mobile <span class="req">*</span></label>
          <input id="nj-mobile" type="tel" class="form-input" placeholder="9876543210" maxlength="15" inputmode="numeric">
        </div>
        <div class="form-group">
          <label class="form-label">Alt. Mobile</label>
          <input id="nj-mobile2" type="tel" class="form-input" placeholder="Optional" maxlength="15" inputmode="numeric">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Customer Name <span class="req">*</span></label>
        <input id="nj-name" type="text" class="form-input" placeholder="Full name" autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">Address</label>
        <textarea id="nj-address" class="form-input" rows="2" placeholder="Street, area, city"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Internal Note</label>
        <textarea id="nj-note" class="form-input" rows="2" placeholder="Remarks for this job…"></textarea>
      </div>
      ${isAdmin() ? `
      <div class="form-group">
        <label class="form-label">Received Amount (₹)</label>
        <input id="nj-received" type="number" class="form-input" placeholder="0" min="0" inputmode="decimal">
      </div>` : ''}
    </div>

    <div class="card">
      <h2 class="section-title"><i class="fas fa-tools" style="color:#E53935"></i> First Machine</h2>
      <div class="form-group">
        <label class="form-label">Product Name <span class="req">*</span></label>
        <input id="nj-product" type="text" class="form-input" placeholder='e.g. Samsung TV 55"' autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">Complaint / Issue <span class="req">*</span></label>
        <textarea id="nj-complaint" class="form-input" rows="2" placeholder="Describe the problem…"></textarea>
      </div>
      <div class="form-row-2">
        ${isAdmin() ? `
        <div class="form-group">
          <label class="form-label">Repair Amount (₹)</label>
          <input id="nj-charges" type="number" class="form-input" placeholder="0" min="0" inputmode="decimal">
        </div>` : ''}
        <div class="form-group">
          <label class="form-label">Quantity</label>
          <input id="nj-qty" type="number" class="form-input" placeholder="1" min="1" value="1" inputmode="numeric">
        </div>
      </div>
      ${isAdmin() ? `
      <div class="form-group">
        <label class="form-label">Assign Staff</label>
        <select id="nj-staff" class="form-input">
          <option value="">— None —</option>
          ${S.staff.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
        </select>
      </div>` : ''}
      <!-- Image capture upfront — part of the machine details form -->
      <div class="form-group">
        <label class="form-label"><i class="fas fa-camera" style="color:#E53935"></i> Product Photo (optional)</label>
        <label class="img-upload-label">
          <i class="fas fa-camera"></i> Take / Pick Photo
          <input id="nj-img" type="file" accept="image/*" capture="environment" style="display:none">
        </label>
        <div id="nj-img-preview" style="margin-top:8px;display:none">
          <img id="nj-img-thumb" style="width:80px;height:80px;object-fit:cover;border-radius:10px;border:2px solid #e0e0e0">
          <button id="nj-img-clear" class="btn-sm btn-red" style="margin-left:8px;vertical-align:top">
            <i class="fas fa-times"></i>
          </button>
        </div>
      </div>
      <button id="nj-submit" class="btn-primary btn-full" style="margin-top:8px">
        <i class="fas fa-save"></i> Create Job
      </button>
    </div>
  </div>`;
}

function bindNewJob() {
  // Pre-load staff for selector if admin
  if (isAdmin() && !S.staff.length) {
    API.get('/api/staff').then(r => {
      S.staff = r.data;
      const sel = document.getElementById('nj-staff');
      if (sel) sel.innerHTML = `<option value="">— None —</option>` +
        S.staff.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    }).catch(() => {});
  }

  const mobileIn = document.getElementById('nj-mobile');
  async function lookupMobile() {
    const m = mobileIn?.value.trim();
    if (!m || m.length < 10) return;
    try {
      const r = await API.get('/api/customers/by-mobile', { params: { mobile: m } });
      if (r.data) {
        document.getElementById('nj-name').value    = r.data.name    || '';
        document.getElementById('nj-mobile2').value = r.data.mobile2 || '';
        document.getElementById('nj-address').value = r.data.address || '';
        toast('Customer found — pre-filled', 'success');
      }
    } catch (_) {}
  }
  mobileIn?.addEventListener('blur', lookupMobile);

  // Image preview
  const imgInput = document.getElementById('nj-img');
  imgInput?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      document.getElementById('nj-img-thumb').src = ev.target.result;
      document.getElementById('nj-img-preview').style.display = 'block';
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('nj-img-clear')?.addEventListener('click', () => {
    if (imgInput) imgInput.value = '';
    document.getElementById('nj-img-preview').style.display = 'none';
  });

  document.getElementById('nj-submit')?.addEventListener('click', async () => {
    const name    = document.getElementById('nj-name')?.value.trim();
    const mobile  = document.getElementById('nj-mobile')?.value.trim();
    const product = document.getElementById('nj-product')?.value.trim();
    if (!name || !mobile || !product) { toast('Name, mobile & product are required', 'error'); return; }

    const btn = document.getElementById('nj-submit');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating…';
    try {
      const jobR = await API.post('/api/jobs', {
        customer_name:    name,
        customer_mobile:  mobile,
        customer_mobile2: document.getElementById('nj-mobile2')?.value.trim() || null,
        customer_address: document.getElementById('nj-address')?.value.trim() || null,
        note:             document.getElementById('nj-note')?.value.trim()    || null,
        received_amount:  isAdmin() ? (parseFloat(document.getElementById('nj-received')?.value) || 0) : 0,
      });
      const jid = jobR.data.id;
      const machR = await API.post(`/api/jobs/${jid}/machines`, {
        product_name:      product,
        product_complaint: document.getElementById('nj-complaint')?.value.trim() || null,
        charges:           isAdmin() ? (parseFloat(document.getElementById('nj-charges')?.value) || 0) : 0,
        quantity:          parseInt(document.getElementById('nj-qty')?.value) || 1,
        assigned_staff_id: isAdmin() ? (document.getElementById('nj-staff')?.value || null) : null,
      });

      // Upload initial image if provided
      const imgFile = document.getElementById('nj-img')?.files[0];
      if (imgFile && machR.data.id) {
        try {
          toast('Uploading image…', 'info');
          const compressed = await compressImage(imgFile, 1080, 0.82);
          const fd = new FormData();
          fd.append('image', compressed);
          await API.post(`/api/machines/${machR.data.id}/images`, fd, {
            headers: { 'Content-Type': 'multipart/form-data' }
          });
        } catch (_) { toast('Image upload failed (job still created)', 'error'); }
      }

      toast(`✅ Job ${jid} created!`, 'success');
      S.jobId = jid;
      navigate('detail');
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to create job', 'error');
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Create Job';
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB DETAIL
// ─────────────────────────────────────────────────────────────────────────────
async function loadDetail() {
  if (!S.jobId) return;
  try {
    const r = await API.get(`/api/jobs/${S.jobId}`);
    S.job   = r.data;
    if (isAdmin() && !S.staff.length) {
      try { const sr = await API.get('/api/staff'); S.staff = sr.data; } catch (_) {}
    }
    renderDetail();
  } catch {
    const root = document.getElementById('detail-root');
    if (root) root.innerHTML = `<div class="empty-state" style="color:#e53935"><i class="fas fa-exclamation-triangle fa-2x"></i><p>Failed to load job</p></div>`;
  }
}

function renderDetail() {
  const j    = S.job;
  if (!j) return;
  const root = document.getElementById('detail-root');
  if (!root) return;

  // Refresh sticky header
  const hdr = document.querySelector('.app-header');
  if (hdr) {
    hdr.outerHTML = headerHTML();
    document.getElementById('hdr-back-btn')?.addEventListener('click', () => navigate('dashboard'));
    document.getElementById('hdr-logout-btn')?.addEventListener('click', logout);
  }

  const color    = sc(j.status);
  const total    = j.total_charges   || 0;
  const received = j.received_amount || 0;
  const balance  = Math.max(0, total - received);
  const userId   = S.user?.id;

  root.innerHTML = `
    <!-- Status Banner -->
    <div class="detail-banner" style="background:${color}">
      <span class="detail-job-id">${j.id}</span>
      <span class="detail-status-label">${sl(j.status)}</span>
    </div>

    <!-- Customer Card -->
    <div class="card mt-3">
      <div class="info-row">
        <i class="fas fa-user info-icon" style="color:${color}"></i>
        <span class="info-val fw-bold">${esc(j.snap_name)}</span>
      </div>
      ${isAdmin() ? `
      <div class="info-row">
        <i class="fas fa-phone info-icon" style="color:${color}"></i>
        <a href="tel:${j.snap_mobile}" class="info-link">${j.snap_mobile}</a>
        ${j.snap_mobile2 ? `<a href="tel:${j.snap_mobile2}" class="info-link ml-8">${j.snap_mobile2}</a>` : ''}
      </div>` : ''}
      ${j.snap_address ? `
      <div class="info-row">
        <i class="fas fa-map-marker-alt info-icon" style="color:${color}"></i>
        <span class="info-val">${esc(j.snap_address)}</span>
      </div>` : ''}
      ${j.note ? `
      <div class="info-row">
        <i class="fas fa-sticky-note info-icon" style="color:${color}"></i>
        <span class="info-val text-muted">${esc(j.note)}</span>
      </div>` : ''}
      <div class="info-row">
        <i class="fas fa-calendar info-icon" style="color:${color}"></i>
        <span class="info-val text-muted">${fmtDate(j.created_at)}</span>
      </div>
    </div>

    <!-- Financial Panel
         Admin: itemized breakdown per machine + Total + Received + Balance
         Staff: ONLY Balance Due — no amounts, no Repair Amount, no Received  -->
    <div class="card mt-3 financial-panel">
      <div class="fin-title"><i class="fas fa-rupee-sign"></i> Financials</div>
      ${isAdmin() ? `
        ${(j.machines||[]).map(m => `
        <div class="fin-machine-row">
          <span class="fin-machine-name">${esc(m.product_name)}${m.quantity>1?` ×${m.quantity}`:''}</span>
          <span class="fin-machine-amt">${fmtRs(m.charges)}</span>
        </div>`).join('')}
        ${(j.machines||[]).length > 1 ? `<div style="border-top:1px dashed #e0e0e0;margin:4px 0"></div>` : ''}
        <div class="fin-row">
          <span class="fin-label fw-bold">= Total Amount</span>
          <span class="fin-amount fw-bold">${fmtRs(total)}</span>
        </div>
        <div class="fin-row">
          <span class="fin-label">Received Amount</span>
          <span class="fin-amount" style="color:#43A047">${fmtRs(received)}</span>
        </div>` : ''}
      <div class="fin-row fin-balance">
        <span class="fin-label fw-bold">Balance Due</span>
        <span class="fin-amount fw-bold" style="color:${balance>0?'#E53935':'#43A047'}">${fmtRs(balance)}</span>
      </div>
      ${isAdmin() && j.status !== 'delivered' ? `
      <div class="fin-edit-row">
        <label class="form-label" style="margin:0">Update Received Amount (₹)</label>
        <div style="display:flex;gap:8px;margin-top:6px">
          <input id="recv-input" type="number" class="form-input" style="flex:1"
                 value="${received}" min="0" placeholder="0" inputmode="decimal">
          <button id="recv-save" class="btn-sm btn-green">Save</button>
        </div>
      </div>` : ''}
    </div>

    ${j.status === 'delivered' && j.delivery_receiver_name ? `
    <!-- Delivery Info Card -->
    <div class="card mt-3 delivery-card">
      <div class="delivery-title"><i class="fas fa-box-open"></i> Delivery Information</div>
      <div class="info-row" style="border:none;padding:3px 0">
        <i class="fas fa-user-check info-icon" style="color:#1E88E5"></i>
        <span class="info-val">${esc(j.delivery_receiver_name)}</span>
      </div>
      ${j.delivery_receiver_mobile ? `
      <div class="info-row" style="border:none;padding:3px 0">
        <i class="fas fa-phone info-icon" style="color:#1E88E5"></i>
        <span class="info-val">${j.delivery_receiver_mobile}</span>
      </div>` : ''}
      ${j.delivery_method ? `
      <div class="info-row" style="border:none;padding:3px 0">
        <i class="fas fa-truck info-icon" style="color:#1E88E5"></i>
        <span class="info-val">${j.delivery_method === 'courier' ? 'Courier' : 'In Person'}
          ${j.delivery_courier_name ? ' — ' + esc(j.delivery_courier_name) : ''}
          ${j.delivery_tracking ? ' · #' + esc(j.delivery_tracking) : ''}
        </span>
      </div>` : ''}
      ${j.delivered_at ? `
      <div class="info-row" style="border:none;padding:3px 0">
        <i class="fas fa-calendar-check info-icon" style="color:#1E88E5"></i>
        <span class="info-val">${fmtDate(j.delivered_at)}</span>
      </div>` : ''}
    </div>` : ''}

    <!-- Action Buttons — RBAC: admin-only download/share/deliver/delete -->
    <div class="action-row mt-3">
      ${isAdmin() && j.status !== 'delivered' ? `
      <button id="btn-deliver" class="action-btn" style="background:#1E88E5">
        <i class="fas fa-check-double"></i><span>Deliver</span>
      </button>` : ''}
      ${isAdmin() ? `
      <button id="btn-jobcard" class="action-btn" style="background:#43A047">
        <i class="fas fa-file-image"></i><span>Download</span>
      </button>
      <button id="btn-share" class="action-btn" style="background:#25D366">
        <i class="fab fa-whatsapp"></i><span>${j.status==='delivered'?'Share':'Share'}</span>
      </button>
      <button id="btn-del-job" class="action-btn" style="background:#E53935">
        <i class="fas fa-trash"></i><span>Delete</span>
      </button>` : ''}
    </div>

    <!-- Machines List -->
    <div class="card mt-3">
      <div class="section-header">
        <h3 class="section-title" style="margin:0">
          <i class="fas fa-tools" style="color:#E53935"></i> Machines
        </h3>
        <button id="btn-add-machine" class="btn-sm btn-red">+ Add</button>
      </div>
      <div id="machines-container">
        ${(j.machines||[]).length
          ? (j.machines||[]).map(m => machineCardHTML(m, userId)).join('')
          : '<p class="text-muted text-center" style="padding:20px">No machines yet — tap + Add</p>'}
      </div>
    </div>

    <!-- Hidden 9:16 print element for html2canvas -->
    <div id="job-card-print"
         style="position:fixed;left:-99999px;top:0;width:1080px;height:1920px;
                background:#fff;overflow:hidden;pointer-events:none;z-index:-1">
      ${jobCardPrintHTML(j)}
    </div>`;

  bindDetail(j);
}

// ─────────────────────────────────────────────────────────────────────────────
// MACHINE CARD
// Staff: sees product name, complaint, status; can change status ONLY if assigned
// Status dropdown disabled for staff not assigned to this machine → shows Request button
// ─────────────────────────────────────────────────────────────────────────────
function machineCardHTML(m, currentUserId) {
  const color = sc(m.status);
  const isAssigned = isAdmin() || (m.assigned_staff_id === currentUserId);
  const staffNotAssigned = !isAdmin() && m.assigned_staff_id !== currentUserId;

  return `
  <div class="machine-card" style="border-left-color:${color};will-change:transform,opacity">
    <div class="machine-top">
      <div style="flex:1;min-width:0">
        <div class="machine-name">${esc(m.product_name)}${m.quantity>1?` <span class="machine-qty">×${m.quantity}</span>`:''}</div>
        ${m.product_complaint ? `<div class="machine-complaint">${esc(m.product_complaint)}</div>` : ''}
        ${m.staff_name ? `<div class="machine-staff"><i class="fas fa-user-cog"></i> ${esc(m.staff_name)}</div>` : ''}
      </div>
      <div class="machine-right">
        ${isAdmin() ? `<div class="machine-charges">${fmtRs(m.charges)}</div>` : ''}
        ${isAssigned ? `
        <select data-mid="${m.id}" class="status-sel" style="border-color:${color};color:${color}">
          <option value="under_repair" ${m.status==='under_repair'?'selected':''}>Under Repair</option>
          <option value="repaired"     ${m.status==='repaired'    ?'selected':''}>Repaired</option>
          <option value="returned"     ${m.status==='returned'    ?'selected':''}>Returned</option>
        </select>` : `
        <span class="status-chip" style="background:${sb(m.status)};color:${color};border:1px solid ${color}">${sl(m.status)}</span>`}
      </div>
    </div>

    <!-- Images row with embedded camera upload -->
    <div class="images-row">
      ${(m.images||[]).map(img => `
      <div class="img-wrap">
        <img src="${img.url}" class="img-thumb" loading="lazy"
             onerror="this.parentElement.style.display='none'">
        ${isAdmin() ? `<button class="img-del-btn" data-iid="${img.id}" title="Remove">×</button>` : ''}
      </div>`).join('')}
      <!-- Camera button — part of machine details, available to all -->
      <label class="img-add-btn" title="Take / pick photo">
        <i class="fas fa-camera"></i>
        <input type="file" accept="image/*" capture="environment"
               data-mid="${m.id}" class="img-file-input" style="display:none">
      </label>
    </div>

    <!-- Audio Note Section (admin & staff — not public) -->
    <div class="audio-row">
      ${m.audio_note_url ? `
      <audio controls src="${m.audio_note_url}" class="audio-player" preload="none"></audio>
      ${isAdmin() ? `<button data-mid="${m.id}" class="btn-sm btn-red btn-del-audio" style="margin-left:6px" title="Delete audio"><i class="fas fa-trash"></i></button>` : ''}
      ` : `
      <button data-mid="${m.id}" class="btn-sm btn-orange btn-rec-audio">
        <i class="fas fa-microphone"></i> Voice Note
      </button>`}
    </div>

    ${isAdmin() ? `
    <div class="machine-actions">
      <button data-mid="${m.id}" class="btn-sm btn-orange btn-edit-m">
        <i class="fas fa-edit"></i> Edit
      </button>
      <button data-mid="${m.id}" class="btn-sm btn-red btn-del-m">
        <i class="fas fa-trash"></i>
      </button>
    </div>` : staffNotAssigned ? `
    <div class="machine-actions">
      <button data-mid="${m.id}" data-jid="${S.job?.id||''}" class="btn-sm btn-blue btn-request-assign">
        <i class="fas fa-hand-paper"></i> Request Assignment
      </button>
    </div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BIND DETAIL
// ─────────────────────────────────────────────────────────────────────────────
function bindDetail(j) {
  // Status selects — only for assigned staff / admin
  document.querySelectorAll('.status-sel').forEach(sel => {
    sel.addEventListener('change', async e => {
      try {
        await API.put(`/api/machines/${e.target.dataset.mid}`, { status: e.target.value });
        toast('Status updated', 'success');
        await loadDetail();
      } catch (err) {
        toast(err.response?.data?.error || 'Update failed', 'error');
        e.target.value = e.target.dataset.prev || 'under_repair';
      }
    });
    sel.dataset.prev = sel.value;
  });

  // Image upload with canvas compression (1080px)
  document.querySelectorAll('.img-file-input').forEach(input => {
    input.addEventListener('change', async e => {
      const raw = e.target.files[0];
      if (!raw) return;
      const mid = e.target.dataset.mid;
      try {
        toast('Compressing…', 'info');
        const compressed = await compressImage(raw, 1080, 0.82);
        const fd = new FormData();
        fd.append('image', compressed);
        toast('Uploading…', 'info');
        await API.post(`/api/machines/${mid}/images`, fd, {
          headers: { 'Content-Type': 'multipart/form-data' }
        });
        toast('Image saved', 'success');
        await loadDetail();
      } catch (_) { toast('Upload failed', 'error'); }
    });
  });

  // Delete image (admin only)
  document.querySelectorAll('.img-del-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('Remove this image?')) return;
      try {
        await API.delete(`/api/images/${btn.dataset.iid}`);
        toast('Removed', 'success'); await loadDetail();
      } catch (_) { toast('Failed', 'error'); }
    });
  });

  // Audio recorder — start recording for a machine
  document.querySelectorAll('.btn-rec-audio').forEach(btn => {
    btn.addEventListener('click', () => showAudioRecorderModal(btn.dataset.mid));
  });

  // Delete audio (admin only)
  document.querySelectorAll('.btn-del-audio').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this voice note?')) return;
      try {
        await API.delete(`/api/machines/${btn.dataset.mid}/audio`);
        toast('Voice note deleted', 'success'); await loadDetail();
      } catch (_) { toast('Failed', 'error'); }
    });
  });

  // Request assignment (staff not assigned)
  document.querySelectorAll('.btn-request-assign').forEach(btn => {
    btn.addEventListener('click', () => showRequestAssignModal(btn.dataset.mid, j.id));
  });

  // Add machine
  document.getElementById('btn-add-machine')?.addEventListener('click', () => showAddMachineModal(j.id));

  // Edit machine (admin only)
  document.querySelectorAll('.btn-edit-m').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = j.machines.find(x => x.id == btn.dataset.mid);
      if (m) showEditMachineModal(m);
    });
  });

  // Delete machine (admin only)
  document.querySelectorAll('.btn-del-m').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this machine and its images/audio?')) return;
      try {
        await API.delete(`/api/machines/${btn.dataset.mid}`);
        toast('Machine deleted', 'success'); await loadDetail();
      } catch (_) { toast('Failed', 'error'); }
    });
  });

  // Delete job (admin only)
  document.getElementById('btn-del-job')?.addEventListener('click', async () => {
    if (!confirm(`Delete job ${j.id}? This cannot be undone.`)) return;
    try {
      await API.delete(`/api/jobs/${j.id}`);
      toast(`Job ${j.id} deleted`, 'success'); navigate('dashboard');
    } catch (_) { toast('Delete failed', 'error'); }
  });

  // Update received amount (admin only)
  document.getElementById('recv-save')?.addEventListener('click', async () => {
    const val = parseFloat(document.getElementById('recv-input')?.value) || 0;
    try {
      await API.put(`/api/jobs/${j.id}`, { received_amount: val });
      toast('Saved', 'success'); await loadDetail();
    } catch (_) { toast('Save failed', 'error'); }
  });

  // Mark delivered (admin only)
  document.getElementById('btn-deliver')?.addEventListener('click', () => showDeliveryModal(j));

  // Job card download (admin only)
  document.getElementById('btn-jobcard')?.addEventListener('click', () => generateAndShareJobCard(j, false));

  // WhatsApp share (admin only)
  document.getElementById('btn-share')?.addEventListener('click', () => generateAndShareJobCard(j, true));
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO RECORDER MODAL
// ─────────────────────────────────────────────────────────────────────────────
function showAudioRecorderModal(machineId) {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-microphone" style="color:#E53935"></i> Voice Note</h3>
    <div id="audio-status" style="text-align:center;padding:16px 0;font-size:15px;color:#666">
      Tap Record to start
    </div>
    <div id="audio-viz" style="height:48px;background:#f5f5f5;border-radius:12px;margin:8px 0;
         display:flex;align-items:center;justify-content:center;gap:3px;overflow:hidden">
      <span style="color:#bbb;font-size:13px">Audio waveform</span>
    </div>
    <div id="audio-preview" style="display:none;margin:8px 0">
      <audio id="audio-playback" controls style="width:100%;border-radius:8px"></audio>
    </div>
    <div class="modal-footer" style="flex-direction:column;gap:8px">
      <div style="display:flex;gap:8px;width:100%">
        <button id="rec-start" class="btn-primary" style="flex:1;background:#E53935">
          <i class="fas fa-circle"></i> Record
        </button>
        <button id="rec-stop" class="btn-primary" style="flex:1;background:#333;display:none">
          <i class="fas fa-stop"></i> Stop
        </button>
      </div>
      <div style="display:flex;gap:8px;width:100%">
        <button onclick="closeModal()" class="btn-ghost" style="flex:1">Cancel</button>
        <button id="rec-save" class="btn-primary" style="flex:1;display:none">
          <i class="fas fa-upload"></i> Upload
        </button>
      </div>
    </div>`);

  let audioBlob = null;
  let audioMime = 'audio/webm';
  let recInterval = null;
  let recSeconds = 0;

  const statusEl = document.getElementById('audio-status');
  const vizEl    = document.getElementById('audio-viz');

  document.getElementById('rec-start')?.addEventListener('click', async () => {
    recSeconds = 0;
    const ok = await startAudioRecorder((blob, mime) => {
      audioBlob = blob; audioMime = mime;
      const url = URL.createObjectURL(blob);
      const aud = document.getElementById('audio-playback');
      if (aud) { aud.src = url; }
      document.getElementById('audio-preview').style.display = 'block';
      document.getElementById('rec-save').style.display = '';
      statusEl.textContent = 'Recording saved — preview and upload';
      statusEl.style.color = '#43A047';
    });
    if (!ok) return;

    document.getElementById('rec-start').style.display = 'none';
    document.getElementById('rec-stop').style.display = '';
    statusEl.style.color = '#E53935';

    recInterval = setInterval(() => {
      recSeconds++;
      statusEl.textContent = `🔴 Recording… ${recSeconds}s`;
      // Animate visualizer bars
      const bars = Array.from({ length: 20 }, () =>
        `<div style="width:5px;height:${8+Math.random()*32}px;background:#E53935;border-radius:3px;
             transition:height 0.1s;will-change:height"></div>`).join('');
      vizEl.innerHTML = bars;
    }, 1000);
  });

  document.getElementById('rec-stop')?.addEventListener('click', () => {
    stopAudioRecorder();
    clearInterval(recInterval);
    document.getElementById('rec-stop').style.display = 'none';
    document.getElementById('rec-start').style.display = '';
    vizEl.innerHTML = '<span style="color:#bbb;font-size:13px">Stopped</span>';
  });

  document.getElementById('rec-save')?.addEventListener('click', async () => {
    if (!audioBlob) { toast('No recording to upload', 'error'); return; }
    const btn = document.getElementById('rec-save');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading…';
    try {
      const ext  = audioMime.includes('ogg') ? '.ogg' : '.webm';
      const file = new File([audioBlob], `voice_note${ext}`, { type: audioMime });
      const fd   = new FormData();
      fd.append('audio', file);
      await API.post(`/api/machines/${machineId}/audio`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      closeModal();
      toast('Voice note saved', 'success');
      await loadDetail();
    } catch (_) { toast('Upload failed', 'error'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-upload"></i> Upload'; }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST ASSIGNMENT MODAL (staff)
// ─────────────────────────────────────────────────────────────────────────────
function showRequestAssignModal(machineId, jobId) {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-hand-paper" style="color:#1E88E5"></i> Request Assignment</h3>
    <p style="color:#555;font-size:14px;margin-bottom:12px">
      Send an urgent request to the admin to be assigned to this machine.
    </p>
    <div class="form-group">
      <label class="form-label">Note (optional)</label>
      <textarea id="req-note" class="form-input" rows="3"
                placeholder="Why do you want this assignment?"></textarea>
    </div>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="req-send" class="btn-primary" style="background:#1E88E5">
        <i class="fas fa-paper-plane"></i> Send Request
      </button>
    </div>`);

  document.getElementById('req-send')?.addEventListener('click', async () => {
    const note = document.getElementById('req-note')?.value.trim();
    const btn  = document.getElementById('req-send');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…';
    try {
      await API.post('/api/requests', { machine_id: parseInt(machineId), note: note || null });
      closeModal();
      toast('Request sent to admin ✅', 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to send request', 'error');
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Request';
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MODALS — Add / Edit Machine, Delivery
// ─────────────────────────────────────────────────────────────────────────────
function showAddMachineModal(jobId) {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-plus" style="color:#E53935"></i> Add Machine</h3>
    <div class="form-group">
      <label class="form-label">Product Name <span class="req">*</span></label>
      <input id="am-prod" type="text" class="form-input" placeholder="e.g. LG AC 1.5T">
    </div>
    <div class="form-group">
      <label class="form-label">Complaint / Issue <span class="req">*</span></label>
      <textarea id="am-comp" class="form-input" rows="2" placeholder="Issue description…"></textarea>
    </div>
    <div class="form-row-2">
      ${isAdmin() ? `
      <div class="form-group">
        <label class="form-label">Repair Amount (₹)</label>
        <input id="am-chg" type="number" class="form-input" min="0" placeholder="0" inputmode="decimal">
      </div>` : ''}
      <div class="form-group">
        <label class="form-label">Qty</label>
        <input id="am-qty" type="number" class="form-input" min="1" value="1" inputmode="numeric">
      </div>
    </div>
    ${isAdmin() ? `
    <div class="form-group">
      <label class="form-label">Assign Staff</label>
      <select id="am-staff" class="form-input">
        <option value="">— None —</option>
        ${S.staff.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
      </select>
    </div>` : ''}
    <!-- Image capture — upfront, part of machine form -->
    <div class="form-group">
      <label class="form-label"><i class="fas fa-camera" style="color:#888"></i> Product Photo</label>
      <label class="img-upload-label">
        <i class="fas fa-camera"></i> Take / Pick Photo
        <input id="am-img" type="file" accept="image/*" capture="environment" style="display:none">
      </label>
      <div id="am-img-preview" style="display:none;margin-top:6px">
        <img id="am-img-thumb" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:2px solid #e0e0e0">
      </div>
    </div>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="am-save" class="btn-primary">Save Machine</button>
    </div>`);

  document.getElementById('am-img')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      document.getElementById('am-img-thumb').src = ev.target.result;
      document.getElementById('am-img-preview').style.display = 'block';
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('am-save')?.addEventListener('click', async () => {
    const prod = document.getElementById('am-prod')?.value.trim();
    if (!prod) { toast('Product name required', 'error'); return; }
    const btn = document.getElementById('am-save');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    try {
      const machR = await API.post(`/api/jobs/${jobId}/machines`, {
        product_name:      prod,
        product_complaint: document.getElementById('am-comp')?.value.trim() || null,
        charges:           isAdmin() ? (parseFloat(document.getElementById('am-chg')?.value) || 0) : 0,
        quantity:          parseInt(document.getElementById('am-qty')?.value) || 1,
        assigned_staff_id: isAdmin() ? (document.getElementById('am-staff')?.value || null) : null,
      });

      // Upload image if selected
      const imgFile = document.getElementById('am-img')?.files[0];
      if (imgFile && machR.data.id) {
        try {
          const compressed = await compressImage(imgFile, 1080, 0.82);
          const fd = new FormData();
          fd.append('image', compressed);
          await API.post(`/api/machines/${machR.data.id}/images`, fd, {
            headers: { 'Content-Type': 'multipart/form-data' }
          });
        } catch (_) {}
      }

      closeModal(); toast('Machine added', 'success'); await loadDetail();
    } catch (_) {
      toast('Failed to add machine', 'error');
      btn.disabled = false; btn.innerHTML = 'Save Machine';
    }
  });
}

function showEditMachineModal(m) {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-edit" style="color:#FB8C00"></i> Edit Machine</h3>
    <div class="form-group">
      <label class="form-label">Product Name <span class="req">*</span></label>
      <input id="em-prod" type="text" class="form-input" value="${esc(m.product_name)}">
    </div>
    <div class="form-group">
      <label class="form-label">Complaint / Issue</label>
      <textarea id="em-comp" class="form-input" rows="2">${esc(m.product_complaint||'')}</textarea>
    </div>
    <div class="form-row-2">
      ${isAdmin() ? `
      <div class="form-group">
        <label class="form-label">Repair Amount (₹)</label>
        <input id="em-chg" type="number" class="form-input" min="0"
               value="${m.charges||0}" inputmode="decimal">
      </div>` : ''}
      <div class="form-group">
        <label class="form-label">Qty</label>
        <input id="em-qty" type="number" class="form-input" min="1"
               value="${m.quantity||1}" inputmode="numeric">
      </div>
    </div>
    ${isAdmin() ? `
    <div class="form-group">
      <label class="form-label">Assign Staff</label>
      <select id="em-staff" class="form-input">
        <option value="">— None —</option>
        ${S.staff.map(s => `<option value="${s.id}" ${m.assigned_staff_id==s.id?'selected':''}>${esc(s.name)}</option>`).join('')}
      </select>
    </div>` : ''}
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="em-save" class="btn-primary">Update</button>
    </div>`);

  document.getElementById('em-save')?.addEventListener('click', async () => {
    const prod = document.getElementById('em-prod')?.value.trim();
    if (!prod) { toast('Product name required', 'error'); return; }
    try {
      await API.put(`/api/machines/${m.id}`, {
        product_name:      prod,
        product_complaint: document.getElementById('em-comp')?.value.trim() || null,
        ...(isAdmin() ? { charges: parseFloat(document.getElementById('em-chg')?.value) || 0 } : {}),
        quantity:          parseInt(document.getElementById('em-qty')?.value) || 1,
        ...(isAdmin() ? { assigned_staff_id: document.getElementById('em-staff')?.value || null } : {}),
      });
      closeModal(); toast('Machine updated', 'success'); await loadDetail();
    } catch (_) { toast('Update failed', 'error'); }
  });
}

function showDeliveryModal(j) {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-check-double" style="color:#1E88E5"></i> Mark as Delivered</h3>
    <div class="form-group">
      <label class="form-label">Receiver Name <span class="req">*</span></label>
      <input id="dm-rname" type="text" class="form-input" placeholder="Person who collected the device">
    </div>
    <div class="form-group">
      <label class="form-label">Receiver Mobile</label>
      <input id="dm-rmob" type="tel" class="form-input" placeholder="Mobile of receiver" inputmode="numeric">
    </div>
    <div class="form-group">
      <label class="form-label">Delivery Method</label>
      <select id="dm-method" class="form-input">
        <option value="in_person">In Person</option>
        <option value="courier">Courier</option>
      </select>
    </div>
    <div id="courier-extra" style="display:none">
      <div class="form-group">
        <label class="form-label">Courier Name</label>
        <input id="dm-courier" type="text" class="form-input" placeholder="e.g. DTDC, BlueDart">
      </div>
      <div class="form-group">
        <label class="form-label">Tracking ID</label>
        <input id="dm-track" type="text" class="form-input" placeholder="Tracking number">
      </div>
      <div class="form-group">
        <label class="form-label">Delivery Address</label>
        <textarea id="dm-addr" class="form-input" rows="2"></textarea>
      </div>
    </div>
    ${isAdmin() ? `
    <div class="form-group">
      <label class="form-label">Final Received Amount (₹)</label>
      <input id="dm-recv" type="number" class="form-input" value="${j.received_amount||0}"
             min="0" inputmode="decimal">
    </div>` : ''}
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="dm-confirm" class="btn-primary" style="background:#1E88E5">
        <i class="fas fa-check"></i> Confirm Delivery
      </button>
    </div>`);

  document.getElementById('dm-method')?.addEventListener('change', e => {
    document.getElementById('courier-extra').style.display =
      e.target.value === 'courier' ? 'block' : 'none';
  });

  document.getElementById('dm-confirm')?.addEventListener('click', async () => {
    const rname = document.getElementById('dm-rname')?.value.trim();
    if (!rname) { toast('Receiver name required', 'error'); return; }
    try {
      await API.put(`/api/jobs/${j.id}`, {
        status:                   'delivered',
        delivery_receiver_name:   rname,
        delivery_receiver_mobile: document.getElementById('dm-rmob')?.value.trim() || null,
        delivery_method:          document.getElementById('dm-method')?.value || 'in_person',
        delivery_courier_name:    document.getElementById('dm-courier')?.value || null,
        delivery_tracking:        document.getElementById('dm-track')?.value   || null,
        delivery_address:         document.getElementById('dm-addr')?.value    || null,
        ...(isAdmin() ? { received_amount: parseFloat(document.getElementById('dm-recv')?.value) || 0 } : {}),
      });
      closeModal(); toast('Job marked as delivered ✅', 'success'); await loadDetail();
    } catch (_) { toast('Failed to update', 'error'); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB CARD PRINT HTML  (1080×1920 — 9:16 HD)
// Smart JPG: itemized prices admin-only, hide 25d notice if Delivered
// html2canvas with allowTaint:true + useCORS:true for R2 images
// ─────────────────────────────────────────────────────────────────────────────
function jobCardPrintHTML(j) {
  const total    = j.total_charges   || 0;
  const received = j.received_amount || 0;
  const balance  = Math.max(0, total - received);
  const color    = sc(j.status);
  const isDelivered = j.status === 'delivered';

  const deliveryBlock = isDelivered ? `
    <div style="margin:0 50px 30px;background:#E3F2FD;border:3px solid #1E88E5;border-radius:16px;padding:28px;flex-shrink:0">
      <div style="font-size:24px;font-weight:800;color:#1565C0;margin-bottom:14px">📦 Delivery Information</div>
      <table style="width:100%;border-collapse:collapse;font-size:20px">
        ${j.delivery_receiver_name   ? `<tr><td style="color:#555;padding:6px 0;width:200px">Received By</td><td style="font-weight:700;color:#1a1a2e">${esc(j.delivery_receiver_name)}</td></tr>` : ''}
        ${j.delivery_receiver_mobile ? `<tr><td style="color:#555;padding:6px 0">Mobile</td><td style="font-weight:700;color:#1565C0">${j.delivery_receiver_mobile}</td></tr>` : ''}
        ${j.delivery_method          ? `<tr><td style="color:#555;padding:6px 0">Method</td><td style="font-weight:700;color:#1a1a2e">${j.delivery_method==='courier'?'Courier':'In Person'}</td></tr>` : ''}
        ${j.delivery_courier_name    ? `<tr><td style="color:#555;padding:6px 0">Courier</td><td style="font-weight:700;color:#1a1a2e">${esc(j.delivery_courier_name)}</td></tr>` : ''}
        ${j.delivery_tracking        ? `<tr><td style="color:#555;padding:6px 0">Tracking</td><td style="font-weight:700;color:#1a1a2e">${esc(j.delivery_tracking)}</td></tr>` : ''}
        ${j.delivered_at             ? `<tr><td style="color:#555;padding:6px 0">Date</td><td style="font-weight:700;color:#1a1a2e">${fmtDate(j.delivered_at)}</td></tr>` : ''}
      </table>
    </div>` : `
    <div style="margin:0 50px 30px;background:#fff8e1;border:3px solid #FFC107;border-radius:16px;padding:28px;flex-shrink:0">
      <div style="font-size:24px;font-weight:800;color:#e65100;margin-bottom:10px">⚠️ Collection Notice</div>
      <div style="font-size:20px;color:#5D4037;line-height:1.65">
        Kindly collect your machine(s) within <strong>25 days</strong> from the date of this notice.
        After this period, we shall <strong>not be held liable</strong> for any claims, loss, or damage to uncollected items.
      </div>
    </div>`;

  return `
  <div style="width:1080px;height:1920px;background:#fff;font-family:'Segoe UI',Arial,sans-serif;display:flex;flex-direction:column;overflow:hidden">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1a1a2e 0%,#0f3460 100%);padding:48px 60px 40px;text-align:center;flex-shrink:0">
      <div style="width:100px;height:100px;background:linear-gradient(135deg,#E53935,#B71C1C);border-radius:24px;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;font-size:60px">⚡</div>
      <div style="color:#fff;font-size:38px;font-weight:900;letter-spacing:3px">ADITION ELECTRIC</div>
      <div style="color:rgba(255,255,255,.65);font-size:20px;margin-top:6px;letter-spacing:1px">SERVICE MANAGEMENT SYSTEM</div>
    </div>

    <!-- Job ID Banner -->
    <div style="background:${color};padding:22px 60px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
      <div style="color:#fff;font-size:52px;font-weight:900;letter-spacing:4px">${j.id}</div>
      <div style="color:#fff;font-size:24px;font-weight:700;background:rgba(0,0,0,.2);padding:8px 20px;border-radius:10px">${sl(j.status)}</div>
    </div>

    <!-- Customer Info -->
    <div style="padding:36px 60px 20px;flex-shrink:0">
      <div style="font-size:18px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:2px;margin-bottom:16px">Customer Details</div>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="font-size:20px;color:#555;padding:8px 0;width:180px">Name</td>
            <td style="font-size:26px;font-weight:800;color:#1a1a2e">${esc(j.snap_name)}</td></tr>
        <tr><td style="font-size:20px;color:#555;padding:8px 0">Mobile</td>
            <td style="font-size:24px;font-weight:700;color:#1565C0">${j.snap_mobile}${j.snap_mobile2?' / '+j.snap_mobile2:''}</td></tr>
        ${j.snap_address ? `<tr><td style="font-size:20px;color:#555;padding:8px 0">Address</td>
            <td style="font-size:20px;color:#333">${esc(j.snap_address)}</td></tr>` : ''}
        <tr><td style="font-size:20px;color:#555;padding:8px 0">Date</td>
            <td style="font-size:20px;color:#555">${fmtDate(j.created_at)}</td></tr>
      </table>
    </div>

    <div style="border-top:2px solid #f0f0f0;margin:0 60px;flex-shrink:0"></div>

    <!-- Machines List (with images via useCORS) -->
    <div style="padding:24px 60px;flex:1;overflow:hidden">
      <div style="font-size:18px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:2px;margin-bottom:16px">Products Registered</div>
      ${(j.machines||[]).map((m,i) => `
      <div style="background:#f8f9fa;border-radius:14px;padding:22px 26px;margin-bottom:14px;border-left:6px solid ${sc(m.status)}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <div style="font-size:26px;font-weight:800;color:#1a1a2e">${i+1}. ${esc(m.product_name)}${m.quantity>1?` ×${m.quantity}`:''}</div>
            ${m.product_complaint ? `<div style="font-size:19px;color:#666;margin-top:4px">${esc(m.product_complaint)}</div>` : ''}
          </div>
          <div style="text-align:right;flex-shrink:0;margin-left:16px">
            <div style="background:${sc(m.status)};color:#fff;border-radius:8px;padding:6px 16px;font-size:17px;font-weight:700;white-space:nowrap">${sl(m.status)}</div>
            <div style="font-size:22px;font-weight:800;color:#E53935;margin-top:6px">${fmtRs(m.charges)}</div>
          </div>
        </div>
        ${(m.images||[]).length ? `
        <div style="display:flex;gap:10px;margin-top:14px;overflow:hidden">
          ${(m.images||[]).slice(0,3).map(img => `<img src="${img.url}" crossorigin="anonymous" style="width:110px;height:110px;border-radius:10px;object-fit:cover" onerror="this.style.display='none'">`).join('')}
        </div>` : ''}
      </div>`).join('')}
    </div>

    <!-- Itemized Financial Summary (admin JPG — always included) -->
    <div style="margin:0 60px 20px;background:#f8f9fa;border-radius:14px;padding:22px 26px;flex-shrink:0">
      <div style="font-size:18px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px">Financial Summary</div>
      ${(j.machines||[]).map(m => `
      <div style="display:flex;justify-content:space-between;font-size:19px;padding:4px 0;color:#666">
        <span>${esc(m.product_name)}${m.quantity>1?` ×${m.quantity}`:''}</span>
        <span style="font-weight:600;color:#1a1a2e">${fmtRs(m.charges)}</span>
      </div>`).join('')}
      ${(j.machines||[]).length > 1 ? `<div style="border-top:1px solid #e0e0e0;margin:8px 0"></div>` : ''}
      <div style="display:flex;justify-content:space-between;font-size:22px;padding:6px 0;border-bottom:1px solid #e0e0e0">
        <span style="color:#555">= Total Amount</span><span style="font-weight:800;color:#1a1a2e">${fmtRs(total)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:22px;padding:6px 0;border-bottom:1px solid #e0e0e0">
        <span style="color:#555">Received</span><span style="font-weight:800;color:#43A047">${fmtRs(received)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:26px;padding:8px 0">
        <span style="font-weight:700;color:#1a1a2e">Balance Due</span>
        <span style="font-weight:900;color:${balance>0?'#E53935':'#43A047'}">${fmtRs(balance)}</span>
      </div>
    </div>

    ${j.note ? `<div style="margin:0 60px 16px;background:#fffde7;border-radius:10px;padding:18px 22px;font-size:19px;color:#795548;flex-shrink:0"><b>Note:</b> ${esc(j.note)}</div>` : ''}

    <!-- Conditional: hide 25d notice if Delivered; show delivery info instead -->
    ${deliveryBlock}

    <!-- Footer -->
    <div style="background:linear-gradient(135deg,#1a1a2e,#0f3460);padding:32px 60px;flex-shrink:0;margin-top:auto">
      <div style="color:#fff;font-size:22px;font-weight:700">✨ adition™ since 1984</div>
      <div style="color:rgba(255,255,255,.65);font-size:17px;margin-top:6px">Opp. Metropolitan Court Gate 2, Gheekanta, Ahmedabad 380001</div>
      <div style="color:rgba(255,255,255,.4);font-size:15px;margin-top:4px">Subjected to Ahmedabad Jurisdiction only</div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE + SHARE JOB CARD  (html2canvas scale:2 → allowTaint+useCORS)
// ─────────────────────────────────────────────────────────────────────────────
async function generateAndShareJobCard(j, shareMode) {
  toast('Generating job card…', 'info');
  try {
    const el = document.getElementById('job-card-print');
    if (!el) { toast('Card element missing', 'error'); return; }

    // Ensure all images have crossOrigin set
    el.querySelectorAll('img').forEach(img => { img.crossOrigin = 'anonymous'; });

    const canvas = await html2canvas(el, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      width: 1080,
      height: 1920,
      backgroundColor: '#ffffff',
      logging: false,
      imageTimeout: 15000,
    });
    canvas.toBlob(async blob => {
      const file = new File([blob], `AES_${j.id}.jpg`, { type: 'image/jpeg' });
      const text = shareText(j);
      if (shareMode && navigator.share && navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: `Job ${j.id}`, text }); return; }
        catch (_) { /* fall through */ }
      }
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href = url; a.download = `AES_${j.id}.jpg`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      if (shareMode) {
        try { await navigator.clipboard.writeText(text); toast('Card saved & text copied!', 'success'); }
        catch (_) { toast('Card downloaded', 'success'); }
      } else {
        toast('Job card downloaded', 'success');
      }
    }, 'image/jpeg', 0.92);
  } catch (e) {
    console.error(e);
    toast('Failed to generate card', 'error');
  }
}

function shareText(j) {
  const balance = Math.max(0, (j.total_charges||0) - (j.received_amount||0));
  if (j.status === 'delivered') {
    const method   = j.delivery_method === 'courier' ? 'via Courier' : 'in person';
    const receiver = j.delivery_receiver_name ? `\nReceived by: *${j.delivery_receiver_name}*` : '';
    const tracking  = j.delivery_tracking ? `\nTracking: *${j.delivery_tracking}*` : '';
    return `🌟 *Successful Delivery!*\n\n✅ Your product(s) under *Job No. ${j.id}* have been successfully delivered ${method}.${receiver}${tracking}\n\n💰 Total: ${fmtRs(j.total_charges||0)} | Received: ${fmtRs(j.received_amount||0)} | Balance: *${fmtRs(balance)}*\n\n🙏 Thank you for your business!\n\n— *ADITION ELECTRIC SOLUTION*\n✨ _adition™ since 1984_ 📍 Gheekanta, Ahmedabad`;
  }
  return `🌟 *Dear Customer,*\n\n✅ Your product(s) have been successfully registered under *Job No. ${j.id}*\n\n📦 Kindly collect your machine(s) within *25 days* from the date of this message.\n\n⚠️ *Note:* After 25 days, we shall not be held liable for any claims, loss, or damage.\n\n🙏 Thank you for choosing *ADITION ELECTRIC SOLUTION*!\n— *Bilal Pathan* | Operations Manager\n✨ _adition™ since 1984_ 📍 Gheekanta, Ahmedabad`;
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUESTS PANEL (admin only) — approve/deny staff assignment requests
// ─────────────────────────────────────────────────────────────────────────────
function requestsHTML() {
  return `
  <div class="view-pad">
    <div class="filter-bar">
      <button class="filter-chip chip-active" data-req-filter="pending" style="--chip-color:#E53935">Pending</button>
      <button class="filter-chip" data-req-filter="approved" style="--chip-color:#43A047">Approved</button>
      <button class="filter-chip" data-req-filter="denied" style="--chip-color:#888">Denied</button>
    </div>
    <div id="req-list">
      <div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div>
    </div>
  </div>`;
}

async function loadRequests(status = 'pending') {
  try {
    const r = await API.get('/api/requests', { params: { status } });
    S.requests = r.data;
    renderRequestsList();
  } catch (_) {
    const el = document.getElementById('req-list');
    if (el) el.innerHTML = `<div class="empty-state"><p>Failed to load requests</p></div>`;
  }

  // Filter buttons
  document.querySelectorAll('[data-req-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-req-filter]').forEach(b => b.classList.remove('chip-active'));
      btn.classList.add('chip-active');
      loadRequests(btn.dataset.reqFilter);
    }, { passive: true });
  });
}

function renderRequestsList() {
  const el = document.getElementById('req-list');
  if (!el) return;
  if (!S.requests.length) {
    el.innerHTML = `<div class="empty-state"><i class="fas fa-bell-slash fa-3x"></i><p>No requests</p></div>`;
    return;
  }
  el.innerHTML = S.requests.map(r => `
  <div class="request-card" data-rid="${r.id}" style="will-change:transform,opacity">
    <div class="req-header">
      <span class="req-staff">${esc(r.staff_name)}</span>
      <span class="req-status status-${r.status}">${r.status}</span>
    </div>
    <div class="req-machine">
      <i class="fas fa-tools" style="color:#888;margin-right:6px"></i>
      <strong>${esc(r.product_name)}</strong>
      <span style="color:#888;font-size:13px;margin-left:6px">${esc(r.job_id)}</span>
    </div>
    ${r.product_complaint ? `<div class="req-complaint">${esc(r.product_complaint)}</div>` : ''}
    ${r.note ? `<div class="req-note"><i class="fas fa-comment-alt" style="color:#888"></i> ${esc(r.note)}</div>` : ''}
    <div class="req-date">${fmtDate(r.created_at)}</div>
    ${r.status === 'pending' ? `
    <div class="req-actions">
      <button class="btn-sm btn-green btn-approve-req" data-rid="${r.id}">
        <i class="fas fa-check"></i> Approve
      </button>
      <button class="btn-sm btn-red btn-deny-req" data-rid="${r.id}">
        <i class="fas fa-times"></i> Deny
      </button>
      <button class="btn-sm btn-blue btn-view-job" data-jid="${r.job_id}">
        <i class="fas fa-eye"></i> View Job
      </button>
    </div>` : ''}
  </div>`).join('');

  document.querySelectorAll('.btn-approve-req').forEach(btn => {
    btn.addEventListener('click', () => resolveRequest(btn.dataset.rid, 'approve'));
  });
  document.querySelectorAll('.btn-deny-req').forEach(btn => {
    btn.addEventListener('click', () => resolveRequest(btn.dataset.rid, 'deny'));
  });
  document.querySelectorAll('.btn-view-job').forEach(btn => {
    btn.addEventListener('click', () => navigate('detail', { jobId: btn.dataset.jid }));
  });
}

async function resolveRequest(requestId, action) {
  try {
    const r = await API.put(`/api/requests/${requestId}`, { action });
    toast(r.data.status === 'approved' ? '✅ Approved — staff assigned' : 'Request denied', 'success');
    await loadRequests('pending');
  } catch (e) {
    toast(e.response?.data?.error || 'Failed', 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STAFF PANEL (admin only)
// ─────────────────────────────────────────────────────────────────────────────
function staffHTML() {
  return `
  <div class="view-pad">
    <button id="btn-add-staff" class="btn-primary btn-full" style="margin-bottom:14px">
      <i class="fas fa-user-plus"></i> Add Staff Member
    </button>
    <div id="staff-list"><div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div></div>
  </div>`;
}
async function loadStaff() {
  try {
    const r = await API.get('/api/staff');
    S.staff = r.data;
    renderStaffList();
  } catch (_) {
    const el = document.getElementById('staff-list');
    if (el) el.innerHTML = `<div class="empty-state"><p>Failed to load staff</p></div>`;
  }
  document.getElementById('btn-add-staff')?.addEventListener('click', showAddStaffModal);
}
function renderStaffList() {
  const el = document.getElementById('staff-list');
  if (!el) return;
  if (!S.staff.length) { el.innerHTML = `<div class="empty-state"><i class="fas fa-users fa-3x"></i><p>No staff yet</p></div>`; return; }
  el.innerHTML = S.staff.map(s => `
  <div class="staff-card">
    <div>
      <div class="staff-name">${esc(s.name)} <span class="role-badge ${s.role==='admin'?'role-admin':'role-staff'}">${s.role}</span></div>
      <div class="staff-email">${esc(s.email)}</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <span class="${s.active?'badge-active':'badge-inactive'}">${s.active?'Active':'Inactive'}</span>
      <button class="btn-sm btn-orange btn-edit-staff" data-sid="${s.id}"
              data-name="${esc(s.name)}" data-email="${esc(s.email)}"
              data-role="${s.role}" data-active="${s.active}">
        <i class="fas fa-edit"></i>
      </button>
    </div>
  </div>`).join('');
  document.querySelectorAll('.btn-edit-staff').forEach(btn => {
    btn.addEventListener('click', () => showEditStaffModal({
      id: btn.dataset.sid, name: btn.dataset.name,
      email: btn.dataset.email, role: btn.dataset.role,
      active: parseInt(btn.dataset.active)
    }));
  });
}
function showAddStaffModal() {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-user-plus" style="color:#E53935"></i> Add Staff</h3>
    <div class="form-group"><label class="form-label">Name <span class="req">*</span></label>
      <input id="as-name" type="text" class="form-input" placeholder="Full name"></div>
    <div class="form-group"><label class="form-label">Email <span class="req">*</span></label>
      <input id="as-email" type="email" class="form-input" placeholder="staff@example.com"></div>
    <div class="form-group"><label class="form-label">Password <span class="req">*</span></label>
      <input id="as-pass" type="password" class="form-input" placeholder="Temporary password"></div>
    <div class="form-group"><label class="form-label">Role</label>
      <select id="as-role" class="form-input">
        <option value="staff">Staff</option>
        <option value="admin">Admin</option>
      </select>
    </div>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="as-save" class="btn-primary">Add</button>
    </div>`);
  document.getElementById('as-save')?.addEventListener('click', async () => {
    const name  = document.getElementById('as-name')?.value.trim();
    const email = document.getElementById('as-email')?.value.trim();
    const pass  = document.getElementById('as-pass')?.value;
    if (!name || !email || !pass) { toast('All fields required', 'error'); return; }
    try {
      await API.post('/api/staff', { name, email, password: pass, role: document.getElementById('as-role')?.value || 'staff' });
      closeModal(); toast('Staff added', 'success'); await loadStaff();
    } catch (e) { toast(e.response?.data?.error || 'Failed', 'error'); }
  });
}
function showEditStaffModal(s) {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-user-edit" style="color:#FB8C00"></i> Edit Staff</h3>
    <div class="form-group"><label class="form-label">Name</label>
      <input id="es-name" type="text" class="form-input" value="${esc(s.name)}"></div>
    <div class="form-group"><label class="form-label">Email</label>
      <input id="es-email" type="email" class="form-input" value="${esc(s.email)}"></div>
    <div class="form-group"><label class="form-label">New Password (leave blank to keep)</label>
      <input id="es-pass" type="password" class="form-input" placeholder="Leave blank to keep current"></div>
    <div class="form-row-2">
      <div class="form-group"><label class="form-label">Role</label>
        <select id="es-role" class="form-input">
          <option value="staff" ${s.role==='staff'?'selected':''}>Staff</option>
          <option value="admin" ${s.role==='admin'?'selected':''}>Admin</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Status</label>
        <select id="es-active" class="form-input">
          <option value="1" ${s.active?'selected':''}>Active</option>
          <option value="0" ${!s.active?'selected':''}>Inactive</option>
        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="es-save" class="btn-primary">Save Changes</button>
    </div>`);
  document.getElementById('es-save')?.addEventListener('click', async () => {
    const body = {
      name:   document.getElementById('es-name')?.value.trim(),
      email:  document.getElementById('es-email')?.value.trim(),
      role:   document.getElementById('es-role')?.value,
      active: parseInt(document.getElementById('es-active')?.value),
    };
    const p = document.getElementById('es-pass')?.value;
    if (p) body.password = p;
    try {
      await API.put(`/api/staff/${s.id}`, body);
      closeModal(); toast('Updated', 'success'); await loadStaff();
    } catch (_) { toast('Update failed', 'error'); }
  });
}

async function loadStaffForSelects() {
  if (S.staff.length) return;
  try { const r = await API.get('/api/staff'); S.staff = r.data; } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORTS (admin only)
// ─────────────────────────────────────────────────────────────────────────────
function reportsHTML() {
  return `
  <div class="view-pad">
    <div class="report-card">
      <div class="report-title"><i class="fas fa-file-excel" style="color:#43A047"></i> Full Backup</div>
      <div class="report-desc">Export all jobs, machines, images and customers</div>
      <button id="btn-export" class="btn-sm btn-green" style="margin-top:10px">
        <i class="fas fa-download"></i> Download .xlsx
      </button>
    </div>
    <div class="report-card">
      <div class="report-title"><i class="fas fa-upload" style="color:#1E88E5"></i> Restore Backup</div>
      <div class="report-desc">Import from a previously exported .xlsx file</div>
      <label class="btn-sm btn-blue" style="margin-top:10px;cursor:pointer">
        <i class="fas fa-file-import"></i> Choose File
        <input id="import-file" type="file" accept=".xlsx" style="display:none">
      </label>
    </div>
    <div class="report-card">
      <div class="report-title"><i class="fas fa-user-chart" style="color:#FB8C00"></i> Staff Work Report</div>
      <div class="report-desc">Machines handled per staff member</div>
      <div class="form-row-2" style="margin-top:10px">
        <div class="form-group"><label class="form-label">From</label>
          <input id="sr-from" type="date" class="form-input"></div>
        <div class="form-group"><label class="form-label">To</label>
          <input id="sr-to" type="date" class="form-input"></div>
      </div>
      <button id="btn-sr" class="btn-sm btn-orange"><i class="fas fa-download"></i> Export</button>
    </div>
    <div class="report-card">
      <div class="report-title"><i class="fas fa-chart-bar" style="color:#9C27B0"></i> Job Summary</div>
      <div class="report-desc">Revenue, status, balance per job</div>
      <div class="form-row-2" style="margin-top:10px">
        <div class="form-group"><label class="form-label">From</label>
          <input id="jr-from" type="date" class="form-input"></div>
        <div class="form-group"><label class="form-label">To</label>
          <input id="jr-to" type="date" class="form-input"></div>
      </div>
      <button id="btn-jr" class="btn-sm btn-blue" style="background:#9C27B0"><i class="fas fa-download"></i> Export</button>
    </div>
  </div>`;
}
function bindReports() {
  document.getElementById('btn-export')?.addEventListener('click', () => {
    const a = document.createElement('a'); a.href = '/api/backup/export';
    a.download = 'AES_backup.xlsx'; document.body.appendChild(a); a.click(); a.remove();
  });
  document.getElementById('import-file')?.addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    if (!confirm('This will merge/overwrite existing data. Proceed?')) return;
    const fd = new FormData(); fd.append('file', file);
    try {
      toast('Importing…', 'info');
      const r = await API.post('/api/backup/import', fd, { headers: { 'Content-Type': 'multipart/form-data' }});
      toast(`Restored: ${r.data.restored.jobs} jobs`, 'success');
    } catch (_) { toast('Import failed', 'error'); }
  });
  document.getElementById('btn-sr')?.addEventListener('click', () => {
    const from = document.getElementById('sr-from')?.value;
    const to   = document.getElementById('sr-to')?.value;
    const p    = new URLSearchParams(); if (from) p.set('from',from); if (to) p.set('to',to);
    const a    = document.createElement('a'); a.href = '/api/reports/staff?' + p;
    a.download = 'AES_staff_report.xlsx'; document.body.appendChild(a); a.click(); a.remove();
  });
  document.getElementById('btn-jr')?.addEventListener('click', () => {
    const from = document.getElementById('jr-from')?.value;
    const to   = document.getElementById('jr-to')?.value;
    const p    = new URLSearchParams(); if (from) p.set('from',from); if (to) p.set('to',to);
    const a    = document.createElement('a'); a.href = '/api/reports/jobs?' + p;
    a.download = 'AES_job_summary.xlsx'; document.body.appendChild(a); a.click(); a.remove();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
function settingsHTML() {
  return `
  <div class="view-pad">
    <div class="card" style="margin-bottom:12px">
      <div class="section-title"><i class="fas fa-user"></i> Logged In As</div>
      <div style="font-size:16px;font-weight:700">${esc(S.user?.name||'')}</div>
      <div style="font-size:13px;color:#888;margin-top:2px">${esc(S.user?.email||'')} · ${S.user?.role||''}</div>
    </div>
    ${isAdmin() ? `
    <div class="settings-item" id="set-cleanup">
      <div>
        <div class="settings-label"><i class="fas fa-broom settings-icon" style="color:#FB8C00"></i> Cleanup Old Records</div>
        <div class="settings-desc">Delete jobs by date range (non-delivered)</div>
      </div>
      <i class="fas fa-chevron-right" style="color:#ccc"></i>
    </div>
    <div class="settings-item" id="set-reset">
      <div>
        <div class="settings-label"><i class="fas fa-trash-alt settings-icon" style="color:#E53935"></i> Full Reset</div>
        <div class="settings-desc">Delete ALL data and reset counter to C-001</div>
      </div>
      <i class="fas fa-chevron-right" style="color:#ccc"></i>
    </div>` : ''}
    <div class="settings-item" id="set-logout">
      <div>
        <div class="settings-label"><i class="fas fa-sign-out-alt settings-icon" style="color:#E53935"></i> Sign Out</div>
        <div class="settings-desc">Log out of this account</div>
      </div>
      <i class="fas fa-chevron-right" style="color:#ccc"></i>
    </div>
    <div style="text-align:center;margin-top:24px;color:#bbb;font-size:13px">
      ✨ adition™ since 1984 · v9.0<br>
      Gheekanta, Ahmedabad 380001
    </div>
  </div>`;
}
function bindSettings() {
  document.getElementById('set-logout')?.addEventListener('click', logout);
  document.getElementById('set-cleanup')?.addEventListener('click', showCleanupModal);
  document.getElementById('set-reset')?.addEventListener('click', () => {
    if (!confirm('⚠️ FULL RESET: Delete ALL jobs, machines, images and reset counter to C-001?\n\nThis CANNOT be undone!')) return;
    API.delete('/api/cleanup', { data: { full_reset: true } })
      .then(() => { toast('Full reset complete', 'success'); navigate('dashboard'); })
      .catch(() => toast('Reset failed', 'error'));
  });
}
function showCleanupModal() {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-broom" style="color:#FB8C00"></i> Cleanup Records</h3>
    <div class="form-row-2">
      <div class="form-group"><label class="form-label">From</label>
        <input id="cl-from" type="date" class="form-input"></div>
      <div class="form-group"><label class="form-label">To</label>
        <input id="cl-to" type="date" class="form-input"></div>
    </div>
    <p style="font-size:13px;color:#888;margin:8px 0">Deletes non-delivered jobs in the date range.</p>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="cl-confirm" class="btn-primary" style="background:#FB8C00">
        <i class="fas fa-broom"></i> Delete Records
      </button>
    </div>`);
  document.getElementById('cl-confirm')?.addEventListener('click', async () => {
    const from = document.getElementById('cl-from')?.value;
    const to   = document.getElementById('cl-to')?.value;
    if (!from || !to) { toast('Select date range', 'error'); return; }
    if (!confirm(`Delete non-delivered jobs from ${from} to ${to}?`)) return;
    try {
      const r = await API.delete('/api/cleanup', { data: { from, to } });
      closeModal(); toast(`Deleted ${r.data.deleted} jobs`, 'success');
    } catch (_) { toast('Cleanup failed', 'error'); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', render);
} else {
  render();
}

// Register Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

})();
