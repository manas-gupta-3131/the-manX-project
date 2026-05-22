/**
 * Thin fetch wrapper. All API calls go through here.
 * On 401, redirects to /login.
 */
const API = (() => {
  async function request(method, url, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      if (window.location.pathname !== '/login') { window.location.href = '/login'; return; }
      throw new Error(data.error || 'Invalid credentials');
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  return {
    get:    (url)        => request('GET',    url),
    post:   (url, body)  => request('POST',   url, body),
    put:    (url, body)  => request('PUT',    url, body),
    delete: (url)        => request('DELETE', url),
  };
})();

/* ── Toast notifications ──────────────────────────────────────────────────── */
function toast(msg, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ── Modal helpers ────────────────────────────────────────────────────────── */
function showModal(html, wideClass = '') {
  let backdrop = document.getElementById('global-modal');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'global-modal';
    backdrop.className = 'modal-backdrop';
    document.body.appendChild(backdrop);
  }
  backdrop.innerHTML = `
    <div class="modal-box ${wideClass}">
      <div class="modal-header">
        <h2 id="modal-title"></h2>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <div class="modal-body">${html}</div>
    </div>`;
  backdrop.classList.remove('hidden');
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
}
function setModalTitle(t) {
  const el = document.getElementById('modal-title');
  if (el) el.textContent = t;
}
function closeModal() {
  const m = document.getElementById('global-modal');
  if (m) m.classList.add('hidden');
}

/* ── Shared badge helpers ─────────────────────────────────────────────────── */
function statusBadge(status) {
  const map = {
    not_started: ['badge-gray',   'Not Started'],
    in_progress: ['badge-blue',   'In Progress'],
    completed:   ['badge-green',  'Completed'],
    blocked:     ['badge-red',    'Blocked'],
    on_hold:     ['badge-yellow', 'On Hold'],
    planning:    ['badge-purple', 'Planning'],
    active:      ['badge-blue',   'Active'],
    cancelled:   ['badge-gray',   'Cancelled'],
  };
  const [cls, label] = map[status] || ['badge-gray', status];
  return `<span class="badge ${cls}">${label}</span>`;
}
function priorityBadge(p) {
  const map = {
    critical: ['badge-red',    'Critical'],
    high:     ['badge-orange', 'High'],
    medium:   ['badge-yellow', 'Medium'],
    low:      ['badge-gray',   'Low'],
  };
  const [cls, label] = map[p] || ['badge-gray', p];
  return `<span class="badge ${cls}">${label}</span>`;
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function initials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}
