// ╔══════════════════════════════════════════════════════════════════╗
// ║  ADITION ELECTRIC SOLUTION — PWA Frontend v6                    ║
// ║  Features: Virtual list · Image compression · Financial panel   ║
// ║            Conditional Job Card · Web Share API · RBAC          ║
// ╚══════════════════════════════════════════════════════════════════╝
;(function () {
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
const S = {
  token   : localStorage.getItem('AES_TOKEN') || null,
  user    : (() => { try { return JSON.parse(localStorage.getItem('AES_USER') || 'null') } catch { return null } })(),
  view    : 'login',
  jobId   : null,          // active job detail
  jobs    : [],            // cached list for virtual rendering
  job     : null,          // full job object for detail view
  staff   : [],
  filter  : new URLSearchParams(window.location.search).get('status') || 'under_repair',
  search  : '',
  vOffset : 0,             // virtual list scroll offset
};

const CARD_H = 88;         // px – height of each job row in virtual list

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────
const API = axios.create({ baseURL: '/' });
API.interceptors.request.use(cfg => {
  if (S.token) cfg.headers.Authorization = 'Bearer ' + S.token;
  return cfg;
});
API.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401) { logout(); }
  return Promise.reject(err);
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const isAdmin  = () => S.user?.role === 'admin';
const fmtRs    = n  => '₹' + (parseFloat(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtDate  = d  => d ? new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '';

const STATUS_COLOR = { under_repair:'#E53935', repaired:'#43A047', returned:'#B8860B', delivered:'#1E88E5' };
const STATUS_BG    = { under_repair:'#FFEBEE', repaired:'#E8F5E9', returned:'#FFF8E1', delivered:'#E3F2FD' };
const STATUS_LABEL = { under_repair:'Under Repair', repaired:'Repaired', returned:'Returned', delivered:'Delivered' };

function sc(s) { return STATUS_COLOR[s] || '#888'; }
function sb(s) { return STATUS_BG[s]    || '#f5f5f5'; }
function sl(s) { return STATUS_LABEL[s] || s; }

function toast(msg, type = 'info') {
  document.querySelectorAll('.aes-toast').forEach(t => t.remove());
  const el = Object.assign(document.createElement('div'), { className: 'aes-toast', textContent: msg });
  const bg = type === 'error' ? '#C62828' : type === 'success' ? '#2E7D32' : '#1565C0';
  el.style.cssText = `position:fixed;bottom:84px;left:50%;transform:translateX(-50%);
    background:${bg};color:#fff;padding:11px 22px;border-radius:10px;z-index:9999;
    font-size:14px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.35);
    max-width:88vw;text-align:center;animation:toastIn .25s ease;`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function showModal(html) {
  closeModal();
  const ov = document.createElement('div');
  ov.id = 'aes-modal';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:8000;display:flex;align-items:flex-end;justify-content:center;animation:fadeIn .2s ease;';
  ov.innerHTML = `<div class="modal-sheet">${html}</div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
}
function closeModal() { document.getElementById('aes-modal')?.remove(); }

function setFilter(s) {
  S.filter = s; S.vOffset = 0;
  const u = new URL(window.location);
  s ? u.searchParams.set('status', s) : u.searchParams.delete('status');
  history.replaceState({}, '', u);
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE COMPRESSION  (canvas, before upload)
// ─────────────────────────────────────────────────────────────────────────────
function compressImage(file, maxW = 1280, quality = 0.82) {
  return new Promise((resolve) => {
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
  S.token = null; S.user = null; S.jobs = []; S.job = null;
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
        <input id="l-email" type="email" class="form-input" placeholder="admin@example.com" value="bilalkhan1108@gmail.com" autocomplete="username">
      </div>
      <div class="form-group">
        <label class="form-label">Password</label>
        <input id="l-pass" type="password" class="form-input" placeholder="••••••••" value="0010" autocomplete="current-password">
      </div>
      <button id="l-btn" class="btn-primary btn-full">Sign In</button>
      <p class="login-hint">Admin: bilalkhan1108@gmail.com / 0010</p>
    </div>
    <p class="login-footer">✨ adition™ since 1984 · Ahmedabad</p>
  </div>`;
}
function bindLogin() {
  document.getElementById('l-btn')?.addEventListener('click', () => {
    login(document.getElementById('l-email').value.trim(), document.getElementById('l-pass').value);
  });
  document.getElementById('l-pass')?.addEventListener('keypress', e => {
    if (e.key === 'Enter') document.getElementById('l-btn').click();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HEADER
// ─────────────────────────────────────────────────────────────────────────────
function headerHTML() {
  const titles = { dashboard:'Jobs Dashboard', newjob:'New Job', detail:'Job Details', staff:'Staff Panel', reports:'Reports', settings:'Settings' };
  const backBtn = S.view === 'detail'
    ? `<button class="hdr-back" onclick="navigate('dashboard')"><i class="fas fa-arrow-left"></i></button>` : '';
  return `
  <header class="app-header">
    <div class="hdr-left">
      ${backBtn}
      <div>
        <div class="hdr-title">${titles[S.view] || 'AES'}</div>
        <div class="hdr-sub">ADITION ELECTRIC SOLUTION</div>
      </div>
    </div>
    <div class="hdr-right">
      <span class="role-badge ${isAdmin()?'role-admin':'role-staff'}">${(S.user?.name||'').split(' ')[0]}</span>
      <button class="icon-btn" onclick="logout()" title="Sign out"><i class="fas fa-sign-out-alt"></i></button>
    </div>
  </header>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOTTOM NAV
// ─────────────────────────────────────────────────────────────────────────────
function bottomNavHTML() {
  const tabs = [
    { id:'dashboard', icon:'fa-list-ul',   label:'Jobs' },
    { id:'newjob',    icon:'fa-plus-circle',label:'New Job' },
    ...(isAdmin() ? [{ id:'staff',   icon:'fa-users',    label:'Staff'   }] : []),
    ...(isAdmin() ? [{ id:'reports', icon:'fa-chart-bar', label:'Reports' }] : []),
    { id:'settings', icon:'fa-cog', label:'More' },
  ];
  return `
  <nav class="bottom-nav">
    ${tabs.map(t => `
    <button class="nav-btn ${S.view===t.id?'nav-active':''}" onclick="navigate('${t.id}')">
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
    case 'staff':     return isAdmin() ? staffHTML()   : denied();
    case 'reports':   return isAdmin() ? reportsHTML() : denied();
    case 'settings':  return settingsHTML();
    default:          return dashboardHTML();
  }
}
const denied = () => `<div class="empty-state"><i class="fas fa-lock fa-3x"></i><p>Access Denied</p></div>`;

function bindView() {
  switch (S.view) {
    case 'dashboard': loadJobs(); break;
    case 'newjob':    bindNewJob(); break;
    case 'detail':    loadDetail(); break;
    case 'staff':     loadStaff(); break;
    case 'reports':   if (isAdmin()) loadStaffForSelects(); bindReports(); break;
    case 'settings':  bindSettings(); break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD — virtual-scroll list
// ─────────────────────────────────────────────────────────────────────────────
function dashboardHTML() {
  const filters = [
    { s:'',            label:'All' },
    { s:'under_repair',label:'Under Repair' },
    { s:'repaired',    label:'Repaired' },
    { s:'returned',    label:'Returned' },
    ...(isAdmin() ? [{ s:'delivered', label:'Delivered' }] : []),
  ];
  return `
  <div>
    <div class="filter-bar">
      ${filters.map(f => `
      <button class="filter-chip ${S.filter===f.s?'chip-active':''}"
        style="${f.s ? `--chip-color:${sc(f.s)}` : '--chip-color:#1a1a2e'}"
        onclick="applyFilter('${f.s}')">${f.label}</button>`).join('')}
    </div>
    <div class="search-wrap">
      <i class="fas fa-search search-icon"></i>
      <input id="dash-search" type="search" class="search-input" placeholder="Search by name, mobile, job ID…" value="${S.search}">
    </div>
    <div id="vlist-wrap" class="vlist-wrap"></div>
  </div>`;
}

async function loadJobs() {
  try {
    const params = {};
    if (S.filter) params.status = S.filter;
    if (S.search) params.q = S.search;
    const r = await API.get('/api/jobs', { params });
    S.jobs = r.data;
    renderVList();
    // search binding
    document.getElementById('dash-search')?.addEventListener('input', e => {
      S.search = e.target.value.trim();
      if (S._searchTimer) clearTimeout(S._searchTimer);
      S._searchTimer = setTimeout(() => loadJobs(), 350);
    });
  } catch (e) {
    const w = document.getElementById('vlist-wrap');
    if (w) w.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-circle fa-2x" style="color:#e53935"></i><p>Error loading jobs</p></div>`;
  }
}

function renderVList() {
  const wrap = document.getElementById('vlist-wrap');
  if (!wrap) return;
  if (!S.jobs.length) {
    wrap.innerHTML = `<div class="empty-state"><i class="fas fa-inbox fa-3x"></i><p>No jobs found</p><p class="empty-sub">Tap <b>New Job</b> to create one</p></div>`;
    return;
  }
  const total = S.jobs.length;
  const wrapH = Math.max(window.innerHeight - 180, 300);
  wrap.style.height = wrapH + 'px';
  wrap.style.overflowY = 'auto';
  wrap.style.position = 'relative';

  function paint() {
    const scrollTop = wrap.scrollTop;
    const startIdx  = Math.max(0, Math.floor(scrollTop / CARD_H) - 3);
    const endIdx    = Math.min(total - 1, startIdx + Math.ceil(wrapH / CARD_H) + 6);

    // spacers
    const topH  = startIdx * CARD_H;
    const botH  = Math.max(0, (total - endIdx - 1) * CARD_H);
    const visible = S.jobs.slice(startIdx, endIdx + 1);

    wrap.innerHTML =
      `<div style="height:${topH}px"></div>` +
      visible.map(j => jobRowHTML(j)).join('') +
      `<div style="height:${botH}px"></div>`;

    wrap.querySelectorAll('.job-row').forEach(row => {
      row.addEventListener('click', () => navigate('detail', { jobId: row.dataset.id }));
    });
  }

  paint();
  wrap.addEventListener('scroll', paint, { passive: true });
}

function jobRowHTML(j) {
  const color    = sc(j.status);
  const bg       = sb(j.status);
  const balanceDue = Math.max(0, (j.total_charges || 0) - (j.received_amount || 0));
  return `
  <div class="job-row" data-id="${j.id}" style="border-left-color:${color}">
    <div class="job-row-thumb">
      ${j.thumb
        ? `<img src="${j.thumb}" class="thumb-img" onerror="this.parentElement.innerHTML='<i class=\\'fas fa-tools\\' style=\\'color:#bbb;font-size:22px\\'></i>'">`
        : `<i class="fas fa-tools" style="color:#bbb;font-size:22px"></i>`}
    </div>
    <div class="job-row-body">
      <div class="job-row-top">
        <span class="job-id">${j.id}</span>
        <span class="status-chip" style="background:${bg};color:${color};border-color:${color}">${sl(j.status)}</span>
      </div>
      <div class="job-name">${j.snap_name}</div>
      <div class="job-row-foot">
        <span class="job-meta"><i class="fas fa-box"></i> ${j.machine_count || 0} item(s)</span>
        ${isAdmin()
          ? `<span class="job-balance" style="color:${balanceDue > 0 ? '#E53935':'#43A047'}">Bal: ${fmtRs(balanceDue)}</span>`
          : `<span class="job-meta">${fmtDate(j.created_at)}</span>`}
      </div>
    </div>
  </div>`;
}

function applyFilter(s) { setFilter(s); render(); }

// ─────────────────────────────────────────────────────────────────────────────
// NEW JOB FORM
// ─────────────────────────────────────────────────────────────────────────────
function newJobHTML() {
  return `
  <div class="view-pad">
    <div class="card">
      <h2 class="section-title"><i class="fas fa-user-circle" style="color:#E53935"></i> Customer</h2>
      <div class="form-row-2">
        <div class="form-group">
          <label class="form-label">Mobile <span class="req">*</span></label>
          <input id="nj-mobile" type="tel" class="form-input" placeholder="9876543210" maxlength="10">
        </div>
        <div class="form-group">
          <label class="form-label">Alt. Mobile</label>
          <input id="nj-mobile2" type="tel" class="form-input" placeholder="Optional">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Customer Name <span class="req">*</span></label>
        <input id="nj-name" type="text" class="form-input" placeholder="Full name">
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
        <input id="nj-received" type="number" class="form-input" placeholder="0" min="0">
      </div>` : ''}
    </div>

    <div class="card" style="margin-top:12px">
      <h2 class="section-title"><i class="fas fa-tools" style="color:#E53935"></i> First Machine</h2>
      <div class="form-group">
        <label class="form-label">Product Name <span class="req">*</span></label>
        <input id="nj-product" type="text" class="form-input" placeholder="e.g. Samsung TV 55"">
      </div>
      <div class="form-group">
        <label class="form-label">Complaint</label>
        <textarea id="nj-complaint" class="form-input" rows="2" placeholder="Describe the issue…"></textarea>
      </div>
      <div class="form-row-2">
        ${isAdmin() ? `
        <div class="form-group">
          <label class="form-label">Charges (₹)</label>
          <input id="nj-charges" type="number" class="form-input" placeholder="0" min="0">
        </div>` : ''}
        <div class="form-group">
          <label class="form-label">Quantity</label>
          <input id="nj-qty" type="number" class="form-input" placeholder="1" min="1" value="1">
        </div>
      </div>
      <button id="nj-submit" class="btn-primary btn-full" style="margin-top:8px">
        <i class="fas fa-save"></i> Create Job
      </button>
    </div>
  </div>`;
}

function bindNewJob() {
  // Mobile lookup on blur
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
        toast('Customer found — details pre-filled', 'success');
      }
    } catch (_) {}
  }
  mobileIn?.addEventListener('blur', lookupMobile);

  document.getElementById('nj-submit')?.addEventListener('click', async () => {
    const name    = document.getElementById('nj-name')?.value.trim();
    const mobile  = document.getElementById('nj-mobile')?.value.trim();
    const product = document.getElementById('nj-product')?.value.trim();
    if (!name || !mobile || !product) { toast('Name, mobile & product are required', 'error'); return; }

    const btn = document.getElementById('nj-submit');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating…';
    try {
      const jobPayload = {
        customer_name:    name,
        customer_mobile:  mobile,
        customer_mobile2: document.getElementById('nj-mobile2')?.value.trim() || null,
        customer_address: document.getElementById('nj-address')?.value.trim() || null,
        note:             document.getElementById('nj-note')?.value.trim()    || null,
        received_amount:  isAdmin() ? (parseFloat(document.getElementById('nj-received')?.value) || 0) : 0,
      };
      const jobR = await API.post('/api/jobs', jobPayload);
      const jid  = jobR.data.id;
      await API.post(`/api/jobs/${jid}/machines`, {
        product_name:      product,
        product_complaint: document.getElementById('nj-complaint')?.value.trim() || null,
        charges:           isAdmin() ? (parseFloat(document.getElementById('nj-charges')?.value) || 0) : 0,
        quantity:          parseInt(document.getElementById('nj-qty')?.value) || 1,
      });
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
    const r   = await API.get(`/api/jobs/${S.jobId}`);
    S.job     = r.data;
    // also preload staff list silently
    if (isAdmin() && !S.staff.length) {
      try { const sr = await API.get('/api/staff'); S.staff = sr.data; } catch (_) {}
    }
    renderDetail();
  } catch (e) {
    const root = document.getElementById('detail-root');
    if (root) root.innerHTML = `<div class="empty-state" style="color:#e53935"><i class="fas fa-exclamation-triangle fa-2x"></i><p>Failed to load job</p></div>`;
  }
}

function renderDetail() {
  const j    = S.job;
  if (!j) return;
  const root = document.getElementById('detail-root');
  if (!root) return;

  const color      = sc(j.status);
  const total      = j.total_charges   || 0;
  const received   = j.received_amount || 0;
  const balance    = Math.max(0, total - received);

  root.innerHTML = `
    <!-- Status Banner -->
    <div class="detail-banner" style="background:${color}">
      <span class="detail-job-id">${j.id}</span>
      <span class="detail-status-label">${sl(j.status)}</span>
    </div>

    <!-- Customer Card -->
    <div class="card mt-3">
      <div class="info-row"><i class="fas fa-user info-icon" style="color:${color}"></i><span class="info-val fw-bold">${j.snap_name}</span></div>
      ${isAdmin() ? `
      <div class="info-row"><i class="fas fa-phone info-icon" style="color:${color}"></i>
        <a href="tel:${j.snap_mobile}" class="info-link">${j.snap_mobile}</a>
        ${j.snap_mobile2 ? `<a href="tel:${j.snap_mobile2}" class="info-link ml-8">${j.snap_mobile2}</a>` : ''}
      </div>` : ''}
      ${j.snap_address ? `<div class="info-row"><i class="fas fa-map-marker-alt info-icon" style="color:${color}"></i><span class="info-val">${j.snap_address}</span></div>` : ''}
      ${j.note ? `<div class="info-row"><i class="fas fa-sticky-note info-icon" style="color:${color}"></i><span class="info-val text-muted">${j.note}</span></div>` : ''}
      <div class="info-row"><i class="fas fa-calendar info-icon" style="color:${color}"></i><span class="info-val text-muted">${fmtDate(j.created_at)}</span></div>
    </div>

    <!-- Financial Panel (admin: all 3 rows; staff: balance only) -->
    <div class="card mt-3 financial-panel">
      <div class="fin-title"><i class="fas fa-rupee-sign"></i> Financials</div>
      ${isAdmin() ? `
      <div class="fin-row">
        <span class="fin-label">Total Charges</span>
        <span class="fin-amount">${fmtRs(total)}</span>
      </div>
      <div class="fin-row">
        <span class="fin-label">Received</span>
        <span class="fin-amount" style="color:#43A047">${fmtRs(received)}</span>
      </div>` : ''}
      <div class="fin-row fin-balance">
        <span class="fin-label fw-bold">Balance Due</span>
        <span class="fin-amount fw-bold" style="color:${balance > 0 ? '#E53935':'#43A047'}">${fmtRs(balance)}</span>
      </div>
      ${isAdmin() && j.status !== 'delivered' ? `
      <div class="fin-edit-row">
        <label class="form-label" style="margin:0">Update Received (₹)</label>
        <div style="display:flex;gap:8px;margin-top:6px">
          <input id="recv-input" type="number" class="form-input" style="flex:1" value="${received}" min="0" placeholder="0">
          <button id="recv-save" class="btn-sm btn-green">Save</button>
        </div>
      </div>` : ''}
    </div>

    <!-- Action Buttons -->
    <div class="action-row mt-3">
      ${isAdmin() && j.status !== 'delivered' ? `
      <button id="btn-deliver" class="action-btn" style="background:#1E88E5">
        <i class="fas fa-check-double"></i><span>Deliver</span>
      </button>` : ''}
      <button id="btn-jobcard" class="action-btn" style="background:#43A047">
        <i class="fas fa-file-image"></i><span>Job Card</span>
      </button>
      <button id="btn-share" class="action-btn" style="background:#25D366">
        <i class="fab fa-whatsapp"></i><span>Share</span>
      </button>
      ${isAdmin() ? `
      <button id="btn-del-job" class="action-btn" style="background:#E53935">
        <i class="fas fa-trash"></i><span>Delete</span>
      </button>` : ''}
    </div>

    <!-- Machines -->
    <div class="card mt-3">
      <div class="section-header">
        <h3 class="section-title" style="margin:0"><i class="fas fa-tools" style="color:#E53935"></i> Machines</h3>
        <button id="btn-add-machine" class="btn-sm btn-red">+ Add</button>
      </div>
      <div id="machines-container">
        ${(j.machines||[]).length
          ? (j.machines||[]).map(m => machineCardHTML(m)).join('')
          : '<p class="text-muted text-center" style="padding:20px">No machines yet — tap + Add</p>'}
      </div>
    </div>

    <!-- Hidden 9:16 job card for html2canvas -->
    <div id="job-card-print" style="position:fixed;left:-9999px;top:0;width:1080px;height:1920px;background:#fff;overflow:hidden;pointer-events:none">
      ${jobCardPrintHTML(j)}
    </div>
  `;

  bindDetail(j);
}

function machineCardHTML(m) {
  const color = sc(m.status);
  return `
  <div class="machine-card" style="border-left-color:${color}">
    <div class="machine-top">
      <div>
        <div class="machine-name">${m.product_name}${m.quantity > 1 ? ` <span class="machine-qty">×${m.quantity}</span>` : ''}</div>
        ${m.product_complaint ? `<div class="machine-complaint">${m.product_complaint}</div>` : ''}
        ${m.staff_name ? `<div class="machine-staff"><i class="fas fa-user-cog"></i> ${m.staff_name}</div>` : ''}
      </div>
      <div class="machine-right">
        ${isAdmin() ? `<div class="machine-charges">${fmtRs(m.charges)}</div>` : ''}
        <select data-mid="${m.id}" class="status-sel" style="border-color:${color};color:${color}">
          <option value="under_repair" ${m.status==='under_repair'?'selected':''}>Under Repair</option>
          <option value="repaired"     ${m.status==='repaired'    ?'selected':''}>Repaired</option>
          <option value="returned"     ${m.status==='returned'    ?'selected':''}>Returned</option>
        </select>
      </div>
    </div>
    <!-- Images row -->
    <div class="images-row">
      ${(m.images||[]).map(img => `
      <div class="img-wrap">
        <img src="${img.url}" class="img-thumb" loading="lazy" onerror="this.parentElement.style.display='none'">
        ${isAdmin() ? `<button class="img-del-btn" data-iid="${img.id}">×</button>` : ''}
      </div>`).join('')}
      <label class="img-add-btn" title="Add photo">
        <i class="fas fa-camera"></i>
        <input type="file" accept="image/*" capture="environment" data-mid="${m.id}" class="img-file-input" style="display:none">
      </label>
    </div>
    ${isAdmin() ? `
    <div class="machine-actions">
      <button data-mid="${m.id}" class="btn-sm btn-orange btn-edit-m"><i class="fas fa-edit"></i> Edit</button>
      <button data-mid="${m.id}" class="btn-sm btn-red btn-del-m"><i class="fas fa-trash"></i></button>
    </div>` : ''}
  </div>`;
}

function bindDetail(j) {
  // Status selects
  document.querySelectorAll('.status-sel').forEach(sel => {
    sel.addEventListener('change', async e => {
      try {
        await API.put(`/api/machines/${e.target.dataset.mid}`, { status: e.target.value });
        toast('Status updated', 'success');
        await loadDetail();
      } catch (_) { toast('Update failed', 'error'); }
    });
  });

  // Image upload (with compression)
  document.querySelectorAll('.img-file-input').forEach(input => {
    input.addEventListener('change', async e => {
      const raw = e.target.files[0];
      if (!raw) return;
      const mid = e.target.dataset.mid;
      try {
        toast('Compressing…', 'info');
        const compressed = await compressImage(raw, 1280, 0.82);
        const fd = new FormData();
        fd.append('image', compressed);
        toast('Uploading…', 'info');
        await API.post(`/api/machines/${mid}/images`, fd, { headers: { 'Content-Type': 'multipart/form-data' }});
        toast('Image saved', 'success');
        await loadDetail();
      } catch (_) { toast('Upload failed', 'error'); }
    });
  });

  // Delete image
  document.querySelectorAll('.img-del-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('Remove image?')) return;
      try {
        await API.delete(`/api/images/${btn.dataset.iid}`);
        toast('Removed', 'success'); await loadDetail();
      } catch (_) { toast('Failed', 'error'); }
    });
  });

  // Add machine
  document.getElementById('btn-add-machine')?.addEventListener('click', () => showAddMachineModal(j.id));

  // Edit machine
  document.querySelectorAll('.btn-edit-m').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = j.machines.find(x => x.id == btn.dataset.mid);
      if (m) showEditMachineModal(m);
    });
  });

  // Delete machine
  document.querySelectorAll('.btn-del-m').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this machine?')) return;
      try { await API.delete(`/api/machines/${btn.dataset.mid}`); toast('Deleted', 'success'); await loadDetail(); }
      catch (_) { toast('Failed', 'error'); }
    });
  });

  // Delete job
  document.getElementById('btn-del-job')?.addEventListener('click', async () => {
    if (!confirm(`Delete job ${j.id}? This cannot be undone.`)) return;
    try { await API.delete(`/api/jobs/${j.id}`); toast(`Job ${j.id} deleted`, 'success'); navigate('dashboard'); }
    catch (_) { toast('Delete failed', 'error'); }
  });

  // Save received amount
  document.getElementById('recv-save')?.addEventListener('click', async () => {
    const val = parseFloat(document.getElementById('recv-input')?.value) || 0;
    try {
      await API.put(`/api/jobs/${j.id}`, { received_amount: val });
      toast('Received amount saved', 'success');
      await loadDetail();
    } catch (_) { toast('Save failed', 'error'); }
  });

  // Deliver
  document.getElementById('btn-deliver')?.addEventListener('click', () => showDeliveryModal(j));

  // Job Card
  document.getElementById('btn-jobcard')?.addEventListener('click', () => generateAndShareJobCard(j, false));

  // Share (WhatsApp)
  document.getElementById('btn-share')?.addEventListener('click', () => generateAndShareJobCard(j, true));
}

// ─────────────────────────────────────────────────────────────────────────────
// MODALS
// ─────────────────────────────────────────────────────────────────────────────
function showAddMachineModal(jobId) {
  showModal(`
    <h3 class="modal-title">Add Machine</h3>
    <div class="form-group"><label class="form-label">Product Name <span class="req">*</span></label>
      <input id="am-prod" type="text" class="form-input" placeholder="e.g. LG AC 1.5T"></div>
    <div class="form-group"><label class="form-label">Complaint</label>
      <textarea id="am-comp" class="form-input" rows="2" placeholder="Issue description…"></textarea></div>
    <div class="form-row-2">
      ${isAdmin() ? `<div class="form-group"><label class="form-label">Charges (₹)</label><input id="am-chg" type="number" class="form-input" min="0" placeholder="0"></div>` : ''}
      <div class="form-group"><label class="form-label">Qty</label><input id="am-qty" type="number" class="form-input" min="1" value="1"></div>
    </div>
    <div class="form-group"><label class="form-label">Assign Staff</label>
      <select id="am-staff" class="form-input">
        <option value="">— None —</option>
        ${S.staff.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
      </select>
    </div>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="am-save" class="btn-primary">Save</button>
    </div>
  `);
  document.getElementById('am-save')?.addEventListener('click', async () => {
    const prod = document.getElementById('am-prod')?.value.trim();
    if (!prod) { toast('Product name required', 'error'); return; }
    try {
      await API.post(`/api/jobs/${jobId}/machines`, {
        product_name: prod,
        product_complaint: document.getElementById('am-comp')?.value.trim() || null,
        charges:  isAdmin() ? (parseFloat(document.getElementById('am-chg')?.value) || 0) : 0,
        quantity: parseInt(document.getElementById('am-qty')?.value) || 1,
        assigned_staff_id: document.getElementById('am-staff')?.value || null,
      });
      closeModal(); toast('Machine added', 'success'); await loadDetail();
    } catch (_) { toast('Failed', 'error'); }
  });
}

function showEditMachineModal(m) {
  showModal(`
    <h3 class="modal-title">Edit Machine</h3>
    <div class="form-group"><label class="form-label">Product Name <span class="req">*</span></label>
      <input id="em-prod" type="text" class="form-input" value="${m.product_name}"></div>
    <div class="form-group"><label class="form-label">Complaint</label>
      <textarea id="em-comp" class="form-input" rows="2">${m.product_complaint||''}</textarea></div>
    <div class="form-row-2">
      ${isAdmin() ? `<div class="form-group"><label class="form-label">Charges (₹)</label><input id="em-chg" type="number" class="form-input" min="0" value="${m.charges||0}"></div>` : ''}
      <div class="form-group"><label class="form-label">Qty</label><input id="em-qty" type="number" class="form-input" min="1" value="${m.quantity||1}"></div>
    </div>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="em-save" class="btn-primary">Update</button>
    </div>
  `);
  document.getElementById('em-save')?.addEventListener('click', async () => {
    try {
      await API.put(`/api/machines/${m.id}`, {
        product_name: document.getElementById('em-prod')?.value.trim(),
        product_complaint: document.getElementById('em-comp')?.value.trim() || null,
        charges: isAdmin() ? (parseFloat(document.getElementById('em-chg')?.value)||0) : undefined,
        quantity: parseInt(document.getElementById('em-qty')?.value)||1,
      });
      closeModal(); toast('Updated', 'success'); await loadDetail();
    } catch (_) { toast('Failed', 'error'); }
  });
}

function showDeliveryModal(j) {
  showModal(`
    <h3 class="modal-title">Mark as Delivered</h3>
    <div class="form-group"><label class="form-label">Receiver Name <span class="req">*</span></label>
      <input id="dm-rname" type="text" class="form-input" placeholder="Person who collected"></div>
    <div class="form-group"><label class="form-label">Receiver Mobile</label>
      <input id="dm-rmob" type="tel" class="form-input" placeholder="Mobile of receiver"></div>
    <div class="form-group"><label class="form-label">Delivery Method</label>
      <select id="dm-method" class="form-input">
        <option value="in_person">In Person</option>
        <option value="courier">Courier</option>
      </select>
    </div>
    <div id="courier-extra" style="display:none">
      <div class="form-group"><label class="form-label">Courier Name</label>
        <input id="dm-courier" type="text" class="form-input" placeholder="e.g. DTDC"></div>
      <div class="form-group"><label class="form-label">Tracking #</label>
        <input id="dm-track" type="text" class="form-input" placeholder="Tracking number"></div>
      <div class="form-group"><label class="form-label">Delivery Address</label>
        <textarea id="dm-addr" class="form-input" rows="2"></textarea></div>
    </div>
    ${isAdmin() ? `
    <div class="form-group"><label class="form-label">Final Received Amount (₹)</label>
      <input id="dm-recv" type="number" class="form-input" value="${j.received_amount||0}" min="0"></div>` : ''}
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="dm-confirm" class="btn-primary" style="background:#1E88E5"><i class="fas fa-check"></i> Confirm</button>
    </div>
  `);
  document.getElementById('dm-method')?.addEventListener('change', e => {
    document.getElementById('courier-extra').style.display = e.target.value === 'courier' ? 'block' : 'none';
  });
  document.getElementById('dm-confirm')?.addEventListener('click', async () => {
    const rname = document.getElementById('dm-rname')?.value.trim();
    if (!rname) { toast('Receiver name required', 'error'); return; }
    try {
      await API.put(`/api/jobs/${j.id}`, {
        status:                    'delivered',
        delivery_receiver_name:    rname,
        delivery_receiver_mobile:  document.getElementById('dm-rmob')?.value.trim() || null,
        delivery_method:           document.getElementById('dm-method')?.value || 'in_person',
        delivery_courier_name:     document.getElementById('dm-courier')?.value || null,
        delivery_tracking:         document.getElementById('dm-track')?.value    || null,
        delivery_address:          document.getElementById('dm-addr')?.value     || null,
        ...(isAdmin() ? { received_amount: parseFloat(document.getElementById('dm-recv')?.value) || 0 } : {}),
      });
      closeModal(); toast('Job delivered ✅', 'success'); await loadDetail();
    } catch (_) { toast('Failed', 'error'); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB CARD PRINT HTML  (1080×1920)
// ─────────────────────────────────────────────────────────────────────────────
function jobCardPrintHTML(j) {
  const total    = j.total_charges   || 0;
  const received = j.received_amount || 0;
  const balance  = Math.max(0, total - received);
  const color    = sc(j.status);
  const isDelivered = j.status === 'delivered';

  const deliveryBlock = isDelivered ? `
    <div style="margin:0 50px 30px;background:#E3F2FD;border:3px solid #1E88E5;border-radius:16px;padding:28px;">
      <div style="font-size:24px;font-weight:800;color:#1565C0;margin-bottom:14px;">📦 Delivery Information</div>
      <table style="width:100%;border-collapse:collapse;font-size:20px;">
        ${j.delivery_receiver_name   ? `<tr><td style="color:#555;padding:6px 0;width:200px">Received By</td><td style="font-weight:700;color:#1a1a2e">${j.delivery_receiver_name}</td></tr>` : ''}
        ${j.delivery_receiver_mobile ? `<tr><td style="color:#555;padding:6px 0">Mobile</td><td style="font-weight:700;color:#1565C0">${j.delivery_receiver_mobile}</td></tr>` : ''}
        ${j.delivery_method          ? `<tr><td style="color:#555;padding:6px 0">Method</td><td style="font-weight:700;color:#1a1a2e">${j.delivery_method === 'courier' ? 'Courier' : 'In Person'}</td></tr>` : ''}
        ${j.delivery_courier_name    ? `<tr><td style="color:#555;padding:6px 0">Courier</td><td style="font-weight:700;color:#1a1a2e">${j.delivery_courier_name}</td></tr>` : ''}
        ${j.delivery_tracking        ? `<tr><td style="color:#555;padding:6px 0">Tracking</td><td style="font-weight:700;color:#1a1a2e">${j.delivery_tracking}</td></tr>` : ''}
        ${j.delivered_at             ? `<tr><td style="color:#555;padding:6px 0">Date</td><td style="font-weight:700;color:#1a1a2e">${fmtDate(j.delivered_at)}</td></tr>` : ''}
      </table>
    </div>` : `
    <div style="margin:0 50px 30px;background:#fff8e1;border:3px solid #FFC107;border-radius:16px;padding:28px;">
      <div style="font-size:24px;font-weight:800;color:#e65100;margin-bottom:10px;">⚠️ Collection Notice</div>
      <div style="font-size:20px;color:#5D4037;line-height:1.65">
        Kindly collect your machine(s) within <strong>25 days</strong> from the date of this notice.
        After this period, we shall <strong>not be held liable</strong> for any claims, loss, or damage to uncollected items.
      </div>
    </div>`;

  return `
  <div style="width:1080px;height:1920px;background:#fff;font-family:'Segoe UI',Arial,sans-serif;display:flex;flex-direction:column;overflow:hidden;">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1a1a2e 0%,#0f3460 100%);padding:48px 60px 40px;text-align:center;flex-shrink:0">
      <div style="width:100px;height:100px;background:linear-gradient(135deg,#E53935,#B71C1C);border-radius:24px;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;font-size:60px">⚡</div>
      <div style="color:#fff;font-size:38px;font-weight:900;letter-spacing:3px">ADITION ELECTRIC</div>
      <div style="color:rgba(255,255,255,.65);font-size:20px;margin-top:6px;letter-spacing:1px">SERVICE MANAGEMENT SYSTEM</div>
    </div>

    <!-- Job ID banner -->
    <div style="background:${color};padding:22px 60px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
      <div style="color:#fff;font-size:52px;font-weight:900;letter-spacing:4px">${j.id}</div>
      <div style="color:#fff;font-size:24px;font-weight:700;background:rgba(0,0,0,.2);padding:8px 20px;border-radius:10px">${sl(j.status)}</div>
    </div>

    <!-- Customer info -->
    <div style="padding:36px 60px 20px;flex-shrink:0">
      <div style="font-size:18px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:2px;margin-bottom:16px">Customer Details</div>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="font-size:20px;color:#555;padding:8px 0;width:180px">Name</td><td style="font-size:26px;font-weight:800;color:#1a1a2e">${j.snap_name}</td></tr>
        <tr><td style="font-size:20px;color:#555;padding:8px 0">Mobile</td><td style="font-size:24px;font-weight:700;color:#1565C0">${j.snap_mobile}${j.snap_mobile2?' / '+j.snap_mobile2:''}</td></tr>
        ${j.snap_address ? `<tr><td style="font-size:20px;color:#555;padding:8px 0">Address</td><td style="font-size:20px;color:#333">${j.snap_address}</td></tr>` : ''}
        <tr><td style="font-size:20px;color:#555;padding:8px 0">Date</td><td style="font-size:20px;color:#555">${fmtDate(j.created_at)}</td></tr>
      </table>
    </div>

    <div style="border-top:2px solid #f0f0f0;margin:0 60px;flex-shrink:0"></div>

    <!-- Machines -->
    <div style="padding:24px 60px;flex:1;overflow:hidden">
      <div style="font-size:18px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:2px;margin-bottom:16px">Products Registered</div>
      ${(j.machines||[]).map((m,i) => `
      <div style="background:#f8f9fa;border-radius:14px;padding:22px 26px;margin-bottom:14px;border-left:6px solid ${sc(m.status)}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-size:26px;font-weight:800;color:#1a1a2e">${i+1}. ${m.product_name}${m.quantity>1?` ×${m.quantity}`:''}</div>
            ${m.product_complaint ? `<div style="font-size:19px;color:#666;margin-top:4px">${m.product_complaint}</div>` : ''}
          </div>
          <div style="background:${sc(m.status)};color:#fff;border-radius:8px;padding:6px 16px;font-size:17px;font-weight:700;white-space:nowrap">${sl(m.status)}</div>
        </div>
        ${(m.images||[]).length ? `
        <div style="display:flex;gap:10px;margin-top:14px;overflow:hidden">
          ${(m.images||[]).slice(0,3).map(img => `<img src="${img.url}" style="width:110px;height:110px;border-radius:10px;object-fit:cover">`).join('')}
        </div>` : ''}
      </div>`).join('')}
    </div>

    <!-- Financial summary (admin data on card) -->
    <div style="margin:0 60px 20px;background:#f8f9fa;border-radius:14px;padding:22px 26px;flex-shrink:0">
      <div style="font-size:18px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px">Financials</div>
      <div style="display:flex;justify-content:space-between;font-size:22px;padding:6px 0;border-bottom:1px solid #e0e0e0">
        <span style="color:#555">Total Charges</span><span style="font-weight:800;color:#1a1a2e">${fmtRs(total)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:22px;padding:6px 0;border-bottom:1px solid #e0e0e0">
        <span style="color:#555">Received</span><span style="font-weight:800;color:#43A047">${fmtRs(received)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:24px;padding:8px 0">
        <span style="font-weight:700;color:#1a1a2e">Balance Due</span>
        <span style="font-weight:900;color:${balance>0?'#E53935':'#43A047'}">${fmtRs(balance)}</span>
      </div>
    </div>

    ${j.note ? `<div style="margin:0 60px 16px;background:#fffde7;border-radius:10px;padding:18px 22px;font-size:19px;color:#795548;flex-shrink:0"><b>Note:</b> ${j.note}</div>` : ''}

    <!-- Conditional: collection notice OR delivery info -->
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
// JOB CARD GENERATION + SHARE
// ─────────────────────────────────────────────────────────────────────────────
async function generateAndShareJobCard(j, shareMode) {
  toast('Generating job card…', 'info');
  try {
    const el = document.getElementById('job-card-print');
    if (!el) { toast('Card element missing', 'error'); return; }
    const canvas = await html2canvas(el, {
      scale: 2, useCORS: true, allowTaint: true,
      width: 1080, height: 1920, backgroundColor: '#ffffff', logging: false,
    });
    canvas.toBlob(async blob => {
      const file = new File([blob], `AES_${j.id}.jpg`, { type: 'image/jpeg' });
      const text = shareText(j);
      if (shareMode && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: `Job ${j.id}`, text }); return; }
        catch (_) { /* fall through to download */ }
      }
      // Download fallback
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href = url; a.download = `AES_${j.id}.jpg`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      if (shareMode) {
        try { await navigator.clipboard.writeText(text); toast('Card downloaded & message copied!', 'success'); }
        catch (_) { toast('Card downloaded', 'success'); }
      } else {
        toast('Job card downloaded', 'success');
      }
    }, 'image/jpeg', 0.92);
  } catch (e) {
    console.error(e);
    toast('Failed to generate job card', 'error');
  }
}

function shareText(j) {
  const balance = Math.max(0, (j.total_charges||0) - (j.received_amount||0));
  if (j.status === 'delivered') {
    const method = j.delivery_method === 'courier' ? `via ${j.delivery_courier_name||'Courier'}` : 'in person';
    const receiver = j.delivery_receiver_name ? `\nReceived by: *${j.delivery_receiver_name}*` : '';
    const tracking = j.delivery_tracking ? `\nTracking: ${j.delivery_tracking}` : '';
    return `🌟 *Dear Customer,*\n\n✅ Your product(s) under *Job No. ${j.id}* have been successfully completed & delivered ${method}.${receiver}${tracking}\n\n💰 Total: ${fmtRs(j.total_charges||0)} | Received: ${fmtRs(j.received_amount||0)} | Balance: *${fmtRs(balance)}*\n\n🙏 Thank you for your business. We look forward to serving you again!\n\n— *ADITION ELECTRIC SOLUTION*\n✨ _adition™ since 1984_ 📍 Gheekanta, Ahmedabad`;
  }
  return `🌟 *Dear Customer,*\n\n✅ Your product(s) have been successfully registered under *Job No. ${j.id}*\n\n📦 Kindly collect your machine(s) within *25 days* from the date of this message.\n\n⚠️ *Note:* After 25 days, we shall not be held liable for any claims, loss, or damage.\n\n🙏 Thank you for choosing *ADITION ELECTRIC SOLUTION*!\n— *Bilal Pathan* | Operations Manager\n✨ _adition™ since 1984_ 📍 Gheekanta, Ahmedabad`;
}

// ─────────────────────────────────────────────────────────────────────────────
// STAFF
// ─────────────────────────────────────────────────────────────────────────────
function staffHTML() {
  return `
  <div class="view-pad">
    <div class="section-header mb-3">
      <h2 class="section-title" style="margin:0">Staff Members</h2>
      <button id="btn-add-staff" class="btn-sm btn-red">+ Add Staff</button>
    </div>
    <div id="staff-list"><div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div></div>
  </div>`;
}

async function loadStaff() {
  try {
    const r   = await API.get('/api/staff');
    S.staff   = r.data;
    const con = document.getElementById('staff-list');
    if (!con) return;
    if (!S.staff.length) {
      con.innerHTML = '<div class="empty-state"><i class="fas fa-users fa-2x"></i><p>No staff members yet</p></div>';
    } else {
      con.innerHTML = S.staff.map(s => `
      <div class="card mb-2 staff-row">
        <div class="staff-avatar" style="background:${s.role==='admin'?'#E53935':'#1565C0'}">${s.name[0].toUpperCase()}</div>
        <div style="flex:1;min-width:0">
          <div class="staff-name">${s.name}</div>
          <div class="staff-email">${s.email}</div>
          <div style="display:flex;gap:6px;margin-top:4px">
            <span class="tag tag-${s.role}">${s.role}</span>
            <span class="tag ${s.active?'tag-active':'tag-inactive'}">${s.active?'Active':'Inactive'}</span>
          </div>
        </div>
        <button data-sid="${s.id}" class="btn-sm btn-orange btn-edit-staff"><i class="fas fa-edit"></i></button>
      </div>`).join('');

      con.querySelectorAll('.btn-edit-staff').forEach(btn => {
        btn.addEventListener('click', () => {
          const s = S.staff.find(x => x.id == btn.dataset.sid);
          if (s) showEditStaffModal(s);
        });
      });
    }
    document.getElementById('btn-add-staff')?.addEventListener('click', showAddStaffModal);
  } catch (_) { toast('Failed to load staff', 'error'); }
}

async function loadStaffForSelects() {
  if (S.staff.length) return;
  try { const r = await API.get('/api/staff'); S.staff = r.data; } catch (_) {}
}

function showAddStaffModal() {
  showModal(`
    <h3 class="modal-title">Add Staff Member</h3>
    <div class="form-group"><label class="form-label">Name <span class="req">*</span></label><input id="as-name" type="text" class="form-input"></div>
    <div class="form-group"><label class="form-label">Email <span class="req">*</span></label><input id="as-email" type="email" class="form-input"></div>
    <div class="form-group"><label class="form-label">Password <span class="req">*</span></label><input id="as-pass" type="password" class="form-input"></div>
    <div class="form-group"><label class="form-label">Role</label>
      <select id="as-role" class="form-input">
        <option value="staff">Staff (View Only)</option>
        <option value="admin">Admin (Full Access)</option>
      </select>
    </div>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="as-save" class="btn-primary">Add</button>
    </div>
  `);
  document.getElementById('as-save')?.addEventListener('click', async () => {
    const name = document.getElementById('as-name')?.value.trim();
    const email = document.getElementById('as-email')?.value.trim();
    const pass = document.getElementById('as-pass')?.value;
    if (!name || !email || !pass) { toast('All fields required', 'error'); return; }
    try {
      await API.post('/api/staff', { name, email, password: pass, role: document.getElementById('as-role')?.value, active: 1 });
      closeModal(); toast('Staff added', 'success'); await loadStaff();
    } catch (e) { toast(e.response?.data?.error || 'Failed', 'error'); }
  });
}

function showEditStaffModal(s) {
  showModal(`
    <h3 class="modal-title">Edit: ${s.name}</h3>
    <div class="form-group"><label class="form-label">Name</label><input id="es-name" type="text" class="form-input" value="${s.name}"></div>
    <div class="form-group"><label class="form-label">New Password <small class="text-muted">(blank = keep)</small></label><input id="es-pass" type="password" class="form-input"></div>
    <div class="form-group"><label class="form-label">Role</label>
      <select id="es-role" class="form-input">
        <option value="staff" ${s.role==='staff'?'selected':''}>Staff</option>
        <option value="admin" ${s.role==='admin'?'selected':''}>Admin</option>
      </select>
    </div>
    <label class="toggle-row">
      <input id="es-active" type="checkbox" ${s.active?'checked':''} class="toggle-check">
      <span class="toggle-label">Active</span>
    </label>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="es-save" class="btn-primary">Update</button>
    </div>
  `);
  document.getElementById('es-save')?.addEventListener('click', async () => {
    const body = {
      name: document.getElementById('es-name')?.value.trim(),
      role: document.getElementById('es-role')?.value,
      active: document.getElementById('es-active')?.checked ? 1 : 0,
    };
    const pass = document.getElementById('es-pass')?.value;
    if (pass) body.password = pass;
    try {
      await API.put(`/api/staff/${s.id}`, body);
      closeModal(); toast('Updated', 'success'); await loadStaff();
    } catch (_) { toast('Failed', 'error'); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────────────────────────────────────
function reportsHTML() {
  return `
  <div class="view-pad">
    <!-- Backup -->
    <div class="card mb-3">
      <h3 class="section-title"><i class="fas fa-database" style="color:#43A047"></i> Backup & Restore</h3>
      <p class="text-muted" style="font-size:13px;margin:0 0 12px">Export all data to Excel or restore from a previous backup.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="btn-export" class="btn-sm btn-green" style="flex:1;min-width:130px"><i class="fas fa-download"></i> Export XLSX</button>
        <label class="btn-sm btn-orange" style="flex:1;min-width:130px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px">
          <i class="fas fa-upload"></i> Import XLSX
          <input id="import-file" type="file" accept=".xlsx" style="display:none">
        </label>
      </div>
    </div>

    <!-- Job Summary -->
    <div class="card mb-3">
      <h3 class="section-title"><i class="fas fa-chart-bar" style="color:#1E88E5"></i> Job Summary</h3>
      <div class="form-row-2">
        <div class="form-group"><label class="form-label">From</label><input id="js-from" type="date" class="form-input"></div>
        <div class="form-group"><label class="form-label">To</label><input id="js-to" type="date" class="form-input"></div>
      </div>
      <button id="btn-job-report" class="btn-primary btn-full"><i class="fas fa-file-excel"></i> Download Report</button>
    </div>

    <!-- Staff Report -->
    <div class="card mb-3">
      <h3 class="section-title"><i class="fas fa-user-chart" style="color:#9C27B0"></i> Staff Work Report</h3>
      <div class="form-row-2">
        <div class="form-group"><label class="form-label">From</label><input id="sr-from" type="date" class="form-input"></div>
        <div class="form-group"><label class="form-label">To</label><input id="sr-to" type="date" class="form-input"></div>
      </div>
      <div class="form-group"><label class="form-label">Staff Member</label>
        <select id="sr-staff" class="form-input">
          <option value="">All Staff</option>
          ${S.staff.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
        </select>
      </div>
      <button id="btn-staff-report" class="btn-primary btn-full" style="background:#9C27B0"><i class="fas fa-file-excel"></i> Download Report</button>
    </div>

    <!-- Cleanup -->
    <div class="card danger-card mb-3">
      <h3 class="section-title" style="color:#E53935"><i class="fas fa-trash-alt"></i> Data Cleanup</h3>
      <div class="form-row-2">
        <div class="form-group"><label class="form-label">From Date</label><input id="cl-from" type="date" class="form-input"></div>
        <div class="form-group"><label class="form-label">To Date</label><input id="cl-to" type="date" class="form-input"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="btn-cleanup-range" class="btn-sm btn-orange" style="flex:1;min-width:130px">Delete Date Range</button>
        <button id="btn-full-reset"    class="btn-sm btn-red"    style="flex:1;min-width:130px">⚠️ Full Reset</button>
      </div>
    </div>
  </div>`;
}

function bindReports() {
  document.getElementById('btn-export')?.addEventListener('click', () => {
    const a = document.createElement('a'); a.href = '/api/backup/export'; a.click();
  });
  document.getElementById('import-file')?.addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    if (!confirm('Import backup? Existing records with matching IDs will be updated.')) return;
    const fd = new FormData(); fd.append('file', file);
    try {
      toast('Restoring…', 'info');
      const r = await API.post('/api/backup/import', fd, { headers: { 'Content-Type': 'multipart/form-data' }});
      toast(`Restored: ${r.data.restored?.jobs||0} jobs, ${r.data.restored?.customers||0} customers`, 'success');
    } catch (_) { toast('Import failed', 'error'); }
  });
  document.getElementById('btn-job-report')?.addEventListener('click', () => {
    const p = new URLSearchParams();
    const f = document.getElementById('js-from')?.value; if (f) p.set('from', f);
    const t = document.getElementById('js-to')?.value;   if (t) p.set('to', t);
    document.createElement('a').href = `/api/reports/jobs?${p}`; 
    const a = document.createElement('a'); a.href = `/api/reports/jobs?${p}`; a.click();
  });
  document.getElementById('btn-staff-report')?.addEventListener('click', () => {
    const p = new URLSearchParams();
    const f = document.getElementById('sr-from')?.value;  if (f) p.set('from', f);
    const t = document.getElementById('sr-to')?.value;    if (t) p.set('to', t);
    const s = document.getElementById('sr-staff')?.value; if (s) p.set('staff_id', s);
    const a = document.createElement('a'); a.href = `/api/reports/staff?${p}`; a.click();
  });
  document.getElementById('btn-cleanup-range')?.addEventListener('click', async () => {
    const from = document.getElementById('cl-from')?.value;
    const to   = document.getElementById('cl-to')?.value;
    if (!from || !to) { toast('Select a date range', 'error'); return; }
    if (!confirm(`Delete all non-delivered jobs from ${from} to ${to}?`)) return;
    try {
      const r = await API.delete('/api/cleanup', { data: { from, to }});
      toast(`Deleted ${r.data.deleted} job(s)`, 'success');
    } catch (_) { toast('Cleanup failed', 'error'); }
  });
  document.getElementById('btn-full-reset')?.addEventListener('click', async () => {
    if (!confirm('⚠️ FULL RESET: Delete ALL data and reset job counter to C-001?\nThis CANNOT be undone!')) return;
    if (!confirm('Second confirmation: Are you 100% sure?')) return;
    try {
      await API.delete('/api/cleanup', { data: { full_reset: true }});
      toast('Full reset complete — counter reset to C-001', 'success');
    } catch (_) { toast('Reset failed', 'error'); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
function settingsHTML() {
  return `
  <div class="view-pad">
    <div class="card mb-3">
      <div class="profile-row">
        <div class="profile-avatar">${(S.user?.name||'?')[0].toUpperCase()}</div>
        <div>
          <div class="profile-name">${S.user?.name}</div>
          <div class="profile-email">${S.user?.email}</div>
          <span class="tag tag-${S.user?.role}">${S.user?.role?.toUpperCase()}</span>
        </div>
      </div>
      <button onclick="logout()" class="btn-outline-red btn-full mt-3"><i class="fas fa-sign-out-alt"></i> Sign Out</button>
    </div>

    <div class="card mb-3">
      <h3 class="section-title">About</h3>
      <div class="info-table">
        <div class="info-row-tbl"><span>Business</span><span class="fw-bold">ADITION ELECTRIC SOLUTION</span></div>
        <div class="info-row-tbl"><span>Version</span><span class="fw-bold">v6.0</span></div>
        <div class="info-row-tbl"><span>Address</span><span>Gheekanta, Ahmedabad 380001</span></div>
        <div class="info-row-tbl"><span>Jurisdiction</span><span class="fw-bold" style="color:#E53935">Ahmedabad Only</span></div>
      </div>
    </div>

    <div id="pwa-section" style="display:none" class="card pwa-card mb-3">
      <h3 class="section-title" style="color:#1565C0"><i class="fas fa-mobile-alt"></i> Install App</h3>
      <p class="text-muted" style="font-size:13px;margin:0 0 10px">Add to your home screen for instant access.</p>
      <button id="btn-install" class="btn-primary btn-full">Install ADITION App</button>
    </div>
  </div>`;
}

let _deferredPWA = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); _deferredPWA = e;
  document.getElementById('pwa-section') && (document.getElementById('pwa-section').style.display = 'block');
});

function bindSettings() {
  setTimeout(() => {
    const sec = document.getElementById('pwa-section');
    const btn = document.getElementById('btn-install');
    if (_deferredPWA && sec) {
      sec.style.display = 'block';
      btn?.addEventListener('click', async () => {
        _deferredPWA.prompt();
        const res = await _deferredPWA.userChoice;
        if (res.outcome === 'accepted') { _deferredPWA = null; sec.style.display = 'none'; toast('App installed!', 'success'); }
      });
    }
  }, 150);
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE WORKER
// ─────────────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// GLOBALS FOR INLINE HANDLERS
// ─────────────────────────────────────────────────────────────────────────────
window.navigate   = navigate;
window.logout     = logout;
window.applyFilter= applyFilter;
window.closeModal = closeModal;

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────
render();

})();
