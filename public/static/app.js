// ADITION ELECTRIC SOLUTION - Full PWA Frontend
// =========================================================
;(function() {
'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const STATE = {
  token: localStorage.getItem('AES_TOKEN') || null,
  user: JSON.parse(localStorage.getItem('AES_USER') || 'null'),
  currentView: 'login',
  jobs: [],
  currentJob: null,
  staff: [],
  statusFilter: new URLSearchParams(window.location.search).get('status') || 'under_repair',
};

// ── API ────────────────────────────────────────────────────────────────────
const API = axios.create({ baseURL: '/' });
API.interceptors.request.use(cfg => {
  if (STATE.token) cfg.headers.Authorization = 'Bearer ' + STATE.token;
  return cfg;
});
API.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401) logout();
  return Promise.reject(err);
});

// ── Helpers ────────────────────────────────────────────────────────────────
function isAdmin() { return STATE.user?.role === 'admin'; }

function statusColor(s) {
  const m = { under_repair: '#F44336', repaired: '#4CAF50', returned: '#B8860B', delivered: '#2196F3' };
  return m[s] || '#9E9E9E';
}
function statusLabel(s) {
  const m = { under_repair: 'Under Repair', repaired: 'Repaired', returned: 'Returned', delivered: 'Delivered' };
  return m[s] || s;
}
function statusBg(s) {
  const m = { under_repair: '#FFEBEE', repaired: '#E8F5E9', returned: '#FFF8E1', delivered: '#E3F2FD' };
  return m[s] || '#F5F5F5';
}
function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
}
function fmtCurrency(n) {
  return '₹' + (parseFloat(n) || 0).toFixed(0);
}
function toast(msg, type='info') {
  const t = document.createElement('div');
  t.className = 'toast-msg';
  t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
    background:${type==='error'?'#d32f2f':type==='success'?'#388e3c':'#1565c0'};
    color:#fff;padding:10px 20px;border-radius:8px;z-index:9999;font-size:14px;
    box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:300px;text-align:center;`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
function showModal(html) {
  const ov = document.createElement('div');
  ov.id = 'modal-overlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:8000;display:flex;align-items:flex-end;justify-content:center;';
  ov.innerHTML = `<div style="background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;max-height:90vh;overflow-y:auto;padding:20px;">${html}</div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
}
function closeModal() { document.getElementById('modal-overlay')?.remove(); }

function setStatusFilter(s) {
  STATE.statusFilter = s;
  const url = new URL(window.location);
  if (s) url.searchParams.set('status', s); else url.searchParams.delete('status');
  history.replaceState({}, '', url);
}

// ── Auth ───────────────────────────────────────────────────────────────────
async function login(email, password) {
  try {
    const r = await API.post('/api/auth/login', { email, password });
    STATE.token = r.data.token;
    STATE.user = r.data.user;
    localStorage.setItem('AES_TOKEN', STATE.token);
    localStorage.setItem('AES_USER', JSON.stringify(STATE.user));
    navigate('dashboard');
  } catch (e) {
    toast(e.response?.data?.error || 'Login failed', 'error');
  }
}
function logout() {
  STATE.token = null; STATE.user = null;
  localStorage.removeItem('AES_TOKEN'); localStorage.removeItem('AES_USER');
  navigate('login');
}

// ── Navigation ─────────────────────────────────────────────────────────────
function navigate(view, params={}) {
  STATE.currentView = view;
  if (params.jobId) STATE.currentJobId = params.jobId;
  render();
}

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  if (!app) return;
  if (!STATE.token || !STATE.user) {
    app.innerHTML = renderLogin();
    bindLogin();
    return;
  }
  app.innerHTML = `
    <div style="max-width:480px;margin:0 auto;min-height:100vh;background:#fff;position:relative;padding-bottom:70px;">
      ${renderHeader()}
      <div id="main-content">
        ${renderCurrentView()}
      </div>
      ${renderBottomNav()}
    </div>`;
  bindCurrentView();
}

function renderLogin() {
  return `
  <div style="min-height:100vh;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);
    display:flex;align-items:center;justify-content:center;padding:20px;">
    <div style="width:100%;max-width:400px;">
      <div style="text-align:center;margin-bottom:32px;">
        <div style="width:80px;height:80px;background:linear-gradient(135deg,#e94560,#0f3460);
          border-radius:20px;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;">
          <i class="fas fa-bolt" style="color:#fff;font-size:36px;"></i>
        </div>
        <h1 style="color:#fff;font-size:22px;font-weight:700;letter-spacing:1px;">ADITION ELECTRIC</h1>
        <p style="color:rgba(255,255,255,0.6);font-size:13px;margin-top:4px;">Service Management System</p>
      </div>
      <div style="background:rgba(255,255,255,0.05);backdrop-filter:blur(10px);border-radius:16px;
        border:1px solid rgba(255,255,255,0.1);padding:28px;">
        <div style="margin-bottom:16px;">
          <label style="color:rgba(255,255,255,0.7);font-size:13px;display:block;margin-bottom:6px;">Email</label>
          <input id="l-email" type="email" placeholder="admin@example.com" value="bilalkhan1108@gmail.com"
            style="width:100%;padding:12px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);
            background:rgba(255,255,255,0.1);color:#fff;font-size:15px;outline:none;box-sizing:border-box;">
        </div>
        <div style="margin-bottom:20px;">
          <label style="color:rgba(255,255,255,0.7);font-size:13px;display:block;margin-bottom:6px;">Password</label>
          <input id="l-pass" type="password" placeholder="••••••••" value="0010"
            style="width:100%;padding:12px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);
            background:rgba(255,255,255,0.1);color:#fff;font-size:15px;outline:none;box-sizing:border-box;">
        </div>
        <button id="l-btn" style="width:100%;padding:14px;background:linear-gradient(135deg,#e94560,#c62a47);
          color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;letter-spacing:0.5px;">
          Sign In
        </button>
        <p style="color:rgba(255,255,255,0.4);font-size:12px;text-align:center;margin-top:16px;">
          Admin: bilalkhan1108@gmail.com / 0010
        </p>
      </div>
      <p style="color:rgba(255,255,255,0.3);font-size:11px;text-align:center;margin-top:20px;">
        ✨ adition™ since 1984 · Ahmedabad
      </p>
    </div>
  </div>`;
}

function bindLogin() {
  document.getElementById('l-btn')?.addEventListener('click', () => {
    const email = document.getElementById('l-email').value.trim();
    const pass = document.getElementById('l-pass').value;
    login(email, pass);
  });
  document.getElementById('l-pass')?.addEventListener('keypress', e => {
    if (e.key === 'Enter') document.getElementById('l-btn')?.click();
  });
}

function renderHeader() {
  const viewTitles = {
    dashboard: 'Jobs Dashboard', newjob: 'New Job', detail: 'Job Details',
    staff: 'Staff Panel', reports: 'Reports', settings: 'Settings'
  };
  return `
  <div style="background:#1a1a2e;color:#fff;padding:12px 16px;display:flex;align-items:center;
    justify-content:space-between;position:sticky;top:0;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,0.3);">
    <div style="display:flex;align-items:center;gap:10px;">
      ${STATE.currentView==='detail' ? `<button onclick="navigate('dashboard')" style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:4px;"><i class="fas fa-arrow-left"></i></button>` : ''}
      <div>
        <div style="font-size:16px;font-weight:700;letter-spacing:0.5px;">${viewTitles[STATE.currentView]||'AES'}</div>
        <div style="font-size:10px;color:rgba(255,255,255,0.5);">ADITION ELECTRIC SOLUTION</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="background:${isAdmin()?'#e94560':'#0f3460'};padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600;">
        ${STATE.user.name.split(' ')[0]}
      </div>
      <button onclick="logout()" style="background:rgba(255,255,255,0.1);border:none;color:#fff;
        width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:13px;">
        <i class="fas fa-sign-out-alt"></i>
      </button>
    </div>
  </div>`;
}

function renderBottomNav() {
  const tabs = [
    { id:'dashboard', icon:'fa-list', label:'Jobs' },
    { id:'newjob', icon:'fa-plus-circle', label:'New Job' },
    ...(isAdmin() ? [{ id:'staff', icon:'fa-users', label:'Staff' }] : []),
    ...(isAdmin() ? [{ id:'reports', icon:'fa-chart-bar', label:'Reports' }] : []),
    { id:'settings', icon:'fa-cog', label:'Settings' },
  ];
  return `
  <div style="position:fixed;bottom:0;left:50%;transform:translateX(-50%);
    width:100%;max-width:480px;background:#1a1a2e;border-top:1px solid rgba(255,255,255,0.1);
    display:flex;z-index:200;padding:4px 0;">
    ${tabs.map(t => `
    <button onclick="navigate('${t.id}')" style="flex:1;background:none;border:none;
      color:${STATE.currentView===t.id?'#e94560':'rgba(255,255,255,0.5)'};
      padding:8px 4px;cursor:pointer;font-size:10px;display:flex;flex-direction:column;align-items:center;gap:3px;">
      <i class="fas ${t.icon}" style="font-size:18px;"></i>
      <span>${t.label}</span>
    </button>`).join('')}
  </div>`;
}

function renderCurrentView() {
  switch(STATE.currentView) {
    case 'dashboard': return renderDashboard();
    case 'newjob': return renderNewJob();
    case 'detail': return renderJobDetail();
    case 'staff': return isAdmin() ? renderStaff() : '<p>Access denied</p>';
    case 'reports': return isAdmin() ? renderReports() : '<p>Access denied</p>';
    case 'settings': return renderSettings();
    default: return renderDashboard();
  }
}

// ── Dashboard ──────────────────────────────────────────────────────────────
function renderDashboard() {
  const filters = [
    { s:'', label:'All' },
    { s:'under_repair', label:'Under Repair' },
    { s:'repaired', label:'Repaired' },
    { s:'returned', label:'Returned' },
    ...(isAdmin() ? [{ s:'delivered', label:'Delivered' }] : []),
  ];
  return `
  <div>
    <!-- Filter chips -->
    <div style="padding:12px;overflow-x:auto;white-space:nowrap;background:#f8f9fa;border-bottom:1px solid #e9ecef;">
      ${filters.map(f => `
      <button onclick="applyFilter('${f.s}')"
        style="display:inline-block;margin-right:8px;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600;
          border:2px solid ${f.s ? statusColor(f.s||'under_repair') : '#1a1a2e'};
          background:${STATE.statusFilter===f.s ? (f.s ? statusColor(f.s) : '#1a1a2e') : 'transparent'};
          color:${STATE.statusFilter===f.s ? '#fff' : (f.s ? statusColor(f.s) : '#1a1a2e')};cursor:pointer;">
        ${f.label}
      </button>`).join('')}
    </div>
    <!-- Job list -->
    <div id="job-list" style="padding:12px;">
      <div style="text-align:center;padding:40px;color:#aaa;">
        <i class="fas fa-spinner fa-spin" style="font-size:24px;"></i>
        <p style="margin-top:8px;font-size:14px;">Loading jobs...</p>
      </div>
    </div>
  </div>`;
}

async function loadDashboard() {
  try {
    const params = STATE.statusFilter ? { status: STATE.statusFilter } : {};
    const r = await API.get('/api/jobs', { params });
    STATE.jobs = r.data;
    const list = document.getElementById('job-list');
    if (!list) return;
    if (!STATE.jobs.length) {
      list.innerHTML = `<div style="text-align:center;padding:60px 20px;color:#aaa;">
        <i class="fas fa-inbox" style="font-size:48px;margin-bottom:12px;display:block;"></i>
        <p style="font-size:15px;">No jobs found</p>
        <p style="font-size:13px;margin-top:4px;">Create a new job to get started</p>
      </div>`;
      return;
    }
    list.innerHTML = STATE.jobs.map(j => renderJobCard(j)).join('');
    list.querySelectorAll('.job-card-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        STATE.currentJobId = btn.dataset.id;
        navigate('detail', { jobId: btn.dataset.id });
      });
    });
  } catch(e) {
    console.error(e);
    const list = document.getElementById('job-list');
    if (list) list.innerHTML = `<div style="text-align:center;padding:40px;color:#e74c3c;">Error loading jobs</div>`;
  }
}

function renderJobCard(j) {
  const color = statusColor(j.status);
  const bg = statusBg(j.status);
  const charges = j.total_charges ? fmtCurrency(j.total_charges) : '—';
  return `
  <button class="job-card-btn" data-id="${j.id}"
    style="width:100%;text-align:left;background:#fff;border:none;border-radius:12px;
      margin-bottom:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);
      border-left:4px solid ${color};cursor:pointer;display:block;padding:0;">
    <div style="padding:12px 14px;display:flex;gap:12px;align-items:flex-start;">
      ${j.thumb ? `<img src="${j.thumb}" style="width:56px;height:56px;border-radius:8px;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'">` 
                : `<div style="width:56px;height:56px;border-radius:8px;background:#f0f0f0;flex-shrink:0;display:flex;align-items:center;justify-content:center;"><i class="fas fa-tools" style="color:#aaa;font-size:20px;"></i></div>`}
      <div style="flex:1;min-width:0;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <span style="font-size:16px;font-weight:700;color:#1a1a2e;">${j.id}</span>
          <span style="background:${bg};color:${color};padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid ${color};">
            ${statusLabel(j.status)}
          </span>
        </div>
        <div style="font-size:14px;color:#333;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${j.snap_name}</div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;">
          <span style="font-size:12px;color:#777;"><i class="fas fa-box" style="margin-right:4px;"></i>${j.machine_count||0} machine(s)</span>
          ${isAdmin() ? `<span style="font-size:12px;font-weight:600;color:${color};">${charges}</span>` : ''}
        </div>
        <div style="font-size:11px;color:#aaa;margin-top:2px;">${fmtDate(j.created_at)}</div>
      </div>
    </div>
  </button>`;
}

function applyFilter(s) {
  STATE.statusFilter = s;
  setStatusFilter(s);
  render();
}

// ── New Job ────────────────────────────────────────────────────────────────
function renderNewJob() {
  return `
  <div style="padding:16px;">
    <div style="background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <h2 style="font-size:18px;font-weight:700;color:#1a1a2e;margin:0 0 20px;">Customer Details</h2>
      
      <div style="margin-bottom:14px;">
        <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">
          Mobile Number <span style="color:#e94560;">*</span>
        </label>
        <div style="display:flex;gap:8px;">
          <input id="nj-mobile" type="tel" placeholder="9876543210" maxlength="10"
            style="flex:1;padding:12px;border:2px solid #e9ecef;border-radius:10px;font-size:15px;outline:none;">
          <button id="nj-lookup" style="background:#1a1a2e;color:#fff;border:none;padding:12px 16px;
            border-radius:10px;cursor:pointer;font-size:13px;white-space:nowrap;">
            Lookup
          </button>
        </div>
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Customer Name <span style="color:#e94560;">*</span></label>
        <input id="nj-name" type="text" placeholder="Enter full name"
          style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:10px;font-size:15px;outline:none;box-sizing:border-box;">
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Alt. Mobile</label>
        <input id="nj-mobile2" type="tel" placeholder="Optional alt number"
          style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:10px;font-size:15px;outline:none;box-sizing:border-box;">
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Address</label>
        <textarea id="nj-address" placeholder="Street, city, state" rows="2"
          style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:10px;font-size:15px;outline:none;box-sizing:border-box;resize:none;"></textarea>
      </div>
      <div style="margin-bottom:20px;">
        <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Note / Remarks</label>
        <textarea id="nj-note" placeholder="Internal notes..." rows="2"
          style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:10px;font-size:15px;outline:none;box-sizing:border-box;resize:none;"></textarea>
      </div>
      
      <h2 style="font-size:18px;font-weight:700;color:#1a1a2e;margin:0 0 16px;border-top:1px solid #eee;padding-top:16px;">Machine #1</h2>
      <div style="margin-bottom:14px;">
        <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Product Name <span style="color:#e94560;">*</span></label>
        <input id="nj-product" type="text" placeholder="e.g. Samsung TV, AC Unit"
          style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:10px;font-size:15px;outline:none;box-sizing:border-box;">
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Complaint</label>
        <textarea id="nj-complaint" placeholder="Describe the issue..." rows="2"
          style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:10px;font-size:15px;outline:none;box-sizing:border-box;resize:none;"></textarea>
      </div>
      <div style="display:flex;gap:12px;margin-bottom:14px;">
        ${isAdmin() ? `
        <div style="flex:1;">
          <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Charges (₹)</label>
          <input id="nj-charges" type="number" placeholder="0" min="0"
            style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:10px;font-size:15px;outline:none;box-sizing:border-box;">
        </div>` : ''}
        <div style="flex:1;">
          <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Quantity</label>
          <input id="nj-qty" type="number" placeholder="1" min="1" value="1"
            style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:10px;font-size:15px;outline:none;box-sizing:border-box;">
        </div>
      </div>
      
      <button id="nj-submit" style="width:100%;padding:14px;background:linear-gradient(135deg,#e94560,#c62a47);
        color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;margin-top:8px;">
        <i class="fas fa-save" style="margin-right:8px;"></i>Create Job
      </button>
    </div>
  </div>`;
}

function bindNewJob() {
  const mobileInput = document.getElementById('nj-mobile');
  document.getElementById('nj-lookup')?.addEventListener('click', async () => {
    const mobile = mobileInput?.value.trim();
    if (!mobile || mobile.length < 10) { toast('Enter valid 10-digit mobile', 'error'); return; }
    try {
      const r = await API.get('/api/customers/by-mobile', { params: { mobile } });
      if (r.data) {
        document.getElementById('nj-name').value = r.data.name || '';
        document.getElementById('nj-mobile2').value = r.data.mobile2 || '';
        document.getElementById('nj-address').value = r.data.address || '';
        toast('Customer found!', 'success');
      } else {
        toast('New customer', 'info');
      }
    } catch(e) { toast('Lookup failed', 'error'); }
  });
  mobileInput?.addEventListener('blur', async () => {
    const mobile = mobileInput.value.trim();
    if (mobile.length === 10) document.getElementById('nj-lookup')?.click();
  });
  document.getElementById('nj-submit')?.addEventListener('click', async () => {
    const name = document.getElementById('nj-name')?.value.trim();
    const mobile = document.getElementById('nj-mobile')?.value.trim();
    const product = document.getElementById('nj-product')?.value.trim();
    if (!name || !mobile || !product) { toast('Name, mobile & product are required', 'error'); return; }
    try {
      const jobData = {
        customer_name: name, customer_mobile: mobile,
        customer_mobile2: document.getElementById('nj-mobile2')?.value.trim()||null,
        customer_address: document.getElementById('nj-address')?.value.trim()||null,
        note: document.getElementById('nj-note')?.value.trim()||null,
      };
      const jobR = await API.post('/api/jobs', jobData);
      const jobId = jobR.data.id;
      // Add first machine
      const machineData = {
        product_name: product,
        product_complaint: document.getElementById('nj-complaint')?.value.trim()||null,
        charges: isAdmin() ? (parseFloat(document.getElementById('nj-charges')?.value)||0) : 0,
        quantity: parseInt(document.getElementById('nj-qty')?.value)||1,
      };
      await API.post(`/api/jobs/${jobId}/machines`, machineData);
      toast(`Job ${jobId} created!`, 'success');
      STATE.currentJobId = jobId;
      navigate('detail');
    } catch(e) { toast(e.response?.data?.error || 'Failed to create job', 'error'); }
  });
}

// ── Job Detail ─────────────────────────────────────────────────────────────
async function loadJobDetail() {
  if (!STATE.currentJobId) return;
  try {
    const r = await API.get(`/api/jobs/${STATE.currentJobId}`);
    STATE.currentJob = r.data;
    renderJobDetailContent();
  } catch(e) { toast('Failed to load job', 'error'); }
}

function renderJobDetail() {
  return `<div id="job-detail-content" style="padding:16px;">
    <div style="text-align:center;padding:40px;color:#aaa;">
      <i class="fas fa-spinner fa-spin" style="font-size:24px;"></i>
    </div>
  </div>`;
}

function renderJobDetailContent() {
  const j = STATE.currentJob;
  if (!j) return;
  const container = document.getElementById('job-detail-content');
  if (!container) return;
  const color = statusColor(j.status);
  const totalCharges = (j.machines||[]).reduce((s, m) => s + (parseFloat(m.charges)||0), 0);
  
  container.innerHTML = `
    <!-- Job Info Card -->
    <div style="background:#fff;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);border-top:4px solid ${color};">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h2 style="font-size:22px;font-weight:800;color:#1a1a2e;margin:0;">${j.id}</h2>
        <span style="background:${statusBg(j.status)};color:${color};padding:6px 12px;border-radius:20px;
          font-size:13px;font-weight:700;border:1px solid ${color};">${statusLabel(j.status)}</span>
      </div>
      <div style="display:grid;gap:8px;">
        <div style="display:flex;gap:8px;align-items:center;">
          <i class="fas fa-user" style="color:${color};width:16px;"></i>
          <span style="font-size:15px;font-weight:600;color:#333;">${j.snap_name}</span>
        </div>
        ${isAdmin() ? `<div style="display:flex;gap:8px;align-items:center;">
          <i class="fas fa-phone" style="color:${color};width:16px;"></i>
          <a href="tel:${j.snap_mobile}" style="font-size:14px;color:#1565c0;">${j.snap_mobile}</a>
          ${j.snap_mobile2 ? `<a href="tel:${j.snap_mobile2}" style="font-size:14px;color:#1565c0;margin-left:8px;">${j.snap_mobile2}</a>` : ''}
        </div>` : ''}
        ${j.snap_address ? `<div style="display:flex;gap:8px;align-items:flex-start;">
          <i class="fas fa-map-marker-alt" style="color:${color};width:16px;margin-top:2px;"></i>
          <span style="font-size:13px;color:#666;">${j.snap_address}</span>
        </div>` : ''}
        ${j.note ? `<div style="display:flex;gap:8px;align-items:flex-start;">
          <i class="fas fa-sticky-note" style="color:${color};width:16px;margin-top:2px;"></i>
          <span style="font-size:13px;color:#666;">${j.note}</span>
        </div>` : ''}
        <div style="display:flex;gap:8px;align-items:center;">
          <i class="fas fa-calendar" style="color:${color};width:16px;"></i>
          <span style="font-size:13px;color:#888;">${fmtDate(j.created_at)}</span>
        </div>
      </div>
      ${isAdmin() ? `
      <div style="background:#f8f9fa;border-radius:8px;padding:12px;margin-top:12px;">
        <div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-bottom:8px;">💰 Financials</div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #e9ecef;">
          <span style="font-size:13px;color:#555;">Total Charges</span>
          <span style="font-size:14px;font-weight:700;color:#1a1a2e;">${fmtCurrency(totalCharges)}</span>
        </div>
      </div>` : ''}
    </div>

    <!-- Action buttons -->
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
      ${isAdmin() && j.status !== 'delivered' ? `
      <button id="btn-deliver" style="flex:1;min-width:120px;padding:10px 8px;background:#2196F3;color:#fff;
        border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">
        <i class="fas fa-check-circle" style="margin-right:4px;"></i>Deliver
      </button>` : ''}
      <button id="btn-jobcard" style="flex:1;min-width:120px;padding:10px 8px;background:#4CAF50;color:#fff;
        border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">
        <i class="fas fa-file-image" style="margin-right:4px;"></i>Job Card
      </button>
      <button id="btn-share-reg" style="flex:1;min-width:120px;padding:10px 8px;background:#FF9800;color:#fff;
        border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">
        <i class="fab fa-whatsapp" style="margin-right:4px;"></i>Share
      </button>
      ${isAdmin() ? `
      <button id="btn-del-job" style="padding:10px 12px;background:#F44336;color:#fff;
        border:none;border-radius:8px;font-size:13px;cursor:pointer;">
        <i class="fas fa-trash"></i>
      </button>` : ''}
    </div>

    <!-- Machines -->
    <div style="background:#fff;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <h3 style="font-size:16px;font-weight:700;color:#1a1a2e;margin:0;">
          <i class="fas fa-tools" style="margin-right:6px;color:#e94560;"></i>Machines
        </h3>
        <button id="btn-add-machine" style="background:#e94560;color:#fff;border:none;
          padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;">
          + Add
        </button>
      </div>
      <div id="machines-list">
        ${(j.machines||[]).map(m => renderMachineCard(m)).join('') || '<p style="color:#aaa;text-align:center;font-size:14px;">No machines yet</p>'}
      </div>
    </div>

    <!-- Hidden 9:16 Job Card for capture -->
    <div id="job-card-canvas" style="position:fixed;left:-9999px;top:-9999px;width:1080px;height:1920px;background:#fff;overflow:hidden;">
      ${renderJobCardHTML(j)}
    </div>
  `;
  bindJobDetail(j);
}

function renderMachineCard(m) {
  const color = statusColor(m.status);
  return `
  <div style="border:1px solid #e9ecef;border-radius:10px;padding:12px;margin-bottom:10px;border-left:4px solid ${color};">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px;">
      <div>
        <div style="font-size:15px;font-weight:700;color:#1a1a2e;">${m.product_name}
          ${m.quantity > 1 ? `<span style="font-size:12px;color:#777;margin-left:4px;">×${m.quantity}</span>` : ''}
        </div>
        ${m.product_complaint ? `<div style="font-size:12px;color:#777;margin-top:2px;">${m.product_complaint}</div>` : ''}
        ${m.staff_name ? `<div style="font-size:12px;color:#1565c0;margin-top:2px;"><i class="fas fa-user-cog" style="margin-right:4px;"></i>${m.staff_name}</div>` : ''}
      </div>
      <div style="text-align:right;flex-shrink:0;">
        ${isAdmin() ? `<div style="font-size:14px;font-weight:700;color:${color};">${fmtCurrency(m.charges)}</div>` : ''}
        <select data-machine-id="${m.id}" class="machine-status-sel"
          style="margin-top:4px;font-size:11px;padding:4px 6px;border-radius:6px;
          border:2px solid ${color};color:${color};background:${statusBg(m.status)};cursor:pointer;font-weight:600;">
          <option value="under_repair" ${m.status==='under_repair'?'selected':''}>Under Repair</option>
          <option value="repaired" ${m.status==='repaired'?'selected':''}>Repaired</option>
          <option value="returned" ${m.status==='returned'?'selected':''}>Returned</option>
        </select>
      </div>
    </div>
    <!-- Images -->
    <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;flex-wrap:nowrap;">
      ${(m.images||[]).map(img => `
      <div style="position:relative;flex-shrink:0;">
        <img src="${img.url}" style="width:64px;height:64px;border-radius:8px;object-fit:cover;" onerror="this.parentElement.style.display='none'">
        ${isAdmin() ? `<button onclick="deleteImage(${img.id})" style="position:absolute;top:-4px;right:-4px;background:#e74c3c;color:#fff;border:none;border-radius:50%;width:18px;height:18px;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;">×</button>` : ''}
      </div>`).join('')}
      <label style="flex-shrink:0;width:64px;height:64px;border:2px dashed #ccc;border-radius:8px;
        display:flex;align-items:center;justify-content:center;cursor:pointer;color:#aaa;">
        <i class="fas fa-camera" style="font-size:20px;"></i>
        <input type="file" accept="image/*" capture="environment" data-machine-id="${m.id}" class="img-upload"
          style="display:none;">
      </label>
    </div>
    <div style="display:flex;gap:6px;margin-top:8px;">
      ${isAdmin() ? `
      <button data-machine-id="${m.id}" class="btn-edit-machine"
        style="flex:1;padding:6px;background:#fff3e0;color:#FF9800;border:1px solid #FF9800;
        border-radius:6px;font-size:12px;cursor:pointer;font-weight:600;">
        <i class="fas fa-edit" style="margin-right:4px;"></i>Edit
      </button>
      <button data-machine-id="${m.id}" class="btn-del-machine"
        style="padding:6px 10px;background:#ffebee;color:#F44336;border:1px solid #F44336;
        border-radius:6px;font-size:12px;cursor:pointer;">
        <i class="fas fa-trash"></i>
      </button>` : ''}
    </div>
  </div>`;
}

function bindJobDetail(j) {
  // Status changes
  document.querySelectorAll('.machine-status-sel').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const machineId = e.target.dataset.machineId;
      try {
        await API.put(`/api/machines/${machineId}`, { status: e.target.value });
        toast('Status updated', 'success');
        await loadJobDetail();
      } catch(err) { toast('Failed to update', 'error'); }
    });
  });

  // Image upload
  document.querySelectorAll('.img-upload').forEach(input => {
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const machineId = e.target.dataset.machineId;
      const fd = new FormData();
      fd.append('image', file);
      try {
        toast('Uploading...', 'info');
        await API.post(`/api/machines/${machineId}/images`, fd, {
          headers: { 'Content-Type': 'multipart/form-data' }
        });
        toast('Image uploaded', 'success');
        await loadJobDetail();
      } catch(err) { toast('Upload failed', 'error'); }
    });
  });

  // Add machine
  document.getElementById('btn-add-machine')?.addEventListener('click', () => showAddMachineModal(j.id));

  // Edit machine
  document.querySelectorAll('.btn-edit-machine').forEach(btn => {
    btn.addEventListener('click', () => {
      const machine = j.machines.find(m => m.id == btn.dataset.machineId);
      if (machine) showEditMachineModal(machine);
    });
  });

  // Delete machine
  document.querySelectorAll('.btn-del-machine').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this machine?')) return;
      try {
        await API.delete(`/api/machines/${btn.dataset.machineId}`);
        toast('Machine deleted', 'success');
        await loadJobDetail();
      } catch(e) { toast('Delete failed', 'error'); }
    });
  });

  // Delete job
  document.getElementById('btn-del-job')?.addEventListener('click', async () => {
    if (!confirm(`Delete job ${j.id}? This cannot be undone.`)) return;
    try {
      await API.delete(`/api/jobs/${j.id}`);
      toast(`Job ${j.id} deleted`, 'success');
      navigate('dashboard');
    } catch(e) { toast('Delete failed', 'error'); }
  });

  // Deliver
  document.getElementById('btn-deliver')?.addEventListener('click', () => showDeliveryModal(j));

  // Job card
  document.getElementById('btn-jobcard')?.addEventListener('click', () => generateJobCard(j));

  // Share
  document.getElementById('btn-share-reg')?.addEventListener('click', () => shareJob(j));
}

function showAddMachineModal(jobId) {
  showModal(`
    <h3 style="margin:0 0 16px;font-size:17px;font-weight:700;color:#1a1a2e;">Add Machine</h3>
    <div style="margin-bottom:12px;">
      <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Product Name *</label>
      <input id="am-product" type="text" placeholder="e.g. Samsung AC"
        style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:12px;">
      <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Complaint</label>
      <textarea id="am-complaint" rows="2" placeholder="Describe the issue..."
        style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;resize:none;"></textarea>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:12px;">
      ${isAdmin() ? `
      <div style="flex:1;">
        <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Charges ₹</label>
        <input id="am-charges" type="number" min="0" placeholder="0"
          style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;">
      </div>` : ''}
      <div style="flex:1;">
        <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Quantity</label>
        <input id="am-qty" type="number" min="1" value="1"
          style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;">
      </div>
    </div>
    <div style="margin-bottom:16px;">
      <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Assign Staff</label>
      <select id="am-staff" style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;">
        <option value="">— None —</option>
        ${STATE.staff.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
      </select>
    </div>
    <div style="display:flex;gap:10px;">
      <button onclick="closeModal()" style="flex:1;padding:12px;background:#f5f5f5;color:#555;border:none;border-radius:8px;font-size:14px;cursor:pointer;">Cancel</button>
      <button id="am-save" style="flex:2;padding:12px;background:#e94560;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">Save Machine</button>
    </div>
  `);
  document.getElementById('am-save')?.addEventListener('click', async () => {
    const product = document.getElementById('am-product')?.value.trim();
    if (!product) { toast('Product name required', 'error'); return; }
    try {
      await API.post(`/api/jobs/${jobId}/machines`, {
        product_name: product,
        product_complaint: document.getElementById('am-complaint')?.value.trim()||null,
        charges: isAdmin() ? (parseFloat(document.getElementById('am-charges')?.value)||0) : 0,
        quantity: parseInt(document.getElementById('am-qty')?.value)||1,
        assigned_staff_id: document.getElementById('am-staff')?.value || null,
      });
      closeModal();
      toast('Machine added', 'success');
      await loadJobDetail();
    } catch(e) { toast('Failed', 'error'); }
  });
}

function showEditMachineModal(m) {
  showModal(`
    <h3 style="margin:0 0 16px;font-size:17px;font-weight:700;color:#1a1a2e;">Edit Machine</h3>
    <div style="margin-bottom:12px;">
      <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Product Name *</label>
      <input id="em-product" type="text" value="${m.product_name}"
        style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:12px;">
      <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Complaint</label>
      <textarea id="em-complaint" rows="2"
        style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;resize:none;">${m.product_complaint||''}</textarea>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:16px;">
      ${isAdmin() ? `
      <div style="flex:1;">
        <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Charges ₹</label>
        <input id="em-charges" type="number" min="0" value="${m.charges||0}"
          style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;">
      </div>` : ''}
      <div style="flex:1;">
        <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Quantity</label>
        <input id="em-qty" type="number" min="1" value="${m.quantity||1}"
          style="width:100%;padding:12px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;">
      </div>
    </div>
    <div style="display:flex;gap:10px;">
      <button onclick="closeModal()" style="flex:1;padding:12px;background:#f5f5f5;color:#555;border:none;border-radius:8px;font-size:14px;cursor:pointer;">Cancel</button>
      <button id="em-save" style="flex:2;padding:12px;background:#e94560;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">Update</button>
    </div>
  `);
  document.getElementById('em-save')?.addEventListener('click', async () => {
    try {
      await API.put(`/api/machines/${m.id}`, {
        product_name: document.getElementById('em-product')?.value.trim(),
        product_complaint: document.getElementById('em-complaint')?.value.trim()||null,
        charges: isAdmin() ? (parseFloat(document.getElementById('em-charges')?.value)||0) : undefined,
        quantity: parseInt(document.getElementById('em-qty')?.value)||1,
      });
      closeModal();
      toast('Updated', 'success');
      await loadJobDetail();
    } catch(e) { toast('Failed', 'error'); }
  });
}

function showDeliveryModal(j) {
  showModal(`
    <h3 style="margin:0 0 16px;font-size:17px;font-weight:700;color:#1a1a2e;">Mark as Delivered</h3>
    <div style="margin-bottom:14px;">
      <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:8px;">Delivery Method *</label>
      <div style="display:flex;gap:10px;">
        <label style="flex:1;padding:12px;border:2px solid #e9ecef;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:8px;">
          <input type="radio" name="dm" value="in_person" checked style="accent-color:#e94560;">
          <span style="font-size:14px;font-weight:600;">In Person</span>
        </label>
        <label style="flex:1;padding:12px;border:2px solid #e9ecef;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:8px;">
          <input type="radio" name="dm" value="courier" style="accent-color:#e94560;">
          <span style="font-size:14px;font-weight:600;">Courier</span>
        </label>
      </div>
    </div>
    <div id="courier-fields" style="display:none;">
      <div style="margin-bottom:10px;">
        <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Courier Name</label>
        <input id="dm-courier" type="text" placeholder="e.g. DTDC, BlueDart"
          style="width:100%;padding:10px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;">
      </div>
      <div style="margin-bottom:10px;">
        <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Tracking #</label>
        <input id="dm-tracking" type="text" placeholder="Tracking number"
          style="width:100%;padding:10px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;">
      </div>
      <div style="margin-bottom:10px;">
        <label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Delivery Address</label>
        <textarea id="dm-address" rows="2"
          style="width:100%;padding:10px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;resize:none;"></textarea>
      </div>
    </div>
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button onclick="closeModal()" style="flex:1;padding:12px;background:#f5f5f5;color:#555;border:none;border-radius:8px;font-size:14px;cursor:pointer;">Cancel</button>
      <button id="dm-save" style="flex:2;padding:12px;background:#2196F3;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">
        <i class="fas fa-check" style="margin-right:6px;"></i>Confirm Delivery
      </button>
    </div>
  `);
  document.querySelectorAll('input[name="dm"]').forEach(radio => {
    radio.addEventListener('change', () => {
      document.getElementById('courier-fields').style.display = radio.value === 'courier' ? 'block' : 'none';
    });
  });
  document.getElementById('dm-save')?.addEventListener('click', async () => {
    const method = document.querySelector('input[name="dm"]:checked')?.value || 'in_person';
    try {
      await API.put(`/api/jobs/${j.id}`, {
        status: 'delivered',
        delivery_method: method,
        delivery_courier_name: document.getElementById('dm-courier')?.value || null,
        delivery_tracking: document.getElementById('dm-tracking')?.value || null,
        delivery_address: document.getElementById('dm-address')?.value || null,
        delivered_at: new Date().toISOString(),
      });
      closeModal();
      toast('Job marked as delivered!', 'success');
      await loadJobDetail();
    } catch(e) { toast('Failed', 'error'); }
  });
}

async function deleteImage(imageId) {
  if (!confirm('Remove this image?')) return;
  try {
    await API.delete(`/api/images/${imageId}`);
    toast('Image removed', 'success');
    await loadJobDetail();
  } catch(e) { toast('Failed', 'error'); }
}

// ── Job Card ────────────────────────────────────────────────────────────────
function renderJobCardHTML(j) {
  const color = statusColor(j.status);
  const totalCharges = (j.machines||[]).reduce((s, m) => s + (parseFloat(m.charges)||0), 0);
  return `
  <div style="width:1080px;height:1920px;background:#fff;font-family:'Segoe UI',Arial,sans-serif;position:relative;overflow:hidden;">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1a1a2e,#0f3460);height:260px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;">
      <div style="width:90px;height:90px;background:linear-gradient(135deg,#e94560,#c62a47);border-radius:22px;display:flex;align-items:center;justify-content:center;margin-bottom:16px;">
        <span style="color:#fff;font-size:50px;">⚡</span>
      </div>
      <div style="color:#fff;font-size:32px;font-weight:800;letter-spacing:2px;">ADITION ELECTRIC</div>
      <div style="color:rgba(255,255,255,0.7);font-size:18px;margin-top:6px;">SERVICE SOLUTION</div>
    </div>
    <!-- Job ID Banner -->
    <div style="background:${color};padding:24px;text-align:center;">
      <div style="color:#fff;font-size:48px;font-weight:900;letter-spacing:4px;">${j.id}</div>
      <div style="color:rgba(255,255,255,0.9);font-size:22px;font-weight:600;margin-top:6px;">${statusLabel(j.status).toUpperCase()}</div>
    </div>
    <!-- Customer Info -->
    <div style="padding:40px 50px;">
      <div style="font-size:20px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:2px;margin-bottom:20px;">Customer Details</div>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:10px 0;font-size:22px;color:#555;width:160px;">Name</td><td style="padding:10px 0;font-size:24px;font-weight:700;color:#1a1a2e;">${j.snap_name}</td></tr>
        <tr><td style="padding:10px 0;font-size:22px;color:#555;">Mobile</td><td style="padding:10px 0;font-size:24px;font-weight:700;color:#1565c0;">${j.snap_mobile}${j.snap_mobile2?' / '+j.snap_mobile2:''}</td></tr>
        ${j.snap_address ? `<tr><td style="padding:10px 0;font-size:22px;color:#555;">Address</td><td style="padding:10px 0;font-size:22px;color:#333;">${j.snap_address}</td></tr>` : ''}
        <tr><td style="padding:10px 0;font-size:22px;color:#555;">Date</td><td style="padding:10px 0;font-size:22px;color:#333;">${fmtDate(j.created_at)}</td></tr>
      </table>
    </div>
    <!-- Divider -->
    <div style="border-top:3px solid #f0f0f0;margin:0 50px;"></div>
    <!-- Machines -->
    <div style="padding:30px 50px;">
      <div style="font-size:20px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:2px;margin-bottom:20px;">Products Registered</div>
      ${(j.machines||[]).map((m, i) => `
      <div style="background:#f8f9fa;border-radius:14px;padding:24px;margin-bottom:16px;border-left:6px solid ${statusColor(m.status)};">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-size:26px;font-weight:700;color:#1a1a2e;">${i+1}. ${m.product_name}</div>
            ${m.product_complaint ? `<div style="font-size:20px;color:#666;margin-top:6px;">${m.product_complaint}</div>` : ''}
            ${m.quantity > 1 ? `<div style="font-size:18px;color:#888;margin-top:4px;">Qty: ${m.quantity}</div>` : ''}
          </div>
          <div style="background:${statusBg(m.status)};border:2px solid ${statusColor(m.status)};border-radius:8px;padding:8px 16px;">
            <span style="color:${statusColor(m.status)};font-size:18px;font-weight:700;">${statusLabel(m.status)}</span>
          </div>
        </div>
        ${(m.images||[]).length > 0 ? `
        <div style="display:flex;gap:12px;margin-top:16px;overflow:hidden;">
          ${(m.images||[]).slice(0,3).map(img => `<img src="${img.url}" style="width:120px;height:120px;border-radius:10px;object-fit:cover;" />`).join('')}
        </div>` : ''}
      </div>`).join('')}
    </div>
    <!-- Note -->
    ${j.note ? `<div style="padding:0 50px 20px;"><div style="background:#fff3cd;border-radius:10px;padding:20px;font-size:20px;color:#856404;"><b>Note:</b> ${j.note}</div></div>` : ''}
    <!-- Collection Notice -->
    <div style="margin:0 50px;background:#fff8e1;border:2px solid #FFC107;border-radius:14px;padding:28px;">
      <div style="font-size:22px;font-weight:700;color:#e65100;margin-bottom:8px;">⚠️ Collection Notice</div>
      <div style="font-size:20px;color:#555;line-height:1.6;">Kindly collect your machine(s) within <b>25 days</b> from the date of registration. After this period, we shall not be held liable for any claims, loss, or damage to uncollected items.</div>
    </div>
    <!-- Spacer -->
    <div style="flex:1;"></div>
    <!-- Footer -->
    <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(135deg,#1a1a2e,#0f3460);padding:40px 50px;">
      <div style="color:#fff;font-size:22px;font-weight:700;margin-bottom:8px;">✨ adition™ since 1984</div>
      <div style="color:rgba(255,255,255,0.7);font-size:18px;margin-bottom:6px;">Opposite Metropolitan Court Gate 2, Gheekanta, Ahmedabad 380001</div>
      <div style="color:rgba(255,255,255,0.5);font-size:16px;">Subjected to Ahmedabad Jurisdiction only</div>
    </div>
  </div>`;
}

async function generateJobCard(j) {
  toast('Generating job card...', 'info');
  try {
    const el = document.getElementById('job-card-canvas');
    if (!el) { toast('Error: card element not found', 'error'); return; }
    const canvas = await html2canvas(el, {
      scale: 2, useCORS: true, allowTaint: true,
      width: 1080, height: 1920,
      backgroundColor: '#ffffff',
    });
    canvas.toBlob(async (blob) => {
      const file = new File([blob], `AES_${j.id}.jpg`, { type: 'image/jpeg' });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: `Job ${j.id}`, text: getShareMessage(j) });
        } catch(e) {
          downloadBlob(blob, `AES_${j.id}.jpg`);
        }
      } else {
        downloadBlob(blob, `AES_${j.id}.jpg`);
        toast('Job card downloaded!', 'success');
      }
    }, 'image/jpeg', 0.92);
  } catch(e) {
    console.error(e);
    toast('Failed to generate job card', 'error');
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getShareMessage(j) {
  if (j.status === 'delivered') {
    return `🌟 *Dear Customer,*\n✅ Your product(s) under *Job No. ${j.id}* have been completed and delivered.\n🙏 Thank you for your business and we look forward to serving you again.\n— *ADITION ELECTRIC SOLUTION*\n✨ _adition™ since 1984_ 📍 Gheekanta, Ahmedabad`;
  }
  return `🌟 *Dear Customer,*\n✅ Your product(s) has been successfully registered with us under *Job No. ${j.id}*\n📦 Kindly collect your machine(s) within *25 days* from the date of this message.\n⚠️ *Note:* After 25 days, we shall not be held liable for any claims, loss, or damage to uncollected items.\n🙏 Thank you for choosing *ADITION ELECTRIC SOLUTION*!\n— *Bilal Pathan* Operations Manager\n✨ _adition™ since 1984_ 📍 Gheekanta, Ahmedabad`;
}

async function shareJob(j) {
  const text = getShareMessage(j);
  // Generate card first then share
  try {
    const el = document.getElementById('job-card-canvas');
    if (el && window.html2canvas) {
      const canvas = await html2canvas(el, {
        scale: 2, useCORS: true, allowTaint: true,
        width: 1080, height: 1920, backgroundColor: '#ffffff',
      });
      canvas.toBlob(async (blob) => {
        const file = new File([blob], `AES_${j.id}.jpg`, { type: 'image/jpeg' });
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: `Job ${j.id}`, text });
            return;
          } catch(e) {}
        }
        // Fallback: copy to clipboard + download
        try { await navigator.clipboard.writeText(text); toast('Message copied!', 'success'); } catch(e) {}
        downloadBlob(blob, `AES_${j.id}.jpg`);
      }, 'image/jpeg', 0.92);
    } else {
      if (navigator.share) {
        await navigator.share({ title: `Job ${j.id}`, text });
      } else {
        await navigator.clipboard.writeText(text);
        toast('Message copied to clipboard', 'success');
      }
    }
  } catch(e) {
    toast('Share not available. Message copied!', 'info');
    try { await navigator.clipboard.writeText(text); } catch(e2) {}
  }
}

// ── Staff Panel ────────────────────────────────────────────────────────────
function renderStaff() {
  return `
  <div style="padding:16px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h2 style="margin:0;font-size:18px;font-weight:700;color:#1a1a2e;">Staff Panel</h2>
      <button id="btn-add-staff" style="background:#e94560;color:#fff;border:none;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">
        + Add Staff
      </button>
    </div>
    <div id="staff-list" style="display:flex;flex-direction:column;gap:10px;">
      <div style="text-align:center;padding:20px;color:#aaa;"><i class="fas fa-spinner fa-spin"></i></div>
    </div>
  </div>`;
}

async function loadStaff() {
  try {
    const r = await API.get('/api/staff');
    STATE.staff = r.data;
    const container = document.getElementById('staff-list');
    if (!container) return;
    if (!STATE.staff.length) {
      container.innerHTML = '<p style="text-align:center;color:#aaa;padding:20px;font-size:14px;">No staff members yet</p>';
      return;
    }
    container.innerHTML = STATE.staff.map(s => `
    <div style="background:#fff;border-radius:10px;padding:14px;box-shadow:0 2px 6px rgba(0,0,0,0.07);display:flex;align-items:center;gap:12px;">
      <div style="width:44px;height:44px;border-radius:50%;background:${s.role==='admin'?'#e94560':'#1565c0'};
        display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="fas fa-user" style="color:#fff;font-size:18px;"></i>
      </div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:15px;font-weight:700;color:#1a1a2e;">${s.name}</div>
        <div style="font-size:12px;color:#777;">${s.email}</div>
        <div style="display:flex;gap:6px;margin-top:4px;">
          <span style="font-size:11px;padding:2px 8px;border-radius:10px;
            background:${s.role==='admin'?'#ffebee':'#e3f2fd'};color:${s.role==='admin'?'#e94560':'#1565c0'};font-weight:600;">
            ${s.role}
          </span>
          <span style="font-size:11px;padding:2px 8px;border-radius:10px;
            background:${s.active?'#e8f5e9':'#fafafa'};color:${s.active?'#388e3c':'#aaa'};font-weight:600;">
            ${s.active?'Active':'Inactive'}
          </span>
        </div>
      </div>
      <button data-staff-id="${s.id}" class="btn-edit-staff"
        style="background:#fff3e0;color:#FF9800;border:1px solid #FF9800;padding:8px 12px;border-radius:8px;font-size:12px;cursor:pointer;">
        <i class="fas fa-edit"></i>
      </button>
    </div>`).join('');

    container.querySelectorAll('.btn-edit-staff').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = STATE.staff.find(x => x.id == btn.dataset.staffId);
        if (s) showEditStaffModal(s);
      });
    });

    document.getElementById('btn-add-staff')?.addEventListener('click', showAddStaffModal);
  } catch(e) { toast('Failed to load staff', 'error'); }
}

function showAddStaffModal() {
  showModal(`
    <h3 style="margin:0 0 16px;font-size:17px;font-weight:700;color:#1a1a2e;">Add Staff Member</h3>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Name *</label>
        <input id="as-name" type="text" placeholder="Full name" style="width:100%;padding:11px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;"></div>
      <div><label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Email *</label>
        <input id="as-email" type="email" placeholder="email@example.com" style="width:100%;padding:11px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;"></div>
      <div><label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Password *</label>
        <input id="as-pass" type="password" placeholder="Set password" style="width:100%;padding:11px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;"></div>
      <div><label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Role</label>
        <select id="as-role" style="width:100%;padding:11px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;">
          <option value="staff">Staff (View Only)</option>
          <option value="admin">Admin (Full Access)</option>
        </select>
      </div>
      <div style="display:flex;gap:10px;margin-top:4px;">
        <button onclick="closeModal()" style="flex:1;padding:12px;background:#f5f5f5;color:#555;border:none;border-radius:8px;font-size:14px;cursor:pointer;">Cancel</button>
        <button id="as-save" style="flex:2;padding:12px;background:#e94560;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">Add Staff</button>
      </div>
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
    } catch(e) { toast(e.response?.data?.error || 'Failed', 'error'); }
  });
}

function showEditStaffModal(s) {
  showModal(`
    <h3 style="margin:0 0 16px;font-size:17px;font-weight:700;color:#1a1a2e;">Edit Staff: ${s.name}</h3>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div><label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Name</label>
        <input id="es-name" type="text" value="${s.name}" style="width:100%;padding:11px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;"></div>
      <div><label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">New Password (leave blank to keep)</label>
        <input id="es-pass" type="password" placeholder="New password" style="width:100%;padding:11px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;"></div>
      <div><label style="font-size:13px;font-weight:600;color:#555;display:block;margin-bottom:6px;">Role</label>
        <select id="es-role" style="width:100%;padding:11px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;">
          <option value="staff" ${s.role==='staff'?'selected':''}>Staff</option>
          <option value="admin" ${s.role==='admin'?'selected':''}>Admin</option>
        </select></div>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="es-active" type="checkbox" ${s.active?'checked':''} style="width:18px;height:18px;accent-color:#e94560;">
        <label for="es-active" style="font-size:14px;font-weight:600;color:#555;cursor:pointer;">Active</label>
      </div>
      <div style="display:flex;gap:10px;margin-top:4px;">
        <button onclick="closeModal()" style="flex:1;padding:12px;background:#f5f5f5;color:#555;border:none;border-radius:8px;font-size:14px;cursor:pointer;">Cancel</button>
        <button id="es-save" style="flex:2;padding:12px;background:#e94560;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">Update</button>
      </div>
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
    } catch(e) { toast('Failed', 'error'); }
  });
}

// ── Reports ────────────────────────────────────────────────────────────────
function renderReports() {
  return `
  <div style="padding:16px;display:flex;flex-direction:column;gap:12px;">
    <!-- Full Backup -->
    <div style="background:#fff;border-radius:12px;padding:18px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <h3 style="font-size:16px;font-weight:700;color:#1a1a2e;margin:0 0 12px;">
        <i class="fas fa-database" style="color:#4CAF50;margin-right:8px;"></i>Backup & Restore
      </h3>
      <p style="font-size:13px;color:#777;margin:0 0 12px;">Export all data to Excel for backup or import a previous backup.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a href="/api/backup/export" id="btn-export" download
          style="flex:1;min-width:120px;padding:10px;background:#4CAF50;color:#fff;border-radius:8px;font-size:13px;font-weight:600;text-align:center;text-decoration:none;">
          <i class="fas fa-download" style="margin-right:4px;"></i>Export XLSX
        </a>
        <label style="flex:1;min-width:120px;padding:10px;background:#FF9800;color:#fff;border-radius:8px;font-size:13px;font-weight:600;text-align:center;cursor:pointer;">
          <i class="fas fa-upload" style="margin-right:4px;"></i>Import XLSX
          <input id="import-file" type="file" accept=".xlsx" style="display:none;">
        </label>
      </div>
    </div>

    <!-- Job Summary -->
    <div style="background:#fff;border-radius:12px;padding:18px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <h3 style="font-size:16px;font-weight:700;color:#1a1a2e;margin:0 0 12px;">
        <i class="fas fa-chart-bar" style="color:#2196F3;margin-right:8px;"></i>Job Summary Report
      </h3>
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <div style="flex:1;"><label style="font-size:12px;color:#777;display:block;margin-bottom:4px;">From</label>
          <input id="js-from" type="date" style="width:100%;padding:8px;border:2px solid #e9ecef;border-radius:8px;font-size:13px;outline:none;box-sizing:border-box;"></div>
        <div style="flex:1;"><label style="font-size:12px;color:#777;display:block;margin-bottom:4px;">To</label>
          <input id="js-to" type="date" style="width:100%;padding:8px;border:2px solid #e9ecef;border-radius:8px;font-size:13px;outline:none;box-sizing:border-box;"></div>
      </div>
      <button id="btn-job-report" style="width:100%;padding:10px;background:#2196F3;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">
        <i class="fas fa-file-excel" style="margin-right:4px;"></i>Download Report
      </button>
    </div>

    <!-- Staff Report -->
    <div style="background:#fff;border-radius:12px;padding:18px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <h3 style="font-size:16px;font-weight:700;color:#1a1a2e;margin:0 0 12px;">
        <i class="fas fa-user-chart" style="color:#9C27B0;margin-right:8px;"></i>Staff Work Report
      </h3>
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <div style="flex:1;"><label style="font-size:12px;color:#777;display:block;margin-bottom:4px;">From</label>
          <input id="sr-from" type="date" style="width:100%;padding:8px;border:2px solid #e9ecef;border-radius:8px;font-size:13px;outline:none;box-sizing:border-box;"></div>
        <div style="flex:1;"><label style="font-size:12px;color:#777;display:block;margin-bottom:4px;">To</label>
          <input id="sr-to" type="date" style="width:100%;padding:8px;border:2px solid #e9ecef;border-radius:8px;font-size:13px;outline:none;box-sizing:border-box;"></div>
      </div>
      <div style="margin-bottom:10px;">
        <label style="font-size:12px;color:#777;display:block;margin-bottom:4px;">Staff Member (optional)</label>
        <select id="sr-staff" style="width:100%;padding:8px;border:2px solid #e9ecef;border-radius:8px;font-size:13px;outline:none;box-sizing:border-box;">
          <option value="">All Staff</option>
          ${STATE.staff.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
        </select>
      </div>
      <button id="btn-staff-report" style="width:100%;padding:10px;background:#9C27B0;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">
        <i class="fas fa-file-excel" style="margin-right:4px;"></i>Download Report
      </button>
    </div>

    <!-- Cleanup -->
    <div style="background:#fff;border-radius:12px;padding:18px;box-shadow:0 2px 8px rgba(0,0,0,0.08);border:1px solid #ffcdd2;">
      <h3 style="font-size:16px;font-weight:700;color:#e94560;margin:0 0 12px;">
        <i class="fas fa-trash-alt" style="margin-right:8px;"></i>Data Cleanup
      </h3>
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <div style="flex:1;"><label style="font-size:12px;color:#777;display:block;margin-bottom:4px;">From Date</label>
          <input id="cl-from" type="date" style="width:100%;padding:8px;border:2px solid #e9ecef;border-radius:8px;font-size:13px;outline:none;box-sizing:border-box;"></div>
        <div style="flex:1;"><label style="font-size:12px;color:#777;display:block;margin-bottom:4px;">To Date</label>
          <input id="cl-to" type="date" style="width:100%;padding:8px;border:2px solid #e9ecef;border-radius:8px;font-size:13px;outline:none;box-sizing:border-box;"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button id="btn-cleanup-range" style="flex:1;min-width:120px;padding:10px;background:#FF9800;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">
          Delete by Date Range
        </button>
        <button id="btn-full-reset" style="flex:1;min-width:120px;padding:10px;background:#F44336;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">
          ⚠️ Full Reset
        </button>
      </div>
    </div>
  </div>`;
}

function bindReports() {
  // Export
  const exportBtn = document.getElementById('btn-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const a = document.createElement('a');
      a.href = '/api/backup/export';
      a.click();
    });
  }

  // Import
  document.getElementById('import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Import backup? This will overwrite existing records.')) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      toast('Restoring...', 'info');
      const r = await API.post('/api/backup/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast(`Restored ${r.data.restored?.jobs||0} jobs`, 'success');
    } catch(e) { toast('Import failed', 'error'); }
  });

  // Job summary report
  document.getElementById('btn-job-report')?.addEventListener('click', () => {
    const from = document.getElementById('js-from')?.value;
    const to = document.getElementById('js-to')?.value;
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const a = document.createElement('a');
    a.href = `/api/reports/jobs?${params.toString()}`;
    a.click();
  });

  // Staff report
  document.getElementById('btn-staff-report')?.addEventListener('click', () => {
    const from = document.getElementById('sr-from')?.value;
    const to = document.getElementById('sr-to')?.value;
    const staffId = document.getElementById('sr-staff')?.value;
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (staffId) params.set('staff_id', staffId);
    const a = document.createElement('a');
    a.href = `/api/reports/staff?${params.toString()}`;
    a.click();
  });

  // Cleanup range
  document.getElementById('btn-cleanup-range')?.addEventListener('click', async () => {
    const from = document.getElementById('cl-from')?.value;
    const to = document.getElementById('cl-to')?.value;
    if (!from || !to) { toast('Select date range', 'error'); return; }
    if (!confirm(`Delete all jobs from ${from} to ${to}?`)) return;
    try {
      const r = await API.delete('/api/cleanup', { data: { from, to } });
      toast(`Deleted ${r.data.deleted} jobs`, 'success');
    } catch(e) { toast('Failed', 'error'); }
  });

  // Full reset
  document.getElementById('btn-full-reset')?.addEventListener('click', async () => {
    if (!confirm('⚠️ FULL RESET: Delete ALL jobs, machines, customers and reset job counter to C-001?\n\nThis CANNOT be undone!')) return;
    if (!confirm('Are you absolutely sure? Type "RESET" to confirm.')) return;
    try {
      await API.delete('/api/cleanup', { data: { full_reset: true } });
      toast('Full reset complete. Job counter reset to C-001.', 'success');
    } catch(e) { toast('Failed', 'error'); }
  });
}

// ── Settings ───────────────────────────────────────────────────────────────
function renderSettings() {
  return `
  <div style="padding:16px;display:flex;flex-direction:column;gap:12px;">
    <div style="background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;">
        <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#e94560,#c62a47);
          display:flex;align-items:center;justify-content:center;">
          <i class="fas fa-user" style="color:#fff;font-size:24px;"></i>
        </div>
        <div>
          <div style="font-size:18px;font-weight:700;color:#1a1a2e;">${STATE.user.name}</div>
          <div style="font-size:13px;color:#777;">${STATE.user.email}</div>
          <div style="font-size:12px;margin-top:4px;background:${isAdmin()?'#ffebee':'#e3f2fd'};
            color:${isAdmin()?'#e94560':'#1565c0'};display:inline-block;padding:2px 10px;border-radius:10px;font-weight:600;">
            ${STATE.user.role?.toUpperCase()}
          </div>
        </div>
      </div>
      <button onclick="logout()" style="width:100%;padding:12px;background:#ffebee;color:#e94560;
        border:1px solid #e94560;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;">
        <i class="fas fa-sign-out-alt" style="margin-right:8px;"></i>Sign Out
      </button>
    </div>

    <div style="background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <h3 style="font-size:16px;font-weight:700;color:#1a1a2e;margin:0 0 12px;">About</h3>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f0f0;">
          <span style="font-size:14px;color:#555;">Business</span>
          <span style="font-size:14px;font-weight:600;color:#1a1a2e;">ADITION ELECTRIC SOLUTION</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f0f0;">
          <span style="font-size:14px;color:#555;">Version</span>
          <span style="font-size:14px;font-weight:600;color:#1a1a2e;">v2.0</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f0f0;">
          <span style="font-size:14px;color:#555;">Address</span>
          <span style="font-size:12px;font-weight:600;color:#555;text-align:right;max-width:200px;">Gheekanta, Ahmedabad 380001</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:8px 0;">
          <span style="font-size:14px;color:#555;">Jurisdiction</span>
          <span style="font-size:14px;font-weight:600;color:#e94560;">Ahmedabad Only</span>
        </div>
      </div>
    </div>

    <!-- PWA Install -->
    <div id="pwa-install-section" style="display:none;background:#e3f2fd;border-radius:12px;padding:16px;border:1px solid #bbdefb;">
      <h3 style="font-size:15px;font-weight:700;color:#1565c0;margin:0 0 8px;">
        <i class="fas fa-mobile-alt" style="margin-right:6px;"></i>Install as App
      </h3>
      <p style="font-size:13px;color:#1565c0;margin:0 0 10px;">Add ADITION Electric to your home screen for quick access.</p>
      <button id="btn-install-pwa" style="width:100%;padding:10px;background:#1565c0;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">
        Install App
      </button>
    </div>
  </div>`;
}

// ── Bind View ──────────────────────────────────────────────────────────────
function bindCurrentView() {
  switch(STATE.currentView) {
    case 'dashboard':
      loadDashboard();
      break;
    case 'newjob':
      bindNewJob();
      break;
    case 'detail':
      loadJobDetail();
      if (isAdmin()) loadStaffForSelects();
      break;
    case 'staff':
      loadStaff();
      break;
    case 'reports':
      if (isAdmin()) loadStaff().then(() => {});
      bindReports();
      break;
    case 'settings':
      setupPWAInstall();
      break;
  }
}

async function loadStaffForSelects() {
  try {
    if (!STATE.staff.length) {
      const r = await API.get('/api/staff');
      STATE.staff = r.data;
    }
  } catch(e) {}
}

// ── PWA Install ────────────────────────────────────────────────────────────
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const section = document.getElementById('pwa-install-section');
  if (section) section.style.display = 'block';
});

function setupPWAInstall() {
  setTimeout(() => {
    const section = document.getElementById('pwa-install-section');
    const btn = document.getElementById('btn-install-pwa');
    if (deferredPrompt && section) {
      section.style.display = 'block';
      btn?.addEventListener('click', async () => {
        deferredPrompt.prompt();
        const result = await deferredPrompt.userChoice;
        if (result.outcome === 'accepted') {
          deferredPrompt = null;
          section.style.display = 'none';
          toast('App installed!', 'success');
        }
      });
    }
  }, 100);
}

// ── Service Worker ─────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── Init ───────────────────────────────────────────────────────────────────
// Expose globals needed in inline onclick handlers
window.navigate = navigate;
window.logout = logout;
window.applyFilter = applyFilter;
window.closeModal = closeModal;
window.deleteImage = deleteImage;

// Start
render();

})();
