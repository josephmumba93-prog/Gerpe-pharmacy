// ============================================================
// GERPE PHARMACY MANAGEMENT SYSTEM
// ============================================================

// ---------- 1. SUPABASE CONFIG ----------
// Replace these two values with your own Supabase project credentials.
// Find them in: Supabase Dashboard > Project Settings > API
const SUPABASE_URL = "https://jrxvoxddcbugbdoecekb.supabase.co/rest/v1/";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpyeHZveGRkY2J1Z2Jkb2VjZWtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwMzExNjcsImV4cCI6MjA5NzYwNzE2N30.eYFMaywJyjsGni0txlO1E5PnNFvJCPeSxObm9egX0us";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- 2. GLOBAL STATE ----------
const STATE = {
  user: null,        // auth user
  profile: null,     // profiles row (full_name, role, is_active)
  settings: null,    // app_settings row
  currentPage: 'dashboard',
  notifications: [],
  cache: {
    categories: [],
    suppliers: [],
    products: [],
  }
};

// ---------- 3. UTILITIES ----------
function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtMoney(n) {
  const cur = STATE.settings?.currency || 'ZMW';
  const num = Number(n || 0);
  return `${cur} ${num.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function timeAgo(d) {
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  return Math.floor(diff/86400) + 'd ago';
}
function uid() { return Math.random().toString(36).slice(2,9); }

function toast(msg, type='info') {
  const box = $('#toastBox');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'warn' ? '⚠' : 'ℹ';
  el.innerHTML = `<span>${icon}</span><span>${esc(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(), 300); }, 3500);
}

function isAdmin() { return STATE.profile?.role === 'admin'; }

// Debounce helper for search inputs
function debounce(fn, ms=300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// CSV export helper
function exportCSV(filename, rows, headers) {
  const headerLine = headers.map(h => `"${h.label.replace(/"/g,'""')}"`).join(',');
  const lines = rows.map(row =>
    headers.map(h => {
      let v = typeof h.get === 'function' ? h.get(row) : row[h.key];
      if (v === null || v === undefined) v = '';
      return `"${String(v).replace(/"/g,'""')}"`;
    }).join(',')
  );
  const csv = [headerLine, ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('Exported ' + filename, 'success');
}

// ---------- 4. MODAL SYSTEM ----------
function openModal(html, opts={}) {
  const box = $('#modalBox');
  box.className = 'modal' + (opts.large ? ' modal-lg' : '');
  box.innerHTML = html;
  $('#modalOverlay').classList.add('show');
  $all('.modal-close', box).forEach(b => b.addEventListener('click', closeModal));
}
function closeModal() {
  $('#modalOverlay').classList.remove('show');
  $('#modalBox').innerHTML = '';
}
$('#modalOverlay')?.addEventListener('click', (e) => { if (e.target.id === 'modalOverlay') closeModal(); });

function confirmAction(message, onConfirm) {
  openModal(`
    <div class="modal-header"><h3>Confirm</h3><button class="modal-close">×</button></div>
    <div class="modal-body"><p>${esc(message)}</p></div>
    <div class="modal-footer">
      <button class="btn btn-secondary modal-close">Cancel</button>
      <button class="btn btn-danger" id="confirmYesBtn">Yes, proceed</button>
    </div>
  `);
  $('#confirmYesBtn').addEventListener('click', async () => {
    closeModal();
    await onConfirm();
  });
}

// ============================================================
// 5. AUTH FLOW
// ============================================================
async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) {
    await loadUserSession(session.user);
  } else {
    showAuthScreen();
  }

  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT') {
      showAuthScreen();
    }
  });
}

async function loadUserSession(authUser) {
  STATE.user = authUser;
  const { data: profile, error } = await sb.from('profiles').select('*').eq('id', authUser.id).maybeSingle();

  if (error || !profile) {
    showAuthError('Could not load your profile. Contact an administrator.');
    await sb.auth.signOut();
    return;
  }
  if (!profile.is_active) {
    showAuthError('Your account has been deactivated. Contact an administrator.');
    await sb.auth.signOut();
    return;
  }

  STATE.profile = profile;
  await loadSettings();
  showApp();
}

async function loadSettings() {
  const { data } = await sb.from('app_settings').select('*').eq('id', 1).maybeSingle();
  STATE.settings = data || { pharmacy_name: 'Gerpe Pharmacy', currency: 'ZMW', expiry_warning_days: 30, low_stock_default: 10 };
  $('#authScreen .auth-logo h1') && ($('#authScreen .auth-logo h1').textContent = STATE.settings.pharmacy_name);
  const nameEls = $all('.sidebar-header .name');
  nameEls.forEach(el => el.textContent = STATE.settings.pharmacy_name);
}

function showAuthScreen() {
  $('#loadingScreen').style.display = 'none';
  $('#app').style.display = 'none';
  $('#authScreen').style.display = 'flex';
}

function showAuthError(msg) {
  const el = $('#authError');
  el.textContent = msg;
  el.style.display = 'block';
}

async function showApp() {
  $('#loadingScreen').style.display = 'none';
  $('#authScreen').style.display = 'none';
  $('#app').style.display = 'block';

  // Populate user chip
  $('#userName').textContent = STATE.profile.full_name;
  $('#userRole').innerHTML = `<span class="role-pill ${STATE.profile.role}">${STATE.profile.role}</span>`;
  $('#userAvatar').textContent = STATE.profile.full_name.charAt(0).toUpperCase();

  // Hide admin-only nav items for staff
  if (!isAdmin()) {
    $all('.admin-only').forEach(el => el.style.display = 'none');
  } else {
    $all('.admin-only').forEach(el => el.style.display = '');
  }

  await loadNotifications();
  navigateTo('dashboard');
  startNotificationPolling();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#authError').style.display = 'none';
  const email = $('#loginEmail').value.trim();
  const password = $('#loginPassword').value;
  const btn = $('#loginBtn');
  btn.disabled = true;
  btn.textContent = 'Signing in...';

  const { data, error } = await sb.auth.signInWithPassword({ email, password });

  btn.disabled = false;
  btn.textContent = 'Sign In';

  if (error) {
    showAuthError(error.message === 'Invalid login credentials' ? 'Invalid email or password.' : error.message);
    return;
  }
  if (data?.user) {
    $('#loadingScreen').style.display = 'flex';
    await loadUserSession(data.user);
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await sb.auth.signOut();
  STATE.user = null;
  STATE.profile = null;
  location.reload();
});

// ============================================================
// 6. NAVIGATION
// ============================================================
const PAGE_TITLES = {
  dashboard: 'Dashboard',
  products: 'Products',
  categories: 'Categories',
  suppliers: 'Suppliers',
  purchases: 'Purchases',
  sales: 'Sales',
  reports: 'Reports',
  users: 'User Management',
  settings: 'App Settings',
};

const PAGE_RENDERERS = {}; // populated by each module file section below

function navigateTo(page) {
  if (!PAGE_RENDERERS[page]) page = 'dashboard';
  if ((page === 'users' || page === 'settings') && !isAdmin()) page = 'dashboard';

  STATE.currentPage = page;
  $all('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  $('#pageTitle').textContent = PAGE_TITLES[page] || 'Gerpe Pharmacy';
  $('#sidebar').classList.remove('open');
  $('#pageContent').innerHTML = '<div style="padding:60px;text-align:center;color:var(--muted);"><div class="spinner" style="border-top-color:var(--teal);border-color:#e2e8f0;margin:0 auto 12px;"></div>Loading...</div>';
  PAGE_RENDERERS[page]();
}

$all('.nav-item').forEach(el => {
  el.addEventListener('click', () => navigateTo(el.dataset.page));
});

$('#menuToggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

// ============================================================
// 7. NOTIFICATIONS
// ============================================================
async function loadNotifications() {
  const { data, error } = await sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(30);
  if (!error) {
    STATE.notifications = data || [];
    renderNotifBell();
  }
}

function renderNotifBell() {
  const unread = STATE.notifications.filter(n => !n.is_read).length;
  $('#bellDot').style.display = unread > 0 ? 'block' : 'none';

  const list = $('#notifList');
  if (STATE.notifications.length === 0) {
    list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
    return;
  }
  const typeColors = {
    out_of_stock: 'danger', low_stock: 'warn', expired: 'danger', expiring_soon: 'warn', general: 'muted'
  };
  const typeLabels = {
    out_of_stock: 'Out of stock', low_stock: 'Low stock', expired: 'Expired', expiring_soon: 'Expiring soon', general: 'Notice'
  };
  list.innerHTML = STATE.notifications.map(n => `
    <div class="notif-item" style="background:${n.is_read ? '#fff' : '#f8fafc'};">
      <div class="ntype" style="color:var(--${typeColors[n.type]==='muted'?'muted':typeColors[n.type]});">${typeLabels[n.type] || n.type}</div>
      <div>${esc(n.message)}</div>
      <div class="ntime">${timeAgo(n.created_at)}</div>
    </div>
  `).join('');
}

$('#bellBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#notifPanel').classList.toggle('show');
});
document.addEventListener('click', (e) => {
  if (!$('#notifPanel').contains(e.target) && e.target.id !== 'bellBtn') {
    $('#notifPanel').classList.remove('show');
  }
});
$('#markAllReadBtn').addEventListener('click', async () => {
  const unreadIds = STATE.notifications.filter(n => !n.is_read).map(n => n.id);
  if (unreadIds.length === 0) return;
  await sb.from('notifications').update({ is_read: true }).in('id', unreadIds);
  await loadNotifications();
  toast('All notifications marked as read', 'success');
});

let _notifPoll = null;
function startNotificationPolling() {
  if (_notifPoll) clearInterval(_notifPoll);
  _notifPoll = setInterval(loadNotifications, 60000); // every 60s
}

// ============================================================
// 8. BOOTSTRAP
// ============================================================
document.addEventListener('DOMContentLoaded', initAuth);
// ============================================================
// MODULE: DASHBOARD
// ============================================================

PAGE_RENDERERS.dashboard = async function renderDashboard() {
  const content = $('#pageContent');

  // Fetch core stats in parallel
  const [
    { count: totalProducts },
    { data: outOfStock },
    { data: expired },
    { data: expiringSoon },
    { data: lowStock },
    { data: todaySales },
    { data: recentSales },
    { data: salesSummary },
  ] = await Promise.all([
    sb.from('products').select('*', { count: 'exact', head: true }).eq('is_active', true),
    sb.from('v_out_of_stock').select('*'),
    sb.from('v_expired').select('*'),
    sb.from('v_expiring_soon').select('*'),
    sb.from('v_low_stock').select('*'),
    sb.from('sales').select('total, quantity').eq('sale_date', new Date().toISOString().slice(0,10)),
    sb.from('sales').select('*, products(name)').order('created_at', { ascending: false }).limit(8),
    sb.from('v_sales_summary').select('*').limit(14),
  ]);

  const todayRevenue = (todaySales || []).reduce((s, r) => s + Number(r.total || 0), 0);
  const todayCount = (todaySales || []).length;

  content.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card">
        <div class="label">Total Products</div>
        <div class="value">${totalProducts ?? 0}</div>
        <div class="sub">Active items in catalog</div>
      </div>
      <div class="stat-card ok">
        <div class="label">Today's Sales</div>
        <div class="value">${fmtMoney(todayRevenue)}</div>
        <div class="sub">${todayCount} transaction${todayCount===1?'':'s'}</div>
      </div>
      <div class="stat-card danger">
        <div class="label">Out of Stock</div>
        <div class="value">${(outOfStock||[]).length}</div>
        <div class="sub">Need restocking now</div>
      </div>
      <div class="stat-card warn">
        <div class="label">Low Stock</div>
        <div class="value">${(lowStock||[]).length}</div>
        <div class="sub">Below reorder level</div>
      </div>
      <div class="stat-card danger">
        <div class="label">Expired</div>
        <div class="value">${(expired||[]).length}</div>
        <div class="sub">Past expiry date</div>
      </div>
      <div class="stat-card warn">
        <div class="label">Expiring Soon</div>
        <div class="value">${(expiringSoon||[]).length}</div>
        <div class="sub">Within ${STATE.settings.expiry_warning_days} days</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:20px;" id="dashGrid">
      <div class="card">
        <div class="card-header"><h3>Sales Trend (last 14 days)</h3></div>
        <div class="card-body"><canvas id="salesChart" height="220"></canvas></div>
      </div>
      <div class="card">
        <div class="card-header"><h3>Stock Alerts</h3></div>
        <div class="card-body" id="alertsBody" style="max-height:300px;overflow-y:auto;"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h3>Recent Sales</h3></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Product</th><th>Qty</th><th>Total</th><th>Recorded</th></tr></thead>
          <tbody>
            ${(recentSales||[]).length === 0 ? `<tr><td colspan="5" class="empty-state">No sales recorded yet</td></tr>` :
              (recentSales||[]).map(s => `
                <tr>
                  <td>${fmtDate(s.sale_date)}</td>
                  <td>${esc(s.products?.name || '—')}</td>
                  <td>${s.quantity}</td>
                  <td>${fmtMoney(s.total)}</td>
                  <td>${timeAgo(s.created_at)}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Responsive grid stack on mobile
  if (window.innerWidth < 880) {
    $('#dashGrid').style.gridTemplateColumns = '1fr';
  }

  // Alerts panel
  const alertsBody = $('#alertsBody');
  const alertRows = [];
  (outOfStock||[]).forEach(p => alertRows.push({ type:'danger', icon:'🛑', text:`${p.name} — out of stock` }));
  (expired||[]).forEach(p => alertRows.push({ type:'danger', icon:'⏰', text:`${p.name} — expired ${fmtDate(p.expiry_date)}` }));
  (lowStock||[]).forEach(p => alertRows.push({ type:'warn', icon:'⚠️', text:`${p.name} — only ${p.quantity} ${p.unit} left` }));
  (expiringSoon||[]).forEach(p => alertRows.push({ type:'warn', icon:'📅', text:`${p.name} — expires ${fmtDate(p.expiry_date)}` }));

  alertsBody.innerHTML = alertRows.length === 0
    ? `<div class="empty-state"><span class="ic">✅</span>All clear — no alerts</div>`
    : alertRows.map(a => `
        <div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);align-items:flex-start;">
          <span>${a.icon}</span>
          <span style="font-size:13px;color:${a.type==='danger'?'var(--danger)':'var(--warn)'};">${esc(a.text)}</span>
        </div>
      `).join('');

  // Sales chart
  const labels = (salesSummary||[]).slice().reverse().map(r => fmtDate(r.sale_date));
  const revenues = (salesSummary||[]).slice().reverse().map(r => Number(r.revenue || 0));
  const ctx = $('#salesChart');
  if (ctx) {
    if (window._salesChartInstance) window._salesChartInstance.destroy();
    window._salesChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels.length ? labels : ['No data'],
        datasets: [{
          label: 'Revenue',
          data: revenues.length ? revenues : [0],
          borderColor: '#0e9594',
          backgroundColor: 'rgba(14,148,148,0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });
  }
};
// ============================================================
// MODULE: CATEGORIES
// ============================================================

PAGE_RENDERERS.categories = async function renderCategories() {
  const content = $('#pageContent');
  content.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        <span class="ic">🔍</span>
        <input type="text" id="catSearch" placeholder="Search categories...">
      </div>
      <div style="margin-left:auto;" class="card-actions">
        <button class="btn btn-secondary btn-sm" id="exportCatBtn">⬇ Export CSV</button>
        <button class="btn btn-secondary btn-sm" id="printCatBtn">🖨 Print</button>
        <button class="btn btn-primary btn-sm" id="addCatBtn">+ Add Category</button>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Description</th><th># Products</th><th>Created</th><th class="no-print">Actions</th></tr></thead>
          <tbody id="catTableBody"><tr><td colspan="5" class="empty-state">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
  `;

  let allCats = [];

  async function loadAndRender(filter='') {
    const { data: cats, error } = await sb.from('categories').select('*').order('name');
    if (error) { toast('Failed to load categories', 'error'); return; }
    const { data: prods } = await sb.from('products').select('category_id');
    const counts = {};
    (prods||[]).forEach(p => { if (p.category_id) counts[p.category_id] = (counts[p.category_id]||0)+1; });

    allCats = (cats||[]).map(c => ({ ...c, productCount: counts[c.id] || 0 }));
    STATE.cache.categories = allCats;
    renderTable(filter);
  }

  function renderTable(filter='') {
    const f = filter.toLowerCase();
    const rows = allCats.filter(c => c.name.toLowerCase().includes(f) || (c.description||'').toLowerCase().includes(f));
    const tbody = $('#catTableBody');
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state"><span class="ic">🏷️</span>No categories found</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(c => `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td class="text-muted">${esc(c.description || '—')}</td>
        <td>${c.productCount}</td>
        <td>${fmtDate(c.created_at)}</td>
        <td class="no-print">
          <div class="row-actions">
            <button class="icon-btn" data-edit="${c.id}">✏️</button>
            <button class="icon-btn danger" data-del="${c.id}">🗑️</button>
          </div>
        </td>
      </tr>
    `).join('');

    $all('[data-edit]', tbody).forEach(b => b.addEventListener('click', () => openCatModal(allCats.find(c=>c.id===b.dataset.edit))));
    $all('[data-del]', tbody).forEach(b => b.addEventListener('click', () => deleteCat(b.dataset.del)));
  }

  function openCatModal(cat=null) {
    openModal(`
      <div class="modal-header"><h3>${cat?'Edit':'Add'} Category</h3><button class="modal-close">×</button></div>
      <div class="modal-body">
        <form id="catForm">
          <div class="form-group">
            <label>Name *</label>
            <input type="text" id="catName" required value="${cat?esc(cat.name):''}">
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea id="catDesc" rows="3">${cat?esc(cat.description||''):''}</textarea>
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-close">Cancel</button>
        <button class="btn btn-primary" id="saveCatBtn">${cat?'Save Changes':'Add Category'}</button>
      </div>
    `);
    $('#saveCatBtn').addEventListener('click', async () => {
      const name = $('#catName').value.trim();
      const description = $('#catDesc').value.trim();
      if (!name) { toast('Category name is required', 'error'); return; }

      let res;
      if (cat) {
        res = await sb.from('categories').update({ name, description }).eq('id', cat.id);
      } else {
        res = await sb.from('categories').insert({ name, description });
      }
      if (res.error) { toast(res.error.message, 'error'); return; }
      toast(cat ? 'Category updated' : 'Category added', 'success');
      closeModal();
      await loadAndRender($('#catSearch').value);
    });
  }

  function deleteCat(id) {
    const cat = allCats.find(c => c.id === id);
    confirmAction(`Delete category "${cat.name}"? Products in this category will become uncategorized.`, async () => {
      const { error } = await sb.from('categories').delete().eq('id', id);
      if (error) { toast(error.message, 'error'); return; }
      toast('Category deleted', 'success');
      await loadAndRender($('#catSearch').value);
    });
  }

  $('#addCatBtn').addEventListener('click', () => openCatModal());
  $('#catSearch').addEventListener('input', debounce(e => renderTable(e.target.value), 200));
  $('#printCatBtn').addEventListener('click', () => window.print());
  $('#exportCatBtn').addEventListener('click', () => {
    exportCSV('categories.csv', allCats, [
      { label: 'Name', key: 'name' },
      { label: 'Description', key: 'description' },
      { label: 'Product Count', key: 'productCount' },
      { label: 'Created', get: c => fmtDate(c.created_at) },
    ]);
  });

  await loadAndRender();
};
// ============================================================
// MODULE: SUPPLIERS
// ============================================================

PAGE_RENDERERS.suppliers = async function renderSuppliers() {
  const content = $('#pageContent');
  content.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        <span class="ic">🔍</span>
        <input type="text" id="supSearch" placeholder="Search suppliers...">
      </div>
      <div style="margin-left:auto;" class="card-actions">
        <button class="btn btn-secondary btn-sm" id="exportSupBtn">⬇ Export CSV</button>
        <button class="btn btn-secondary btn-sm" id="printSupBtn">🖨 Print</button>
        <button class="btn btn-primary btn-sm" id="addSupBtn">+ Add Supplier</button>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Contact Person</th><th>Phone</th><th>Email</th><th># Products</th><th class="no-print">Actions</th></tr></thead>
          <tbody id="supTableBody"><tr><td colspan="6" class="empty-state">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
  `;

  let allSups = [];

  async function loadAndRender(filter='') {
    const { data: sups, error } = await sb.from('suppliers').select('*').order('name');
    if (error) { toast('Failed to load suppliers', 'error'); return; }
    const { data: prods } = await sb.from('products').select('supplier_id');
    const counts = {};
    (prods||[]).forEach(p => { if (p.supplier_id) counts[p.supplier_id] = (counts[p.supplier_id]||0)+1; });

    allSups = (sups||[]).map(s => ({ ...s, productCount: counts[s.id] || 0 }));
    STATE.cache.suppliers = allSups;
    renderTable(filter);
  }

  function renderTable(filter='') {
    const f = filter.toLowerCase();
    const rows = allSups.filter(s =>
      s.name.toLowerCase().includes(f) ||
      (s.contact_person||'').toLowerCase().includes(f) ||
      (s.phone||'').toLowerCase().includes(f)
    );
    const tbody = $('#supTableBody');
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state"><span class="ic">🚚</span>No suppliers found</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(s => `
      <tr>
        <td><strong>${esc(s.name)}</strong></td>
        <td>${esc(s.contact_person || '—')}</td>
        <td>${esc(s.phone || '—')}</td>
        <td>${esc(s.email || '—')}</td>
        <td>${s.productCount}</td>
        <td class="no-print">
          <div class="row-actions">
            <button class="icon-btn" data-edit="${s.id}">✏️</button>
            <button class="icon-btn danger" data-del="${s.id}">🗑️</button>
          </div>
        </td>
      </tr>
    `).join('');

    $all('[data-edit]', tbody).forEach(b => b.addEventListener('click', () => openSupModal(allSups.find(s=>s.id===b.dataset.edit))));
    $all('[data-del]', tbody).forEach(b => b.addEventListener('click', () => deleteSup(b.dataset.del)));
  }

  function openSupModal(sup=null) {
    openModal(`
      <div class="modal-header"><h3>${sup?'Edit':'Add'} Supplier</h3><button class="modal-close">×</button></div>
      <div class="modal-body">
        <form id="supForm">
          <div class="form-group">
            <label>Company Name *</label>
            <input type="text" id="supName" required value="${sup?esc(sup.name):''}">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Contact Person</label>
              <input type="text" id="supContact" value="${sup?esc(sup.contact_person||''):''}">
            </div>
            <div class="form-group">
              <label>Phone</label>
              <input type="text" id="supPhone" value="${sup?esc(sup.phone||''):''}">
            </div>
          </div>
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="supEmail" value="${sup?esc(sup.email||''):''}">
          </div>
          <div class="form-group">
            <label>Address</label>
            <textarea id="supAddress" rows="2">${sup?esc(sup.address||''):''}</textarea>
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-close">Cancel</button>
        <button class="btn btn-primary" id="saveSupBtn">${sup?'Save Changes':'Add Supplier'}</button>
      </div>
    `);
    $('#saveSupBtn').addEventListener('click', async () => {
      const name = $('#supName').value.trim();
      if (!name) { toast('Supplier name is required', 'error'); return; }
      const payload = {
        name,
        contact_person: $('#supContact').value.trim() || null,
        phone: $('#supPhone').value.trim() || null,
        email: $('#supEmail').value.trim() || null,
        address: $('#supAddress').value.trim() || null,
      };
      let res;
      if (sup) res = await sb.from('suppliers').update(payload).eq('id', sup.id);
      else res = await sb.from('suppliers').insert(payload);

      if (res.error) { toast(res.error.message, 'error'); return; }
      toast(sup ? 'Supplier updated' : 'Supplier added', 'success');
      closeModal();
      await loadAndRender($('#supSearch').value);
    });
  }

  function deleteSup(id) {
    const sup = allSups.find(s => s.id === id);
    confirmAction(`Delete supplier "${sup.name}"? Products linked to this supplier will become unassigned.`, async () => {
      const { error } = await sb.from('suppliers').delete().eq('id', id);
      if (error) { toast(error.message, 'error'); return; }
      toast('Supplier deleted', 'success');
      await loadAndRender($('#supSearch').value);
    });
  }

  $('#addSupBtn').addEventListener('click', () => openSupModal());
  $('#supSearch').addEventListener('input', debounce(e => renderTable(e.target.value), 200));
  $('#printSupBtn').addEventListener('click', () => window.print());
  $('#exportSupBtn').addEventListener('click', () => {
    exportCSV('suppliers.csv', allSups, [
      { label: 'Name', key: 'name' },
      { label: 'Contact Person', key: 'contact_person' },
      { label: 'Phone', key: 'phone' },
      { label: 'Email', key: 'email' },
      { label: 'Address', key: 'address' },
      { label: 'Product Count', key: 'productCount' },
    ]);
  });

  await loadAndRender();
};
// ============================================================
// MODULE: PRODUCTS
// ============================================================

PAGE_RENDERERS.products = async function renderProducts() {
  const content = $('#pageContent');
  content.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        <span class="ic">🔍</span>
        <input type="text" id="prodSearch" placeholder="Search products...">
      </div>
      <select class="filter-select" id="prodCatFilter"><option value="">All Categories</option></select>
      <select class="filter-select" id="prodStatusFilter">
        <option value="">All Status</option>
        <option value="out">Out of Stock</option>
        <option value="low">Low Stock</option>
        <option value="expired">Expired</option>
        <option value="expiring">Expiring Soon</option>
        <option value="ok">OK</option>
      </select>
      <div style="margin-left:auto;" class="card-actions">
        <button class="btn btn-secondary btn-sm" id="exportProdBtn">⬇ Export CSV</button>
        <button class="btn btn-secondary btn-sm" id="printProdBtn">🖨 Print</button>
        <button class="btn btn-primary btn-sm" id="addProdBtn">+ Add Product</button>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Product</th><th>Category</th><th>Cost</th><th>Price</th><th>Stock</th>
            <th>Expiry</th><th>Status</th><th class="no-print">Actions</th>
          </tr></thead>
          <tbody id="prodTableBody"><tr><td colspan="8" class="empty-state">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
  `;

  let allProds = [];
  let cats = [], sups = [];

  function getStatus(p) {
    const today = new Date(); today.setHours(0,0,0,0);
    const exp = p.expiry_date ? new Date(p.expiry_date) : null;
    const warnDays = STATE.settings.expiry_warning_days || 30;

    if (exp && exp < today) return { key:'expired', label:'Expired', cls:'badge-danger' };
    if (Number(p.quantity) <= 0) return { key:'out', label:'Out of Stock', cls:'badge-danger' };
    if (exp) {
      const diffDays = Math.ceil((exp - today) / 86400000);
      if (diffDays <= warnDays) return { key:'expiring', label:`Expires in ${diffDays}d`, cls:'badge-warn' };
    }
    if (Number(p.quantity) <= Number(p.reorder_level)) return { key:'low', label:'Low Stock', cls:'badge-warn' };
    return { key:'ok', label:'OK', cls:'badge-ok' };
  }

  async function loadAndRender() {
    const [{ data: prods, error }, { data: catData }, { data: supData }] = await Promise.all([
      sb.from('products').select('*, categories(name), suppliers(name)').eq('is_active', true).order('name'),
      sb.from('categories').select('*').order('name'),
      sb.from('suppliers').select('*').order('name'),
    ]);
    if (error) { toast('Failed to load products', 'error'); return; }
    cats = catData || []; sups = supData || [];
    STATE.cache.categories = cats; STATE.cache.suppliers = sups;

    allProds = (prods||[]).map(p => ({ ...p, _status: getStatus(p) }));

    const catFilter = $('#prodCatFilter');
    catFilter.innerHTML = '<option value="">All Categories</option>' + cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

    applyFilters();
  }

  function applyFilters() {
    const search = $('#prodSearch').value.toLowerCase();
    const catId = $('#prodCatFilter').value;
    const statusKey = $('#prodStatusFilter').value;

    let rows = allProds.filter(p => {
      if (search && !p.name.toLowerCase().includes(search) && !(p.sku||'').toLowerCase().includes(search)) return false;
      if (catId && p.category_id !== catId) return false;
      if (statusKey && p._status.key !== statusKey) return false;
      return true;
    });
    renderTable(rows);
  }

  function renderTable(rows) {
    const tbody = $('#prodTableBody');
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state"><span class="ic">📦</span>No products found</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(p => `
      <tr>
        <td><strong>${esc(p.name)}</strong>${p.sku ? `<br><span class="text-muted" style="font-size:11.5px;">SKU: ${esc(p.sku)}</span>` : ''}</td>
        <td>${esc(p.categories?.name || '—')}</td>
        <td>${fmtMoney(p.cost_price)}</td>
        <td>${fmtMoney(p.selling_price)}</td>
        <td>${p.quantity} ${esc(p.unit)}</td>
        <td>${fmtDate(p.expiry_date)}</td>
        <td><span class="badge ${p._status.cls}">${p._status.label}</span></td>
        <td class="no-print">
          <div class="row-actions">
            <button class="icon-btn" data-edit="${p.id}">✏️</button>
            <button class="icon-btn danger" data-del="${p.id}">🗑️</button>
          </div>
        </td>
      </tr>
    `).join('');

    $all('[data-edit]', tbody).forEach(b => b.addEventListener('click', () => openProdModal(allProds.find(p=>p.id===b.dataset.edit))));
    $all('[data-del]', tbody).forEach(b => b.addEventListener('click', () => deleteProd(b.dataset.del)));
  }

  function openProdModal(p=null) {
    openModal(`
      <div class="modal-header"><h3>${p?'Edit':'Add'} Product</h3><button class="modal-close">×</button></div>
      <div class="modal-body">
        <form id="prodForm">
          <div class="form-group">
            <label>Product Name *</label>
            <input type="text" id="pName" required value="${p?esc(p.name):''}">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>SKU / Code</label>
              <input type="text" id="pSku" value="${p?esc(p.sku||''):''}">
            </div>
            <div class="form-group">
              <label>Unit</label>
              <input type="text" id="pUnit" placeholder="e.g. tablets, bottles, pcs" value="${p?esc(p.unit||'pcs'):'pcs'}">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Category</label>
              <select id="pCategory">
                <option value="">— None —</option>
                ${cats.map(c => `<option value="${c.id}" ${p&&p.category_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Supplier</label>
              <select id="pSupplier">
                <option value="">— None —</option>
                ${sups.map(s => `<option value="${s.id}" ${p&&p.supplier_id===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Cost Price *</label>
              <input type="number" id="pCost" step="0.01" min="0" required value="${p?p.cost_price:'0'}">
            </div>
            <div class="form-group">
              <label>Selling Price *</label>
              <input type="number" id="pPrice" step="0.01" min="0" required value="${p?p.selling_price:'0'}">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Opening Stock Quantity ${p?'':''}</label>
              <input type="number" id="pQty" step="0.01" min="0" value="${p?p.quantity:'0'}" ${p?'disabled':''}>
              ${p ? '<div class="help-text">Edit stock via Purchases (add) or Sales (deduct), not here.</div>' : '<div class="help-text">Use Purchases to add more stock later.</div>'}
            </div>
            <div class="form-group">
              <label>Reorder Level *</label>
              <input type="number" id="pReorder" step="0.01" min="0" required value="${p?p.reorder_level:STATE.settings.low_stock_default||10}">
            </div>
          </div>
          <div class="form-group">
            <label>Expiry Date</label>
            <input type="date" id="pExpiry" value="${p&&p.expiry_date?p.expiry_date:''}">
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-close">Cancel</button>
        <button class="btn btn-primary" id="saveProdBtn">${p?'Save Changes':'Add Product'}</button>
      </div>
    `);

    $('#saveProdBtn').addEventListener('click', async () => {
      const name = $('#pName').value.trim();
      const costPrice = parseFloat($('#pCost').value);
      const sellPrice = parseFloat($('#pPrice').value);
      const reorder = parseFloat($('#pReorder').value);
      if (!name) { toast('Product name is required', 'error'); return; }
      if (isNaN(costPrice) || isNaN(sellPrice)) { toast('Valid cost and selling price required', 'error'); return; }

      const payload = {
        name,
        sku: $('#pSku').value.trim() || null,
        unit: $('#pUnit').value.trim() || 'pcs',
        category_id: $('#pCategory').value || null,
        supplier_id: $('#pSupplier').value || null,
        cost_price: costPrice,
        selling_price: sellPrice,
        reorder_level: isNaN(reorder) ? 10 : reorder,
        expiry_date: $('#pExpiry').value || null,
      };
      if (!p) payload.quantity = parseFloat($('#pQty').value) || 0;

      let res;
      if (p) res = await sb.from('products').update(payload).eq('id', p.id);
      else res = await sb.from('products').insert(payload);

      if (res.error) {
        if (res.error.message.includes('duplicate') || res.error.code === '23505') {
          toast('SKU already exists. Use a unique SKU.', 'error');
        } else {
          toast(res.error.message, 'error');
        }
        return;
      }
      toast(p ? 'Product updated' : 'Product added', 'success');
      closeModal();
      await loadAndRender();
    });
  }

  function deleteProd(id) {
    const p = allProds.find(x => x.id === id);
    confirmAction(`Delete product "${p.name}"? This will also remove its purchase/sale history.`, async () => {
      const { error } = await sb.from('products').delete().eq('id', id);
      if (error) { toast(error.message, 'error'); return; }
      toast('Product deleted', 'success');
      await loadAndRender();
    });
  }

  $('#addProdBtn').addEventListener('click', () => openProdModal());
  $('#prodSearch').addEventListener('input', debounce(applyFilters, 200));
  $('#prodCatFilter').addEventListener('change', applyFilters);
  $('#prodStatusFilter').addEventListener('change', applyFilters);
  $('#printProdBtn').addEventListener('click', () => window.print());
  $('#exportProdBtn').addEventListener('click', () => {
    exportCSV('products.csv', allProds, [
      { label: 'Name', key: 'name' },
      { label: 'SKU', key: 'sku' },
      { label: 'Category', get: p => p.categories?.name || '' },
      { label: 'Supplier', get: p => p.suppliers?.name || '' },
      { label: 'Cost Price', key: 'cost_price' },
      { label: 'Selling Price', key: 'selling_price' },
      { label: 'Quantity', key: 'quantity' },
      { label: 'Unit', key: 'unit' },
      { label: 'Reorder Level', key: 'reorder_level' },
      { label: 'Expiry Date', get: p => fmtDate(p.expiry_date) },
      { label: 'Status', get: p => p._status.label },
    ]);
  });

  await loadAndRender();
};
// ============================================================
// MODULE: PURCHASES (Stock In)
// ============================================================

PAGE_RENDERERS.purchases = async function renderPurchases() {
  const content = $('#pageContent');
  content.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        <span class="ic">🔍</span>
        <input type="text" id="purSearch" placeholder="Search by product or invoice...">
      </div>
      <input type="date" class="filter-select" id="purFromDate">
      <input type="date" class="filter-select" id="purToDate">
      <div style="margin-left:auto;" class="card-actions">
        <button class="btn btn-secondary btn-sm" id="exportPurBtn">⬇ Export CSV</button>
        <button class="btn btn-secondary btn-sm" id="printPurBtn">🖨 Print</button>
        <button class="btn btn-primary btn-sm" id="addPurBtn">+ Record Purchase</button>
      </div>
    </div>
    <div class="stat-grid" id="purStatGrid"></div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Date</th><th>Product</th><th>Supplier</th><th>Qty</th><th>Cost/Unit</th>
            <th>Total Cost</th><th>Invoice #</th><th>Recorded By</th><th class="no-print">Actions</th>
          </tr></thead>
          <tbody id="purTableBody"><tr><td colspan="9" class="empty-state">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
  `;

  let allPurchases = [];
  let products = [], suppliers = [];

  async function loadAndRender() {
    const [{ data: purchases, error }, { data: prodData }, { data: supData }] = await Promise.all([
      sb.from('purchases').select('*, products(name, unit), suppliers(name), profiles(full_name)').order('purchase_date', { ascending: false }).order('created_at', { ascending: false }),
      sb.from('products').select('*').eq('is_active', true).order('name'),
      sb.from('suppliers').select('*').order('name'),
    ]);
    if (error) { toast('Failed to load purchases', 'error'); return; }
    products = prodData || []; suppliers = supData || [];
    allPurchases = purchases || [];
    applyFilters();
  }

  function applyFilters() {
    const search = $('#purSearch').value.toLowerCase();
    const from = $('#purFromDate').value;
    const to = $('#purToDate').value;
    let rows = allPurchases.filter(p => {
      if (search && !(p.products?.name||'').toLowerCase().includes(search) && !(p.invoice_no||'').toLowerCase().includes(search)) return false;
      if (from && p.purchase_date < from) return false;
      if (to && p.purchase_date > to) return false;
      return true;
    });
    renderStats(rows);
    renderTable(rows);
  }

  function renderStats(rows) {
    const totalCost = rows.reduce((s,r) => s + Number(r.cost_price)*Number(r.quantity), 0);
    const totalQty = rows.reduce((s,r) => s + Number(r.quantity), 0);
    $('#purStatGrid').innerHTML = `
      <div class="stat-card"><div class="label">Total Purchases</div><div class="value">${rows.length}</div></div>
      <div class="stat-card"><div class="label">Units Received</div><div class="value">${totalQty}</div></div>
      <div class="stat-card warn"><div class="label">Total Cost</div><div class="value">${fmtMoney(totalCost)}</div></div>
    `;
  }

  function renderTable(rows) {
    const tbody = $('#purTableBody');
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-state"><span class="ic">⬇️</span>No purchases recorded</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(p => `
      <tr>
        <td>${fmtDate(p.purchase_date)}</td>
        <td><strong>${esc(p.products?.name || '—')}</strong></td>
        <td>${esc(p.suppliers?.name || '—')}</td>
        <td>${p.quantity} ${esc(p.products?.unit||'')}</td>
        <td>${fmtMoney(p.cost_price)}</td>
        <td>${fmtMoney(Number(p.cost_price)*Number(p.quantity))}</td>
        <td>${esc(p.invoice_no || '—')}</td>
        <td>${esc(p.profiles?.full_name || '—')}</td>
        <td class="no-print">
          <div class="row-actions">
            <button class="icon-btn danger" data-del="${p.id}">🗑️</button>
          </div>
        </td>
      </tr>
    `).join('');
    $all('[data-del]', tbody).forEach(b => b.addEventListener('click', () => deletePurchase(b.dataset.del)));
  }

  function openPurModal() {
    if (products.length === 0) {
      toast('Add a product first before recording purchases', 'warn');
      return;
    }
    openModal(`
      <div class="modal-header"><h3>Record Purchase</h3><button class="modal-close">×</button></div>
      <div class="modal-body">
        <form id="purForm">
          <div class="form-group">
            <label>Product *</label>
            <select id="purProduct" required>
              <option value="">— Select product —</option>
              ${products.map(p => `<option value="${p.id}" data-cost="${p.cost_price}">${esc(p.name)} (current stock: ${p.quantity} ${esc(p.unit)})</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Supplier</label>
            <select id="purSupplier">
              <option value="">— None —</option>
              ${suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Quantity Received *</label>
              <input type="number" id="purQty" step="0.01" min="0.01" required>
            </div>
            <div class="form-group">
              <label>Cost Price per Unit *</label>
              <input type="number" id="purCost" step="0.01" min="0" required>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Purchase Date *</label>
              <input type="date" id="purDate" required value="${new Date().toISOString().slice(0,10)}">
            </div>
            <div class="form-group">
              <label>Invoice / Receipt #</label>
              <input type="text" id="purInvoice">
            </div>
          </div>
          <div class="form-group">
            <label>Notes</label>
            <textarea id="purNotes" rows="2"></textarea>
          </div>
          <div class="help-text">This will increase the product's stock quantity automatically and update its cost price.</div>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-close">Cancel</button>
        <button class="btn btn-primary" id="savePurBtn">Record Purchase</button>
      </div>
    `);

    $('#purProduct').addEventListener('change', (e) => {
      const opt = e.target.selectedOptions[0];
      if (opt && opt.dataset.cost) $('#purCost').value = opt.dataset.cost;
    });

    $('#savePurBtn').addEventListener('click', async () => {
      const productId = $('#purProduct').value;
      const qty = parseFloat($('#purQty').value);
      const cost = parseFloat($('#purCost').value);
      const date = $('#purDate').value;
      if (!productId) { toast('Select a product', 'error'); return; }
      if (isNaN(qty) || qty <= 0) { toast('Enter a valid quantity', 'error'); return; }
      if (isNaN(cost) || cost < 0) { toast('Enter a valid cost price', 'error'); return; }

      const btn = $('#savePurBtn');
      btn.disabled = true; btn.textContent = 'Saving...';

      const { error } = await sb.from('purchases').insert({
        product_id: productId,
        supplier_id: $('#purSupplier').value || null,
        quantity: qty,
        cost_price: cost,
        purchase_date: date,
        invoice_no: $('#purInvoice').value.trim() || null,
        notes: $('#purNotes').value.trim() || null,
        created_by: STATE.profile.id,
      });

      btn.disabled = false; btn.textContent = 'Record Purchase';

      if (error) { toast(error.message, 'error'); return; }
      toast('Purchase recorded — stock updated', 'success');
      closeModal();
      await loadAndRender();
    });
  }

  function deletePurchase(id) {
    confirmAction('Delete this purchase record? Stock will be reduced accordingly.', async () => {
      const { error } = await sb.from('purchases').delete().eq('id', id);
      if (error) { toast(error.message, 'error'); return; }
      toast('Purchase deleted', 'success');
      await loadAndRender();
    });
  }

  $('#addPurBtn').addEventListener('click', openPurModal);
  $('#purSearch').addEventListener('input', debounce(applyFilters, 200));
  $('#purFromDate').addEventListener('change', applyFilters);
  $('#purToDate').addEventListener('change', applyFilters);
  $('#printPurBtn').addEventListener('click', () => window.print());
  $('#exportPurBtn').addEventListener('click', () => {
    exportCSV('purchases.csv', allPurchases, [
      { label: 'Date', get: p => fmtDate(p.purchase_date) },
      { label: 'Product', get: p => p.products?.name || '' },
      { label: 'Supplier', get: p => p.suppliers?.name || '' },
      { label: 'Quantity', key: 'quantity' },
      { label: 'Cost/Unit', key: 'cost_price' },
      { label: 'Total Cost', get: p => (Number(p.cost_price)*Number(p.quantity)).toFixed(2) },
      { label: 'Invoice #', key: 'invoice_no' },
      { label: 'Recorded By', get: p => p.profiles?.full_name || '' },
    ]);
  });

  await loadAndRender();
};
// ============================================================
// MODULE: SALES (Stock Out)
// ============================================================

PAGE_RENDERERS.sales = async function renderSales() {
  const content = $('#pageContent');
  content.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        <span class="ic">🔍</span>
        <input type="text" id="saleSearch" placeholder="Search by product...">
      </div>
      <input type="date" class="filter-select" id="saleFromDate">
      <input type="date" class="filter-select" id="saleToDate">
      <div style="margin-left:auto;" class="card-actions">
        <button class="btn btn-secondary btn-sm" id="exportSaleBtn">⬇ Export CSV</button>
        <button class="btn btn-secondary btn-sm" id="printSaleBtn">🖨 Print</button>
        <button class="btn btn-primary btn-sm" id="addSaleBtn">+ Record Sale</button>
      </div>
    </div>
    <div class="stat-grid" id="saleStatGrid"></div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Date</th><th>Product</th><th>Qty</th><th>Price/Unit</th>
            <th>Total</th><th>Recorded By</th><th class="no-print">Actions</th>
          </tr></thead>
          <tbody id="saleTableBody"><tr><td colspan="7" class="empty-state">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
  `;

  let allSales = [];
  let products = [];

  async function loadAndRender() {
    const [{ data: sales, error }, { data: prodData }] = await Promise.all([
      sb.from('sales').select('*, products(name, unit), profiles(full_name)').order('sale_date', { ascending: false }).order('created_at', { ascending: false }),
      sb.from('products').select('*').eq('is_active', true).order('name'),
    ]);
    if (error) { toast('Failed to load sales', 'error'); return; }
    products = prodData || [];
    allSales = sales || [];
    applyFilters();
  }

  function applyFilters() {
    const search = $('#saleSearch').value.toLowerCase();
    const from = $('#saleFromDate').value;
    const to = $('#saleToDate').value;
    let rows = allSales.filter(s => {
      if (search && !(s.products?.name||'').toLowerCase().includes(search)) return false;
      if (from && s.sale_date < from) return false;
      if (to && s.sale_date > to) return false;
      return true;
    });
    renderStats(rows);
    renderTable(rows);
  }

  function renderStats(rows) {
    const totalRevenue = rows.reduce((s,r) => s + Number(r.total), 0);
    const totalQty = rows.reduce((s,r) => s + Number(r.quantity), 0);
    $('#saleStatGrid').innerHTML = `
      <div class="stat-card"><div class="label">Total Sales</div><div class="value">${rows.length}</div></div>
      <div class="stat-card"><div class="label">Units Sold</div><div class="value">${totalQty}</div></div>
      <div class="stat-card ok"><div class="label">Total Revenue</div><div class="value">${fmtMoney(totalRevenue)}</div></div>
    `;
  }

  function renderTable(rows) {
    const tbody = $('#saleTableBody');
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state"><span class="ic">⬆️</span>No sales recorded</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(s => `
      <tr>
        <td>${fmtDate(s.sale_date)}</td>
        <td><strong>${esc(s.products?.name || '—')}</strong></td>
        <td>${s.quantity} ${esc(s.products?.unit||'')}</td>
        <td>${fmtMoney(s.sale_price)}</td>
        <td>${fmtMoney(s.total)}</td>
        <td>${esc(s.profiles?.full_name || '—')}</td>
        <td class="no-print">
          <div class="row-actions">
            <button class="icon-btn danger" data-del="${s.id}">🗑️</button>
          </div>
        </td>
      </tr>
    `).join('');
    $all('[data-del]', tbody).forEach(b => b.addEventListener('click', () => deleteSale(b.dataset.del)));
  }

  function openSaleModal() {
    if (products.length === 0) {
      toast('Add a product first before recording sales', 'warn');
      return;
    }
    openModal(`
      <div class="modal-header"><h3>Record Sale</h3><button class="modal-close">×</button></div>
      <div class="modal-body">
        <form id="saleForm">
          <div class="form-group">
            <label>Product *</label>
            <select id="saleProduct" required>
              <option value="">— Select product —</option>
              ${products.map(p => `<option value="${p.id}" data-price="${p.selling_price}" data-stock="${p.quantity}" data-unit="${esc(p.unit)}">${esc(p.name)} (in stock: ${p.quantity} ${esc(p.unit)})</option>`).join('')}
            </select>
            <div class="help-text" id="stockHint"></div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Quantity Sold *</label>
              <input type="number" id="saleQty" step="0.01" min="0.01" required>
            </div>
            <div class="form-group">
              <label>Price per Unit *</label>
              <input type="number" id="salePrice" step="0.01" min="0" required>
            </div>
          </div>
          <div class="form-group">
            <label>Sale Date *</label>
            <input type="date" id="saleDate" required value="${new Date().toISOString().slice(0,10)}">
          </div>
          <div class="form-group">
            <label>Notes</label>
            <textarea id="saleNotes" rows="2" placeholder="e.g. customer name, prescription ref"></textarea>
          </div>
          <div class="form-group mb-0">
            <label>Total</label>
            <input type="text" id="saleTotalDisplay" disabled value="${fmtMoney(0)}">
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-close">Cancel</button>
        <button class="btn btn-primary" id="saveSaleBtn">Record Sale</button>
      </div>
    `);

    function updateTotal() {
      const qty = parseFloat($('#saleQty').value) || 0;
      const price = parseFloat($('#salePrice').value) || 0;
      $('#saleTotalDisplay').value = fmtMoney(qty * price);
    }

    $('#saleProduct').addEventListener('change', (e) => {
      const opt = e.target.selectedOptions[0];
      if (opt && opt.dataset.price) {
        $('#salePrice').value = opt.dataset.price;
        $('#stockHint').textContent = `Available stock: ${opt.dataset.stock} ${opt.dataset.unit}`;
      } else {
        $('#stockHint').textContent = '';
      }
      updateTotal();
    });
    $('#saleQty').addEventListener('input', updateTotal);
    $('#salePrice').addEventListener('input', updateTotal);

    $('#saveSaleBtn').addEventListener('click', async () => {
      const productId = $('#saleProduct').value;
      const qty = parseFloat($('#saleQty').value);
      const price = parseFloat($('#salePrice').value);
      const date = $('#saleDate').value;
      if (!productId) { toast('Select a product', 'error'); return; }
      if (isNaN(qty) || qty <= 0) { toast('Enter a valid quantity', 'error'); return; }
      if (isNaN(price) || price < 0) { toast('Enter a valid price', 'error'); return; }

      const opt = $('#saleProduct').selectedOptions[0];
      const availableStock = parseFloat(opt.dataset.stock);
      if (qty > availableStock) {
        toast(`Insufficient stock — only ${availableStock} ${opt.dataset.unit} available`, 'error');
        return;
      }

      const btn = $('#saveSaleBtn');
      btn.disabled = true; btn.textContent = 'Saving...';

      const { error } = await sb.from('sales').insert({
        product_id: productId,
        quantity: qty,
        sale_price: price,
        total: qty * price,
        sale_date: date,
        notes: $('#saleNotes').value.trim() || null,
        created_by: STATE.profile.id,
      });

      btn.disabled = false; btn.textContent = 'Record Sale';

      if (error) {
        toast(error.message.includes('Insufficient stock') ? error.message : error.message, 'error');
        return;
      }
      toast('Sale recorded — stock updated', 'success');
      closeModal();
      await loadAndRender();
      await loadNotifications();
    });
  }

  function deleteSale(id) {
    confirmAction('Delete this sale record? Stock will be restored accordingly.', async () => {
      const { error } = await sb.from('sales').delete().eq('id', id);
      if (error) { toast(error.message, 'error'); return; }
      toast('Sale deleted', 'success');
      await loadAndRender();
    });
  }

  $('#addSaleBtn').addEventListener('click', openSaleModal);
  $('#saleSearch').addEventListener('input', debounce(applyFilters, 200));
  $('#saleFromDate').addEventListener('change', applyFilters);
  $('#saleToDate').addEventListener('change', applyFilters);
  $('#printSaleBtn').addEventListener('click', () => window.print());
  $('#exportSaleBtn').addEventListener('click', () => {
    exportCSV('sales.csv', allSales, [
      { label: 'Date', get: s => fmtDate(s.sale_date) },
      { label: 'Product', get: s => s.products?.name || '' },
      { label: 'Quantity', key: 'quantity' },
      { label: 'Price/Unit', key: 'sale_price' },
      { label: 'Total', key: 'total' },
      { label: 'Recorded By', get: s => s.profiles?.full_name || '' },
    ]);
  });

  await loadAndRender();
};
// ============================================================
// MODULE: REPORTS
// ============================================================

PAGE_RENDERERS.reports = async function renderReports() {
  const content = $('#pageContent');
  content.innerHTML = `
    <div class="toolbar">
      <label class="text-muted" style="font-size:13px;">Period:</label>
      <input type="date" class="filter-select" id="repFromDate">
      <input type="date" class="filter-select" id="repToDate">
      <button class="btn btn-secondary btn-sm" id="repApplyBtn">Apply</button>
      <div style="margin-left:auto;" class="card-actions">
        <button class="btn btn-secondary btn-sm" id="printRepBtn">🖨 Print Report</button>
      </div>
    </div>

    <div class="stat-grid" id="repStatGrid"></div>

    <div class="card">
      <div class="card-header">
        <h3>Sales by Product</h3>
        <button class="btn btn-secondary btn-sm no-print" id="exportSalesByProdBtn">⬇ Export CSV</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Product</th><th>Units Sold</th><th>Revenue</th><th>Est. Cost</th><th>Est. Profit</th></tr></thead>
          <tbody id="salesByProdBody"><tr><td colspan="5" class="empty-state">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Purchases by Supplier</h3>
        <button class="btn btn-secondary btn-sm no-print" id="exportPurBySupBtn">⬇ Export CSV</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Supplier</th><th>Purchases</th><th>Units Received</th><th>Total Spent</th></tr></thead>
          <tbody id="purBySupBody"><tr><td colspan="4" class="empty-state">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Inventory Status</h3>
        <button class="btn btn-secondary btn-sm no-print" id="exportInvBtn">⬇ Export CSV</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Product</th><th>Stock</th><th>Stock Value (cost)</th><th>Status</th></tr></thead>
          <tbody id="invBody"><tr><td colspan="4" class="empty-state">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
  `;

  // Default period: last 30 days
  const today = new Date();
  const monthAgo = new Date(today); monthAgo.setDate(monthAgo.getDate() - 30);
  $('#repFromDate').value = monthAgo.toISOString().slice(0,10);
  $('#repToDate').value = today.toISOString().slice(0,10);

  let cachedSalesByProd = [], cachedPurBySup = [], cachedInv = [];

  async function loadAndRender() {
    const from = $('#repFromDate').value;
    const to = $('#repToDate').value;

    const [{ data: sales }, { data: purchases }, { data: products }] = await Promise.all([
      sb.from('sales').select('*, products(name, cost_price)').gte('sale_date', from).lte('sale_date', to),
      sb.from('purchases').select('*, suppliers(name)').gte('purchase_date', from).lte('purchase_date', to),
      sb.from('products').select('*, categories(name)').eq('is_active', true),
    ]);

    // --- Sales by product ---
    const prodMap = {};
    (sales||[]).forEach(s => {
      const key = s.product_id;
      if (!prodMap[key]) prodMap[key] = { name: s.products?.name || 'Unknown', units: 0, revenue: 0, cost: 0 };
      prodMap[key].units += Number(s.quantity);
      prodMap[key].revenue += Number(s.total);
      prodMap[key].cost += Number(s.quantity) * Number(s.products?.cost_price || 0);
    });
    cachedSalesByProd = Object.values(prodMap).sort((a,b) => b.revenue - a.revenue);

    const totalRevenue = cachedSalesByProd.reduce((s,r)=>s+r.revenue,0);
    const totalCost = cachedSalesByProd.reduce((s,r)=>s+r.cost,0);
    const totalProfit = totalRevenue - totalCost;
    const totalUnitsSold = cachedSalesByProd.reduce((s,r)=>s+r.units,0);

    $('#salesByProdBody').innerHTML = cachedSalesByProd.length === 0
      ? '<tr><td colspan="5" class="empty-state">No sales in this period</td></tr>'
      : cachedSalesByProd.map(r => `
        <tr>
          <td><strong>${esc(r.name)}</strong></td>
          <td>${r.units}</td>
          <td>${fmtMoney(r.revenue)}</td>
          <td>${fmtMoney(r.cost)}</td>
          <td style="color:${r.revenue-r.cost>=0?'var(--ok)':'var(--danger)'};">${fmtMoney(r.revenue-r.cost)}</td>
        </tr>
      `).join('');

    // --- Purchases by supplier ---
    const supMap = {};
    (purchases||[]).forEach(p => {
      const key = p.supplier_id || 'none';
      if (!supMap[key]) supMap[key] = { name: p.suppliers?.name || 'Unspecified', count: 0, units: 0, spent: 0 };
      supMap[key].count += 1;
      supMap[key].units += Number(p.quantity);
      supMap[key].spent += Number(p.quantity) * Number(p.cost_price);
    });
    cachedPurBySup = Object.values(supMap).sort((a,b) => b.spent - a.spent);
    const totalSpent = cachedPurBySup.reduce((s,r)=>s+r.spent,0);

    $('#purBySupBody').innerHTML = cachedPurBySup.length === 0
      ? '<tr><td colspan="4" class="empty-state">No purchases in this period</td></tr>'
      : cachedPurBySup.map(r => `
        <tr>
          <td><strong>${esc(r.name)}</strong></td>
          <td>${r.count}</td>
          <td>${r.units}</td>
          <td>${fmtMoney(r.spent)}</td>
        </tr>
      `).join('');

    // --- Inventory status ---
    const todayD = new Date(); todayD.setHours(0,0,0,0);
    cachedInv = (products||[]).map(p => {
      const exp = p.expiry_date ? new Date(p.expiry_date) : null;
      let status = 'OK', cls = 'badge-ok';
      if (exp && exp < todayD) { status = 'Expired'; cls = 'badge-danger'; }
      else if (Number(p.quantity) <= 0) { status = 'Out of Stock'; cls = 'badge-danger'; }
      else if (Number(p.quantity) <= Number(p.reorder_level)) { status = 'Low Stock'; cls = 'badge-warn'; }
      return { name: p.name, quantity: p.quantity, unit: p.unit, value: Number(p.quantity)*Number(p.cost_price), status, cls };
    }).sort((a,b) => b.value - a.value);

    const totalStockValue = cachedInv.reduce((s,r)=>s+r.value,0);

    $('#invBody').innerHTML = cachedInv.length === 0
      ? '<tr><td colspan="4" class="empty-state">No products yet</td></tr>'
      : cachedInv.map(r => `
        <tr>
          <td><strong>${esc(r.name)}</strong></td>
          <td>${r.quantity} ${esc(r.unit)}</td>
          <td>${fmtMoney(r.value)}</td>
          <td><span class="badge ${r.cls}">${r.status}</span></td>
        </tr>
      `).join('');

    // --- Top stat cards ---
    $('#repStatGrid').innerHTML = `
      <div class="stat-card ok"><div class="label">Revenue</div><div class="value">${fmtMoney(totalRevenue)}</div><div class="sub">${totalUnitsSold} units sold</div></div>
      <div class="stat-card"><div class="label">Cost of Goods Sold</div><div class="value">${fmtMoney(totalCost)}</div></div>
      <div class="stat-card ${totalProfit>=0?'ok':'danger'}"><div class="label">Gross Profit</div><div class="value">${fmtMoney(totalProfit)}</div></div>
      <div class="stat-card warn"><div class="label">Purchases Spent</div><div class="value">${fmtMoney(totalSpent)}</div></div>
      <div class="stat-card"><div class="label">Current Stock Value</div><div class="value">${fmtMoney(totalStockValue)}</div><div class="sub">at cost price</div></div>
    `;
  }

  $('#repApplyBtn').addEventListener('click', loadAndRender);
  $('#printRepBtn').addEventListener('click', () => window.print());

  $('#exportSalesByProdBtn').addEventListener('click', () => {
    exportCSV('sales_by_product.csv', cachedSalesByProd, [
      { label:'Product', key:'name' }, { label:'Units Sold', key:'units' },
      { label:'Revenue', key:'revenue' }, { label:'Est. Cost', key:'cost' },
      { label:'Est. Profit', get:r=>(r.revenue-r.cost).toFixed(2) },
    ]);
  });
  $('#exportPurBySupBtn').addEventListener('click', () => {
    exportCSV('purchases_by_supplier.csv', cachedPurBySup, [
      { label:'Supplier', key:'name' }, { label:'Purchases', key:'count' },
      { label:'Units Received', key:'units' }, { label:'Total Spent', key:'spent' },
    ]);
  });
  $('#exportInvBtn').addEventListener('click', () => {
    exportCSV('inventory_status.csv', cachedInv, [
      { label:'Product', key:'name' }, { label:'Stock', get:r=>`${r.quantity} ${r.unit}` },
      { label:'Stock Value', key:'value' }, { label:'Status', key:'status' },
    ]);
  });

  await loadAndRender();
};
// ============================================================
// MODULE: USERS (Admin only)
// ============================================================
// NOTE: Creating brand-new login accounts requires Supabase's admin API
// (service role key), which must never be exposed in frontend code.
// So new accounts are created via Supabase Dashboard > Authentication > Users
// (see README for steps). This screen lets the admin manage roles &
// active/inactive status for accounts that already exist.

PAGE_RENDERERS.users = async function renderUsers() {
  const content = $('#pageContent');
  content.innerHTML = `
    <div class="card" style="background:#eff8ff;border-color:#bae0fd;">
      <div class="card-body" style="font-size:13px;color:#0c4a6e;">
        <strong>How to add a new staff account:</strong> Go to your Supabase project dashboard →
        Authentication → Users → "Add user". Enter their email and a temporary password.
        A profile is created automatically (as Staff) — come back here to promote them to Admin if needed.
      </div>
    </div>

    <div class="toolbar">
      <div class="search-box">
        <span class="ic">🔍</span>
        <input type="text" id="userSearch" placeholder="Search users...">
      </div>
      <div style="margin-left:auto;">
        <button class="btn btn-secondary btn-sm" id="exportUserBtn">⬇ Export CSV</button>
      </div>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Joined</th><th class="no-print">Actions</th></tr></thead>
          <tbody id="userTableBody"><tr><td colspan="5" class="empty-state">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
  `;

  let allUsers = [];

  async function loadAndRender() {
    const { data, error } = await sb.from('profiles').select('*').order('created_at');
    if (error) { toast('Failed to load users', 'error'); return; }
    allUsers = data || [];
    renderTable($('#userSearch').value);
  }

  function renderTable(filter='') {
    const f = filter.toLowerCase();
    const rows = allUsers.filter(u => u.full_name.toLowerCase().includes(f));
    const tbody = $('#userTableBody');
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No users found</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(u => `
      <tr>
        <td><strong>${esc(u.full_name)}</strong>${u.id===STATE.profile.id ? ' <span class="text-muted">(you)</span>' : ''}</td>
        <td><span class="role-pill ${u.role}">${u.role}</span></td>
        <td><span class="badge ${u.is_active?'badge-ok':'badge-danger'}">${u.is_active?'Active':'Deactivated'}</span></td>
        <td>${fmtDate(u.created_at)}</td>
        <td class="no-print">
          <div class="row-actions">
            <button class="icon-btn" data-edit="${u.id}">✏️</button>
            ${u.id !== STATE.profile.id ? `<button class="icon-btn ${u.is_active?'danger':''}" data-toggle="${u.id}">${u.is_active?'🚫':'✅'}</button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');

    $all('[data-edit]', tbody).forEach(b => b.addEventListener('click', () => openUserModal(allUsers.find(u=>u.id===b.dataset.edit))));
    $all('[data-toggle]', tbody).forEach(b => b.addEventListener('click', () => toggleActive(b.dataset.toggle)));
  }

  function openUserModal(u) {
    openModal(`
      <div class="modal-header"><h3>Edit User</h3><button class="modal-close">×</button></div>
      <div class="modal-body">
        <form id="userForm">
          <div class="form-group">
            <label>Full Name</label>
            <input type="text" id="uFullName" value="${esc(u.full_name)}">
          </div>
          <div class="form-group">
            <label>Role</label>
            <select id="uRole" ${u.id===STATE.profile.id ? 'disabled' : ''}>
              <option value="staff" ${u.role==='staff'?'selected':''}>Staff</option>
              <option value="admin" ${u.role==='admin'?'selected':''}>Admin</option>
            </select>
            ${u.id===STATE.profile.id ? '<div class="help-text">You cannot change your own role.</div>' : ''}
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-close">Cancel</button>
        <button class="btn btn-primary" id="saveUserBtn">Save Changes</button>
      </div>
    `);
    $('#saveUserBtn').addEventListener('click', async () => {
      const fullName = $('#uFullName').value.trim();
      if (!fullName) { toast('Name is required', 'error'); return; }
      const payload = { full_name: fullName };
      if (u.id !== STATE.profile.id) payload.role = $('#uRole').value;

      const { error } = await sb.from('profiles').update(payload).eq('id', u.id);
      if (error) { toast(error.message, 'error'); return; }
      toast('User updated', 'success');
      closeModal();
      await loadAndRender();
    });
  }

  function toggleActive(id) {
    const u = allUsers.find(x => x.id === id);
    const action = u.is_active ? 'deactivate' : 'reactivate';
    confirmAction(`Are you sure you want to ${action} ${u.full_name}'s account?`, async () => {
      const { error } = await sb.from('profiles').update({ is_active: !u.is_active }).eq('id', id);
      if (error) { toast(error.message, 'error'); return; }
      toast(`User ${action}d`, 'success');
      await loadAndRender();
    });
  }

  $('#userSearch').addEventListener('input', debounce(e => renderTable(e.target.value), 200));
  $('#exportUserBtn').addEventListener('click', () => {
    exportCSV('users.csv', allUsers, [
      { label:'Name', key:'full_name' }, { label:'Role', key:'role' },
      { label:'Status', get:u=>u.is_active?'Active':'Deactivated' }, { label:'Joined', get:u=>fmtDate(u.created_at) },
    ]);
  });

  await loadAndRender();
};
// ============================================================
// MODULE: APP SETTINGS (Admin only)
// ============================================================

PAGE_RENDERERS.settings = async function renderSettings() {
  const content = $('#pageContent');
  const s = STATE.settings;

  content.innerHTML = `
    <div class="card" style="max-width:640px;">
      <div class="card-header"><h3>Pharmacy Information</h3></div>
      <div class="card-body">
        <form id="settingsForm">
          <div class="form-group">
            <label>Pharmacy Name *</label>
            <input type="text" id="setName" required value="${esc(s.pharmacy_name||'')}">
          </div>
          <div class="form-group">
            <label>Address</label>
            <textarea id="setAddress" rows="2">${esc(s.address||'')}</textarea>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Phone</label>
              <input type="text" id="setPhone" value="${esc(s.phone||'')}">
            </div>
            <div class="form-group">
              <label>Email</label>
              <input type="email" id="setEmail" value="${esc(s.email||'')}">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Currency Code</label>
              <input type="text" id="setCurrency" maxlength="6" value="${esc(s.currency||'ZMW')}">
              <div class="help-text">e.g. ZMW, USD, TZS, MWK</div>
            </div>
            <div class="form-group">
              <label>Default Reorder Level</label>
              <input type="number" id="setLowStock" min="0" value="${s.low_stock_default||10}">
              <div class="help-text">Used as default when adding new products</div>
            </div>
          </div>
          <div class="form-group">
            <label>Expiry Warning Window (days)</label>
            <input type="number" id="setExpiryDays" min="1" value="${s.expiry_warning_days||30}">
            <div class="help-text">Products expiring within this many days show as "Expiring Soon"</div>
          </div>
          <div class="form-group mb-0">
            <label>Receipt / Report Footer Note</label>
            <textarea id="setFooter" rows="2" placeholder="e.g. Thank you for shopping with us">${esc(s.receipt_footer||'')}</textarea>
          </div>
        </form>
      </div>
      <div class="modal-footer" style="justify-content:flex-start;border-top:1px solid var(--border);">
        <button class="btn btn-primary" id="saveSettingsBtn">Save Settings</button>
      </div>
    </div>

    <div class="card" style="max-width:640px;">
      <div class="card-header"><h3>Database & Backup</h3></div>
      <div class="card-body" style="font-size:13px;color:var(--muted);line-height:1.6;">
        This system runs on Supabase, which automatically backs up your database.
        For point-in-time recovery or manual backups, visit your
        <strong>Supabase Dashboard → Database → Backups</strong>.
        No action is needed here — backups happen automatically on Supabase's infrastructure.
      </div>
    </div>
  `;

  $('#saveSettingsBtn').addEventListener('click', async () => {
    const pharmacy_name = $('#setName').value.trim();
    if (!pharmacy_name) { toast('Pharmacy name is required', 'error'); return; }

    const payload = {
      id: 1,
      pharmacy_name,
      address: $('#setAddress').value.trim() || null,
      phone: $('#setPhone').value.trim() || null,
      email: $('#setEmail').value.trim() || null,
      currency: $('#setCurrency').value.trim() || 'ZMW',
      low_stock_default: parseInt($('#setLowStock').value) || 10,
      expiry_warning_days: parseInt($('#setExpiryDays').value) || 30,
      receipt_footer: $('#setFooter').value.trim() || null,
      updated_at: new Date().toISOString(),
    };

    const btn = $('#saveSettingsBtn');
    btn.disabled = true; btn.textContent = 'Saving...';
    const { error } = await sb.from('app_settings').upsert(payload);
    btn.disabled = false; btn.textContent = 'Save Settings';

    if (error) { toast(error.message, 'error'); return; }
    toast('Settings saved', 'success');
    await loadSettings();
  });
};
