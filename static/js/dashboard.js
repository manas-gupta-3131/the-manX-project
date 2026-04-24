/* Dashboard — Portfolio, Teams & Members management */

let __dash = null, __projects = [], __users = [], __teams = [];
let __activeTab = 'portfolio';

document.addEventListener('DOMContentLoaded', async () => {
  await waitForUser();
  const me = window.__me;
  if (!me) return;
  await loadDashboard(me);
});

function waitForUser() {
  return new Promise(resolve => {
    const check = () => window.__me ? resolve() : setTimeout(check, 50);
    check();
  });
}

async function loadDashboard(me) {
  const root = document.getElementById('dashboard-root');
  root.innerHTML = '';

  const fetches = [
    API.get('/api/dashboard'),
    API.get('/api/projects'),
    API.get('/api/teams'),
  ];
  if (me.role !== 'member') fetches.push(API.get('/api/users'));

  const results = await Promise.all(fetches);
  __dash     = results[0];
  __projects = results[1];
  __teams    = results[2];
  __users    = results[3] || [];
  window.__users    = __users;
  window.__projects = __projects;
  window.__teams    = __teams;

  renderHeader(root, me);
  renderStatTiles(root, me);
  renderTabs(root, me);
  switchTab(__activeTab);
}

/* ── Header ─────────────────────────────────────────────────────────────────── */
function renderHeader(root, me) {
  root.insertAdjacentHTML('beforeend', `
    <div class="page-header">
      <div>
        <div class="page-title">Welcome, ${me.name}</div>
        <div class="text-muted text-sm">${roleLabel(me.role)} · ${new Date().toLocaleDateString('en-GB', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}</div>
      </div>
      <div style="display:flex;gap:8px">
        ${me.role !== 'member' ? `<button class="btn btn-primary" onclick="openNewProjectModal()">+ New Project</button>` : ''}
        ${['vp','pm'].includes(me.role) ? `
          <button class="btn btn-secondary" onclick="openAddMemberModal()">+ Add Member</button>
          <button class="btn btn-secondary" onclick="openNewTeamModal()">+ New Team</button>
        ` : ''}
      </div>
    </div>
  `);
}

/* ── Stat tiles ─────────────────────────────────────────────────────────────── */
function renderStatTiles(root, me) {
  root.insertAdjacentHTML('beforeend', `
    <div class="stat-tiles">
      <div class="stat-tile primary">
        <div class="label">Active Projects</div>
        <div class="value">${__dash.active_project_count}</div>
      </div>
      <div class="stat-tile danger">
        <div class="label">Overdue Tasks</div>
        <div class="value">${__dash.overdue_task_count}</div>
      </div>
      <div class="stat-tile warning">
        <div class="label">Pending Approvals</div>
        <div class="value">${__dash.my_pending_approvals}</div>
      </div>
      <div class="stat-tile success">
        <div class="label">Teams</div>
        <div class="value">${__teams.length}</div>
      </div>
    </div>
  `);
}

/* ── Tabs ────────────────────────────────────────────────────────────────────── */
function renderTabs(root, me) {
  const tabs = [
    { id: 'portfolio', label: 'Portfolio' },
    { id: 'teams',     label: 'Teams' },
    { id: 'members',   label: 'Members' },
    { id: 'alerts',    label: 'Alerts' },
  ];
  root.insertAdjacentHTML('beforeend', `
    <div class="tab-nav" id="dash-tabs">
      ${tabs.map(t => `<button class="tab-btn${t.id === __activeTab ? ' active' : ''}" onclick="switchTab('${t.id}')">${t.label}</button>`).join('')}
    </div>
    <div id="tab-content"></div>
  `);
}

function switchTab(tab) {
  __activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.textContent.toLowerCase() === tab || b.getAttribute('onclick').includes(`'${tab}'`));
  });
  const content = document.getElementById('tab-content');
  content.innerHTML = '';

  if (tab === 'portfolio') renderPortfolioTab(content);
  else if (tab === 'teams') renderTeamsTab(content);
  else if (tab === 'members') renderMembersTab(content);
  else if (tab === 'alerts') renderAlertsTab(content);
}

/* ── Portfolio tab ──────────────────────────────────────────────────────────── */
function renderPortfolioTab(root) {
  root.insertAdjacentHTML('beforeend', `
    <div style="display:flex;justify-content:space-between;align-items:center" class="section-title">
      All Projects
      <input type="text" placeholder="Filter projects…" id="proj-filter"
        style="font-size:12px;padding:4px 10px;width:180px;border:1px solid var(--border-2);border-radius:var(--radius);font-weight:400">
    </div>
  `);
  if (__projects.length === 0) {
    root.insertAdjacentHTML('beforeend', `<div class="empty-state">No projects yet. Click "New Project" to get started.</div>`);
  } else {
    const grid = document.createElement('div');
    grid.className = 'cards-grid';
    grid.id = 'projects-grid';
    __projects.forEach(p => grid.insertAdjacentHTML('beforeend', projectCardHTML(p)));
    root.appendChild(grid);
  }
  document.getElementById('proj-filter')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.project-card').forEach(card => {
      card.style.display = card.dataset.name.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

/* ── Teams tab ──────────────────────────────────────────────────────────────── */
function renderTeamsTab(root) {
  const me = window.__me;
  root.insertAdjacentHTML('beforeend', `<div class="section-title">Teams</div>`);

  if (__teams.length === 0) {
    root.insertAdjacentHTML('beforeend', `<div class="empty-state">No teams yet.</div>`);
    return;
  }

  const table = `
    <div class="card" style="margin-bottom:24px">
      <div class="card-body" style="padding:0">
        <table class="data-table">
          <thead>
            <tr>
              <th>Team Name</th>
              <th>Description</th>
              <th>Lead</th>
              <th>Members</th>
              ${['vp','pm'].includes(me.role) ? '<th style="width:100px">Actions</th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${__teams.map(t => `
              <tr>
                <td><strong>${t.name}</strong></td>
                <td class="text-muted">${t.description || '—'}</td>
                <td>${t.lead_name || '—'}</td>
                <td>${t.member_count}</td>
                ${['vp','pm'].includes(me.role) ? `
                  <td>
                    <button class="btn btn-secondary btn-xs" onclick="openEditTeamModal(${t.id})">Edit</button>
                    <button class="btn btn-danger btn-xs" onclick="deleteTeam(${t.id}, '${t.name.replace(/'/g,"\\'")}')">Delete</button>
                  </td>` : ''}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  root.insertAdjacentHTML('beforeend', table);

  // Team member breakdown
  root.insertAdjacentHTML('beforeend', `<div class="section-title">Members by Team</div>`);
  const byTeam = {};
  __users.forEach(u => {
    const key = u.team_name || 'Unassigned';
    (byTeam[key] = byTeam[key] || []).push(u);
  });
  const cards = document.createElement('div');
  cards.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-bottom:24px';
  Object.entries(byTeam).forEach(([teamName, members]) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-body">
        <div style="font-weight:600;margin-bottom:12px;color:var(--text-primary)">${teamName}</div>
        ${members.map(u => `
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <div class="avatar avatar-sm">${initials(u.name)}</div>
            <div>
              <div style="font-size:13px;font-weight:500">${u.name}</div>
              <div style="font-size:11px;color:var(--text-muted)">${roleLabel(u.role)}</div>
            </div>
          </div>`).join('')}
      </div>`;
    cards.appendChild(card);
  });
  root.appendChild(cards);
}

/* ── Members tab ────────────────────────────────────────────────────────────── */
function renderMembersTab(root) {
  const me = window.__me;
  root.insertAdjacentHTML('beforeend', `
    <div style="display:flex;justify-content:space-between;align-items:center" class="section-title">
      All Members
      <input type="text" placeholder="Filter members…" id="mem-filter"
        style="font-size:12px;padding:4px 10px;width:180px;border:1px solid var(--border-2);border-radius:var(--radius);font-weight:400">
    </div>
  `);

  if (__users.length === 0) {
    root.insertAdjacentHTML('beforeend', `<div class="empty-state">No members found.</div>`);
    return;
  }

  const tbody = __users.map(u => `
    <tr class="mem-row" data-name="${u.name.toLowerCase()}">
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="avatar avatar-sm">${initials(u.name)}</div>
          <div>
            <div style="font-weight:500">${u.name}</div>
            <div style="font-size:11px;color:var(--text-muted)">${u.email}</div>
          </div>
        </div>
      </td>
      <td>${roleLabel(u.role)}</td>
      <td>${u.team_name || '<span class="text-muted">Unassigned</span>'}</td>
      <td>${u.capacity_hours_per_day}h/day</td>
      ${['vp','pm'].includes(me.role) ? `
        <td>
          <button class="btn btn-secondary btn-xs" onclick="openEditMemberModal(${u.id})">Edit</button>
        </td>` : ''}
    </tr>`).join('');

  root.insertAdjacentHTML('beforeend', `
    <div class="card">
      <div class="card-body" style="padding:0">
        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Team</th>
              <th>Capacity</th>
              ${['vp','pm'].includes(me.role) ? '<th style="width:80px">Actions</th>' : ''}
            </tr>
          </thead>
          <tbody id="mem-tbody">${tbody}</tbody>
        </table>
      </div>
    </div>
  `);

  document.getElementById('mem-filter')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.mem-row').forEach(row => {
      row.style.display = row.dataset.name.includes(q) ? '' : 'none';
    });
  });
}

/* ── Alerts tab ──────────────────────────────────────────────────────────────── */
function renderAlertsTab(root) {
  root.insertAdjacentHTML('beforeend', `<div class="section-title">Alerts & Actions</div>`);
  let html = '<ul class="alert-list">';
  if (__dash.overdue_task_count > 0)
    html += `<li class="alert-item"><span class="dot dot-red"></span><div><strong>${__dash.overdue_task_count}</strong> task(s) are overdue across active projects.</div></li>`;
  if (__dash.my_pending_approvals > 0)
    html += `<li class="alert-item"><span class="dot dot-yellow"></span><div><strong>${__dash.my_pending_approvals}</strong> approval(s) awaiting your action.</div></li>`;
  if (__dash.overdue_task_count === 0 && __dash.my_pending_approvals === 0)
    html += `<li class="alert-item"><span class="dot dot-blue"></span><div>No active alerts. Everything looks on track.</div></li>`;
  html += '</ul>';
  root.insertAdjacentHTML('beforeend', html);

  const atRisk = (__dash.projects_summary || []).filter(p => p.progress < 30 && p.status === 'active');
  if (atRisk.length) {
    root.insertAdjacentHTML('beforeend', `
      <div class="section-title mt-16">At-Risk Projects</div>
      <ul class="alert-list">
        ${atRisk.map(p => `
          <li class="alert-item">
            <span class="dot dot-yellow"></span>
            <div><strong>${p.name}</strong> — ${p.progress}% complete
              <a href="/projects/${p.id}" style="margin-left:8px;font-size:12px">View →</a>
            </div>
          </li>`).join('')}
      </ul>`);
  }
}

/* ── Project card ────────────────────────────────────────────────────────────── */
function projectCardHTML(p) {
  return `
    <div class="project-card" data-name="${p.name}" onclick="window.location='/projects/${p.id}'">
      <div class="project-card-header">
        <div>
          <div class="project-card-name">${p.name}</div>
          <div class="project-card-owner">${p.owner_name || '—'}</div>
        </div>
        ${priorityBadge(p.priority)}
      </div>
      <div class="project-card-dates">
        ${fmtDate(p.start_date)} → ${fmtDate(p.target_date)}
        ${p.npd_reference ? `<span class="text-muted"> · ${p.npd_reference}</span>` : ''}
      </div>
      <div class="flex gap-8 mb-4">${statusBadge(p.status)}</div>
      <div class="progress-bar"><div class="fill" style="width:${p.progress}%"></div></div>
      <div class="progress-label">
        <span>${p.completed_task_count}/${p.task_count} tasks</span>
        <span>${p.progress}%</span>
      </div>
    </div>`;
}

function roleLabel(r) {
  return { vp: 'VP R&D', pm: 'Project Manager', lead: 'Team Lead', member: 'Team Member' }[r] || r;
}

/* ══════════════════════════════════════════════════════════════════════════════
   NEW PROJECT MODAL
══════════════════════════════════════════════════════════════════════════════ */
async function openNewProjectModal() {
  const usersHtml = __users
    .filter(u => ['vp','pm'].includes(u.role))
    .map(u => `<option value="${u.id}">${u.name}</option>`).join('');

  showModal(`
    <div class="form-group">
      <label>Project Name *</label>
      <input type="text" id="np-name" placeholder="e.g. Smart Inverter Gen-4">
    </div>
    <div class="form-group">
      <label>Description</label>
      <textarea id="np-desc" rows="2" placeholder="Brief description…"></textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Priority</label>
        <select id="np-priority">
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium" selected>Medium</option>
          <option value="low">Low</option>
        </select>
      </div>
      <div class="form-group">
        <label>Status</label>
        <select id="np-status">
          <option value="planning" selected>Planning</option>
          <option value="active">Active</option>
          <option value="on_hold">On Hold</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Start Date</label>
        <input type="date" id="np-start">
      </div>
      <div class="form-group">
        <label>Target Date (NPD)</label>
        <input type="date" id="np-target">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Owner</label>
        <select id="np-owner">
          ${usersHtml || '<option value="">— me —</option>'}
        </select>
      </div>
      <div class="form-group">
        <label>NPD Reference #</label>
        <input type="text" id="np-npd" placeholder="e.g. NPD-2026-014">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitNewProject()">Create Project</button>
    </div>
  `);
  setModalTitle('New Project');
}

async function submitNewProject() {
  const name = document.getElementById('np-name').value.trim();
  if (!name) { toast('Project name is required', 'error'); return; }
  try {
    const proj = await API.post('/api/projects', {
      name,
      description: document.getElementById('np-desc').value,
      priority:    document.getElementById('np-priority').value,
      status:      document.getElementById('np-status').value,
      start_date:  document.getElementById('np-start').value || null,
      target_date: document.getElementById('np-target').value || null,
      npd_reference: document.getElementById('np-npd').value || null,
      owner_id: document.getElementById('np-owner').value
        ? parseInt(document.getElementById('np-owner').value) : null,
    });
    closeModal();
    toast('Project created', 'success');
    window.location.href = `/projects/${proj.id}`;
  } catch(e) { toast(e.message, 'error'); }
}

/* ══════════════════════════════════════════════════════════════════════════════
   TEAM MODALS
══════════════════════════════════════════════════════════════════════════════ */
function teamFormHTML(team = {}) {
  const leadOptions = __users
    .filter(u => ['vp','pm','lead'].includes(u.role))
    .map(u => `<option value="${u.id}" ${team.lead_id === u.id ? 'selected' : ''}>${u.name}</option>`)
    .join('');
  return `
    <div class="form-group">
      <label>Team Name *</label>
      <input type="text" id="tm-name" value="${team.name || ''}" placeholder="e.g. Power Electronics">
    </div>
    <div class="form-group">
      <label>Description</label>
      <textarea id="tm-desc" rows="2" placeholder="What does this team do?">${team.description || ''}</textarea>
    </div>
    <div class="form-group">
      <label>Team Lead</label>
      <select id="tm-lead">
        <option value="">— None —</option>
        ${leadOptions}
      </select>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="tm-submit-btn">Save Team</button>
    </div>`;
}

function openNewTeamModal() {
  showModal(teamFormHTML());
  setModalTitle('New Team');
  document.getElementById('tm-submit-btn').onclick = submitNewTeam;
}

async function openEditTeamModal(tid) {
  const team = __teams.find(t => t.id === tid);
  if (!team) return;
  showModal(teamFormHTML(team));
  setModalTitle(`Edit Team: ${team.name}`);
  document.getElementById('tm-submit-btn').onclick = () => submitEditTeam(tid);
}

async function submitNewTeam() {
  const name = document.getElementById('tm-name').value.trim();
  if (!name) { toast('Team name is required', 'error'); return; }
  try {
    await API.post('/api/teams', {
      name,
      description: document.getElementById('tm-desc').value,
      lead_id: document.getElementById('tm-lead').value
        ? parseInt(document.getElementById('tm-lead').value) : null,
    });
    closeModal();
    toast('Team created', 'success');
    await refreshData();
    switchTab('teams');
  } catch(e) { toast(e.message, 'error'); }
}

async function submitEditTeam(tid) {
  const name = document.getElementById('tm-name').value.trim();
  if (!name) { toast('Team name is required', 'error'); return; }
  try {
    await API.put(`/api/teams/${tid}`, {
      name,
      description: document.getElementById('tm-desc').value,
      lead_id: document.getElementById('tm-lead').value
        ? parseInt(document.getElementById('tm-lead').value) : null,
    });
    closeModal();
    toast('Team updated', 'success');
    await refreshData();
    switchTab('teams');
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteTeam(tid, name) {
  if (!confirm(`Delete team "${name}"? Members will be unassigned.`)) return;
  try {
    await API.delete(`/api/teams/${tid}`);
    toast('Team deleted', 'success');
    await refreshData();
    switchTab('teams');
  } catch(e) { toast(e.message, 'error'); }
}

/* ══════════════════════════════════════════════════════════════════════════════
   MEMBER MODALS
══════════════════════════════════════════════════════════════════════════════ */
function memberFormHTML(user = {}, isNew = false) {
  const teamOptions = __teams
    .map(t => `<option value="${t.id}" ${user.team_id === t.id ? 'selected' : ''}>${t.name}</option>`)
    .join('');
  return `
    <div class="form-group">
      <label>Full Name *</label>
      <input type="text" id="mb-name" value="${user.name || ''}" placeholder="e.g. Kiran Patel">
    </div>
    <div class="form-group">
      <label>Email *</label>
      <input type="email" id="mb-email" value="${user.email || ''}" placeholder="kiran.patel@vguard.in" ${!isNew ? 'readonly style="opacity:0.6"' : ''}>
    </div>
    ${isNew ? `
    <div class="form-group">
      <label>Password *</label>
      <input type="password" id="mb-password" placeholder="Min. 8 characters">
    </div>` : ''}
    <div class="form-row">
      <div class="form-group">
        <label>Role</label>
        <select id="mb-role">
          <option value="vp"     ${user.role==='vp'     ? 'selected':''}>VP R&D</option>
          <option value="pm"     ${user.role==='pm'     ? 'selected':''}>Project Manager</option>
          <option value="lead"   ${user.role==='lead'   ? 'selected':''}>Team Lead</option>
          <option value="member" ${user.role==='member' ? 'selected':'selected'}>Team Member</option>
        </select>
      </div>
      <div class="form-group">
        <label>Capacity (hrs/day)</label>
        <input type="number" id="mb-cap" value="${user.capacity_hours_per_day || 8}" min="1" max="16" step="0.5">
      </div>
    </div>
    <div class="form-group">
      <label>Team</label>
      <select id="mb-team">
        <option value="">— Unassigned —</option>
        ${teamOptions}
      </select>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="mb-submit-btn">Save Member</button>
    </div>`;
}

function openAddMemberModal() {
  showModal(memberFormHTML({}, true));
  setModalTitle('Add Member');
  document.getElementById('mb-submit-btn').onclick = submitNewMember;
}

async function openEditMemberModal(uid) {
  const user = __users.find(u => u.id === uid);
  if (!user) return;
  showModal(memberFormHTML(user, false));
  setModalTitle(`Edit: ${user.name}`);
  document.getElementById('mb-submit-btn').onclick = () => submitEditMember(uid);
}

async function submitNewMember() {
  const name     = document.getElementById('mb-name').value.trim();
  const email    = document.getElementById('mb-email').value.trim();
  const password = document.getElementById('mb-password').value;
  if (!name || !email || !password) { toast('Name, email and password are required', 'error'); return; }
  if (password.length < 8) { toast('Password must be at least 8 characters', 'error'); return; }
  try {
    await API.post('/api/auth/register', {
      name, email, password,
      role: document.getElementById('mb-role').value,
      capacity_hours_per_day: parseFloat(document.getElementById('mb-cap').value) || 8,
    });
    // assign team separately via update
    const newUser = __users[__users.length]; // will be fresh after refresh
    const teamId = document.getElementById('mb-team').value;
    closeModal();
    toast('Member added', 'success');
    await refreshData();
    // If team selected, update the newly created user
    if (teamId) {
      const fresh = __users.find(u => u.email === email.toLowerCase());
      if (fresh) await API.put(`/api/users/${fresh.id}`, { team_id: parseInt(teamId) });
    }
    await refreshData();
    switchTab('members');
  } catch(e) { toast(e.message, 'error'); }
}

async function submitEditMember(uid) {
  const name = document.getElementById('mb-name').value.trim();
  if (!name) { toast('Name is required', 'error'); return; }
  try {
    await API.put(`/api/users/${uid}`, {
      name,
      role: document.getElementById('mb-role').value,
      capacity_hours_per_day: parseFloat(document.getElementById('mb-cap').value) || 8,
      team_id: document.getElementById('mb-team').value
        ? parseInt(document.getElementById('mb-team').value) : null,
    });
    closeModal();
    toast('Member updated', 'success');
    await refreshData();
    switchTab('members');
  } catch(e) { toast(e.message, 'error'); }
}

/* ── Refresh in-memory state without full page reload ────────────────────── */
async function refreshData() {
  const [projects, teams, users] = await Promise.all([
    API.get('/api/projects'),
    API.get('/api/teams'),
    API.get('/api/users'),
  ]);
  __projects = projects; window.__projects = projects;
  __teams    = teams;    window.__teams    = teams;
  __users    = users;    window.__users    = users;
}
