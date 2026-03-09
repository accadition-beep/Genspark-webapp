// adition PWA — app.js v10.2
// Admin: acc.adition@gmail.com / 0010
// Staff: staff1–staff4 / same as username

const API_BASE   = '';
const OWNER_EMAIL = 'acc.adition@gmail.com';
const IDB_NAME   = 'adition-offline';
const IDB_VER    = 4;
const SYNC_TAG   = 'adition-sync';

/* ─── State ─────────────────────────────────────────────── */
let authToken = null, userRole = null, userEmail = null, staffName = null;
let allJobs = [], filteredJobs = [], deliveredJobs = [], filteredDelivered = [];
let currentTab = 'active';
let confirmCallback = null;
let customerCache = {};
let idb = null;

/* ─── IDB ────────────────────────────────────────────────── */
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('queue')) {
        const s = db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
        s.createIndex('status_idx', 'status');
      }
      if (!db.objectStoreNames.contains('meta'))    db.createObjectStore('meta',    { keyPath: 'key' });
      if (!db.objectStoreNames.contains('offline_data')) db.createObjectStore('offline_data', { keyPath: 'key' });
    };
    req.onsuccess  = e => { idb = e.target.result; resolve(idb); };
    req.onerror    = ()  => reject(req.error);
  });
}
async function idbGet(store, key) {
  const db = idb || await openIDB();
  return new Promise(r => { const req = db.transaction(store,'readonly').objectStore(store).get(key); req.onsuccess = e => r(e.target.result); req.onerror = () => r(null); });
}
async function idbPut(store, val) {
  const db = idb || await openIDB();
  return new Promise(r => { const req = db.transaction(store,'readwrite').objectStore(store).put(val); req.onsuccess = () => r(); req.onerror = () => r(); });
}
async function idbGetAll(store) {
  const db = idb || await openIDB();
  return new Promise(r => { const items = []; const req = db.transaction(store,'readonly').objectStore(store).openCursor(); req.onsuccess = e => { const c = e.target.result; if (c) { items.push(c.value); c.continue(); } else r(items); }; req.onerror = () => r([]); });
}
async function idbDelete(store, key) {
  const db = idb || await openIDB();
  return new Promise(r => { const req = db.transaction(store,'readwrite').objectStore(store).delete(key); req.onsuccess = () => r(); req.onerror = () => r(); });
}
async function saveAuthToIDB(token) { await idbPut('meta', { key: 'auth_token', value: token }); }
async function clearAuthFromIDB()   { await idbDelete('meta', 'auth_token'); }

/* ─── Queue ──────────────────────────────────────────────── */
async function enqueueRequest(url, method, body) {
  const db = idb || await openIDB();
  await new Promise(r => { const req = db.transaction('queue','readwrite').objectStore('queue').add({ url, method, body: JSON.stringify(body), status: 'pending', ts: Date.now() }); req.onsuccess = () => r(); req.onerror = () => r(); });
  updateSyncBadge();
}
async function updateSyncBadge() {
  const items = await idbGetAll('queue');
  const pending = items.filter(i => i.status === 'pending').length;
  const badge = document.getElementById('sync-badge');
  if (badge) { const sc = document.getElementById('sync-count'); if (sc) sc.textContent = pending; badge.classList.toggle('visible', pending > 0); }
}
async function manualSync() {
  if (!navigator.onLine) { showToast('Still offline — sync queued', 'warning'); return; }
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SYNC_NOW' });
    showToast('Sync started…', 'info');
  } else {
    await flushQueueDirect();
  }
}
async function flushQueueDirect() {
  const items = await idbGetAll('queue');
  const pending = items.filter(i => i.status === 'pending');
  if (!pending.length) return;
  let synced = 0;
  for (const item of pending) {
    try {
      const resp = await fetch(item.url, { method: item.method, headers: { 'Content-Type': 'application/json', 'Authorization': authToken ? `Bearer ${authToken}` : '' }, body: item.body || undefined });
      if (resp.ok || resp.status === 409 || resp.status === 400) { await idbDelete('queue', item.id); synced++; }
      else if (resp.status === 401 || resp.status === 403) break;
    } catch { break; }
  }
  if (synced > 0) { showToast(`Synced ${synced} item(s)`, 'success'); await loadJobs(); }
  updateSyncBadge();
}

/* ─── Helpers ────────────────────────────────────────────── */
function authHeaders() { return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }; }
function showToast(msg, type = 'success', dur = 3000) {
  const t = document.getElementById('toast'); if (!t) return;
  t.className = `fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] px-5 py-3 rounded-xl shadow-2xl text-sm font-semibold text-white max-w-sm text-center transition-all`;
  const colors = { success: '#16a34a', error: '#dc2626', warning: '#d97706', info: '#1e40af' };
  t.style.background = colors[type] || colors.info;
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._tid); t._tid = setTimeout(() => t.classList.add('hidden'), dur);
}
function showConfirm(title, msg, cb) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = msg;
  confirmCallback = cb;
  openModal('confirm-dialog');
}
function openModal(id)  { const m = document.getElementById(id); if (m) m.classList.remove('hidden'); }
function closeModal(id) { const m = document.getElementById(id); if (m) m.classList.add('hidden'); }
function fmtDate(d) { if (!d) return '—'; try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return d; } }
function fmtDateTime(d) { if (!d) return '—'; try { return new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return d; } }
function fmtCurrency(n) { return '₹' + (parseFloat(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
function statusBadge(s) {
  const map = { 'Under Repair': 'status-under-repair', 'Repaired': 'status-repaired', 'Return': 'status-return', 'Delivered': 'status-delivered' };
  const icon = { 'Under Repair': '🔴', 'Repaired': '🟢', 'Return': '🟡', 'Delivered': '🔵' };
  return `<span class="status-badge ${map[s] || 'status-under-repair'}">${icon[s] || '⚪'} ${s}</span>`;
}
function togglePwd() {
  const el = document.getElementById('login-password'); const ic = document.getElementById('eye-icon');
  if (el.type === 'password') { el.type = 'text'; ic.classList.replace('fa-eye', 'fa-eye-slash'); }
  else { el.type = 'password'; ic.classList.replace('fa-eye-slash', 'fa-eye'); }
}

/* ─── Auth ───────────────────────────────────────────────── */
function tryRestoreSession() {
  const token = localStorage.getItem('adition_token');
  const role   = localStorage.getItem('adition_role');
  const email  = localStorage.getItem('adition_email');
  const name   = localStorage.getItem('adition_name');
  if (token && role) {
    authToken = token; userRole = role; userEmail = email; staffName = name;
    showApp();
    return true;
  }
  return false;
}
function handleLogout() {
  authToken = null; userRole = null; userEmail = null; staffName = null;
  localStorage.removeItem('adition_token'); localStorage.removeItem('adition_role');
  localStorage.removeItem('adition_email'); localStorage.removeItem('adition_name');
  clearAuthFromIDB();
  allJobs = []; filteredJobs = []; deliveredJobs = []; filteredDelivered = [];
  document.getElementById('app-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('login-error').classList.add('hidden');
}

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const emailVal = document.getElementById('login-email').value.trim();
  const passVal  = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  const spinner  = document.getElementById('login-spinner');
  const btnText  = document.getElementById('login-btn-text');
  const btn      = document.getElementById('login-submit-btn');

  errEl.classList.add('hidden');
  spinner.classList.remove('hidden'); btnText.textContent = 'Signing in…'; btn.disabled = true;

  try {
    const resp = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailVal, username: emailVal, password: passVal })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Login failed');

    authToken = data.token; userRole = data.role;
    userEmail = data.email || emailVal; staffName = data.staff_name || '';
    localStorage.setItem('adition_token', authToken);
    localStorage.setItem('adition_role',  userRole);
    localStorage.setItem('adition_email', userEmail);
    localStorage.setItem('adition_name',  staffName);
    await saveAuthToIDB(authToken);
    showApp();
  } catch (err) {
    errEl.textContent = err.message || 'Invalid credentials'; errEl.classList.remove('hidden');
  } finally {
    spinner.classList.add('hidden'); btnText.textContent = 'Sign In'; btn.disabled = false;
  }
});

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-screen').classList.remove('hidden');
  const navInfo = document.getElementById('nav-user-info');
  if (navInfo) navInfo.textContent = userRole === 'admin' ? (userEmail || 'Admin') : (staffName || 'Staff');

  const roleBadge = document.getElementById('role-badge');
  if (roleBadge) {
    roleBadge.textContent = userRole === 'admin' ? '⚡ Admin' : '🔧 Staff';
    roleBadge.className = `text-xs font-semibold px-2 py-1 rounded-full ${userRole === 'admin' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`;
    roleBadge.classList.remove('hidden');
  }

  const isAdmin = userRole === 'admin';
  document.querySelectorAll('.admin-only-el').forEach(el => {
    if (isAdmin) el.classList.remove('hidden'); else el.classList.add('hidden');
  });
  const adminToolsBtn = document.getElementById('admin-tools-btn');
  const reportBtn     = document.getElementById('report-btn');
  const newJobBtn     = document.getElementById('new-job-btn');
  const deliveredTab  = document.getElementById('tab-delivered');
  if (adminToolsBtn) adminToolsBtn.classList.toggle('hidden', !isAdmin);
  if (reportBtn)     reportBtn.classList.toggle('hidden', !isAdmin);
  if (newJobBtn)     newJobBtn.classList.remove('hidden');
  if (deliveredTab)  deliveredTab.classList.toggle('hidden', !isAdmin);
  if (isAdmin) {
    const cs = document.getElementById('cleanup-section');
    const rs = document.getElementById('reset-seq-section');
    const rsf = document.getElementById('report-staff-filter-row');
    if (cs && userEmail === OWNER_EMAIL) cs.classList.remove('hidden');
    if (rs && userEmail === OWNER_EMAIL) rs.classList.remove('hidden');
    if (rsf) rsf.classList.remove('hidden');
  }
  loadJobs();
  updateSyncBadge();
}

/* ─── API fetch with offline fallback ───────────────────── */
async function apiFetch(url, opts = {}) {
  if (!navigator.onLine) {
    if (opts.method && opts.method !== 'GET') {
      await enqueueRequest(API_BASE + url, opts.method, opts.body ? JSON.parse(opts.body) : null);
      throw new Error('offline_queued');
    }
    throw new Error('You are offline');
  }
  const resp = await fetch(API_BASE + url, { ...opts, headers: authHeaders() });
  if (resp.status === 401) { handleLogout(); throw new Error('Session expired'); }
  return resp;
}

/* ─── Jobs ───────────────────────────────────────────────── */
async function loadJobs() {
  const loadingEl = document.getElementById('loading-indicator');
  const emptyEl   = document.getElementById('empty-state');
  const container = document.getElementById('jobs-container');
  if (loadingEl) loadingEl.classList.remove('hidden');
  if (emptyEl)   emptyEl.classList.add('hidden');
  if (container) container.innerHTML = '';
  try {
    const resp = await apiFetch('/api/jobs');
    const data = await resp.json();
    allJobs = data.filter(j => !j.all_delivered);
    deliveredJobs = data.filter(j => j.all_delivered);
    updateJobCountText();
    filterJobs();
    filterDelivered();
  } catch (err) {
    if (err.message !== 'offline_queued') showToast(err.message || 'Failed to load jobs', 'error');
  } finally {
    if (loadingEl) loadingEl.classList.add('hidden');
  }
}

function updateJobCountText() {
  const el = document.getElementById('job-count-text');
  if (!el) return;
  const act = allJobs.length;
  const del = deliveredJobs.length;
  el.textContent = userRole === 'admin'
    ? `${act} active job${act !== 1 ? 's' : ''} · ${del} delivered`
    : `${act} assigned job${act !== 1 ? 's' : ''}`;
  const atc = document.getElementById('active-tab-count');
  const dtc = document.getElementById('delivered-tab-count');
  if (atc) atc.textContent = act;
  if (dtc) dtc.textContent = del;
}

function filterJobs() {
  const q    = (document.getElementById('search-input')?.value || '').toLowerCase();
  const st   = document.getElementById('status-filter')?.value || '';
  const sf   = document.getElementById('staff-filter')?.value  || '';
  filteredJobs = allJobs.filter(j => {
    const matchSearch = !q || j.job_id?.toLowerCase().includes(q) || j.customer_name?.toLowerCase().includes(q) ||
      j.machines?.some(m => m.description?.toLowerCase().includes(q));
    const matchStatus = !st || j.machines?.some(m => m.status === st);
    const matchStaff  = !sf || j.machines?.some(m => m.assigned_to === sf);
    return matchSearch && matchStatus && matchStaff;
  });
  renderJobs(filteredJobs, 'jobs-container');
}

function filterDelivered() {
  const q = (document.getElementById('delivered-search')?.value || '').toLowerCase();
  filteredDelivered = deliveredJobs.filter(j => !q || j.job_id?.toLowerCase().includes(q) || j.customer_name?.toLowerCase().includes(q));
  if (currentTab === 'delivered') renderJobs(filteredDelivered, 'jobs-container');
}

function onStatusFilterChange() {
  filterJobs();
}

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tab-active').classList.toggle('active', tab === 'active');
  document.getElementById('tab-delivered').classList.toggle('active', tab === 'delivered');
  const afb = document.getElementById('active-filter-bar');
  const dfb = document.getElementById('delivered-filter-bar');
  if (afb) afb.classList.toggle('hidden', tab !== 'active');
  if (dfb) dfb.classList.toggle('hidden', tab !== 'delivered');
  const emptyEl = document.getElementById('empty-state');
  const container = document.getElementById('jobs-container');
  if (emptyEl)   emptyEl.classList.add('hidden');
  if (container) container.innerHTML = '';
  if (tab === 'active')    renderJobs(filteredJobs,     'jobs-container');
  else                     renderJobs(filteredDelivered, 'jobs-container');
}

function renderJobs(jobs, containerId) {
  const container = document.getElementById(containerId);
  const emptyEl   = document.getElementById('empty-state');
  if (!container) return;
  if (!jobs.length) { container.innerHTML = ''; if (emptyEl) emptyEl.classList.remove('hidden'); return; }
  if (emptyEl) emptyEl.classList.add('hidden');
  container.innerHTML = jobs.map(j => buildJobCard(j)).join('');
}

function buildJobCard(job) {
  const isAdmin = userRole === 'admin';
  const allDelivered = job.all_delivered;
  const machines = job.machines || [];
  const machinesHtml = machines.length ? machines.map(m => buildMachineRow(m, job.job_id)).join('') : `<p class="text-gray-400 text-xs text-center py-4">No machines yet</p>`;

  let adminBadgeHtml = '';
  if (isAdmin) {
    adminBadgeHtml = `<span class="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2 py-1 rounded-lg">
      Grand: ${fmtCurrency(job.grand_total || 0)} · Paid: ${fmtCurrency(job.amount_received || 0)} · Bal: ${fmtCurrency(job.balance || 0)}
    </span>`;
  }

  const canDeliver = isAdmin && !allDelivered && job.all_repaired && machines.length > 0;
  const deliverBtn = canDeliver ? `<button onclick="openDelivery('${job.job_id}')" class="action-btn-sm bg-indigo-600 text-white hover:bg-indigo-700"><i class="fas fa-truck"></i> Deliver</button>` : '';

  const mobileHtml = isAdmin && job.customer_mobile ? `<span class="text-xs text-gray-400">${job.customer_mobile}</span>` : '';
  const addrHtml   = isAdmin && job.customer_address ? `<span class="text-xs text-gray-400">${job.customer_address}</span>` : '';

  const editBtn   = isAdmin ? `<button onclick="openEditJob('${job.job_id}')" class="action-btn bg-yellow-50 text-yellow-600 hover:bg-yellow-100" title="Edit Job"><i class="fas fa-edit text-xs"></i></button>` : '';
  const deleteBtn = isAdmin && userEmail === OWNER_EMAIL ? `<button onclick="deleteJob('${job.job_id}')" class="action-btn bg-red-50 text-red-500 hover:bg-red-100" title="Delete Job"><i class="fas fa-trash text-xs"></i></button>` : '';
  const addMachineBtn = isAdmin ? `<button onclick="openAddMachine('${job.job_id}')" class="action-btn-sm bg-blue-50 text-blue-600 hover:bg-blue-100"><i class="fas fa-plus text-xs"></i> Machine</button>` : '';
  const printBtn = isAdmin ? `<button onclick="generateJobCardImage('${job.job_id}')" class="action-btn-sm bg-green-50 text-green-600 hover:bg-green-100"><i class="fas fa-image text-xs"></i> JPG</button>` : '';

  const cardBg = allDelivered ? 'job-card-delivered' : 'bg-white';

  return `<div class="${cardBg} rounded-xl border border-gray-200 shadow-sm overflow-hidden" id="job-card-${job.job_id}">
    <div class="flex items-start justify-between p-4 pb-3">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap mb-1">
          <span class="font-black text-blue-600 text-base">${job.job_id}</span>
          ${allDelivered ? `<span class="status-badge status-delivered">🔵 Delivered</span>` : ''}
          ${job.all_repaired && !allDelivered ? `<span class="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full font-semibold">Ready to deliver</span>` : ''}
        </div>
        <p class="font-bold text-gray-800 text-sm">${job.customer_name}</p>
        <div class="flex flex-wrap gap-2 mt-0.5">${mobileHtml}${addrHtml}</div>
        ${job.notes ? `<p class="text-xs text-gray-400 mt-1 italic">${job.notes}</p>` : ''}
      </div>
      <div class="flex items-center gap-1 ml-2">
        ${editBtn}${deleteBtn}
      </div>
    </div>
    ${isAdmin ? `<div class="px-4 pb-2 flex items-center justify-between flex-wrap gap-2">
      ${adminBadgeHtml}
      <span class="text-xs text-gray-400">${fmtDate(job.created_at)}</span>
    </div>` : `<div class="px-4 pb-2"><span class="text-xs text-gray-400">${fmtDate(job.created_at)}</span></div>`}
    <div class="border-t border-gray-100 divide-y divide-gray-50">${machinesHtml}</div>
    <div class="flex items-center gap-2 px-4 py-3 border-t border-gray-100 flex-wrap">
      ${addMachineBtn}${deliverBtn}${printBtn}
    </div>
  </div>`;
}

function buildMachineRow(m, jobId) {
  const isAdmin = userRole === 'admin';
  const imgHtml = m.image_data ? `<img src="${m.image_data}" class="thumb-img" onclick="viewImage('${m.image_data.replace(/'/g,"\\'")}')">` : '';
  const priceHtml = isAdmin ? `<span class="text-xs text-gray-500">${fmtCurrency(m.unit_price||0)} × ${m.quantity||1} = ${fmtCurrency((m.unit_price||0)*(m.quantity||1))}</span>` : '';
  const editMachineBtn = (isAdmin || m.assigned_to === staffName) ? `<button onclick="openEditMachine('${jobId}','${m.id}')" class="action-btn-sm bg-gray-50 text-gray-600 hover:bg-gray-100"><i class="fas fa-edit text-xs"></i> Edit</button>` : '';
  const delMachineBtn = isAdmin && userEmail === OWNER_EMAIL ? `<button onclick="deleteMachine('${jobId}','${m.id}')" class="action-btn bg-red-50 text-red-400 hover:bg-red-100" title="Delete"><i class="fas fa-trash text-xs"></i></button>` : '';
  const assignedHtml = m.assigned_to ? `<span class="assigned-badge">${m.assigned_to}</span>` : '';

  return `<div class="flex items-center gap-3 px-4 py-3" id="machine-row-${m.id}">
    ${imgHtml}
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="font-semibold text-gray-800 text-sm">${m.description}</span>
        ${statusBadge(m.status)}
        ${assignedHtml}
      </div>
      ${m.condition_text ? `<p class="text-xs text-gray-400 mt-0.5">${m.condition_text}</p>` : ''}
      ${priceHtml}
    </div>
    <div class="flex items-center gap-1">${editMachineBtn}${delMachineBtn}</div>
  </div>`;
}

/* ─── New Job ─────────────────────────────────────────────── */
function openNewJobModal() {
  document.getElementById('new-customer-name').value = '';
  document.getElementById('new-customer-mobile').value = '';
  document.getElementById('new-customer-address').value = '';
  document.getElementById('new-notes').value = '';
  openModal('new-job-modal');
  setTimeout(() => document.getElementById('new-customer-name').focus(), 100);
  setupAutocomplete('new-customer-mobile', 'new-customer-name', 'new-customer-address');
}

async function createJob() {
  const name  = document.getElementById('new-customer-name').value.trim();
  const mobile= document.getElementById('new-customer-mobile').value.trim();
  const addr  = document.getElementById('new-customer-address').value.trim();
  const notes = document.getElementById('new-notes').value.trim();
  if (!name) { showToast('Customer name required', 'error'); return; }
  const spinner = document.getElementById('create-job-spinner');
  const btnText = document.getElementById('create-job-btn-text');
  spinner.classList.remove('hidden'); btnText.textContent = 'Creating…';
  try {
    const resp = await apiFetch('/api/jobs', { method: 'POST', body: JSON.stringify({ customer_name: name, customer_mobile: mobile || null, customer_address: addr || null, notes: notes || null }) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);
    if (mobile) { try { await apiFetch('/api/customers/upsert', { method: 'POST', body: JSON.stringify({ name, mobile, address: addr || null }) }); } catch {} }
    closeModal('new-job-modal');
    showToast(`Job ${data.job_id} created!`, 'success');
    await loadJobs();
  } catch (err) {
    if (err.message === 'offline_queued') { closeModal('new-job-modal'); showToast('Queued for sync', 'warning'); }
    else showToast(err.message || 'Failed', 'error');
  } finally {
    spinner.classList.add('hidden'); btnText.textContent = 'Create Job';
  }
}

/* ─── Edit Job ────────────────────────────────────────────── */
function openEditJob(jobId) {
  const job = allJobs.find(j => j.job_id === jobId) || deliveredJobs.find(j => j.job_id === jobId);
  if (!job) return;
  document.getElementById('edit-job-id').value = jobId;
  document.getElementById('edit-customer-name').value = job.customer_name || '';
  document.getElementById('edit-customer-mobile').value = job.customer_mobile || '';
  document.getElementById('edit-customer-address').value = job.customer_address || '';
  document.getElementById('edit-amount-received').value = job.amount_received || 0;
  document.getElementById('edit-notes').value = job.notes || '';
  openModal('edit-job-modal');
}

async function saveJobEdit() {
  const jobId = document.getElementById('edit-job-id').value;
  const body = {
    customer_name:    document.getElementById('edit-customer-name').value.trim(),
    customer_mobile:  document.getElementById('edit-customer-mobile').value.trim(),
    customer_address: document.getElementById('edit-customer-address').value.trim(),
    amount_received:  parseFloat(document.getElementById('edit-amount-received').value) || 0,
    notes:            document.getElementById('edit-notes').value.trim()
  };
  if (!body.customer_name) { showToast('Name required', 'error'); return; }
  try {
    const resp = await apiFetch(`/api/jobs/${jobId}`, { method: 'PUT', body: JSON.stringify(body) });
    if (!resp.ok) throw new Error((await resp.json()).error);
    closeModal('edit-job-modal');
    showToast('Job updated', 'success');
    await loadJobs();
  } catch (err) {
    showToast(err.message || 'Failed', 'error');
  }
}

/* ─── Delete Job ──────────────────────────────────────────── */
function deleteJob(jobId) {
  showConfirm('Delete Job', `Delete ${jobId} and all its machines? This cannot be undone.`, async () => {
    try {
      const resp = await apiFetch(`/api/jobs/${jobId}`, { method: 'DELETE', body: '{}' });
      if (!resp.ok) throw new Error((await resp.json()).error);
      showToast(`${jobId} deleted`, 'success');
      await loadJobs();
    } catch (err) {
      showToast(err.message || 'Failed', 'error');
    }
  });
}

/* ─── Machine Modal ──────────────────────────────────────── */
let currentMachineJobId = null, currentMachineId = null;

function openAddMachine(jobId) {
  currentMachineJobId = jobId; currentMachineId = null;
  document.getElementById('machine-modal-title').innerHTML = '<i class="fas fa-plus-circle text-blue-500 mr-2"></i>Add Machine';
  document.getElementById('machine-desc').value = '';
  document.getElementById('machine-condition').value = '';
  document.getElementById('machine-qty').value = '1';
  document.getElementById('machine-price').value = '0';
  document.getElementById('machine-assigned-to').value = '';
  document.getElementById('machine-status').value = 'Under Repair';
  document.getElementById('machine-work-done').value = '';
  document.getElementById('machine-return-reason').value = '';
  removeImage();
  const isAdmin = userRole === 'admin';
  document.getElementById('price-qty-row').classList.toggle('hidden', !isAdmin);
  document.getElementById('assigned-to-row').classList.toggle('hidden', !isAdmin);
  document.getElementById('image-upload-row').classList.remove('hidden');
  document.getElementById('work-done-row').classList.add('hidden');
  document.getElementById('return-reason-row').classList.add('hidden');
  document.getElementById('machine-save-btn-text').textContent = 'Add Machine';
  openModal('machine-modal');
}

function openEditMachine(jobId, machineId) {
  currentMachineJobId = jobId; currentMachineId = machineId;
  const job = allJobs.find(j => j.job_id === jobId) || deliveredJobs.find(j => j.job_id === jobId);
  const m   = job?.machines?.find(m => String(m.id) === String(machineId));
  if (!m) return;
  document.getElementById('machine-modal-title').innerHTML = '<i class="fas fa-edit text-yellow-500 mr-2"></i>Edit Machine';
  document.getElementById('machine-desc').value = m.description || '';
  document.getElementById('machine-condition').value = m.condition_text || '';
  document.getElementById('machine-qty').value = m.quantity || 1;
  document.getElementById('machine-price').value = m.unit_price || 0;
  document.getElementById('machine-assigned-to').value = m.assigned_to || '';
  document.getElementById('machine-status').value = m.status || 'Under Repair';
  document.getElementById('machine-work-done').value = m.work_done || '';
  document.getElementById('machine-return-reason').value = m.return_reason || '';
  const isAdmin = userRole === 'admin';
  document.getElementById('price-qty-row').classList.toggle('hidden', !isAdmin);
  document.getElementById('assigned-to-row').classList.toggle('hidden', !isAdmin);
  document.getElementById('image-upload-row').classList.remove('hidden');
  if (m.image_data) {
    document.getElementById('machine-image-preview').src = m.image_data;
    document.getElementById('machine-image-preview').classList.remove('hidden');
    document.getElementById('image-preview-container').classList.add('hidden');
    document.getElementById('remove-image-btn').classList.remove('hidden');
  } else { removeImage(); }
  onMachineStatusChange(document.getElementById('machine-status'));
  document.getElementById('machine-save-btn-text').textContent = 'Save Changes';
  openModal('machine-modal');
}

function onMachineStatusChange(sel) {
  const s = sel.value;
  document.getElementById('work-done-row').classList.toggle('hidden', s !== 'Repaired');
  document.getElementById('return-reason-row').classList.toggle('hidden', s !== 'Return');
}

async function handleImageUpload(input) {
  const file = input.files[0]; if (!file) return;
  const preview = document.getElementById('machine-image-preview');
  const container = document.getElementById('image-preview-container');
  const removeBtn = document.getElementById('remove-image-btn');
  // Compress to JPEG with scale 5 (high quality for WhatsApp sharing)
  const b64 = await compressImageToBase64(file, 1200, 0.88);
  preview.src = b64; preview.classList.remove('hidden');
  container.classList.add('hidden'); removeBtn.classList.remove('hidden');
}
function removeImage() {
  document.getElementById('machine-image-preview').src = '';
  document.getElementById('machine-image-preview').classList.add('hidden');
  document.getElementById('image-preview-container').classList.remove('hidden');
  document.getElementById('remove-image-btn').classList.add('hidden');
  document.getElementById('machine-image-input').value = '';
}
function compressImageToBase64(file, maxDim, quality) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else        { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function saveMachine() {
  const desc = document.getElementById('machine-desc').value.trim();
  if (!desc) { showToast('Description required', 'error'); return; }
  const status = document.getElementById('machine-status').value;
  const workDone = document.getElementById('machine-work-done').value.trim();
  const returnReason = document.getElementById('machine-return-reason').value.trim();
  if (status === 'Repaired' && !workDone) { showToast('Work done is required for Repaired status', 'error'); return; }
  if (status === 'Return'   && !returnReason) { showToast('Return reason is required', 'error'); return; }

  const imgPreview = document.getElementById('machine-image-preview');
  const imgData = imgPreview.classList.contains('hidden') ? null : (imgPreview.src || null);

  const body = {
    description:   desc,
    condition_text: document.getElementById('machine-condition').value.trim() || null,
    quantity:       parseInt(document.getElementById('machine-qty').value) || 1,
    unit_price:     parseFloat(document.getElementById('machine-price').value) || 0,
    assigned_to:    document.getElementById('machine-assigned-to').value || null,
    status,
    work_done:      workDone || null,
    return_reason:  returnReason || null,
    image_data:     imgData
  };

  const spinner = document.getElementById('machine-save-spinner');
  const btnText = document.getElementById('machine-save-btn-text');
  spinner.classList.remove('hidden'); btnText.textContent = 'Saving…';
  try {
    let resp;
    if (currentMachineId) {
      resp = await apiFetch(`/api/jobs/${currentMachineJobId}/machines/${currentMachineId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      resp = await apiFetch(`/api/jobs/${currentMachineJobId}/machines`, { method: 'POST', body: JSON.stringify(body) });
    }
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);
    closeModal('machine-modal');
    showToast(currentMachineId ? 'Machine updated' : 'Machine added', 'success');
    await loadJobs();
  } catch (err) {
    if (err.message === 'offline_queued') { closeModal('machine-modal'); showToast('Queued for sync', 'warning'); }
    else showToast(err.message || 'Failed', 'error');
  } finally {
    spinner.classList.add('hidden'); btnText.textContent = currentMachineId ? 'Save Changes' : 'Add Machine';
  }
}

function deleteMachine(jobId, machineId) {
  showConfirm('Delete Machine', 'Remove this machine from the job?', async () => {
    try {
      const resp = await apiFetch(`/api/jobs/${jobId}/machines/${machineId}`, { method: 'DELETE', body: '{}' });
      if (!resp.ok) throw new Error((await resp.json()).error);
      showToast('Machine removed', 'success');
      await loadJobs();
    } catch (err) {
      showToast(err.message || 'Failed', 'error');
    }
  });
}

function viewImage(src) {
  document.getElementById('image-viewer-img').src = src;
  openModal('image-viewer-modal');
}

/* ─── Delivery ────────────────────────────────────────────── */
function openDelivery(jobId) {
  document.getElementById('delivery-job-id').value = jobId;
  document.getElementById('delivery-job-id-label').textContent = jobId;
  document.getElementById('delivery-name').value = '';
  document.getElementById('delivery-mobile').value = '';
  document.getElementById('delivery-relation').value = '';
  document.getElementById('delivery-service').value = '';
  document.getElementById('delivery-tracking').value = '';
  document.getElementById('delivery-driver').value = '';
  document.getElementById('delivery-driver-contact').value = '';
  setDeliveryType('in_person');
  openModal('delivery-modal');
}
function setDeliveryType(type) {
  document.getElementById('delivery-type').value = type;
  const ip = document.getElementById('delivery-inperson-fields');
  const co = document.getElementById('delivery-courier-fields');
  const bi = document.getElementById('btn-inperson');
  const bc = document.getElementById('btn-courier');
  if (type === 'in_person') {
    ip.classList.remove('hidden'); co.classList.add('hidden');
    bi.className = 'flex-1 bg-indigo-600 text-white rounded-lg py-2 text-sm font-semibold';
    bc.className = 'flex-1 border border-gray-200 text-gray-600 rounded-lg py-2 text-sm font-medium hover:bg-gray-50';
  } else {
    ip.classList.add('hidden'); co.classList.remove('hidden');
    bc.className = 'flex-1 bg-indigo-600 text-white rounded-lg py-2 text-sm font-semibold';
    bi.className = 'flex-1 border border-gray-200 text-gray-600 rounded-lg py-2 text-sm font-medium hover:bg-gray-50';
  }
}
async function confirmDelivery() {
  const jobId = document.getElementById('delivery-job-id').value;
  const type  = document.getElementById('delivery-type').value;
  let delivery_info;
  if (type === 'in_person') {
    delivery_info = { type: 'in_person', name: document.getElementById('delivery-name').value.trim(), mobile: document.getElementById('delivery-mobile').value.trim(), relation: document.getElementById('delivery-relation').value.trim() };
  } else {
    const service = document.getElementById('delivery-service').value.trim();
    const tracking = document.getElementById('delivery-tracking').value.trim();
    if (!service || !tracking) { showToast('Service and tracking ID required', 'error'); return; }
    delivery_info = { type: 'courier', service, tracking_id: tracking, driver: document.getElementById('delivery-driver').value.trim(), driver_contact: document.getElementById('delivery-driver-contact').value.trim() };
  }
  try {
    const resp = await apiFetch(`/api/jobs/${jobId}/deliver`, { method: 'POST', body: JSON.stringify({ delivery_info }) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);
    closeModal('delivery-modal');
    showToast(`${jobId} delivered!`, 'success');
    await loadJobs();
  } catch (err) {
    showToast(err.message || 'Delivery failed', 'error');
  }
}

/* ─── Admin Tools ────────────────────────────────────────── */
function openAdminTools() {
  openModal('admin-tools-modal');
  loadQueueList();
}

async function loadQueueList() {
  const items = await idbGetAll('queue');
  const pending = items.filter(i => i.status === 'pending');
  const el = document.getElementById('queue-list');
  if (!el) return;
  if (!pending.length) { el.innerHTML = '<p class="text-xs text-gray-400 text-center py-2">Queue empty</p>'; return; }
  el.innerHTML = pending.map(i => `<div class="flex items-center gap-2 text-xs bg-white rounded-lg p-2 border border-amber-100">
    <i class="fas fa-clock text-amber-400"></i>
    <span class="flex-1 truncate">${i.method} ${i.url}</span>
    <span class="text-gray-400">${new Date(i.ts).toLocaleTimeString()}</span>
  </div>`).join('');
  updateSyncBadge();
}

async function exportData() {
  const from  = document.getElementById('export-from').value;
  const to    = document.getElementById('export-to').value;
  const month = document.getElementById('export-month').value;
  let url = '/api/admin/export?';
  if (month) url += `month=${month}`;
  else if (from && to) url += `from=${from}&to=${to}`;
  try {
    const resp = await apiFetch(url);
    const { jobs, machines } = await resp.json();
    const rows = [];
    rows.push(['job_id','customer_name','customer_mobile','customer_address','amount_received','notes','created_at',
               'machine_id','description','condition_text','quantity','unit_price','status','assigned_to','work_done','return_reason','delivery_info','delivered_at','image_data'].join(','));
    for (const j of jobs) {
      const jMachines = machines.filter(m => m.job_id === j.job_id);
      if (!jMachines.length) {
        rows.push([j.job_id,j.customer_name,j.customer_mobile||'',j.customer_address||'',j.amount_received||0,j.notes||'',j.created_at,'','','','','','','','','','','',''].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
      } else {
        for (const m of jMachines) {
          rows.push([j.job_id,j.customer_name,j.customer_mobile||'',j.customer_address||'',j.amount_received||0,j.notes||'',j.created_at,m.id,m.description,m.condition_text||'',m.quantity||1,m.unit_price||0,m.status,m.assigned_to||'',m.work_done||'',m.return_reason||'',m.delivery_info||'',m.delivered_at||'',m.image_data||''].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
        }
      }
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `adition-export-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    showToast('CSV exported', 'success');
  } catch (err) { showToast(err.message || 'Export failed', 'error'); }
}

async function handleRestoreCsv(input) {
  const file = input.files[0]; if (!file) return;
  const text = await file.text();
  const lines = text.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.replace(/"/g,'').trim());
  const jobs = {}, machines = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => row[h] = (cols[idx] || '').replace(/"/g,'').trim());
    if (row.job_id) {
      if (!jobs[row.job_id]) jobs[row.job_id] = { job_id: row.job_id, customer_name: row.customer_name, customer_mobile: row.customer_mobile, customer_address: row.customer_address, amount_received: parseFloat(row.amount_received)||0, notes: row.notes, created_at: row.created_at };
      if (row.machine_id && row.description) machines.push({ job_id: row.job_id, description: row.description, condition_text: row.condition_text, quantity: parseInt(row.quantity)||1, unit_price: parseFloat(row.unit_price)||0, status: row.status||'Under Repair', assigned_to: row.assigned_to||null, work_done: row.work_done||null, return_reason: row.return_reason||null, delivery_info: row.delivery_info||null, delivered_at: row.delivered_at||null, image_data: row.image_data||null, created_at: row.created_at });
    }
  }
  try {
    const resp = await apiFetch('/api/admin/restore', { method: 'POST', body: JSON.stringify({ jobs: Object.values(jobs), machines }) });
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error);
    showToast(`Restored: ${result.upserted_jobs} jobs, ${result.upserted_machines} machines`, 'success');
    await loadJobs();
  } catch (err) { showToast(err.message || 'Restore failed', 'error'); }
  input.value = '';
}
function parseCsvLine(line) {
  const result = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (line[i] === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += line[i];
  }
  result.push(cur); return result;
}

async function cleanupData() {
  const from = document.getElementById('cleanup-from').value;
  const to   = document.getElementById('cleanup-to').value;
  if (!from || !to) { showToast('Select date range', 'error'); return; }
  showConfirm('Delete Jobs', `Delete all jobs from ${from} to ${to}? Cannot be undone.`, async () => {
    try {
      const resp = await apiFetch('/api/admin/cleanup', { method: 'POST', body: JSON.stringify({ from, to }) });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      showToast(`Deleted ${data.deleted} jobs`, 'success');
      closeModal('admin-tools-modal'); await loadJobs();
    } catch (err) { showToast(err.message || 'Failed', 'error'); }
  });
}

async function resetSequence() {
  showConfirm('Reset Sequence', 'Reset job ID sequence to 0?', async () => {
    try {
      const resp = await apiFetch('/api/admin/reset-sequence', { method: 'POST', body: '{}' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      showToast('Sequence reset', 'success');
    } catch (err) { showToast(err.message || 'Failed', 'error'); }
  });
}

/* ─── Report Center ──────────────────────────────────────── */
let reportData = [];
function openReportCenter() { openModal('report-modal'); }

async function runReport() {
  const from    = document.getElementById('report-from').value;
  const to      = document.getElementById('report-to').value;
  const month   = document.getElementById('report-month').value;
  const cbs     = Array.from(document.querySelectorAll('.report-status-cb:checked')).map(c => c.value);
  const staff   = document.getElementById('report-staff')?.value || '';
  let url = '/api/admin/report?';
  if (month) url += `month=${month}`;
  else if (from && to) url += `from=${from}&to=${to}`;
  if (cbs.length) url += `&statuses=${cbs.join(',')}`;
  if (staff) url += `&staff=${encodeURIComponent(staff)}`;
  try {
    const resp = await apiFetch(url);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);
    reportData = data.machines || [];
    const { summary } = data;
    document.getElementById('report-result-count').textContent = reportData.length;
    document.getElementById('report-summary-cards').innerHTML = [
      { label: 'Total', value: summary.total, color: 'gray' },
      { label: 'Under Repair', value: summary.under_repair, color: 'red' },
      { label: 'Repaired', value: summary.repaired, color: 'green' },
      { label: 'Delivered', value: summary.delivered, color: 'indigo' },
      { label: 'Revenue', value: fmtCurrency(summary.total_revenue), color: 'blue' },
    ].map(s => `<div class="bg-${s.color}-50 rounded-xl p-3 text-center"><p class="text-xs text-gray-500">${s.label}</p><p class="text-lg font-bold text-${s.color}-700">${s.value}</p></div>`).join('');
    document.getElementById('report-table-body').innerHTML = reportData.map(m => `<tr class="hover:bg-gray-50 border-b border-gray-50">
      <td class="px-3 py-2">${m.job_id}</td>
      <td class="px-3 py-2">${m.customer_name||'—'}</td>
      <td class="px-3 py-2">${m.description}</td>
      <td class="px-3 py-2">${statusBadge(m.status)}</td>
      <td class="px-3 py-2">${m.assigned_to||'—'}</td>
      <td class="px-3 py-2 report-admin-col ${userRole==='admin'?'':'hidden'}">${fmtCurrency(m.unit_price||0)}</td>
      <td class="px-3 py-2">${fmtDate(m.created_at)}</td>
    </tr>`).join('');
    document.getElementById('report-summary').classList.remove('hidden');
    document.getElementById('report-empty').classList.add('hidden');
  } catch (err) { showToast(err.message || 'Report failed', 'error'); }
}

function exportReportCsv() {
  if (!reportData.length) return;
  const rows = [['Job ID','Customer','Description','Status','Assigned','Unit Price','Date'].join(',')];
  reportData.forEach(m => rows.push([m.job_id, m.customer_name||'', m.description, m.status, m.assigned_to||'', m.unit_price||0, m.created_at].map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')));
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `report-${Date.now()}.csv`; a.click();
}

/* ─── Autocomplete ───────────────────────────────────────── */
function setupAutocomplete(mobileId, nameId, addressId) {
  const mobileEl = document.getElementById(mobileId);
  const nameEl   = document.getElementById(nameId);
  if (!mobileEl) return;
  mobileEl.addEventListener('input', async () => {
    const q = mobileEl.value.trim();
    if (q.length < 3) { closeAutocomplete(); return; }
    try {
      const resp = await apiFetch(`/api/customers/search?q=${encodeURIComponent(q)}`);
      const results = await resp.json();
      if (Array.isArray(results) && results.length) showAutocomplete(results, mobileId, nameId, addressId);
      else closeAutocomplete();
    } catch { closeAutocomplete(); }
  });
  nameEl?.addEventListener('input', async () => {
    const q = nameEl.value.trim();
    if (q.length < 2) { closeAutocomplete(); return; }
    try {
      const resp = await apiFetch(`/api/customers/search?q=${encodeURIComponent(q)}`);
      const results = await resp.json();
      if (Array.isArray(results) && results.length) showAutocomplete(results, mobileId, nameId, addressId);
      else closeAutocomplete();
    } catch { closeAutocomplete(); }
  });
}
function showAutocomplete(results, mobileId, nameId, addressId) {
  const dropdown = document.getElementById('autocomplete-dropdown');
  if (!dropdown) return;
  const mobileEl = document.getElementById(mobileId);
  const rect = mobileEl.getBoundingClientRect();
  dropdown.style.top  = `${rect.bottom + window.scrollY + 4}px`;
  dropdown.style.left = `${rect.left + window.scrollX}px`;
  dropdown.style.width = `${rect.width}px`;
  dropdown.innerHTML = results.map(c => `<div class="px-4 py-3 hover:bg-blue-50 cursor-pointer border-b border-gray-50 last:border-0" onclick="selectCustomer(${JSON.stringify(c).replace(/'/g,"&apos;")},'${mobileId}','${nameId}','${addressId}')">
    <p class="font-semibold text-sm text-gray-800">${c.name}</p>
    <p class="text-xs text-gray-400">${c.mobile}${c.address ? ' · '+c.address : ''}</p>
  </div>`).join('');
  dropdown.classList.remove('hidden');
}
function selectCustomer(c, mobileId, nameId, addressId) {
  const mobileEl = document.getElementById(mobileId);
  const nameEl   = document.getElementById(nameId);
  const addrEl   = document.getElementById(addressId);
  if (mobileEl) mobileEl.value = c.mobile || '';
  if (nameEl)   nameEl.value   = c.name   || '';
  if (addrEl)   addrEl.value   = c.address|| '';
  closeAutocomplete();
}
function closeAutocomplete() {
  const d = document.getElementById('autocomplete-dropdown');
  if (d) d.classList.add('hidden');
}
document.addEventListener('click', e => { if (!e.target.closest('#autocomplete-dropdown')) closeAutocomplete(); });

/* ─── JPG Job Card (WhatsApp quality) ───────────────────── */
async function generateJobCardImage(jobId) {
  const job = allJobs.find(j => j.job_id === jobId) || deliveredJobs.find(j => j.job_id === jobId);
  if (!job) return;

  const spinner = document.getElementById('print-spinner');
  spinner.classList.remove('hidden');

  try {
    // Build HTML content for the card
    const machines = job.machines || [];
    const grandTotal = machines.reduce((s, m) => s + (m.quantity||1) * (m.unit_price||0), 0);
    const balance = grandTotal - (job.amount_received || 0);

    // Pre-load images to base64
    const machinesWithImg = await Promise.all(machines.map(async m => {
      if (m.image_data && m.image_data.startsWith('data:')) return { ...m, _img: m.image_data };
      return { ...m, _img: null };
    }));

    const now = new Date();
    const printDate = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

    const machineRows = machinesWithImg.map((m, i) => {
      const statusColor = { 'Under Repair': '#dc2626', 'Repaired': '#16a34a', 'Return': '#b45309', 'Delivered': '#4338ca' }[m.status] || '#374151';
      const imgTag = m._img ? `<img src="${m._img}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;flex-shrink:0;" />` : '';
      return `<tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:10px 8px;vertical-align:top;font-size:13px;color:#374151;font-weight:600;white-space:nowrap;">${i+1}.</td>
        <td style="padding:10px 8px;vertical-align:top;">
          <div style="display:flex;gap:10px;align-items:flex-start;">
            ${imgTag}
            <div>
              <div style="font-size:13px;font-weight:700;color:#1e293b;">${m.description}</div>
              ${m.condition_text ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">${m.condition_text}</div>` : ''}
              <div style="margin-top:4px;"><span style="background:${statusColor}18;color:${statusColor};border:1px solid ${statusColor}44;border-radius:20px;padding:2px 10px;font-size:10px;font-weight:700;">${m.status}</span></div>
            </div>
          </div>
        </td>
        <td style="padding:10px 8px;text-align:center;font-size:12px;color:#374151;">${m.quantity||1}</td>
        <td style="padding:10px 8px;text-align:right;font-size:12px;color:#374151;">₹${parseFloat(m.unit_price||0).toFixed(0)}</td>
        <td style="padding:10px 8px;text-align:right;font-size:13px;font-weight:700;color:#1e40af;">₹${((m.quantity||1)*(m.unit_price||0)).toFixed(0)}</td>
      </tr>`;
    }).join('');

    const deliveryHtml = job.all_delivered && machines.some(m => m.delivery_info) ? (() => {
      const di = (() => { try { const v = machines.find(m=>m.delivery_info)?.delivery_info; return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } })();
      if (!di) return '';
      if (di.type === 'in_person') return `<div style="background:#f0fdf4;border-radius:8px;padding:10px 14px;margin-top:12px;font-size:12px;color:#166534;">
        <strong>✅ Delivered In Person</strong>${di.name ? ` · ${di.name}` : ''}${di.relation ? ` (${di.relation})` : ''}${di.mobile ? ` · ${di.mobile}` : ''}
      </div>`;
      return `<div style="background:#eff6ff;border-radius:8px;padding:10px 14px;margin-top:12px;font-size:12px;color:#1e40af;">
        <strong>📦 Courier: ${di.service||''}</strong> · Tracking: ${di.tracking_id||''}
      </div>`;
    })() : '';

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Segoe UI', Arial, sans-serif; background: white; }
</style>
</head>
<body>
<div style="width:700px;background:white;padding:28px;min-height:400px;">

  <!-- Header -->
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;padding-bottom:16px;border-bottom:2px solid #1e40af;">
    <div style="display:flex;align-items:center;gap:12px;">
      <div style="width:44px;height:44px;background:#1e40af;border-radius:10px;display:flex;align-items:center;justify-content:center;">
        <span style="color:white;font-size:22px;">⚡</span>
      </div>
      <div>
        <div style="font-size:22px;font-weight:900;color:#1e40af;letter-spacing:-0.5px;">adition</div>
        <div style="font-size:10px;color:#64748b;font-weight:600;letter-spacing:1px;">ELECTRIC SOLUTION · GHEEKANTA, AHMEDABAD</div>
      </div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:20px;font-weight:900;color:#1e40af;">JOB CARD</div>
      <div style="font-size:22px;font-weight:900;color:#1e40af;">${job.job_id}</div>
      <div style="font-size:11px;color:#64748b;">Date: ${printDate}</div>
    </div>
  </div>

  <!-- Customer Info -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;background:#f8fafc;border-radius:10px;padding:14px;">
    <div>
      <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Customer Name</div>
      <div style="font-size:16px;font-weight:800;color:#1e293b;">${job.customer_name}</div>
    </div>
    ${job.customer_mobile ? `<div>
      <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Mobile</div>
      <div style="font-size:14px;font-weight:700;color:#1e293b;">${job.customer_mobile}</div>
    </div>` : '<div></div>'}
    ${job.customer_address ? `<div style="grid-column:1/-1;">
      <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Address</div>
      <div style="font-size:12px;color:#475569;">${job.customer_address}</div>
    </div>` : ''}
    ${job.notes ? `<div style="grid-column:1/-1;">
      <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Notes</div>
      <div style="font-size:12px;color:#64748b;font-style:italic;">${job.notes}</div>
    </div>` : ''}
  </div>

  <!-- Machines Table -->
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
    <thead>
      <tr style="background:#1e40af;">
        <th style="padding:9px 8px;text-align:left;font-size:11px;color:white;font-weight:700;border-radius:6px 0 0 0;">#</th>
        <th style="padding:9px 8px;text-align:left;font-size:11px;color:white;font-weight:700;">Description</th>
        <th style="padding:9px 8px;text-align:center;font-size:11px;color:white;font-weight:700;">Qty</th>
        <th style="padding:9px 8px;text-align:right;font-size:11px;color:white;font-weight:700;">Rate</th>
        <th style="padding:9px 8px;text-align:right;font-size:11px;color:white;font-weight:700;border-radius:0 6px 0 0;">Total</th>
      </tr>
    </thead>
    <tbody>${machineRows || `<tr><td colspan="5" style="text-align:center;padding:20px;color:#94a3b8;font-size:12px;">No machines</td></tr>`}</tbody>
  </table>

  <!-- Totals -->
  <div style="display:flex;justify-content:flex-end;margin-bottom:16px;">
    <div style="background:#f8fafc;border-radius:10px;padding:14px 20px;min-width:240px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
        <span style="font-size:12px;color:#64748b;">Grand Total</span>
        <span style="font-size:14px;font-weight:700;color:#1e293b;">₹${grandTotal.toFixed(0)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
        <span style="font-size:12px;color:#64748b;">Amount Received</span>
        <span style="font-size:14px;font-weight:700;color:#16a34a;">₹${parseFloat(job.amount_received||0).toFixed(0)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding-top:6px;border-top:1px solid #e2e8f0;">
        <span style="font-size:13px;font-weight:700;color:#1e293b;">Balance Due</span>
        <span style="font-size:15px;font-weight:900;color:${balance > 0 ? '#dc2626' : '#16a34a'};">₹${Math.abs(balance).toFixed(0)}${balance < 0 ? ' CR' : ''}</span>
      </div>
    </div>
  </div>

  ${deliveryHtml}

  <!-- Footer -->
  <div style="border-top:1px solid #e2e8f0;padding-top:12px;margin-top:12px;text-align:center;">
    <div style="font-size:10px;color:#64748b;">Subjected to Ahmedabad jurisdiction only</div>
    <div style="font-size:10px;color:#94a3b8;margin-top:3px;">adition™ Electric Solution · Gheekanta, Ahmedabad · Since 1984</div>
  </div>

</div>
</body>
</html>`;

    // Render to canvas using an iframe approach
    await renderHtmlToJpeg(html, job.job_id);

  } catch (err) {
    console.error('JPG generation error:', err);
    showToast('Failed to generate image: ' + (err.message || 'Unknown error'), 'error');
  } finally {
    spinner.classList.add('hidden');
  }
}

async function renderHtmlToJpeg(html, jobId) {
  // Create a hidden iframe, write content, use html2canvas
  const printArea = document.getElementById('print-area');

  // Use a wrapper div approach
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-1;';
  wrapper.innerHTML = html;
  document.body.appendChild(wrapper);

  const target = wrapper.querySelector('div');

  // Wait for images to load
  const imgs = Array.from(wrapper.querySelectorAll('img'));
  await Promise.all(imgs.map(img => new Promise(r => {
    if (img.complete) r();
    else { img.onload = r; img.onerror = r; }
  })));

  try {
    // Use html2canvas if available, else fallback to blob screenshot
    if (typeof html2canvas !== 'undefined') {
      const canvas = await html2canvas(target, {
        scale: 3,           // 3x for high-quality WhatsApp image
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        logging: false,
        width: 700,
        windowWidth: 750,
      });
      canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `job-card-${jobId}.jpg`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        showToast('JPG saved!', 'success');
      }, 'image/jpeg', 0.95);
    } else {
      // Fallback: open in new window for manual save
      const win = window.open('', '_blank');
      win.document.write(html);
      win.document.close();
      showToast('Opened in new tab — right-click to save', 'info', 5000);
    }
  } finally {
    document.body.removeChild(wrapper);
  }
}

/* ─── Online/Offline ─────────────────────────────────────── */
function updateOnlineStatus() {
  const banner = document.getElementById('offline-banner');
  if (banner) banner.classList.toggle('visible', !navigator.onLine);
  if (navigator.onLine) { flushQueueDirect(); }
}
window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

/* ─── Service Worker ─────────────────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      navigator.serviceWorker.addEventListener('message', e => {
        if (e.data?.type === 'SYNC_DONE') { showToast(`Synced ${e.data.count} item(s)`, 'success'); loadJobs(); updateSyncBadge(); }
      });
    }).catch(err => console.warn('SW registration failed:', err));
  });
}

/* ─── html2canvas dynamic loader ────────────────────────── */
function loadHtml2Canvas() {
  return new Promise((resolve) => {
    if (typeof html2canvas !== 'undefined') { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    script.onload = resolve;
    script.onerror = resolve; // fallback even if CDN fails
    document.head.appendChild(script);
  });
}

// Override generateJobCardImage to ensure html2canvas is loaded first
const _originalGenerate = generateJobCardImage;
window.generateJobCardImage = async function(jobId) {
  await loadHtml2Canvas();
  await _originalGenerate(jobId);
};

/* ─── Init ───────────────────────────────────────────────── */
(async function init() {
  await openIDB();
  if (!tryRestoreSession()) {
    document.getElementById('login-screen').classList.remove('hidden');
  }
})();
