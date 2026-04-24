/* Dashboard — Portfolio, Teams & Members management */

let __dash = null, __projects = [], __users = [], __teams = [];
let __activeTab = 'portfolio';

document.addEventListener('DOMContentLoaded', async () => {
  await waitForUser();
  const me = window.__me;
  if (!me) return;
  await loadDashboard(me);
});

window.addEventListener('hashchange', () => {
  const tab = hashToTab(window.location.hash);
  if (tab) switchTab(tab);
});

function hashToTab(hash) {
  const map = { '#projects': 'portfolio', '#teams': 'teams', '#resources': 'members', '#approvals': 'alerts', '#members': 'members', '#alerts': 'alerts' };
  return map[hash] || null;
}

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
  const tabFromHash = hashToTab(window.location.hash);
  switchTab(tabFromHash || __activeTab);
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
  root.insertAdjacentHTML('beforeend', `
    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
      Teams
      <span style="font-size:12px;color:var(--text-muted);font-weight:400">Click a team row to view details</span>
    </div>
  `);

  if (__teams.length === 0) {
    root.insertAdjacentHTML('beforeend', `<div class="empty-state">No teams yet.</div>`);
    return;
  }

  const tbody = __teams.map(t => {
    const members = __users.filter(u => u.team_id === t.id);
    const activeTasks = 0;
    return `
      <tr class="team-row" onclick="openTeamDetail(${t.id})" style="cursor:pointer" title="Click to open team">
        <td>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="avatar" style="background:var(--primary);flex-shrink:0">${t.name.slice(0,2).toUpperCase()}</div>
            <div>
              <div style="font-weight:600;color:var(--primary)">${t.name}</div>
              <div style="font-size:11px;color:var(--text-muted)">${t.description || 'No description'}</div>
            </div>
          </div>
        </td>
        <td>${t.lead_name ? `<div style="display:flex;align-items:center;gap:6px"><div class="avatar avatar-sm">${initials(t.lead_name)}</div>${t.lead_name}</div>` : '<span class="text-muted">—</span>'}</td>
        <td>
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            ${members.slice(0,5).map(u => `<div class="avatar avatar-sm" title="${u.name}">${initials(u.name)}</div>`).join('')}
            ${members.length > 5 ? `<div class="avatar avatar-sm" style="background:var(--surface-2);color:var(--text-2)">+${members.length - 5}</div>` : ''}
          </div>
        </td>
        <td><span class="badge badge-blue">${members.length} member${members.length !== 1 ? 's' : ''}</span></td>
        <td>
          <div style="display:flex;gap:6px;align-items:center" onclick="event.stopPropagation()">
            ${['vp','pm'].includes(me.role) ? `
              <button class="btn btn-secondary btn-xs" onclick="openEditTeamModal(${t.id})">Edit</button>
              <button class="btn btn-danger btn-xs" onclick="deleteTeam(${t.id}, '${t.name.replace(/'/g,"\\'")}')">Delete</button>
            ` : ''}
            <button class="btn btn-secondary btn-xs" onclick="openTeamDetail(${t.id})">Open →</button>
          </div>
        </td>
      </tr>`;
  }).join('');

  root.insertAdjacentHTML('beforeend', `
    <div class="card" style="margin-bottom:24px">
      <div class="card-body" style="padding:0">
        <table class="data-table">
          <thead>
            <tr>
              <th>Team</th><th>Lead</th><th>Members</th><th>Size</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    </div>
  `);
}

/* ── Team Detail View ────────────────────────────────────────────────────────── */
async function openTeamDetail(tid) {
  const content = document.getElementById('tab-content');
  content.innerHTML = `<div style="text-align:center;padding:48px"><div class="spinner" style="margin:auto"></div></div>`;

  const team    = __teams.find(t => t.id === tid);
  const members = __users.filter(u => u.team_id === tid);
  const memberIds = new Set(members.map(m => m.id));

  // Fetch tasks from all projects in parallel
  const activePids = __projects.map(p => p.id);
  let allTasks = [];
  try {
    const taskArrays = await Promise.all(activePids.map(pid => API.get(`/api/projects/${pid}/tasks`)));
    const projMap = {};
    __projects.forEach(p => { projMap[p.id] = p.name; });
    taskArrays.forEach((tasks, i) => {
      tasks.forEach(t => { t._projectName = projMap[activePids[i]]; t._projectId = activePids[i]; });
      allTasks.push(...tasks);
    });
  } catch(e) { /* continue with empty */ }

  const teamTasks = allTasks.filter(t => memberIds.has(t.assignee_id));

  // Stats per member
  const statsByMember = {};
  members.forEach(m => { statsByMember[m.id] = { total: 0, active: 0, done: 0, blocked: 0 }; });
  teamTasks.forEach(t => {
    if (!statsByMember[t.assignee_id]) return;
    statsByMember[t.assignee_id].total++;
    if (t.status === 'completed') statsByMember[t.assignee_id].done++;
    else if (t.status === 'blocked') statsByMember[t.assignee_id].blocked++;
    else if (t.status === 'in_progress') statsByMember[t.assignee_id].active++;
  });

  const totalCapacity = members.reduce((s, m) => s + (m.capacity_hours_per_day || 8), 0);
  const totalActiveTasks = teamTasks.filter(t => t.status === 'in_progress').length;
  const totalDone        = teamTasks.filter(t => t.status === 'completed').length;
  const totalBlocked     = teamTasks.filter(t => t.status === 'blocked').length;

  content.innerHTML = `
    <!-- Back -->
    <div style="margin-bottom:16px">
      <button class="btn btn-secondary btn-sm" onclick="switchTab('teams')">← Back to Teams</button>
    </div>

    <!-- Team Header -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-body" style="display:flex;align-items:flex-start;gap:20px">
        <div class="avatar" style="width:56px;height:56px;font-size:20px;flex-shrink:0;background:var(--primary)">${team.name.slice(0,2).toUpperCase()}</div>
        <div style="flex:1">
          <div style="font-size:22px;font-weight:700;margin-bottom:4px">${team.name}</div>
          <div style="color:var(--text-muted);margin-bottom:10px">${team.description || 'No description'}</div>
          <div style="display:flex;gap:20px;flex-wrap:wrap">
            <div><span style="color:var(--text-muted);font-size:12px">Team Lead</span><div style="font-weight:600">${team.lead_name || '—'}</div></div>
            <div><span style="color:var(--text-muted);font-size:12px">Members</span><div style="font-weight:600">${members.length}</div></div>
            <div><span style="color:var(--text-muted);font-size:12px">Total Capacity</span><div style="font-weight:600">${totalCapacity}h/day</div></div>
            <div><span style="color:var(--text-muted);font-size:12px">Active Tasks</span><div style="font-weight:600">${totalActiveTasks}</div></div>
            <div><span style="color:var(--text-muted);font-size:12px">Completed</span><div style="font-weight:600;color:var(--success)">${totalDone}</div></div>
            ${totalBlocked > 0 ? `<div><span style="color:var(--text-muted);font-size:12px">Blocked</span><div style="font-weight:600;color:var(--danger)">${totalBlocked}</div></div>` : ''}
          </div>
        </div>
      </div>
    </div>

    <!-- Members & Workload -->
    <div class="section-title">Members & Resource Utilization</div>
    <div class="card" style="margin-bottom:24px">
      <div class="card-body" style="padding:0">
        <table class="data-table">
          <thead>
            <tr><th>Member</th><th>Role</th><th>Capacity</th><th>Tasks</th><th>In Progress</th><th>Done</th><th>Blocked</th><th style="width:200px">Workload</th></tr>
          </thead>
          <tbody>
            ${members.length === 0 ? `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">No members in this team</td></tr>` :
              members.map(u => {
                const s = statsByMember[u.id] || { total:0, active:0, done:0, blocked:0 };
                const cap = u.capacity_hours_per_day || 8;
                // rough utilization: assume each active task uses 2h/day
                const usedH = s.active * 2;
                const utilPct = Math.min(Math.round((usedH / cap) * 100), 100);
                const barClass = utilPct > 85 ? 'over' : utilPct > 60 ? 'warn' : '';
                const statusBadgeHtml = utilPct > 85 ? '<span class="badge badge-red">Overloaded</span>' : utilPct > 60 ? '<span class="badge badge-yellow">High Load</span>' : '<span class="badge badge-green">Available</span>';
                return `<tr>
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
                  <td>${cap}h/day</td>
                  <td><strong>${s.total}</strong></td>
                  <td><span style="color:var(--primary)">${s.active}</span></td>
                  <td><span style="color:var(--success)">${s.done}</span></td>
                  <td><span style="color:${s.blocked > 0 ? 'var(--danger)' : 'var(--text-muted)'}">${s.blocked}</span></td>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px">
                      <div class="util-bar" style="flex:1"><div class="util-fill ${barClass}" style="width:${utilPct}%"></div></div>
                      <span style="font-size:11px;width:32px;text-align:right">${utilPct}%</span>
                      ${statusBadgeHtml}
                    </div>
                  </td>
                </tr>`;
              }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- All Tasks -->
    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
      Tasks Assigned to Team
      <div style="display:flex;gap:8px">
        <select id="task-status-filter" onchange="filterTeamTasks()" style="font-size:12px;padding:4px 8px;border:1px solid var(--border-2);border-radius:var(--radius)">
          <option value="">All Statuses</option>
          <option value="in_progress">In Progress</option>
          <option value="not_started">Not Started</option>
          <option value="completed">Completed</option>
          <option value="blocked">Blocked</option>
          <option value="on_hold">On Hold</option>
        </select>
        <select id="task-member-filter" onchange="filterTeamTasks()" style="font-size:12px;padding:4px 8px;border:1px solid var(--border-2);border-radius:var(--radius)">
          <option value="">All Members</option>
          ${members.map(u => `<option value="${u.id}">${u.name}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="card">
      <div class="card-body" style="padding:0">
        <table class="data-table" id="team-tasks-table">
          <thead>
            <tr><th>Task</th><th>Project</th><th>Assignee</th><th>Status</th><th>Start</th><th>Due</th><th>Progress</th></tr>
          </thead>
          <tbody id="team-tasks-body">
            ${teamTasks.length === 0
              ? `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-muted)">No tasks assigned to this team's members</td></tr>`
              : teamTasks.map(t => `
                <tr class="team-task-row"
                    data-status="${t.status}"
                    data-assignee="${t.assignee_id}"
                    onclick="window.location='/projects/${t._projectId}'"
                    style="cursor:pointer">
                  <td>
                    <div style="font-weight:500">${t.title}</div>
                    ${t.wbs_number ? `<div style="font-size:11px;color:var(--text-muted)">${t.wbs_number}</div>` : ''}
                  </td>
                  <td style="font-size:12px;color:var(--text-muted)">${t._projectName}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:6px">
                      <div class="avatar avatar-sm">${initials(t.assignee_name || '?')}</div>
                      <span style="font-size:12px">${t.assignee_name || '—'}</span>
                    </div>
                  </td>
                  <td>${statusBadge(t.status)}</td>
                  <td style="font-size:12px;color:var(--text-muted)">${fmtDate(t.start_date) || '—'}</td>
                  <td style="font-size:12px;color:${!t.end_date ? 'var(--text-muted)' : new Date(t.end_date) < new Date() && t.status !== 'completed' ? 'var(--danger)' : 'var(--text-muted)'}">${fmtDate(t.end_date) || '—'}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:6px">
                      <div class="progress-bar" style="width:80px"><div class="fill" style="width:${t.percent_complete || 0}%"></div></div>
                      <span style="font-size:11px">${t.percent_complete || 0}%</span>
                    </div>
                  </td>
                </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function filterTeamTasks() {
  const statusFilter = document.getElementById('task-status-filter')?.value || '';
  const memberFilter = document.getElementById('task-member-filter')?.value || '';
  document.querySelectorAll('.team-task-row').forEach(row => {
    const matchStatus = !statusFilter || row.dataset.status === statusFilter;
    const matchMember = !memberFilter || row.dataset.assignee === memberFilter;
    row.style.display = matchStatus && matchMember ? '' : 'none';
  });
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
