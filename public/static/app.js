// adition PWA — app.js v11.1.0
// Admin: acc.adition@gmail.com / 0010  |  Staff: staff1-4 / same as username
// Changes v11.1.0:
//   - Barcode generation (JsBarcode) with download / print / share
//   - Barcode scanner via camera (ZXing) + manual fallback
//   - Bulk job actions: export, archive, select all
//   - Rapid job entry: mobile + name + address + inline machines, one-submit
//   - AI Repair Suggestions from historical data
//   - Audio notes per machine (record → base64 audio_note)
//   - Machine timeline view
//   - Trash page (soft-delete recovery)
//   - Customer lookup modal with job history
//   - System health modal
//   - Customer analytics with overview + date range export
//   - Monthly backup CSV download
//   - Priority alert indicators (>24h pending, RED/GREEN/YELLOW/BLUE badges)
//   - Alert color logic: all repaired→GREEN, courier received→YELLOW, ready dispatch→RED
//   - Staff dashboard: all active jobs, assigned machines highlighted BLUE
//   - Optimistic UI, lazy image loading
//   - Alert sounds for urgent machines (optional)
// Changes v10.5.1:
//   - Backend: POST /api/jobs now returns flat { success:true, job_id, ...fields }
//   - Backend: POST /api/jobs/:id/machines returns { success:true, machine:{...}, ...fields }
//   - Backend: PUT /api/jobs/:id/machines/:mid returns { success:true, machine:{...}, ...fields }
//   - Backend: All endpoints wrapped in try/catch, proper JSON on error (never empty response)
//   - Backend: initDB() runs on every /api/* request — schema always up to date
//   - Backend: DB repair endpoint POST /api/debug/repair migrates production schema
//   - Production: deployed & verified working (Create Job, Add Machine, Update Machine, Deliver)
// Changes v10.4:
//   - Staff sees ALL active jobs (not just assigned), assigned machines highlighted
//   - "Assigned to Me" filter for staff
//   - WhatsApp button always visible (no env check), uses Web Share API with file
//   - Delivery: courier service/tracking optional, only show if filled in job card
//   - Machine save: parse response correctly (success + machine obj)
//   - Delivery job card sharing via Web Share API
//   - Internal Notes field added to machine modal

const API_BASE    = '';
const OWNER_EMAIL = 'acc.adition@gmail.com';
const IDB_NAME    = 'adition-offline';
const IDB_VER     = 4;

/* ─────────────────────────────────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────────────────────────────────── */
let authToken = null, userRole = null, userEmail = null, staffName = null;
let allJobs = [], filteredJobs = [], deliveredJobs = [], filteredDelivered = [];
let currentTab = 'active';
let confirmCallback = null;
let idb = null;
let staffFilterMode = 'all'; // 'all' | 'mine'

/* ─────────────────────────────────────────────────────────────────────────────
   INDEXED DB
───────────────────────────────────────────────────────────────────────────── */
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('queue')) {
        const s = db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
        s.createIndex('status_idx', 'status');
      }
      if (!db.objectStoreNames.contains('meta'))         db.createObjectStore('meta',         { keyPath: 'key' });
      if (!db.objectStoreNames.contains('offline_data')) db.createObjectStore('offline_data', { keyPath: 'key' });
    };
    req.onsuccess = e => { idb = e.target.result; resolve(idb); };
    req.onerror   = ()  => reject(req.error);
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

/* ─────────────────────────────────────────────────────────────────────────────
   OFFLINE QUEUE
───────────────────────────────────────────────────────────────────────────── */
async function enqueueRequest(url, method, body) {
  const db = idb || await openIDB();
  await new Promise(r => {
    const req = db.transaction('queue','readwrite').objectStore('queue')
      .add({ url, method, body: JSON.stringify(body), status: 'pending', ts: Date.now() });
    req.onsuccess = () => r(); req.onerror = () => r();
  });
  updateSyncBadge();
}
async function updateSyncBadge() {
  const items   = await idbGetAll('queue');
  const pending = items.filter(i => i.status === 'pending').length;
  const badge   = document.getElementById('sync-badge');
  if (badge) { const sc = document.getElementById('sync-count'); if (sc) sc.textContent = pending; badge.classList.toggle('visible', pending > 0); }
}
async function manualSync() {
  if (!navigator.onLine) { showToast('Still offline — sync queued', 'warning'); return; }
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SYNC_NOW' });
    showToast('Sync started…', 'info');
  } else { await flushQueueDirect(); }
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

/* ─────────────────────────────────────────────────────────────────────────────
   UTILITY HELPERS
───────────────────────────────────────────────────────────────────────────── */
function authHeaders() { return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }; }

function showToast(msg, type = 'success', dur = 3500) {
  const t = document.getElementById('toast'); if (!t) return;
  const colors = { success: '#16a34a', error: '#dc2626', warning: '#d97706', info: '#1e40af' };
  t.style.background = colors[type] || colors.info;
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._tid); t._tid = setTimeout(() => t.classList.add('hidden'), dur);
}
function showConfirm(title, msg, cb) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = msg;
  confirmCallback = cb; openModal('confirm-dialog');
}
function openModal(id)  { const m = document.getElementById(id); if (m) m.classList.remove('hidden'); }
function closeModal(id) { const m = document.getElementById(id); if (m) m.classList.add('hidden'); }
function fmtDate(d)    { if (!d) return '—'; try { return new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }); } catch { return d; } }
function fmtCurrency(n){ return '₹' + (parseFloat(n)||0).toLocaleString('en-IN', { minimumFractionDigits:0, maximumFractionDigits:2 }); }
function statusBadge(s){
  const map  = { 'Under Repair':'status-under-repair', 'Repaired':'status-repaired', 'Return':'status-return', 'Delivered':'status-delivered' };
  const icon = { 'Under Repair':'🔴', 'Repaired':'🟢', 'Return':'🟡', 'Delivered':'🔵' };
  return `<span class="status-badge ${map[s]||'status-under-repair'}">${icon[s]||'⚪'} ${s}</span>`;
}
function togglePwd() {
  const el = document.getElementById('login-password'), ic = document.getElementById('eye-icon');
  if (el.type === 'password') { el.type = 'text';     ic.classList.replace('fa-eye','fa-eye-slash'); }
  else                        { el.type = 'password'; ic.classList.replace('fa-eye-slash','fa-eye'); }
}

/* ─────────────────────────────────────────────────────────────────────────────
   AUTH
───────────────────────────────────────────────────────────────────────────── */
function tryRestoreSession() {
  const token = localStorage.getItem('adition_token');
  const role  = localStorage.getItem('adition_role');
  const email = localStorage.getItem('adition_email');
  const name  = localStorage.getItem('adition_name');
  if (token && role) {
    authToken = token; userRole = role; userEmail = email; staffName = name;
    showApp(); return true;
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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
  const navInfo   = document.getElementById('nav-user-info');
  if (navInfo) navInfo.textContent = userRole === 'admin' ? (userEmail || 'Admin') : (staffName || 'Staff');
  const roleBadge = document.getElementById('role-badge');
  if (roleBadge) {
    roleBadge.textContent  = userRole === 'admin' ? '⚡ Admin' : '🔧 Staff';
    roleBadge.className    = `text-xs font-semibold px-2 py-1 rounded-full ${userRole==='admin'?'bg-blue-100 text-blue-700':'bg-green-100 text-green-700'}`;
    roleBadge.classList.remove('hidden');
  }
  const isAdmin = userRole === 'admin';
  document.querySelectorAll('.admin-only-el').forEach(el => el.classList.toggle('hidden', !isAdmin));
  const adminBtn = document.getElementById('admin-tools-btn');
  const reportBtn= document.getElementById('report-btn');
  const newJobBtn= document.getElementById('new-job-btn');
  const delTab   = document.getElementById('tab-delivered');
  if (adminBtn)  adminBtn.classList.toggle('hidden', !isAdmin);
  if (reportBtn) reportBtn.classList.toggle('hidden', !isAdmin);
  if (newJobBtn) newJobBtn.classList.remove('hidden');
  if (delTab)    delTab.classList.toggle('hidden', !isAdmin);

  // Show "Assigned to Me" filter for staff
  const myFilterRow = document.getElementById('my-filter-row');
  if (myFilterRow) myFilterRow.classList.toggle('hidden', isAdmin);

  if (isAdmin) {
    const cs  = document.getElementById('cleanup-section');
    const rs  = document.getElementById('reset-seq-section');
    const rsf = document.getElementById('report-staff-filter-row');
    if (cs  && userEmail === OWNER_EMAIL) cs.classList.remove('hidden');
    if (rs  && userEmail === OWNER_EMAIL) rs.classList.remove('hidden');
    if (rsf) rsf.classList.remove('hidden');
  }
  loadJobs();
  updateSyncBadge();
}

/* ─────────────────────────────────────────────────────────────────────────────
   API FETCH
───────────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────────
   LOAD JOBS
───────────────────────────────────────────────────────────────────────────── */
async function loadJobs() {
  const loadEl = document.getElementById('loading-indicator');
  const emptyEl= document.getElementById('empty-state');
  const cont   = document.getElementById('jobs-container');
  if (loadEl)  loadEl.classList.remove('hidden');
  if (emptyEl) emptyEl.classList.add('hidden');
  if (cont)    cont.innerHTML = '';
  try {
    const resp = await apiFetch('/api/jobs');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to load');
    allJobs       = data.filter(j => !j.all_delivered);
    deliveredJobs = data.filter(j => j.all_delivered);
    updateJobCountText();
    filterJobs();
    filterDelivered();
  } catch (err) {
    if (err.message !== 'offline_queued') showToast(err.message || 'Failed to load jobs', 'error');
  } finally {
    if (loadEl) loadEl.classList.add('hidden');
  }
}

function updateJobCountText() {
  const el = document.getElementById('job-count-text'); if (!el) return;
  const act = allJobs.length, del = deliveredJobs.length;
  if (userRole === 'admin') {
    el.textContent = `${act} active job${act!==1?'s':''} · ${del} delivered`;
  } else {
    const mine = allJobs.filter(j => j.has_mine).length;
    el.textContent = `${act} active job${act!==1?'s':''} · ${mine} assigned to you`;
  }
  const atc = document.getElementById('active-tab-count');
  const dtc = document.getElementById('delivered-tab-count');
  if (atc) atc.textContent = act;
  if (dtc) dtc.textContent = del;
}

function filterJobs() {
  const q  = (document.getElementById('search-input')?.value  || '').toLowerCase();
  const st = document.getElementById('status-filter')?.value  || '';
  const sf = document.getElementById('staff-filter')?.value   || '';

  filteredJobs = allJobs.filter(j => {
    const ms  = !q  || j.job_id?.toLowerCase().includes(q) || j.customer_name?.toLowerCase().includes(q) || j.machines?.some(m => m.description?.toLowerCase().includes(q));
    const mst = !st || j.machines?.some(m => m.status === st);
    const msf = !sf || j.machines?.some(m => m.assigned_to === sf);
    // Staff "assigned to me" filter
    const mine = (staffFilterMode !== 'mine') || j.has_mine;
    return ms && mst && msf && mine;
  });
  if (currentTab === 'active') renderJobs(filteredJobs, 'jobs-container');
}

function toggleMyFilter() {
  staffFilterMode = staffFilterMode === 'all' ? 'mine' : 'all';
  const btn = document.getElementById('my-filter-btn');
  if (btn) {
    if (staffFilterMode === 'mine') {
      btn.className = 'text-xs px-3 py-1.5 rounded-full font-semibold bg-blue-600 text-white';
      btn.textContent = '✓ My Jobs Only';
    } else {
      btn.className = 'text-xs px-3 py-1.5 rounded-full font-semibold border border-blue-300 text-blue-600 hover:bg-blue-50';
      btn.textContent = '🔧 Assigned to Me';
    }
  }
  filterJobs();
}

function filterDelivered() {
  const q = (document.getElementById('delivered-search')?.value || '').toLowerCase();
  filteredDelivered = deliveredJobs.filter(j => !q || j.job_id?.toLowerCase().includes(q) || j.customer_name?.toLowerCase().includes(q));
  if (currentTab === 'delivered') renderJobs(filteredDelivered, 'jobs-container');
}

function onStatusFilterChange() { filterJobs(); }

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tab-active').classList.toggle('active', tab === 'active');
  document.getElementById('tab-delivered').classList.toggle('active', tab === 'delivered');
  const afb = document.getElementById('active-filter-bar');
  const dfb = document.getElementById('delivered-filter-bar');
  if (afb) afb.classList.toggle('hidden', tab !== 'active');
  if (dfb) dfb.classList.toggle('hidden', tab !== 'delivered');
  const emptyEl = document.getElementById('empty-state');
  const cont    = document.getElementById('jobs-container');
  if (emptyEl) emptyEl.classList.add('hidden');
  if (cont)    cont.innerHTML = '';
  if (tab === 'active') renderJobs(filteredJobs,     'jobs-container');
  else                  renderJobs(filteredDelivered, 'jobs-container');
}

function renderJobs(jobs, containerId) {
  const cont    = document.getElementById(containerId);
  const emptyEl = document.getElementById('empty-state');
  if (!cont) return;
  if (!jobs.length) { cont.innerHTML = ''; if (emptyEl) emptyEl.classList.remove('hidden'); return; }
  if (emptyEl) emptyEl.classList.add('hidden');
  cont.innerHTML = jobs.map(j => buildJobCard(j)).join('');
}

/* ─────────────────────────────────────────────────────────────────────────────
   JOB CARD RENDER
───────────────────────────────────────────────────────────────────────────── */
function buildJobCard(job) {
  const isAdmin      = userRole === 'admin';
  const allDelivered = job.all_delivered;
  const machines     = job.machines || [];

  const machinesHtml = machines.length
    ? machines.map(m => buildMachineRow(m, job.job_id)).join('')
    : `<p class="text-gray-400 text-xs text-center py-4">No machines yet</p>`;

  const totalsHtml = isAdmin ? `<span class="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2 py-1 rounded-lg">
    Total: ${fmtCurrency(job.grand_total||0)} · Paid: ${fmtCurrency(job.amount_received||0)} · Bal: ${fmtCurrency(job.balance||0)}
  </span>` : '';

  const mobileHtml = isAdmin && job.customer_mobile ? `<span class="text-xs text-gray-400">${job.customer_mobile}</span>` : '';
  const addrHtml   = isAdmin && job.customer_address ? `<span class="text-xs text-gray-400">${job.customer_address}</span>` : '';

  // Staff: highlight if any machine is assigned to me
  const mineIndicator = (!isAdmin && job.has_mine)
    ? `<span class="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full font-semibold">📌 Has my work</span>`
    : '';

  const editBtn   = isAdmin ? `<button onclick="openEditJob('${job.job_id}')" class="action-btn bg-yellow-50 text-yellow-600 hover:bg-yellow-100" title="Edit"><i class="fas fa-edit text-xs"></i></button>` : '';
  const deleteBtn = isAdmin && userEmail === OWNER_EMAIL ? `<button onclick="deleteJob('${job.job_id}')" class="action-btn bg-red-50 text-red-500 hover:bg-red-100" title="Delete"><i class="fas fa-trash text-xs"></i></button>` : '';
  const addMachBtn= isAdmin ? `<button onclick="openAddMachine('${job.job_id}')" class="action-btn-sm bg-blue-50 text-blue-600 hover:bg-blue-100"><i class="fas fa-plus text-xs"></i> Machine</button>` : '';
  const deliverBtn= isAdmin && !allDelivered && job.all_repaired && machines.length > 0
    ? `<button onclick="openDelivery('${job.job_id}')" class="action-btn-sm bg-indigo-600 text-white hover:bg-indigo-700"><i class="fas fa-truck text-xs"></i> Deliver</button>` : '';

  // WhatsApp share buttons — always visible for admin, no environment checks needed
  const waRegBtn = isAdmin
    ? `<button onclick="shareWhatsApp('${job.job_id}','register')" class="action-btn-sm bg-green-600 text-white hover:bg-green-700" title="Share registration via WhatsApp"><i class="fab fa-whatsapp text-xs"></i> Register</button>`
    : '';
  const waDelBtn = isAdmin && allDelivered
    ? `<button onclick="shareWhatsApp('${job.job_id}','delivered')" class="action-btn-sm bg-green-700 text-white hover:bg-green-800" title="Share delivered message via WhatsApp"><i class="fab fa-whatsapp text-xs"></i> Delivered</button>`
    : '';
  const jpgBtn = isAdmin
    ? `<button onclick="generateJobCardImage('${job.job_id}')" class="action-btn-sm bg-purple-50 text-purple-600 hover:bg-purple-100"><i class="fas fa-image text-xs"></i> JPG</button>`
    : '';

  const cardBg = allDelivered ? 'job-card-delivered' : 'bg-white';

  return `<div class="${cardBg} rounded-xl border border-gray-200 shadow-sm overflow-hidden" id="job-card-${job.job_id}">
    <div class="flex items-start justify-between p-4 pb-2">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap mb-1">
          <span class="font-black text-blue-600 text-base">${job.job_id}</span>
          ${allDelivered ? `<span class="status-badge status-delivered">🔵 Delivered</span>` : ''}
          ${job.all_repaired && !allDelivered ? `<span class="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full font-semibold">Ready to deliver</span>` : ''}
          ${mineIndicator}
        </div>
        <p class="font-bold text-gray-800 text-sm">${job.customer_name}</p>
        <div class="flex flex-wrap gap-2 mt-0.5">${mobileHtml}${addrHtml}</div>
        ${job.notes ? `<p class="text-xs text-gray-400 mt-1 italic">${job.notes}</p>` : ''}
      </div>
      <div class="flex items-center gap-1 ml-2">${editBtn}${deleteBtn}</div>
    </div>
    ${isAdmin ? `<div class="px-4 pb-2 flex items-center justify-between flex-wrap gap-2">
      ${totalsHtml}<span class="text-xs text-gray-400">${fmtDate(job.created_at)}</span>
    </div>` : `<div class="px-4 pb-2"><span class="text-xs text-gray-400">${fmtDate(job.created_at)}</span></div>`}
    <div class="border-t border-gray-100 divide-y divide-gray-50">${machinesHtml}</div>
    <div class="flex items-center gap-2 px-4 py-3 border-t border-gray-100 flex-wrap">
      ${addMachBtn}${deliverBtn}${jpgBtn}${waRegBtn}${waDelBtn}
    </div>
  </div>`;
}

function buildMachineRow(m, jobId) {
  const isAdmin    = userRole === 'admin';
  const isMine     = m.is_mine || (m.assigned_to === staffName);
  const imgHtml    = m.image_data ? `<img src="${m.image_data}" class="thumb-img" onclick="viewImage('${m.image_data.replace(/'/g,"\\'")}')">` : '';
  const priceHtml  = isAdmin ? `<span class="text-xs text-gray-500">${fmtCurrency(m.unit_price||0)} × ${m.quantity||1} = ${fmtCurrency((m.unit_price||0)*(m.quantity||1))}</span>` : '';

  // Staff can edit if machine is assigned to them
  const canEdit    = isAdmin || isMine;
  const editBtn    = canEdit
    ? `<button onclick="openEditMachine('${jobId}','${m.id}')" class="action-btn-sm bg-gray-50 text-gray-600 hover:bg-gray-100"><i class="fas fa-edit text-xs"></i> Edit</button>` : '';
  const delBtn     = isAdmin && userEmail === OWNER_EMAIL
    ? `<button onclick="deleteMachine('${jobId}','${m.id}')" class="action-btn bg-red-50 text-red-400 hover:bg-red-100"><i class="fas fa-trash text-xs"></i></button>` : '';
  const assigned   = m.assigned_to ? `<span class="assigned-badge">${m.assigned_to}</span>` : '';

  // Highlight row if this machine is mine (staff view)
  const rowHighlight = (!isAdmin && isMine) ? 'style="background:#eff6ff;"' : '';

  return `<div class="flex items-center gap-3 px-4 py-3" id="machine-row-${m.id}" ${rowHighlight}>
    ${imgHtml}
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="font-semibold text-gray-800 text-sm">${m.description}</span>
        ${statusBadge(m.status)}${assigned}
        ${(!isAdmin && isMine) ? '<span class="text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded font-semibold">📌 Mine</span>' : ''}
      </div>
      ${m.condition_text ? `<p class="text-xs text-gray-400 mt-0.5">${m.condition_text}</p>` : ''}
      ${priceHtml}
    </div>
    <div class="flex items-center gap-1">${editBtn}${delBtn}</div>
  </div>`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   NEW JOB
───────────────────────────────────────────────────────────────────────────── */
function openNewJobModal() {
  ['new-customer-name','new-customer-mobile','new-customer-address','new-notes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  openModal('new-job-modal');
  setTimeout(() => document.getElementById('new-customer-name')?.focus(), 100);
  setupAutocomplete('new-customer-mobile','new-customer-name','new-customer-address');
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
    const resp = await apiFetch('/api/jobs', { method:'POST', body: JSON.stringify({ customer_name: name, customer_mobile: mobile||null, customer_address: addr||null, notes: notes||null }) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to create');
    if (mobile) { try { await apiFetch('/api/customers/upsert', { method:'POST', body: JSON.stringify({ name, mobile, address: addr||null }) }); } catch {} }
    closeModal('new-job-modal');
    showToast(`Job ${data.job_id} created!`, 'success');
    await loadJobs();
  } catch (err) {
    if (err.message === 'offline_queued') { closeModal('new-job-modal'); showToast('Queued for sync', 'warning'); }
    else showToast(err.message || 'Failed', 'error');
  } finally { spinner.classList.add('hidden'); btnText.textContent = 'Create Job'; }
}

/* ─────────────────────────────────────────────────────────────────────────────
   EDIT JOB
───────────────────────────────────────────────────────────────────────────── */
function openEditJob(jobId) {
  const job = allJobs.find(j => j.job_id === jobId) || deliveredJobs.find(j => j.job_id === jobId);
  if (!job) return;
  document.getElementById('edit-job-id').value           = jobId;
  document.getElementById('edit-customer-name').value    = job.customer_name    || '';
  document.getElementById('edit-customer-mobile').value  = job.customer_mobile  || '';
  document.getElementById('edit-customer-address').value = job.customer_address || '';
  document.getElementById('edit-amount-received').value  = job.amount_received  || 0;
  document.getElementById('edit-notes').value            = job.notes            || '';
  openModal('edit-job-modal');
}
async function saveJobEdit() {
  const jobId = document.getElementById('edit-job-id').value;
  const body  = {
    customer_name:    document.getElementById('edit-customer-name').value.trim(),
    customer_mobile:  document.getElementById('edit-customer-mobile').value.trim(),
    customer_address: document.getElementById('edit-customer-address').value.trim(),
    amount_received:  parseFloat(document.getElementById('edit-amount-received').value) || 0,
    notes:            document.getElementById('edit-notes').value.trim()
  };
  if (!body.customer_name) { showToast('Name required', 'error'); return; }
  try {
    const resp = await apiFetch(`/api/jobs/${jobId}`, { method:'PUT', body: JSON.stringify(body) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to update');
    closeModal('edit-job-modal'); showToast('Job updated', 'success'); await loadJobs();
  } catch (err) { showToast(err.message || 'Failed', 'error'); }
}

/* DELETE JOB */
function deleteJob(jobId) {
  showConfirm('Delete Job', `Delete ${jobId} and all its machines?`, async () => {
    try {
      const resp = await apiFetch(`/api/jobs/${jobId}`, { method:'DELETE', body:'{}' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed');
      showToast(`${jobId} deleted`, 'success'); await loadJobs();
    } catch (err) { showToast(err.message || 'Failed', 'error'); }
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   MACHINE MODAL
───────────────────────────────────────────────────────────────────────────── */
let currentMachineJobId = null, currentMachineId = null;

function openAddMachine(jobId) {
  currentMachineJobId = jobId; currentMachineId = null;
  document.getElementById('machine-modal-title').innerHTML = '<i class="fas fa-plus-circle text-blue-500 mr-2"></i>Add Machine';
  ['machine-desc','machine-condition','machine-work-done','machine-return-reason','machine-internal-notes'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value='';
  });
  document.getElementById('machine-qty').value = '1';
  document.getElementById('machine-price').value = '0';
  document.getElementById('machine-assigned-to').value = '';
  document.getElementById('machine-status').value = 'Under Repair';
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
  document.getElementById('machine-desc').value          = m.description    || '';
  document.getElementById('machine-condition').value     = m.condition_text  || '';
  document.getElementById('machine-qty').value           = m.quantity        || 1;
  document.getElementById('machine-price').value         = m.unit_price      || 0;
  document.getElementById('machine-assigned-to').value   = m.assigned_to    || '';
  document.getElementById('machine-status').value        = m.status          || 'Under Repair';
  document.getElementById('machine-work-done').value     = m.work_done       || '';
  document.getElementById('machine-return-reason').value = m.return_reason   || '';
  const internalNotes = document.getElementById('machine-internal-notes');
  if (internalNotes) internalNotes.value = m.internal_notes || '';

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
  document.getElementById('work-done-row').classList.toggle('hidden',      s !== 'Repaired');
  document.getElementById('return-reason-row').classList.toggle('hidden',  s !== 'Return');
}

async function handleImageUpload(input) {
  const file = input.files[0]; if (!file) return;
  const preview   = document.getElementById('machine-image-preview');
  const container = document.getElementById('image-preview-container');
  const removeBtn = document.getElementById('remove-image-btn');
  // High quality compression: max 1400px, 92% quality
  const b64 = await compressImageToBase64(file, 1400, 0.92);
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
          else       { w = Math.round(w * maxDim / h); h = maxDim; }
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
  const desc         = document.getElementById('machine-desc').value.trim();
  const status       = document.getElementById('machine-status').value;
  const workDone     = document.getElementById('machine-work-done').value.trim();
  const returnReason = document.getElementById('machine-return-reason').value.trim();
  if (!desc) { showToast('Description required', 'error'); return; }
  if (status === 'Repaired' && !workDone)     { showToast('Work done is required for Repaired status', 'error'); return; }
  if (status === 'Return'   && !returnReason) { showToast('Return reason is required', 'error'); return; }

  const imgEl   = document.getElementById('machine-image-preview');
  const imgData = imgEl.classList.contains('hidden') ? null : (imgEl.src || null);
  // Clean up if it's an empty src
  const cleanImg = imgData && imgData.length > 50 ? imgData : null;

  const body = {
    description:    desc,
    condition_text: document.getElementById('machine-condition').value.trim() || null,
    quantity:       parseInt(document.getElementById('machine-qty').value) || 1,
    unit_price:     parseFloat(document.getElementById('machine-price').value) || 0,
    assigned_to:    document.getElementById('machine-assigned-to').value.trim() || null,
    status,
    work_done:      workDone     || null,
    return_reason:  returnReason || null,
    image_data:     cleanImg
  };

  const spinner = document.getElementById('machine-save-spinner');
  const btnText = document.getElementById('machine-save-btn-text');
  spinner.classList.remove('hidden'); btnText.textContent = 'Saving…';
  try {
    let resp;
    if (currentMachineId) {
      resp = await apiFetch(`/api/jobs/${currentMachineJobId}/machines/${currentMachineId}`, { method:'PUT', body: JSON.stringify(body) });
    } else {
      resp = await apiFetch(`/api/jobs/${currentMachineJobId}/machines`, { method:'POST', body: JSON.stringify(body) });
    }
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || data.detail || 'Failed to save machine');
    // Response: { success: true, machine: {...} } for both POST and PUT
    closeModal('machine-modal');
    showToast(currentMachineId ? 'Machine updated ✓' : 'Machine added ✓', 'success');
    await loadJobs();
  } catch (err) {
    if (err.message === 'offline_queued') { closeModal('machine-modal'); showToast('Queued for sync', 'warning'); }
    else showToast(err.message || 'Failed to save machine', 'error');
  } finally {
    spinner.classList.add('hidden');
    btnText.textContent = currentMachineId ? 'Save Changes' : 'Add Machine';
  }
}

function deleteMachine(jobId, machineId) {
  showConfirm('Delete Machine', 'Remove this machine from the job?', async () => {
    try {
      const resp = await apiFetch(`/api/jobs/${jobId}/machines/${machineId}`, { method:'DELETE', body:'{}' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed');
      showToast('Machine removed', 'success'); await loadJobs();
    } catch (err) { showToast(err.message || 'Failed', 'error'); }
  });
}

function viewImage(src) { document.getElementById('image-viewer-img').src = src; openModal('image-viewer-modal'); }

/* ─────────────────────────────────────────────────────────────────────────────
   DELIVERY
   Courier service & tracking are now optional (previously required)
───────────────────────────────────────────────────────────────────────────── */
function openDelivery(jobId) {
  document.getElementById('delivery-job-id').value = jobId;
  document.getElementById('delivery-job-id-label').textContent = jobId;
  ['delivery-name','delivery-mobile','delivery-relation',
   'delivery-service','delivery-tracking','delivery-driver','delivery-driver-contact'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  setDeliveryType('in_person');
  openModal('delivery-modal');
}
function setDeliveryType(type) {
  document.getElementById('delivery-type').value = type;
  const ipF = document.getElementById('delivery-inperson-fields');
  const coF = document.getElementById('delivery-courier-fields');
  const bi  = document.getElementById('btn-inperson');
  const bc  = document.getElementById('btn-courier');
  if (type === 'in_person') {
    ipF.classList.remove('hidden'); coF.classList.add('hidden');
    bi.className = 'flex-1 bg-indigo-600 text-white rounded-lg py-2 text-sm font-semibold';
    bc.className = 'flex-1 border border-gray-200 text-gray-600 rounded-lg py-2 text-sm font-medium hover:bg-gray-50';
  } else {
    ipF.classList.add('hidden'); coF.classList.remove('hidden');
    bc.className = 'flex-1 bg-indigo-600 text-white rounded-lg py-2 text-sm font-semibold';
    bi.className = 'flex-1 border border-gray-200 text-gray-600 rounded-lg py-2 text-sm font-medium hover:bg-gray-50';
  }
}
async function confirmDelivery() {
  const jobId = document.getElementById('delivery-job-id').value;
  const type  = document.getElementById('delivery-type').value;
  let delivery_info;
  if (type === 'in_person') {
    delivery_info = {
      type:     'in_person',
      name:     document.getElementById('delivery-name').value.trim()            || null,
      mobile:   document.getElementById('delivery-mobile').value.trim()          || null,
      relation: document.getElementById('delivery-relation').value.trim()        || null
    };
  } else {
    // Courier: service & tracking are now optional
    const service  = document.getElementById('delivery-service').value.trim()       || null;
    const tracking = document.getElementById('delivery-tracking').value.trim()      || null;
    const driver   = document.getElementById('delivery-driver').value.trim()        || null;
    const dContact = document.getElementById('delivery-driver-contact').value.trim()|| null;
    delivery_info = { type: 'courier', service, tracking_id: tracking, driver, driver_contact: dContact };
  }
  const btnText = 'Confirm Delivery';
  const btn     = document.querySelector('#delivery-modal button[onclick="confirmDelivery()"]');
  if (btn) btn.disabled = true;
  try {
    const resp = await apiFetch(`/api/jobs/${jobId}/deliver`, { method:'POST', body: JSON.stringify({ delivery_info }) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || data.detail || 'Delivery failed');
    closeModal('delivery-modal'); showToast(`${jobId} delivered! 🎉`, 'success'); await loadJobs();
  } catch (err) { showToast(err.message || 'Delivery failed', 'error'); }
  finally { if (btn) btn.disabled = false; }
}

/* ─────────────────────────────────────────────────────────────────────────────
   WHATSAPP SHARING — Web Share API with file attachment
   Works on: Chrome Android, Safari iOS 15+, Edge Android
   Fallback: Desktop — copies text to clipboard + downloads image
   No environment checks — always shows buttons
───────────────────────────────────────────────────────────────────────────── */

function buildRegisterMessage(job) {
  return `🌟 Dear Customer,

✅ Your product(s) has been successfully registered with us under
Job No. ${job.job_id}

📦 Kindly collect your machine(s) within 25 days from the date of this message.

⚠️ Note: After 25 days, we shall not be held liable for any claims, loss, or damage to uncollected items.

🙏 Thank you for choosing ADITION ELECTRIC SOLUTION!

— Bilal Pathan
Operations Manager
✨ adition™ since 1984
📍 Gheekanta, Ahmedabad`;
}

function buildDeliveredMessage(job) {
  return `🌟 Dear Customer,

✅ Your product(s) under Job No. ${job.job_id} have been completed and delivered.

🙏 Thank you for your business and we look forward to serving you again.

— ADITION ELECTRIC SOLUTION
✨ adition™ since 1984
📍 Gheekanta, Ahmedabad`;
}

async function shareWhatsApp(jobId, type) {
  const job = allJobs.find(j => j.job_id === jobId) || deliveredJobs.find(j => j.job_id === jobId);
  if (!job) { showToast('Job not found', 'error'); return; }

  const text     = type === 'register' ? buildRegisterMessage(job) : buildDeliveredMessage(job);
  const fileName = `Job_${jobId}.jpg`;

  // Show spinner
  const spinner    = document.getElementById('print-spinner');
  const spinnerMsg = spinner ? spinner.querySelector('p') : null;
  if (spinnerMsg) spinnerMsg.textContent = 'Preparing WhatsApp share…';
  if (spinner)    spinner.classList.remove('hidden');

  try {
    await loadHtml2Canvas();
    const blob = await generateJobCardBlob(job);
    if (spinner) spinner.classList.add('hidden');

    const file = new File([blob], fileName, { type: 'image/jpeg' });

    // Try Web Share API with file (works on Chrome Android, Safari iOS 15+)
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          title: `Job Card ${jobId} — ADITION ELECTRIC SOLUTION`,
          text,
          files: [file]
        });
        return; // Success — no toast needed (user completed share)
      } catch (shareErr) {
        if (shareErr.name === 'AbortError') return; // User cancelled
        // Fall through to text-only share
      }
    }

    // Try Web Share API text only (share sheet opens, user picks WhatsApp)
    if (navigator.share) {
      try {
        await navigator.share({ title: `Job Card ${jobId}`, text });
        // Also download the image so user can attach manually
        downloadBlob(blob, fileName);
        showToast('Image downloaded — attach it in WhatsApp', 'info', 5000);
        return;
      } catch (shareErr) {
        if (shareErr.name === 'AbortError') return;
        // Fall through to desktop fallback
      }
    }

    // Desktop fallback: copy text + download image
    await copyToClipboard(text);
    downloadBlob(blob, fileName);
    showToast('✓ Message copied + image downloaded! Paste in WhatsApp.', 'info', 6000);

  } catch (err) {
    if (spinner) spinner.classList.add('hidden');
    if (err.name === 'AbortError') return;
    console.error('WhatsApp share error:', err);
    showToast('Share failed: ' + (err.message || 'unknown error'), 'error');
  }
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ─────────────────────────────────────────────────────────────────────────────
   JPG JOB CARD GENERATION
   - 4× scale (very high res for WhatsApp)
   - Delivery details shown only if filled
   - No signature sections
   - Footer: "Subjected to Ahmedabad jurisdiction only"
   - Branding: ADITION ELECTRIC SOLUTION
───────────────────────────────────────────────────────────────────────────── */
function buildJobCardHTML(job) {
  const machines   = job.machines || [];
  const grandTotal = machines.reduce((s, m) => s + (m.quantity||1) * (m.unit_price||0), 0);
  const balance    = grandTotal - (job.amount_received || 0);
  const printDate  = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });

  const machineRows = machines.map((m, i) => {
    const sColor = { 'Under Repair':'#dc2626','Repaired':'#16a34a','Return':'#b45309','Delivered':'#4338ca' }[m.status] || '#374151';
    const imgTag  = m.image_data
      ? `<img src="${m.image_data}" style="width:72px;height:72px;object-fit:cover;border-radius:8px;flex-shrink:0;border:1px solid #e2e8f0;" />`
      : '';
    return `<tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:12px 8px;vertical-align:top;font-size:14px;color:#374151;font-weight:700;">${i+1}.</td>
      <td style="padding:12px 8px;vertical-align:top;">
        <div style="display:flex;gap:12px;align-items:flex-start;">
          ${imgTag}
          <div style="flex:1;">
            <div style="font-size:15px;font-weight:800;color:#1e293b;margin-bottom:3px;">${m.description}</div>
            ${m.condition_text ? `<div style="font-size:12px;color:#64748b;margin-bottom:4px;">${m.condition_text}</div>` : ''}
            <span style="background:${sColor}18;color:${sColor};border:1px solid ${sColor}44;border-radius:20px;padding:3px 12px;font-size:11px;font-weight:700;">${m.status}</span>
          </div>
        </div>
      </td>
      <td style="padding:12px 8px;text-align:center;font-size:13px;color:#374151;font-weight:600;">${m.quantity||1}</td>
      <td style="padding:12px 8px;text-align:right;font-size:13px;color:#374151;">₹${parseFloat(m.unit_price||0).toFixed(0)}</td>
      <td style="padding:12px 8px;text-align:right;font-size:14px;font-weight:800;color:#1e40af;">₹${((m.quantity||1)*(m.unit_price||0)).toFixed(0)}</td>
    </tr>`;
  }).join('');

  // Delivery block — only show fields that have actual values
  const deliveryBlock = (() => {
    if (!job.all_delivered) return '';
    const m = machines.find(m => m.delivery_info);
    if (!m) return '';
    try {
      const di = typeof m.delivery_info === 'string' ? JSON.parse(m.delivery_info) : m.delivery_info;
      if (!di) return '';
      if (di.type === 'in_person') {
        const parts = [];
        if (di.name)     parts.push(di.name);
        if (di.relation) parts.push(`(${di.relation})`);
        if (di.mobile)   parts.push(di.mobile);
        const detail = parts.length ? ` — ${parts.join(' · ')}` : '';
        return `<div style="background:#f0fdf4;border-radius:10px;padding:12px 16px;margin-top:14px;font-size:13px;color:#166534;">
          <strong>✅ Delivered In Person</strong>${detail}
        </div>`;
      }
      // Courier — only show filled fields
      const parts = [];
      if (di.service)     parts.push(`<strong>📦 ${di.service}</strong>`);
      if (di.tracking_id) parts.push(`Tracking: ${di.tracking_id}`);
      if (di.driver)      parts.push(`Driver: ${di.driver}`);
      if (di.driver_contact) parts.push(`Contact: ${di.driver_contact}`);
      if (!parts.length) return `<div style="background:#eff6ff;border-radius:10px;padding:12px 16px;margin-top:14px;font-size:13px;color:#1e40af;"><strong>📦 Delivered via Courier</strong></div>`;
      return `<div style="background:#eff6ff;border-radius:10px;padding:12px 16px;margin-top:14px;font-size:13px;color:#1e40af;">${parts.join(' · ')}</div>`;
    } catch { return ''; }
  })();

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'Segoe UI',Arial,sans-serif;background:#fff;}</style>
</head><body>
<div id="card" style="width:760px;background:#fff;padding:32px;">

  <!-- HEADER -->
  <div style="display:flex;align-items:center;justify-content:space-between;padding-bottom:18px;border-bottom:3px solid #1e40af;margin-bottom:22px;">
    <div style="display:flex;align-items:center;gap:14px;">
      <div style="width:56px;height:56px;background:#1e40af;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:30px;">⚡</div>
      <div>
        <div style="font-size:28px;font-weight:900;color:#1e40af;letter-spacing:-0.5px;line-height:1.1;">adition</div>
        <div style="font-size:12px;color:#64748b;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">ADITION ELECTRIC SOLUTION</div>
        <div style="font-size:10px;color:#94a3b8;">Gheekanta, Ahmedabad · Since 1984</div>
      </div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:13px;font-weight:700;color:#64748b;letter-spacing:1px;text-transform:uppercase;">JOB CARD</div>
      <div style="font-size:32px;font-weight:900;color:#1e40af;line-height:1.1;">${job.job_id}</div>
      <div style="font-size:12px;color:#64748b;margin-top:2px;">Date: ${printDate}</div>
    </div>
  </div>

  <!-- CUSTOMER INFO -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:22px;border:1px solid #e2e8f0;">
    <div>
      <div style="font-size:10px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;">Customer Name</div>
      <div style="font-size:18px;font-weight:900;color:#1e293b;">${job.customer_name}</div>
    </div>
    ${job.customer_mobile ? `<div><div style="font-size:10px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;">Mobile</div><div style="font-size:16px;font-weight:700;color:#1e293b;">${job.customer_mobile}</div></div>` : '<div></div>'}
    ${job.customer_address ? `<div style="grid-column:1/-1;"><div style="font-size:10px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;">Address</div><div style="font-size:13px;color:#475569;">${job.customer_address}</div></div>` : ''}
    ${job.notes ? `<div style="grid-column:1/-1;"><div style="font-size:10px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;">Notes</div><div style="font-size:12px;color:#64748b;font-style:italic;">${job.notes}</div></div>` : ''}
  </div>

  <!-- MACHINES TABLE -->
  <table style="width:100%;border-collapse:collapse;margin-bottom:18px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
    <thead>
      <tr style="background:#1e40af;">
        <th style="padding:10px 8px;text-align:left;font-size:12px;color:white;font-weight:700;width:36px;">#</th>
        <th style="padding:10px 8px;text-align:left;font-size:12px;color:white;font-weight:700;">Description / Item</th>
        <th style="padding:10px 8px;text-align:center;font-size:12px;color:white;font-weight:700;width:50px;">Qty</th>
        <th style="padding:10px 8px;text-align:right;font-size:12px;color:white;font-weight:700;width:80px;">Rate (₹)</th>
        <th style="padding:10px 8px;text-align:right;font-size:12px;color:white;font-weight:700;width:90px;">Total (₹)</th>
      </tr>
    </thead>
    <tbody>${machineRows || `<tr><td colspan="5" style="text-align:center;padding:24px;color:#94a3b8;font-size:13px;">No machines added</td></tr>`}</tbody>
  </table>

  <!-- TOTALS -->
  <div style="display:flex;justify-content:flex-end;margin-bottom:18px;">
    <div style="background:#f8fafc;border-radius:12px;padding:16px 22px;min-width:260px;border:1px solid #e2e8f0;">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span style="font-size:13px;color:#64748b;">Grand Total</span>
        <span style="font-size:15px;font-weight:700;color:#1e293b;">₹${grandTotal.toFixed(0)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span style="font-size:13px;color:#64748b;">Amount Received</span>
        <span style="font-size:15px;font-weight:700;color:#16a34a;">₹${parseFloat(job.amount_received||0).toFixed(0)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding-top:8px;border-top:2px solid #e2e8f0;">
        <span style="font-size:14px;font-weight:800;color:#1e293b;">Balance Due</span>
        <span style="font-size:17px;font-weight:900;color:${balance>0?'#dc2626':'#16a34a'};">₹${Math.abs(balance).toFixed(0)}${balance<0?' CR':''}</span>
      </div>
    </div>
  </div>

  ${deliveryBlock}

  <!-- FOOTER — no signature lines -->
  <div style="border-top:2px solid #e2e8f0;padding-top:16px;margin-top:18px;text-align:center;">
    <div style="font-size:12px;color:#374151;font-weight:700;margin-bottom:4px;">Subjected to Ahmedabad jurisdiction only</div>
    <div style="font-size:10px;color:#94a3b8;">ADITION ELECTRIC SOLUTION · Gheekanta, Ahmedabad · Since 1984 · adition™</div>
  </div>

</div></body></html>`;
}

/** Generate a high-res blob (used for WhatsApp share + download) */
async function generateJobCardBlob(job) {
  await loadHtml2Canvas();
  return new Promise(async (resolve, reject) => {
    const html    = buildJobCardHTML(job);
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-1;background:white;';
    wrapper.innerHTML = html;
    document.body.appendChild(wrapper);
    const target = wrapper.querySelector('#card') || wrapper.firstElementChild;
    // Wait for images
    const imgs = Array.from(wrapper.querySelectorAll('img'));
    await Promise.all(imgs.map(img => new Promise(r => {
      if (img.complete) r();
      else { img.onload = r; img.onerror = r; }
    })));
    try {
      const canvas = await html2canvas(target, {
        scale:           4,        // 4× = very high resolution
        useCORS:         true,
        allowTaint:      true,
        backgroundColor: '#ffffff',
        logging:         false,
        width:           760,
        windowWidth:     800,
        imageTimeout:    15000,
      });
      canvas.toBlob(blob => {
        document.body.removeChild(wrapper);
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob returned null'));
      }, 'image/jpeg', 0.95);
    } catch (err) {
      if (document.body.contains(wrapper)) document.body.removeChild(wrapper);
      reject(err);
    }
  });
}

/** JPG button — download the card */
async function generateJobCardImage(jobId) {
  const job = allJobs.find(j => j.job_id === jobId) || deliveredJobs.find(j => j.job_id === jobId);
  if (!job) return;
  const spinner    = document.getElementById('print-spinner');
  const spinnerMsg = spinner?.querySelector('p');
  if (spinnerMsg) spinnerMsg.textContent = 'Generating high-res image…';
  if (spinner)    spinner.classList.remove('hidden');
  try {
    await loadHtml2Canvas();
    const blob = await generateJobCardBlob(job);
    downloadBlob(blob, `Job-Card-${jobId}.jpg`);
    showToast('Job card saved!', 'success');
  } catch (err) {
    console.error('JPG error:', err);
    const html = buildJobCardHTML(job);
    const win  = window.open('', '_blank');
    if (win) { win.document.write(html); win.document.close(); }
    showToast('Opened in new tab — right-click → Save as image', 'info', 6000);
  } finally {
    if (spinner) spinner.classList.add('hidden');
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   AUTOCOMPLETE
───────────────────────────────────────────────────────────────────────────── */
function setupAutocomplete(mobileId, nameId, addressId) {
  const mobileEl = document.getElementById(mobileId);
  const nameEl   = document.getElementById(nameId);
  if (!mobileEl) return;
  const doSearch = async (q) => {
    if (q.length < 2) { closeAutocomplete(); return; }
    try {
      const resp = await apiFetch(`/api/customers/search?q=${encodeURIComponent(q)}`);
      const res  = await resp.json();
      if (Array.isArray(res) && res.length) showAutocomplete(res, mobileId, nameId, addressId);
      else closeAutocomplete();
    } catch { closeAutocomplete(); }
  };
  mobileEl.addEventListener('input', () => doSearch(mobileEl.value.trim()));
  nameEl?.addEventListener('input',  () => doSearch(nameEl.value.trim()));
}
function showAutocomplete(results, mobileId, nameId, addressId) {
  const dd = document.getElementById('autocomplete-dropdown'); if (!dd) return;
  const el = document.getElementById(mobileId);
  const r  = el.getBoundingClientRect();
  dd.style.top   = `${r.bottom + window.scrollY + 4}px`;
  dd.style.left  = `${r.left   + window.scrollX}px`;
  dd.style.width = `${r.width}px`;
  dd.innerHTML = results.map(c => `<div class="px-4 py-3 hover:bg-blue-50 cursor-pointer border-b border-gray-50 last:border-0" onclick='selectCustomer(${JSON.stringify(c)},"${mobileId}","${nameId}","${addressId}")'>
    <p class="font-semibold text-sm text-gray-800">${c.name}</p>
    <p class="text-xs text-gray-400">${c.mobile}${c.address?` · ${c.address}`:''}</p>
  </div>`).join('');
  dd.classList.remove('hidden');
}
function selectCustomer(c, mobileId, nameId, addressId) {
  const mel = document.getElementById(mobileId), nel = document.getElementById(nameId), ael = document.getElementById(addressId);
  if (mel) mel.value = c.mobile  || '';
  if (nel) nel.value = c.name    || '';
  if (ael) ael.value = c.address || '';
  closeAutocomplete();
}
function closeAutocomplete() { const d = document.getElementById('autocomplete-dropdown'); if (d) d.classList.add('hidden'); }
document.addEventListener('click', e => { if (!e.target.closest('#autocomplete-dropdown')) closeAutocomplete(); });

/* ─────────────────────────────────────────────────────────────────────────────
   ADMIN TOOLS
───────────────────────────────────────────────────────────────────────────── */
function openAdminTools() { openModal('admin-tools-modal'); loadQueueList(); }

async function loadQueueList() {
  const items   = await idbGetAll('queue');
  const pending = items.filter(i => i.status === 'pending');
  const el      = document.getElementById('queue-list'); if (!el) return;
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
    const rows = [['job_id','customer_name','customer_mobile','customer_address','amount_received','notes','created_at','machine_id','description','condition_text','quantity','unit_price','status','assigned_to','work_done','return_reason','delivery_info','delivered_at','image_data'].join(',')];
    for (const j of jobs) {
      const jm = machines.filter(m => m.job_id === j.job_id);
      if (!jm.length) {
        rows.push([j.job_id,j.customer_name,j.customer_mobile||'',j.customer_address||'',j.amount_received||0,j.notes||'',j.created_at,'','','','','','','','','','','',''].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
      } else {
        for (const m of jm) rows.push([j.job_id,j.customer_name,j.customer_mobile||'',j.customer_address||'',j.amount_received||0,j.notes||'',j.created_at,m.id,m.description,m.condition_text||'',m.quantity||1,m.unit_price||0,m.status,m.assigned_to||'',m.work_done||'',m.return_reason||'',m.delivery_info||'',m.delivered_at||'',m.image_data||''].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
      }
    }
    const blob = new Blob([rows.join('\n')], { type:'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `adition-export-${new Date().toISOString().slice(0,10)}.csv`; a.click();
    showToast('CSV exported', 'success');
  } catch (err) { showToast(err.message || 'Export failed', 'error'); }
}

async function handleRestoreCsv(input) {
  const file = input.files[0]; if (!file) return;
  const text  = await file.text();
  const lines = text.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.replace(/"/g,'').trim());
  const jobs = {}, machines = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const row = {}; headers.forEach((h, idx) => row[h] = (cols[idx]||'').replace(/"/g,'').trim());
    if (row.job_id) {
      if (!jobs[row.job_id]) jobs[row.job_id] = { job_id:row.job_id, customer_name:row.customer_name, customer_mobile:row.customer_mobile, customer_address:row.customer_address, amount_received:parseFloat(row.amount_received)||0, notes:row.notes, created_at:row.created_at };
      if (row.machine_id && row.description) machines.push({ job_id:row.job_id, description:row.description, condition_text:row.condition_text, quantity:parseInt(row.quantity)||1, unit_price:parseFloat(row.unit_price)||0, status:row.status||'Under Repair', assigned_to:row.assigned_to||null, work_done:row.work_done||null, return_reason:row.return_reason||null, delivery_info:row.delivery_info||null, delivered_at:row.delivered_at||null, image_data:row.image_data||null, created_at:row.created_at });
    }
  }
  try {
    const resp = await apiFetch('/api/admin/restore', { method:'POST', body: JSON.stringify({ jobs: Object.values(jobs), machines }) });
    const res  = await resp.json();
    if (!resp.ok) throw new Error(res.error || 'Restore failed');
    showToast(`Restored: ${res.upserted_jobs} jobs, ${res.upserted_machines} machines`, 'success');
    await loadJobs();
  } catch (err) { showToast(err.message || 'Restore failed', 'error'); }
  input.value = '';
}
function parseCsvLine(line) {
  const res = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') { if (inQ && line[i+1]==='"') { cur+='"'; i++; } else inQ=!inQ; }
    else if (line[i]===',' && !inQ) { res.push(cur); cur=''; }
    else cur+=line[i];
  }
  res.push(cur); return res;
}

async function cleanupData() {
  const from = document.getElementById('cleanup-from').value;
  const to   = document.getElementById('cleanup-to').value;
  if (!from || !to) { showToast('Select date range', 'error'); return; }
  showConfirm('Delete Jobs', `Delete all jobs from ${from} to ${to}?`, async () => {
    try {
      const resp = await apiFetch('/api/admin/cleanup', { method:'POST', body: JSON.stringify({ from, to }) });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed');
      showToast(`Deleted ${data.deleted} jobs`, 'success');
      closeModal('admin-tools-modal'); await loadJobs();
    } catch (err) { showToast(err.message || 'Failed', 'error'); }
  });
}
async function resetSequence() {
  showConfirm('Reset Sequence', 'Reset job ID sequence to 0?', async () => {
    try {
      const resp = await apiFetch('/api/admin/reset-sequence', { method:'POST', body:'{}' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed');
      showToast('Sequence reset', 'success');
    } catch (err) { showToast(err.message || 'Failed', 'error'); }
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   REPORT CENTER
───────────────────────────────────────────────────────────────────────────── */
let reportData = [];
function openReportCenter() { openModal('report-modal'); }

async function runReport() {
  const from  = document.getElementById('report-from').value;
  const to    = document.getElementById('report-to').value;
  const month = document.getElementById('report-month').value;
  const cbs   = Array.from(document.querySelectorAll('.report-status-cb:checked')).map(c => c.value);
  const staff = document.getElementById('report-staff')?.value || '';
  let url = '/api/admin/report?';
  if (month) url += `month=${month}`;
  else if (from && to) url += `from=${from}&to=${to}`;
  if (cbs.length) url += `&statuses=${cbs.join(',')}`;
  if (staff) url += `&staff=${encodeURIComponent(staff)}`;
  try {
    const resp = await apiFetch(url);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Report failed');
    reportData = data.machines || [];
    const { summary } = data;
    document.getElementById('report-result-count').textContent = reportData.length;
    document.getElementById('report-summary-cards').innerHTML = [
      { label:'Total',       value:summary.total,        color:'gray' },
      { label:'Under Repair',value:summary.under_repair, color:'red' },
      { label:'Repaired',    value:summary.repaired,     color:'green' },
      { label:'Delivered',   value:summary.delivered,    color:'indigo' },
      { label:'Revenue',     value:fmtCurrency(summary.total_revenue), color:'blue' },
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
  reportData.forEach(m => rows.push([m.job_id,m.customer_name||'',m.description,m.status,m.assigned_to||'',m.unit_price||0,m.created_at].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')));
  const blob = new Blob([rows.join('\n')], { type:'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `report-${Date.now()}.csv`; a.click();
}

/* ─────────────────────────────────────────────────────────────────────────────
   ONLINE / OFFLINE
───────────────────────────────────────────────────────────────────────────── */
function updateOnlineStatus() {
  const banner = document.getElementById('offline-banner');
  if (banner) banner.classList.toggle('visible', !navigator.onLine);
  if (navigator.onLine) flushQueueDirect();
}
window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

/* ─────────────────────────────────────────────────────────────────────────────
   SERVICE WORKER
───────────────────────────────────────────────────────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(() => {
      navigator.serviceWorker.addEventListener('message', e => {
        if (e.data?.type === 'SYNC_DONE') { showToast(`Synced ${e.data.count} item(s)`, 'success'); loadJobs(); updateSyncBadge(); }
      });
    }).catch(err => console.warn('SW registration failed:', err));
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   HTML2CANVAS LOADER
───────────────────────────────────────────────────────────────────────────── */
function loadHtml2Canvas() {
  return new Promise(resolve => {
    if (typeof html2canvas !== 'undefined') { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    s.onload = resolve; s.onerror = resolve; // resolve even on error so we handle gracefully
    document.head.appendChild(s);
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────────────────────────────
   BULK ACTIONS
───────────────────────────────────────────────────────────────────────────── */
let bulkMode = false;
let bulkSelected = new Set();

function toggleBulkMode() {
  bulkMode = !bulkMode;
  bulkSelected.clear();
  const bar = document.getElementById('bulk-actions-bar');
  const btn = document.getElementById('bulk-toggle-btn');
  if (bar) bar.classList.toggle('hidden', !bulkMode);
  if (btn) btn.classList.toggle('bg-blue-100', bulkMode);
  updateBulkCount();
  filterJobs(); // re-render with checkboxes
}

function toggleBulkSelect(jobId) {
  if (bulkSelected.has(jobId)) bulkSelected.delete(jobId);
  else bulkSelected.add(jobId);
  updateBulkCount();
  // Update checkbox visually
  const cb = document.getElementById(`bulk-cb-${jobId}`);
  if (cb) cb.checked = bulkSelected.has(jobId);
}

function selectAllJobs() {
  filteredJobs.forEach(j => bulkSelected.add(j.job_id));
  updateBulkCount();
  filterJobs();
}

function updateBulkCount() {
  const el = document.getElementById('bulk-count');
  if (el) el.textContent = bulkSelected.size;
}

async function bulkAction(action) {
  if (!bulkSelected.size) { showToast('Select at least one job', 'warning'); return; }
  const ids = Array.from(bulkSelected);
  if (action === 'export') {
    try {
      const resp = await apiFetch('/api/jobs/bulk', { method:'POST', body: JSON.stringify({ action:'export', job_ids:ids }) });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Export failed');
      const { jobs, machines } = data;
      const rows = [['job_id','customer_name','customer_mobile','customer_address','amount_received','notes','created_at','machine_id','description','status','unit_price','quantity','assigned_to'].join(',')];
      for (const j of jobs||[]) {
        const jm = (machines||[]).filter(m => m.job_id === j.job_id);
        if (!jm.length) rows.push([j.job_id,j.customer_name,'','','','','','','','','','',''].map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(','));
        else for (const m of jm) rows.push([j.job_id,j.customer_name,j.customer_mobile||'',j.customer_address||'',j.amount_received||0,j.notes||'',j.created_at,m.id,m.description,m.status,m.unit_price||0,m.quantity||1,m.assigned_to||''].map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(','));
      }
      const blob = new Blob([rows.join('\n')], { type:'text/csv' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `bulk-export-${Date.now()}.csv`; a.click();
      showToast(`Exported ${ids.length} jobs`, 'success');
    } catch (err) { showToast(err.message || 'Export failed', 'error'); }
  } else if (action === 'archive') {
    showConfirm('Archive Jobs', `Archive ${ids.length} selected jobs?`, async () => {
      try {
        const resp = await apiFetch('/api/jobs/bulk', { method:'POST', body: JSON.stringify({ action:'archive', job_ids:ids }) });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Archive failed');
        showToast(`Archived ${data.affected || ids.length} jobs`, 'success');
        toggleBulkMode(); await loadJobs();
      } catch (err) { showToast(err.message || 'Archive failed', 'error'); }
    });
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   RAPID JOB ENTRY
───────────────────────────────────────────────────────────────────────────── */
let rapidMachineCount = 0;

function openRapidEntry() {
  rapidMachineCount = 0;
  ['re-mobile','re-name','re-address','re-notes'].forEach(id => { const el = document.getElementById(id); if (el) el.value=''; });
  const ml = document.getElementById('rapid-machines-list'); if (ml) ml.innerHTML = '';
  addRapidMachine();
  openModal('rapid-entry-modal');
  setTimeout(() => document.getElementById('re-mobile')?.focus(), 100);
}

async function rapidMobileLookup() {
  const mobile = document.getElementById('re-mobile')?.value.trim();
  if (!mobile || mobile.length < 5) return;
  try {
    const resp = await apiFetch(`/api/customers/search?q=${encodeURIComponent(mobile)}`);
    const results = await resp.json();
    if (Array.isArray(results) && results.length) {
      const c = results[0];
      const nameEl = document.getElementById('re-name'); if (nameEl && !nameEl.value) nameEl.value = c.name || '';
      const addrEl = document.getElementById('re-address'); if (addrEl && !addrEl.value) addrEl.value = c.address || '';
    }
  } catch {}
}

function addRapidMachine() {
  rapidMachineCount++;
  const id = rapidMachineCount;
  const ml = document.getElementById('rapid-machines-list'); if (!ml) return;
  const div = document.createElement('div');
  div.id = `rm-${id}`;
  div.className = 'bg-gray-50 rounded-xl p-3 space-y-2 border border-gray-200';
  div.innerHTML = `
    <div class="flex items-center justify-between mb-1">
      <span class="text-sm font-semibold text-gray-700">Machine ${id}</span>
      ${id > 1 ? `<button onclick="removeRapidMachine(${id})" class="text-red-400 hover:text-red-600 text-xs"><i class="fas fa-times"></i></button>` : ''}
    </div>
    <input id="rm-desc-${id}" type="text" placeholder="Description (e.g., Ceiling Fan) *" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-400"/>
    <input id="rm-cond-${id}" type="text" placeholder="Condition / Problem" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-400"/>
    <div class="grid grid-cols-3 gap-2">
      <div><input id="rm-qty-${id}" type="number" min="1" value="1" placeholder="Qty" class="w-full border border-gray-200 rounded-lg px-2 py-2 text-sm outline-none focus:border-blue-400"/></div>
      <div><input id="rm-price-${id}" type="number" min="0" value="0" placeholder="Price" class="w-full border border-gray-200 rounded-lg px-2 py-2 text-sm outline-none focus:border-blue-400"/></div>
      <div>
        <select id="rm-staff-${id}" class="w-full border border-gray-200 rounded-lg px-2 py-2 text-sm outline-none focus:border-blue-400">
          <option value="">Staff</option>
          <option value="Staff 1">S1</option><option value="Staff 2">S2</option>
          <option value="Staff 3">S3</option><option value="Staff 4">S4</option>
        </select>
      </div>
    </div>`;
  ml.appendChild(div);
}

function removeRapidMachine(id) {
  const el = document.getElementById(`rm-${id}`); if (el) el.remove();
}

async function submitRapidEntry() {
  const mobile = document.getElementById('re-mobile')?.value.trim();
  const name   = document.getElementById('re-name')?.value.trim();
  const addr   = document.getElementById('re-address')?.value.trim();
  const notes  = document.getElementById('re-notes')?.value.trim();
  if (!name) { showToast('Customer name required', 'error'); return; }

  // Collect machines
  const machinesData = [];
  for (let i = 1; i <= rapidMachineCount; i++) {
    const el = document.getElementById(`rm-${i}`);
    if (!el) continue;
    const desc = document.getElementById(`rm-desc-${i}`)?.value.trim();
    if (!desc) continue;
    machinesData.push({
      description:    desc,
      condition_text: document.getElementById(`rm-cond-${i}`)?.value.trim() || null,
      quantity:       parseInt(document.getElementById(`rm-qty-${i}`)?.value)||1,
      unit_price:     parseFloat(document.getElementById(`rm-price-${i}`)?.value)||0,
      assigned_to:    document.getElementById(`rm-staff-${i}`)?.value || null,
      status:         'Under Repair'
    });
  }
  if (!machinesData.length) { showToast('Add at least one machine', 'error'); return; }

  const spinner = document.getElementById('re-spinner');
  const btnText = document.getElementById('re-btn-text');
  if (spinner) spinner.classList.remove('hidden');
  if (btnText) btnText.textContent = 'Creating…';

  try {
    // Create job
    const jResp = await apiFetch('/api/jobs', { method:'POST', body: JSON.stringify({ customer_name:name, customer_mobile:mobile||null, customer_address:addr||null, notes:notes||null }) });
    const jData = await jResp.json();
    if (!jResp.ok) throw new Error(jData.error || 'Job creation failed');
    const jobId = jData.job_id;

    // Upsert customer
    if (mobile) { try { await apiFetch('/api/customers/upsert', { method:'POST', body: JSON.stringify({ name, mobile, address:addr||null }) }); } catch {} }

    // Add machines
    let addedCount = 0;
    for (const m of machinesData) {
      try {
        await apiFetch(`/api/jobs/${jobId}/machines`, { method:'POST', body: JSON.stringify(m) });
        addedCount++;
      } catch(e) { console.warn('Machine add failed:', e.message); }
    }

    closeModal('rapid-entry-modal');
    showToast(`Job ${jobId} created with ${addedCount} machine(s)!`, 'success');
    await loadJobs();
  } catch (err) {
    if (err.message === 'offline_queued') { closeModal('rapid-entry-modal'); showToast('Queued for sync', 'warning'); }
    else showToast(err.message || 'Failed', 'error');
  } finally {
    if (spinner) spinner.classList.add('hidden');
    if (btnText) btnText.textContent = 'Create Job & Machines';
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   BARCODE GENERATION + SCANNER
───────────────────────────────────────────────────────────────────────────── */
function loadJsBarcode() {
  return new Promise(resolve => {
    if (typeof JsBarcode !== 'undefined') { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';
    s.onload = resolve; s.onerror = resolve;
    document.head.appendChild(s);
  });
}

async function showBarcode(jobId) {
  await loadJsBarcode();
  const container = document.getElementById('barcode-container');
  const label     = document.getElementById('barcode-job-id-text');
  if (!container) return;
  container.innerHTML = '<canvas id="barcode-canvas"></canvas>';
  if (label) label.textContent = jobId;
  try {
    JsBarcode('#barcode-canvas', jobId, {
      format:      'CODE128',
      lineColor:   '#000000',
      width:       2.5,
      height:      80,
      displayValue: true,
      fontSize:    16,
      margin:      10,
      background:  '#ffffff'
    });
  } catch (e) {
    container.innerHTML = `<p class="text-sm text-red-500">Barcode error: ${e.message}</p>`;
  }
  openModal('barcode-modal');
}

function downloadBarcode() {
  const canvas = document.getElementById('barcode-canvas');
  if (!canvas) return;
  const jobId = document.getElementById('barcode-job-id-text')?.textContent || 'barcode';
  canvas.toBlob(blob => { if (blob) downloadBlob(blob, `Barcode-${jobId}.png`); });
}

function printBarcode() {
  const canvas = document.getElementById('barcode-canvas');
  const jobId  = document.getElementById('barcode-job-id-text')?.textContent || '';
  if (!canvas) return;
  const dataUrl = canvas.toDataURL('image/png');
  const win = window.open('', '_blank', 'width=400,height=300');
  if (!win) { showToast('Pop-up blocked — use Download instead', 'warning'); return; }
  win.document.write(`<html><head><title>Barcode ${jobId}</title>
    <style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;margin:0;padding:20px;font-family:Arial;}
    img{max-width:300px;}h2{font-size:18px;margin-top:10px;}</style></head>
    <body><img src="${dataUrl}"/><h2>${jobId}</h2><script>window.onload=()=>window.print()<\/script></body></html>`);
  win.document.close();
}

// Mobile share for barcode
async function shareBarcodeSheet(jobId) {
  await loadJsBarcode();
  const canvas = document.createElement('canvas');
  try {
    JsBarcode(canvas, jobId, { format:'CODE128', lineColor:'#000000', width:3, height:100, displayValue:true, fontSize:18, margin:14 });
    canvas.toBlob(async blob => {
      if (!blob) return;
      const file = new File([blob], `Barcode-${jobId}.png`, { type:'image/png' });
      if (navigator.share && navigator.canShare && navigator.canShare({ files:[file] })) {
        try { await navigator.share({ title:`Job ${jobId} Barcode`, files:[file] }); return; } catch {}
      }
      downloadBlob(blob, `Barcode-${jobId}.png`);
    });
  } catch { showBarcode(jobId); }
}

/* Barcode scanner — uses camera + ZXing */
let scannerStream = null;
let scannerInterval = null;

async function openBarcodeScanner() {
  openModal('scanner-modal');
  const video = document.getElementById('scanner-video');
  const status = document.getElementById('scanner-status');
  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:'environment' } });
    if (video) { video.srcObject = scannerStream; await video.play(); }
    if (status) status.textContent = 'Camera active — scanning…';
    // Load ZXing
    await loadZXing();
    startZXingScan(video);
  } catch (err) {
    if (status) status.textContent = 'Camera unavailable — use manual entry below';
  }
}

function loadZXing() {
  return new Promise(resolve => {
    if (typeof ZXing !== 'undefined') { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
    s.onload = resolve; s.onerror = resolve;
    document.head.appendChild(s);
  });
}

function startZXingScan(video) {
  try {
    if (typeof ZXing === 'undefined') return;
    const hints = new Map();
    const formats = [ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.QR_CODE, ZXing.BarcodeFormat.DATA_MATRIX];
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
    const reader = new ZXing.MultiFormatReader();
    reader.setHints(hints);
    const status = document.getElementById('scanner-status');
    scannerInterval = setInterval(async () => {
      if (!video || video.readyState < 2) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        const lum = ZXing.HTMLCanvasElementLuminanceSource ? new ZXing.HTMLCanvasElementLuminanceSource(canvas) : null;
        if (!lum) return;
        const bmp    = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum));
        const result = reader.decode(bmp);
        if (result?.text) {
          if (status) status.textContent = `Found: ${result.text}`;
          stopScanner();
          jumpToJob(result.text.trim());
        }
      } catch {}
    }, 300);
  } catch (e) { console.warn('ZXing error:', e); }
}

function stopScanner() {
  if (scannerStream) { scannerStream.getTracks().forEach(t => t.stop()); scannerStream = null; }
  if (scannerInterval) { clearInterval(scannerInterval); scannerInterval = null; }
  closeModal('scanner-modal');
}

async function jumpToJob(jobId) {
  if (!jobId) return;
  const normalized = jobId.toUpperCase().trim();
  const job = allJobs.find(j => j.job_id === normalized) || deliveredJobs.find(j => j.job_id === normalized);
  if (job) {
    // Scroll to card
    const el = document.getElementById(`job-card-${normalized}`);
    if (el) { el.scrollIntoView({ behavior:'smooth', block:'center' }); el.style.outline = '3px solid #3b82f6'; setTimeout(() => el.style.outline='', 2000); }
    else { switchTab(job.all_delivered ? 'delivered' : 'active'); setTimeout(() => { const el2 = document.getElementById(`job-card-${normalized}`); if (el2) el2.scrollIntoView({ behavior:'smooth' }); }, 200); }
    showToast(`Found job ${normalized}`, 'success');
  } else {
    // Try API
    try {
      const resp = await apiFetch(`/api/jobs/${normalized}`);
      if (resp.ok) { await loadJobs(); setTimeout(() => jumpToJob(normalized), 500); }
      else showToast('Job not found: ' + normalized, 'error');
    } catch { showToast('Job not found: ' + normalized, 'error'); }
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   AI REPAIR SUGGESTIONS
───────────────────────────────────────────────────────────────────────────── */
async function getAISuggestions() {
  const desc = document.getElementById('machine-desc')?.value.trim();
  const cond = document.getElementById('machine-condition')?.value.trim();
  const box  = document.getElementById('ai-suggestions-box');
  if (!box) return;
  if (!desc) { showToast('Enter machine description first', 'warning'); return; }
  box.innerHTML = '<div class="text-xs text-purple-500 text-center py-2"><span class="spinner w-4 h-4 inline-block"></span> Loading AI suggestions…</div>';
  box.classList.remove('hidden');
  try {
    const resp = await apiFetch(`/api/jobs/ai-suggest?desc=${encodeURIComponent(desc)}&cond=${encodeURIComponent(cond||'')}`);
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error(data.error || 'AI failed');
    if (!data.suggestions?.length) { box.innerHTML = '<p class="text-xs text-gray-400 text-center py-2">No historical data for this machine yet</p>'; return; }
    box.innerHTML = `<p class="text-xs font-semibold text-purple-700 mb-2">🤖 Based on ${data.total_similar} similar repairs${data.avg_repair_hours ? ` · avg ${data.avg_repair_hours}h` : ''}:</p>` +
      data.suggestions.map(s => `<div class="bg-white rounded-lg px-3 py-2 cursor-pointer hover:bg-purple-100 border border-purple-100 text-xs text-gray-700 flex items-center justify-between" onclick="applyAISuggestion('${s.repair.replace(/'/g,"&#39;").replace(/\n/g,' ')}')">
        <span>${s.repair}</span>
        <span class="text-purple-500 font-semibold ml-2">${s.pct}%</span>
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<p class="text-xs text-red-400 text-center py-2">${err.message}</p>`;
  }
}

function applyAISuggestion(text) {
  const el = document.getElementById('machine-work-done'); if (el) el.value = text;
  const box = document.getElementById('ai-suggestions-box'); if (box) box.classList.add('hidden');
  showToast('Suggestion applied', 'info');
}

/* ─────────────────────────────────────────────────────────────────────────────
   AUDIO NOTES
───────────────────────────────────────────────────────────────────────────── */
let mediaRecorder = null, audioChunks = [], audioTimerInterval = null, audioSeconds = 0;
let currentAudioBase64 = null;

async function toggleAudioRecord() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  } else {
    await startAudioRecord();
  }
}

async function startAudioRecord() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = []; audioSeconds = 0;
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      stream.getTracks().forEach(t => t.stop());
      // Convert to base64
      const reader = new FileReader();
      reader.onload = () => {
        currentAudioBase64 = reader.result;
        const ind = document.getElementById('audio-saved-indicator');
        if (ind) ind.classList.remove('hidden');
      };
      reader.readAsDataURL(blob);
      clearInterval(audioTimerInterval);
      const timer = document.getElementById('audio-timer'); if (timer) timer.classList.add('hidden');
      const btn = document.getElementById('audio-record-btn');
      const icon = document.getElementById('audio-icon');
      const txt  = document.getElementById('audio-btn-text');
      if (btn)  btn.classList.remove('bg-red-600','text-white');
      if (btn)  btn.classList.add('bg-red-50','text-red-600');
      if (icon) { icon.classList.remove('fa-stop'); icon.classList.add('fa-microphone'); }
      if (txt)  txt.textContent = 'Re-record';
    };
    mediaRecorder.start();
    // Update UI
    const btn = document.getElementById('audio-record-btn');
    const icon = document.getElementById('audio-icon');
    const txt  = document.getElementById('audio-btn-text');
    const timer = document.getElementById('audio-timer');
    if (btn)  { btn.classList.remove('bg-red-50','text-red-600'); btn.classList.add('bg-red-600','text-white'); }
    if (icon) { icon.classList.remove('fa-microphone'); icon.classList.add('fa-stop'); }
    if (txt)  txt.textContent = 'Stop';
    if (timer) timer.classList.remove('hidden');
    audioTimerInterval = setInterval(() => { audioSeconds++; const m=Math.floor(audioSeconds/60); const s=audioSeconds%60; if (timer) timer.textContent=`${m}:${String(s).padStart(2,'0')}`; }, 1000);
  } catch (err) {
    showToast('Microphone unavailable: ' + err.message, 'error');
  }
}

function resetAudioRecorder() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  currentAudioBase64 = null;
  audioChunks = []; audioSeconds = 0;
  clearInterval(audioTimerInterval);
  const timer = document.getElementById('audio-timer'); if (timer) { timer.textContent = '0:00'; timer.classList.add('hidden'); }
  const ind = document.getElementById('audio-saved-indicator'); if (ind) ind.classList.add('hidden');
  const btn = document.getElementById('audio-record-btn');
  const icon = document.getElementById('audio-icon');
  const txt  = document.getElementById('audio-btn-text');
  if (btn)  { btn.classList.remove('bg-red-600','text-white'); btn.classList.add('bg-red-50','text-red-600'); }
  if (icon) { icon.classList.remove('fa-stop'); icon.classList.add('fa-microphone'); }
  if (txt)  txt.textContent = 'Record';
}

/* Patch saveMachine to include audio_note */
const _origSaveMachine = saveMachine;
// We'll override below after definition

/* ─────────────────────────────────────────────────────────────────────────────
   MACHINE TIMELINE
───────────────────────────────────────────────────────────────────────────── */
async function openTimeline(jobId) {
  openModal('timeline-modal');
  const el = document.getElementById('timeline-content');
  if (!el) return;
  el.innerHTML = '<div class="text-center py-6"><div class="spinner w-8 h-8 mx-auto mb-2"></div><p class="text-sm text-gray-400">Loading timeline…</p></div>';
  try {
    const resp = await apiFetch(`/api/jobs/${jobId}/timeline`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    const events = data.timeline || [];
    if (!events.length) { el.innerHTML = '<p class="text-center text-gray-400 text-sm py-6">No timeline events yet</p>'; return; }
    const iconMap = { received:'fa-box-open text-blue-500', assigned:'fa-user-tag text-green-500', repair_completed:'fa-check-circle text-green-600', marked_return:'fa-undo text-yellow-500', delivered:'fa-truck text-indigo-500', photo_uploaded:'fa-image text-purple-500', status_changed:'fa-exchange-alt text-gray-400' };
    el.innerHTML = `<div class="relative">
      <div class="absolute left-5 top-0 bottom-0 w-0.5 bg-gray-100"></div>
      <div class="space-y-4">
        ${events.map(e => {
          const ic = iconMap[e.event_type] || 'fa-circle text-gray-300';
          return `<div class="relative flex gap-4">
            <div class="w-10 h-10 rounded-full bg-white border-2 border-gray-100 flex items-center justify-center z-10 flex-shrink-0">
              <i class="fas ${ic} text-sm"></i>
            </div>
            <div class="flex-1 pb-4">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <p class="font-semibold text-gray-800 text-sm">${e.event_type.replace(/_/g,' ')}</p>
                  ${e.event_note ? `<p class="text-xs text-gray-500 mt-0.5">${e.event_note}</p>` : ''}
                  ${e.description ? `<p class="text-xs text-blue-500 mt-0.5">Machine: ${e.description}</p>` : ''}
                </div>
                <div class="text-right">
                  <p class="text-xs text-gray-400">${fmtDate(e.created_at)}</p>
                  ${e.actor ? `<p class="text-xs text-gray-400">${e.actor}</p>` : ''}
                </div>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  } catch (err) { el.innerHTML = `<p class="text-center text-red-400 text-sm py-6">${err.message}</p>`; }
}

/* ─────────────────────────────────────────────────────────────────────────────
   TRASH / SOFT DELETE RECOVERY
───────────────────────────────────────────────────────────────────────────── */
async function openTrash() {
  openModal('trash-modal');
  const el = document.getElementById('trash-content');
  if (!el) return;
  el.innerHTML = '<div class="text-center py-6"><div class="spinner w-8 h-8 mx-auto mb-2"></div><p class="text-sm text-gray-400">Loading…</p></div>';
  try {
    const resp = await apiFetch('/api/jobs/trash/list');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    const items = data.items || [];
    if (!items.length) { el.innerHTML = '<p class="text-center text-gray-400 text-sm py-6">Trash is empty</p>'; return; }
    el.innerHTML = items.map(item => {
      const purge  = item.purge_at ? new Date(item.purge_at).toLocaleDateString('en-IN') : 'N/A';
      const del    = item.deleted_at ? new Date(item.deleted_at).toLocaleDateString('en-IN') : '';
      const parsed = (() => { try { return JSON.parse(item.item_data); } catch { return {}; } })();
      const label  = item.item_type === 'job'
        ? `Job ${item.item_id} — ${parsed.job?.customer_name || parsed.customer_name || ''}`
        : `Machine #${item.item_id} — ${parsed.description || ''}`;
      return `<div class="bg-white rounded-xl border border-orange-100 p-4 flex items-center justify-between gap-3">
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-sm text-gray-800">${label}</p>
          <p class="text-xs text-gray-400">Deleted: ${del} · Purge: ${purge}</p>
        </div>
        <button onclick="restoreTrashItem(${item.id})" class="text-xs bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-700 font-semibold flex-shrink-0"><i class="fas fa-undo mr-1"></i>Restore</button>
      </div>`;
    }).join('');
  } catch (err) { el.innerHTML = `<p class="text-center text-red-400 text-sm py-6">${err.message}</p>`; }
}

async function restoreTrashItem(trashId) {
  try {
    const resp = await apiFetch('/api/jobs/trash/restore', { method:'POST', body: JSON.stringify({ trash_id: trashId }) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Restore failed');
    showToast(data.message || 'Restored', 'success');
    await openTrash(); // refresh trash list
    await loadJobs();
  } catch (err) { showToast(err.message || 'Restore failed', 'error'); }
}

/* ─────────────────────────────────────────────────────────────────────────────
   CUSTOMER LOOKUP
───────────────────────────────────────────────────────────────────────────── */
async function customerLookup() {
  const q  = document.getElementById('lookup-mobile')?.value.trim() || '';
  const el = document.getElementById('lookup-result');
  if (!el) return;
  if (q.length < 3) { el.innerHTML = '<p class="text-sm text-gray-400 text-center py-2">Type at least 3 chars</p>'; return; }
  el.innerHTML = '<div class="text-center py-4"><div class="spinner w-6 h-6 mx-auto"></div></div>';
  try {
    const resp = await apiFetch(`/api/customers/search?q=${encodeURIComponent(q)}`);
    const results = await resp.json();
    if (!Array.isArray(results) || !results.length) { el.innerHTML = '<p class="text-sm text-gray-400 text-center py-2">No customers found</p>'; return; }
    el.innerHTML = results.map(c => `<div class="bg-gray-50 rounded-xl p-4 border border-gray-100 space-y-2">
      <div class="flex items-start justify-between gap-2">
        <div>
          <p class="font-bold text-gray-800">${c.name}</p>
          <p class="text-sm text-gray-500">${c.mobile}${c.address ? ` · ${c.address}` : ''}</p>
          <p class="text-xs text-gray-400">Jobs: ${c.job_count || 0} · Last: ${fmtDate(c.last_seen)}</p>
        </div>
        <span class="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded-lg font-semibold">${c.job_count || 0} jobs</span>
      </div>
      <div class="flex gap-2 flex-wrap">
        <button onclick="closeModal('customer-lookup-modal');openNewJobModal();fillJobMobile('${c.mobile}','${c.name.replace(/'/g,"&#39;")}','${(c.address||'').replace(/'/g,"&#39;")}')" class="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 font-semibold"><i class="fas fa-plus mr-1"></i>New Job</button>
        <button onclick="lookupJobHistory('${c.mobile}')" class="text-xs border border-gray-200 text-gray-600 px-3 py-1.5 rounded-lg hover:bg-gray-50 font-semibold"><i class="fas fa-history mr-1"></i>History</button>
        <button onclick="shareWhatsAppContact('${c.mobile}','${c.name.replace(/'/g,"&#39;")}')" class="text-xs bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-700 font-semibold"><i class="fab fa-whatsapp mr-1"></i>WhatsApp</button>
      </div>
      <div id="history-${c.mobile}" class="hidden mt-2"></div>
    </div>`).join('');
  } catch (err) { el.innerHTML = `<p class="text-sm text-red-400 text-center py-2">${err.message}</p>`; }
}

function fillJobMobile(mobile, name, address) {
  setTimeout(() => {
    const mel = document.getElementById('new-customer-mobile'); if (mel) mel.value = mobile;
    const nel = document.getElementById('new-customer-name');   if (nel) nel.value = name;
    const ael = document.getElementById('new-customer-address'); if (ael) ael.value = address;
  }, 200);
}

async function lookupJobHistory(mobile) {
  const el = document.getElementById(`history-${mobile}`);
  if (!el) return;
  if (!el.classList.contains('hidden')) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = '<p class="text-xs text-gray-400 text-center py-2">Loading…</p>';
  try {
    const resp = await apiFetch(`/api/jobs/search?q=${encodeURIComponent(mobile)}`);
    const results = await resp.json();
    if (!Array.isArray(results) || !results.length) { el.innerHTML = '<p class="text-xs text-gray-400 text-center py-2">No jobs found</p>'; return; }
    el.innerHTML = `<div class="space-y-1">${results.map(j => `<div class="flex items-center gap-2 text-xs text-gray-600 bg-white rounded-lg px-3 py-2 border border-gray-100">
      <span class="font-bold text-blue-600">${j.job_id}</span>
      <span class="flex-1">${j.customer_name}</span>
      <span class="text-gray-400">${fmtDate(j.created_at)}</span>
    </div>`).join('')}</div>`;
  } catch (err) { el.innerHTML = `<p class="text-xs text-red-400 text-center py-2">${err.message}</p>`; }
}

function shareWhatsAppContact(mobile, name) {
  const text = `Hi ${name}, regarding your service with ADITION ELECTRIC SOLUTION.`;
  const wa   = `https://wa.me/91${mobile}?text=${encodeURIComponent(text)}`;
  window.open(wa, '_blank');
}

/* ─────────────────────────────────────────────────────────────────────────────
   SYSTEM HEALTH
───────────────────────────────────────────────────────────────────────────── */
async function openSystemHealth() {
  openModal('health-modal');
  const el = document.getElementById('health-content');
  if (!el) return;
  el.innerHTML = '<div class="text-center py-6"><div class="spinner w-8 h-8 mx-auto mb-2"></div><p class="text-sm text-gray-400">Loading health data…</p></div>';
  try {
    const resp = await apiFetch('/api/jobs/system-health');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    el.innerHTML = `<div class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        ${[
          { label:'Total Jobs',     value:data.total_jobs,    color:'blue', icon:'fa-clipboard-list' },
          { label:'Total Machines', value:data.total_machines, color:'green', icon:'fa-cog' },
          { label:'Delivered Jobs', value:data.delivered_jobs, color:'indigo', icon:'fa-truck' },
          { label:'In Trash',       value:data.soft_deleted,   color:'orange', icon:'fa-trash' },
        ].map(s => `<div class="bg-${s.color}-50 rounded-xl p-4 text-center">
          <i class="fas ${s.icon} text-${s.color}-400 text-lg mb-2 block"></i>
          <p class="text-2xl font-black text-${s.color}-700">${s.value || 0}</p>
          <p class="text-xs text-gray-500 mt-1">${s.label}</p>
        </div>`).join('')}
      </div>
      <div class="bg-gray-50 rounded-xl p-4 space-y-3">
        <div class="flex justify-between items-center">
          <span class="text-sm text-gray-600">Est. DB Size</span>
          <span class="font-semibold text-gray-800">${data.est_db_size_mb || '0.00'} MB</span>
        </div>
        <div class="flex justify-between items-center">
          <span class="text-sm text-gray-600">Last Backup</span>
          <span class="font-semibold text-gray-800">${data.last_backup ? `${data.last_backup.backup_key} (${fmtDate(data.last_backup.created_at)})` : 'Never'}</span>
        </div>
      </div>
      <div class="flex gap-3">
        <button onclick="runMonthlyBackup()" class="flex-1 bg-teal-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-teal-700"><i class="fas fa-cloud-download-alt mr-1"></i> Backup Now</button>
        <button onclick="closeModal('health-modal');openAdminTools()" class="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2 text-sm font-medium">Admin Tools</button>
      </div>
    </div>`;
  } catch (err) { el.innerHTML = `<p class="text-center text-red-400 text-sm py-6">${err.message}</p>`; }
}

/* ─────────────────────────────────────────────────────────────────────────────
   ANALYTICS
───────────────────────────────────────────────────────────────────────────── */
let analyticsData = [];

async function openAnalytics() {
  openModal('analytics-modal');
  await loadAnalytics();
}

async function loadAnalytics() {
  const from = document.getElementById('analytics-from')?.value || '';
  const to   = document.getElementById('analytics-to')?.value   || '';
  let url = '/api/analytics/customers';
  if (from && to) url += `?from=${from}&to=${to}`;

  const tbody = document.getElementById('analytics-table-body');
  const ov    = document.getElementById('analytics-overview');
  if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center py-8"><div class="spinner w-6 h-6 mx-auto"></div></td></tr>';

  try {
    const [custResp, ovResp] = await Promise.all([
      apiFetch(url),
      apiFetch('/api/analytics/overview' + (from && to ? `?from=${from}&to=${to}` : ''))
    ]);
    const custData = await custResp.json();
    const ovData   = await ovResp.json();

    analyticsData = custData.customers || [];
    const overview = ovData.overview || {};

    if (ov) {
      ov.innerHTML = [
        { label:'Total Jobs',     value:overview.total_jobs     || 0, color:'blue' },
        { label:'Total Machines', value:overview.total_machines || 0, color:'green' },
        { label:'Revenue',        value:fmtCurrency(overview.total_revenue||0), color:'indigo' },
        { label:'Delivered',      value:overview.delivered      || 0, color:'gray' },
        { label:'Under Repair',   value:overview.under_repair   || 0, color:'red' },
        { label:'Repaired',       value:overview.repaired       || 0, color:'emerald' },
      ].map(s => `<div class="bg-${s.color}-50 rounded-xl p-3 text-center">
        <p class="text-xs text-gray-500 mb-1">${s.label}</p>
        <p class="text-lg font-bold text-${s.color}-700">${s.value}</p>
      </div>`).join('');
    }

    if (!analyticsData.length) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-gray-400 text-sm">No customer data</td></tr>';
      return;
    }
    if (tbody) tbody.innerHTML = analyticsData.map(c => `<tr class="hover:bg-gray-50 border-b border-gray-50">
      <td class="px-3 py-2 font-semibold text-gray-800">${c.customer_name}</td>
      <td class="px-3 py-2 text-gray-500">${c.customer_mobile || '—'}</td>
      <td class="px-3 py-2 text-center font-bold text-blue-600">${c.total_jobs}</td>
      <td class="px-3 py-2 text-center text-gray-600">${c.total_machines}</td>
      <td class="px-3 py-2 text-right font-semibold text-green-700">${fmtCurrency(c.total_revenue||0)}</td>
    </tr>`).join('');
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-red-400 text-sm">${err.message}</td></tr>`;
  }
}

function exportAnalyticsCsv() {
  if (!analyticsData.length) { showToast('Load data first', 'warning'); return; }
  const rows = [['Customer','Mobile','Total Jobs','Total Machines','Revenue','Last Job'].join(',')];
  analyticsData.forEach(c => rows.push([c.customer_name,c.customer_mobile||'',c.total_jobs,c.total_machines,c.total_revenue||0,c.last_job_at||''].map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(',')));
  const blob = new Blob([rows.join('\n')], { type:'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `customer-analytics-${Date.now()}.csv`; a.click();
  showToast('Analytics exported', 'success');
}

/* ─────────────────────────────────────────────────────────────────────────────
   MONTHLY BACKUP
───────────────────────────────────────────────────────────────────────────── */
async function runMonthlyBackup() {
  showToast('Creating backup…', 'info');
  try {
    const resp = await apiFetch('/api/admin/backup', { method:'POST', body:'{}' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || data.detail || 'Backup failed');

    const { jobs=[], machines=[], customers=[], backup_key } = data;
    // Build CSV
    const rows = [['type','job_id','customer_name','customer_mobile','customer_address','amount_received','notes','created_at','machine_id','description','condition_text','quantity','unit_price','status','assigned_to','work_done','return_reason','delivered_at'].join(',')];
    for (const j of jobs) {
      const jm = machines.filter(m => m.job_id === j.job_id);
      if (!jm.length) {
        rows.push(['job',j.job_id,j.customer_name,j.customer_mobile||'',j.customer_address||'',j.amount_received||0,j.notes||'',j.created_at,'','','','','','','','','',''].map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(','));
      } else {
        for (const m of jm) rows.push(['job',j.job_id,j.customer_name,j.customer_mobile||'',j.customer_address||'',j.amount_received||0,j.notes||'',j.created_at,m.id,m.description,m.condition_text||'',m.quantity||1,m.unit_price||0,m.status,m.assigned_to||'',m.work_done||'',m.return_reason||'',m.delivered_at||''].map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(','));
      }
    }
    for (const c of customers) rows.push(['customer','',c.name,c.mobile,c.address||'','','',c.created_at,'','','','','','','','','',''].map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(','));
    const blob = new Blob([rows.join('\n')], { type:'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${backup_key || 'backup'}.csv`; a.click();
    showToast(`Backup ${backup_key} created (${data.record_count} records)`, 'success', 5000);
  } catch (err) { showToast(err.message || 'Backup failed', 'error'); }
}

/* ─────────────────────────────────────────────────────────────────────────────
   PRIORITY ALERT COLORS
   - All repaired (ready to deliver) → GREEN card glow
   - Has courier machine with delivery_info.type==='courier' → YELLOW glow  
   - Pending >24h (any Under Repair) → RED glow
   - Staff: assigned machine → BLUE highlight (already done per machine row)
───────────────────────────────────────────────────────────────────────────── */
function getJobAlertClass(job) {
  const machines = job.machines || [];
  const now = Date.now();

  // All repaired / ready to deliver
  if (job.all_repaired && !job.all_delivered) return 'job-alert-green';

  // Check if any machine has been under repair > 24h
  const urgent = machines.some(m => m.status === 'Under Repair' && m.created_at && (now - new Date(m.created_at).getTime()) > 24*3600*1000);
  if (urgent) return 'job-alert-red';

  return '';
}

// Override buildJobCard to use alert classes and bulk checkboxes
const _origBuildJobCard = buildJobCard;
// (defined inline below to replace the original)

/* ─────────────────────────────────────────────────────────────────────────────
   OVERRIDE buildJobCard with alert + bulk selection
───────────────────────────────────────────────────────────────────────────── */
function buildJobCard(job) {
  const isAdmin      = userRole === 'admin';
  const allDelivered = job.all_delivered;
  const machines     = job.machines || [];
  const alertClass   = getJobAlertClass(job);

  const machinesHtml = machines.length
    ? machines.map(m => buildMachineRow(m, job.job_id)).join('')
    : `<p class="text-gray-400 text-xs text-center py-4">No machines yet</p>`;

  const totalsHtml = isAdmin ? `<span class="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2 py-1 rounded-lg">
    Total: ${fmtCurrency(job.grand_total||0)} · Paid: ${fmtCurrency(job.amount_received||0)} · Bal: ${fmtCurrency(job.balance||0)}
  </span>` : '';

  const mobileHtml = isAdmin && job.customer_mobile ? `<span class="text-xs text-gray-400">${job.customer_mobile}</span>` : '';
  const addrHtml   = isAdmin && job.customer_address ? `<span class="text-xs text-gray-400">${job.customer_address}</span>` : '';

  // Staff: highlight if any machine is assigned to me
  const mineIndicator = (!isAdmin && job.has_mine)
    ? `<span class="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full font-semibold">📌 Has my work</span>` : '';

  // Alert badge
  const alertBadge = !allDelivered ? (() => {
    if (job.all_repaired) return `<span class="text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full font-semibold">✅ Ready to Deliver</span>`;
    const urgent = machines.some(m => m.status === 'Under Repair' && m.created_at && (Date.now() - new Date(m.created_at).getTime()) > 24*3600*1000);
    if (urgent) return `<span class="text-xs text-red-700 bg-red-100 px-2 py-0.5 rounded-full font-semibold">⚠️ Pending >24h</span>`;
    return '';
  })() : '';

  const editBtn    = isAdmin ? `<button onclick="openEditJob('${job.job_id}')" class="action-btn bg-yellow-50 text-yellow-600 hover:bg-yellow-100" title="Edit"><i class="fas fa-edit text-xs"></i></button>` : '';
  const deleteBtn  = isAdmin && userEmail === OWNER_EMAIL ? `<button onclick="deleteJob('${job.job_id}')" class="action-btn bg-red-50 text-red-500 hover:bg-red-100" title="Delete"><i class="fas fa-trash text-xs"></i></button>` : '';
  const addMachBtn = isAdmin ? `<button onclick="openAddMachine('${job.job_id}')" class="action-btn-sm bg-blue-50 text-blue-600 hover:bg-blue-100"><i class="fas fa-plus text-xs"></i> Machine</button>` : '';
  const deliverBtn = isAdmin && !allDelivered && job.all_repaired && machines.length > 0
    ? `<button onclick="openDelivery('${job.job_id}')" class="action-btn-sm bg-indigo-600 text-white hover:bg-indigo-700"><i class="fas fa-truck text-xs"></i> Deliver</button>` : '';
  const timelineBtn= `<button onclick="openTimeline('${job.job_id}')" class="action-btn-sm bg-gray-50 text-gray-500 hover:bg-gray-100" title="Timeline"><i class="fas fa-history text-xs"></i></button>`;
  const barcodeBtn = `<button onclick="showBarcode('${job.job_id}')" class="action-btn-sm bg-gray-50 text-gray-600 hover:bg-gray-100" title="Barcode"><i class="fas fa-barcode text-xs"></i></button>`;

  const waRegBtn = isAdmin ? `<button onclick="shareWhatsApp('${job.job_id}','register')" class="action-btn-sm bg-green-600 text-white hover:bg-green-700" title="Share registration"><i class="fab fa-whatsapp text-xs"></i> Register</button>` : '';
  const waDelBtn = isAdmin && allDelivered ? `<button onclick="shareWhatsApp('${job.job_id}','delivered')" class="action-btn-sm bg-green-700 text-white hover:bg-green-800"><i class="fab fa-whatsapp text-xs"></i> Delivered</button>` : '';
  const jpgBtn   = isAdmin ? `<button onclick="generateJobCardImage('${job.job_id}')" class="action-btn-sm bg-purple-50 text-purple-600 hover:bg-purple-100"><i class="fas fa-image text-xs"></i> JPG</button>` : '';

  const bulkCb = bulkMode ? `<input type="checkbox" id="bulk-cb-${job.job_id}" ${bulkSelected.has(job.job_id)?'checked':''} onclick="toggleBulkSelect('${job.job_id}')" class="w-4 h-4 text-blue-600 mr-2 flex-shrink-0 rounded">` : '';
  const cardBg = allDelivered ? 'job-card-delivered' : `bg-white ${alertClass}`;

  return `<div class="${cardBg} rounded-xl border border-gray-200 shadow-sm overflow-hidden" id="job-card-${job.job_id}">
    <div class="flex items-start justify-between p-4 pb-2">
      <div class="flex items-start gap-1.5 flex-1 min-w-0">
        ${bulkCb}
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span class="font-black text-blue-600 text-base">${job.job_id}</span>
            ${allDelivered ? `<span class="status-badge status-delivered">🔵 Delivered</span>` : ''}
            ${alertBadge}
            ${mineIndicator}
          </div>
          <p class="font-bold text-gray-800 text-sm">${job.customer_name}</p>
          <div class="flex flex-wrap gap-2 mt-0.5">${mobileHtml}${addrHtml}</div>
          ${job.notes ? `<p class="text-xs text-gray-400 mt-1 italic">${job.notes}</p>` : ''}
        </div>
      </div>
      <div class="flex items-center gap-1 ml-2">${editBtn}${deleteBtn}</div>
    </div>
    ${isAdmin ? `<div class="px-4 pb-2 flex items-center justify-between flex-wrap gap-2">${totalsHtml}<span class="text-xs text-gray-400">${fmtDate(job.created_at)}</span></div>` : `<div class="px-4 pb-2"><span class="text-xs text-gray-400">${fmtDate(job.created_at)}</span></div>`}
    <div class="border-t border-gray-100 divide-y divide-gray-50">${machinesHtml}</div>
    <div class="flex items-center gap-2 px-4 py-3 border-t border-gray-100 flex-wrap">
      ${addMachBtn}${deliverBtn}${timelineBtn}${barcodeBtn}${jpgBtn}${waRegBtn}${waDelBtn}
    </div>
  </div>`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   OVERRIDE saveMachine to include audio_note
───────────────────────────────────────────────────────────────────────────── */
async function saveMachine() {
  const desc         = document.getElementById('machine-desc').value.trim();
  const status       = document.getElementById('machine-status').value;
  const workDone     = document.getElementById('machine-work-done').value.trim();
  const returnReason = document.getElementById('machine-return-reason').value.trim();
  if (!desc) { showToast('Description required', 'error'); return; }
  if (status === 'Repaired' && !workDone)     { showToast('Work done is required for Repaired status', 'error'); return; }
  if (status === 'Return'   && !returnReason) { showToast('Return reason is required', 'error'); return; }

  const imgEl   = document.getElementById('machine-image-preview');
  const imgData = imgEl.classList.contains('hidden') ? null : (imgEl.src || null);
  const cleanImg = imgData && imgData.length > 50 ? imgData : null;

  const body = {
    description:    desc,
    condition_text: document.getElementById('machine-condition').value.trim() || null,
    quantity:       parseInt(document.getElementById('machine-qty').value) || 1,
    unit_price:     parseFloat(document.getElementById('machine-price').value) || 0,
    assigned_to:    document.getElementById('machine-assigned-to').value.trim() || null,
    status,
    work_done:      workDone     || null,
    return_reason:  returnReason || null,
    image_data:     cleanImg,
    audio_note:     currentAudioBase64 || null
  };

  const spinner = document.getElementById('machine-save-spinner');
  const btnText = document.getElementById('machine-save-btn-text');
  spinner.classList.remove('hidden'); btnText.textContent = 'Saving…';
  try {
    let resp;
    if (currentMachineId) {
      resp = await apiFetch(`/api/jobs/${currentMachineJobId}/machines/${currentMachineId}`, { method:'PUT', body: JSON.stringify(body) });
    } else {
      resp = await apiFetch(`/api/jobs/${currentMachineJobId}/machines`, { method:'POST', body: JSON.stringify(body) });
    }
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || data.detail || 'Failed to save machine');
    resetAudioRecorder();
    closeModal('machine-modal');
    showToast(currentMachineId ? 'Machine updated ✓' : 'Machine added ✓', 'success');
    await loadJobs();
  } catch (err) {
    if (err.message === 'offline_queued') { closeModal('machine-modal'); showToast('Queued for sync', 'warning'); resetAudioRecorder(); }
    else showToast(err.message || 'Failed to save machine', 'error');
  } finally {
    spinner.classList.add('hidden');
    btnText.textContent = currentMachineId ? 'Save Changes' : 'Add Machine';
  }
}

/* Reset audio on close */
const _origCloseModal = closeModal;
function closeModal(id) {
  if (id === 'machine-modal') resetAudioRecorder();
  const m = document.getElementById(id); if (m) m.classList.add('hidden');
}

/* ─────────────────────────────────────────────────────────────────────────────
   ALERT COLOR CSS (injected at runtime)
───────────────────────────────────────────────────────────────────────────── */
(function injectAlertCSS() {
  const style = document.createElement('style');
  style.textContent = `
    .job-alert-green { box-shadow: 0 0 0 2px #16a34a40 !important; border-color: #16a34a88 !important; }
    .job-alert-red   { box-shadow: 0 0 0 2px #dc262640 !important; border-color: #dc262688 !important; }
    .job-alert-yellow{ box-shadow: 0 0 0 2px #d9770640 !important; border-color: #d9770688 !important; }
    .thumb-img { width:48px;height:48px;object-fit:cover;border-radius:8px;border:1px solid #e2e8f0;cursor:pointer;flex-shrink:0; }
  `;
  document.head.appendChild(style);
})();

/* ─────────────────────────────────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────────────────────────────────── */
(async function init() {
  await openIDB();
  if (!tryRestoreSession()) {
    document.getElementById('login-screen').classList.remove('hidden');
  }
})();
