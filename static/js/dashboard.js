/* Dashboard — renders different views based on current user role */

document.addEventListener('DOMContentLoaded', async () => {
  // Wait for base.html to resolve __me
  await waitForUser();
  const me = window.__me;
  if (!me) return;
  await renderDashboard(me);
});

function waitForUser() {
  return new Promise(resolve => {
    const check = () => window.__me ? resolve() : setTimeout(check, 50);
    check();
  });
}

async function renderDashboard(me) {
  const root = document.getElementById('dashboard-root');
  root.innerHTML = '';

  const [dash, projects, users] = await Promise.all([
    API.get('/api/dashboard'),
    API.get('/api/projects'),
    (me.role !== 'member') ? API.get('/api/users') : Promise.resolve([]),
  ]);

  // Page header
  root.insertAdjacentHTML('beforeend', `
    <div class="page-header">
      <div>
        <div class="page-title">Welcome, ${me.name}</div>
        <div class="text-muted text-sm">${roleLabel(me.role)} · ${new Date().toLocaleDateString('en-GB', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}</div>
      </div>
      ${me.role !== 'member' ? `<button class="btn btn-primary" onclick="openNewProjectModal()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Project
      </button>` : ''}
    </div>
  `);

  // Stat tiles
  root.insertAdjacentHTML('beforeend', `
    <div class="stat-tiles">
      <div class="stat-tile primary">
        <div class="label">Active Projects</div>
        <div class="value">${dash.active_project_count}</div>
      </div>
      <div class="stat-tile danger">
        <div class="label">Overdue Tasks</div>
        <div class="value">${dash.overdue_task_count}</div>
      </div>
      <div class="stat-tile warning">
        <div class="label">Pending Approvals</div>
        <div class="value">${dash.my_pending_approvals}</div>
      </div>
      <div class="stat-tile success">
        <div class="label">My Role</div>
        <div class="value" style="font-size:16px;padding-top:6px">${roleLabel(me.role)}</div>
      </div>
    </div>
  `);

  // Role-specific main content
  if (me.role === 'vp' || me.role === 'pm') {
    renderPortfolioView(root, projects, users);
  } else if (me.role === 'lead') {
    renderLeadView(root, projects, users, me);
  } else {
    renderMemberView(root, projects, me);
  }

  // Alerts panel (for all roles)
  renderAlertsPanel(root, dash);

  // Store users for modals
  window.__users = users;
  window.__projects = projects;
}

function renderPortfolioView(root, projects, users) {
  const main = document.createElement('div');
  main.className = 'dashboard-grid';

  // Left: project cards
  const left = document.createElement('div');
  left.innerHTML = `<div class="section-title">
    All Projects
    <input type="text" placeholder="Filter…" id="proj-filter" style="font-size:12px;padding:4px 8px;width:160px;border:1px solid var(--border-2);border-radius:var(--radius);">
  </div>`;
  const grid = document.createElement('div');
  grid.className = 'cards-grid';
  grid.id = 'projects-grid';
  projects.forEach(p => grid.insertAdjacentHTML('beforeend', projectCardHTML(p)));
  left.appendChild(grid);
  main.appendChild(left);

  root.appendChild(main);

  document.getElementById('proj-filter')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.project-card').forEach(card => {
      card.style.display = card.dataset.name.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

function renderLeadView(root, projects, users, me) {
  const main = document.createElement('div');
  main.className = 'dashboard-grid';
  const left = document.createElement('div');
  left.innerHTML = `<div class="section-title">Team Projects</div>`;
  const grid = document.createElement('div');
  grid.className = 'cards-grid';
  projects.forEach(p => grid.insertAdjacentHTML('beforeend', projectCardHTML(p)));
  left.appendChild(grid);

  // Member workload table
  if (users.length) {
    left.insertAdjacentHTML('beforeend', `
      <div class="section-title mt-16">Team Workload</div>
      <div class="card">
        <div class="card-body" style="padding:0">
          <table class="data-table">
            <thead><tr><th>Member</th><th>Role</th><th>Active Tasks</th></tr></thead>
            <tbody>${users.map(u => `
              <tr>
                <td>${u.name}</td>
                <td>${roleLabel(u.role)}</td>
                <td>—</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `);
  }
  main.appendChild(left);
  root.appendChild(main);
}

function renderMemberView(root, projects, me) {
  root.insertAdjacentHTML('beforeend', `
    <div class="section-title">My Projects</div>
    <div class="cards-grid">${projects.map(projectCardHTML).join('')}</div>
  `);
}

function renderAlertsPanel(root, dash) {
  // Inject alerts column into dashboard-grid if exists, else append
  const grid = root.querySelector('.dashboard-grid');
  const target = grid || root;
  const panel = document.createElement('div');
  panel.innerHTML = `
    <div class="section-title">Alerts & Actions</div>
    <ul class="alert-list">
      ${dash.overdue_task_count > 0 ? `
        <li class="alert-item">
          <span class="dot dot-red"></span>
          <div><strong>${dash.overdue_task_count}</strong> task(s) are overdue across active projects.</div>
        </li>` : ''}
      ${dash.my_pending_approvals > 0 ? `
        <li class="alert-item">
          <span class="dot dot-yellow"></span>
          <div><strong>${dash.my_pending_approvals}</strong> approval(s) awaiting your action.</div>
        </li>` : ''}
      ${dash.overdue_task_count === 0 && dash.my_pending_approvals === 0 ? `
        <li class="alert-item">
          <span class="dot dot-blue"></span>
          <div>No active alerts. Everything looks on track.</div>
        </li>` : ''}
    </ul>

    ${dash.projects_summary && dash.projects_summary.some(p => p.progress < 30 && p.status === 'active') ? `
    <div class="section-title mt-16">At-Risk Projects</div>
    <ul class="alert-list">
      ${dash.projects_summary.filter(p => p.progress < 30 && p.status === 'active').map(p => `
        <li class="alert-item">
          <span class="dot dot-yellow"></span>
          <div><strong>${p.name}</strong> — ${p.progress}% complete</div>
        </li>`).join('')}
    </ul>` : ''}
  `;
  if (grid) grid.appendChild(panel);
  else root.appendChild(panel);
}

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

/* ── New Project Modal ────────────────────────────────────────────────────── */
async function openNewProjectModal() {
  let usersHtml = '';
  if (window.__users && window.__users.length) {
    usersHtml = window.__users
      .filter(u => ['vp','pm'].includes(u.role))
      .map(u => `<option value="${u.id}">${u.name}</option>`).join('');
  }
  showModal(`
    <div class="form-group">
      <label>Project Name *</label>
      <input type="text" id="np-name" placeholder="e.g. 12V 100Ah Li-ion Battery">
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
      priority: document.getElementById('np-priority').value,
      status: document.getElementById('np-status').value,
      start_date: document.getElementById('np-start').value || null,
      target_date: document.getElementById('np-target').value || null,
      npd_reference: document.getElementById('np-npd').value || null,
      owner_id: document.getElementById('np-owner').value ? parseInt(document.getElementById('np-owner').value) : null,
    });
    closeModal();
    toast('Project created', 'success');
    window.location.href = `/projects/${proj.id}`;
  } catch(e) { toast(e.message, 'error'); }
}
