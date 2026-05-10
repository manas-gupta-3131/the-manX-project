/* ════════════════════════════════════════════════════════════════════════════
   project.js  —  MS-Project–style Gantt + Kanban + Resources
   State is kept in memory; every mutation calls the API then re-renders.
   ════════════════════════════════════════════════════════════════════════════ */

const PID = window.__projectId;

// ── In-memory state ──────────────────────────────────────────────────────────
let state = {
  project:   null,   // project object
  tasks:     [],     // flat list, sorted by display_order
  deps:      [],     // all dependency objects
  users:     [],     // all users
  gantt:     null,   // Frappe Gantt instance
  ganttMode: 'Week', // current view mode
  expanded:  new Set(), // set of task ids that are expanded (show children)
  selected:  null,   // currently selected task id
  serialOf:  {},     // task.id  → serial number (1-based row #)
  bySerial:  {},     // serial # → task.id
};

// ── Serial number helpers ────────────────────────────────────────────────────
// Each task gets a stable 1-based row number based on its position in the
// hierarchical display order (parents before their children, depth-first).
// This is the "serial number" users type when adding predecessors.
function rebuildSerialIndex() {
  state.serialOf = {};
  state.bySerial = {};
  const roots = buildTree();
  let n = 0;
  const walk = (nodes) => {
    nodes.forEach(node => {
      n += 1;
      state.serialOf[node.id] = n;
      state.bySerial[n]       = node.id;
      if (node.children && node.children.length) walk(node.children);
    });
  };
  walk(roots);
}

// Format predecessors for display: "3FS, 5SS+2"
function formatPredsFor(taskId) {
  const preds = state.deps.filter(d => d.successor_id === taskId);
  if (!preds.length) return '';
  return preds.map(d => {
    const s = state.serialOf[d.predecessor_id] || '?';
    const lag = d.lag_days ? (d.lag_days > 0 ? `+${d.lag_days}` : `${d.lag_days}`) : '';
    return `${s}${d.dep_type}${lag}`;
  }).join(', ');
}

// ── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await waitForUser();
  await loadAll();
});

function waitForUser() {
  return new Promise(r => { const t = () => window.__me ? r() : setTimeout(t, 50); t(); });
}

async function loadAll() {
  const [project, tasks, deps, users] = await Promise.all([
    API.get(`/api/projects/${PID}`),
    API.get(`/api/projects/${PID}/tasks`),
    API.get(`/api/projects/${PID}/dependencies`),
    API.get('/api/users'),
  ]);
  state.project = project;
  state.tasks   = tasks;
  state.deps    = deps;
  state.users   = users;
  window.__users = users;

  // Default: expand root tasks
  state.tasks.filter(t => !t.parent_task_id).forEach(t => state.expanded.add(t.id));

  // Recompute on load so parent/phase tasks always have rolled-up dates.
  try { await API.post(`/api/projects/${PID}/schedule/recompute`); } catch(_) {}
  const freshTasks = await API.get(`/api/projects/${PID}/tasks`);
  state.tasks = freshTasks;

  renderHeader();
  renderTaskGrid();
  renderGantt();
}

// ── Header ────────────────────────────────────────────────────────────────────
function renderHeader() {
  const p = state.project;
  document.getElementById('proj-name').textContent = p.name;
  document.getElementById('proj-status-badge').innerHTML  = statusBadge(p.status);
  document.getElementById('proj-priority-badge').innerHTML = priorityBadge(p.priority);
  document.getElementById('proj-start').textContent  = fmtDate(p.start_date);
  document.getElementById('proj-target').textContent = fmtDate(p.target_date);
  document.getElementById('proj-owner').textContent  = p.owner_name || '—';
  if (p.npd_reference) {
    document.getElementById('proj-npd-wrap').style.display = '';
    document.getElementById('proj-npd').textContent = p.npd_reference;
  }
  document.title = `${p.name} — R&D PM`;

  // NPD breach warning banner
  let warnEl = document.getElementById('proj-npd-warn');
  if (!warnEl) {
    warnEl = document.createElement('div');
    warnEl.id = 'proj-npd-warn';
    document.querySelector('.project-header').appendChild(warnEl);
  }
  const forecast = p.current_forecast_date || p.target_date;
  const hasBreach = p.target_date && forecast && forecast > p.target_date;
  if (hasBreach) {
    const days = Math.round((new Date(forecast + 'T00:00:00') - new Date(p.target_date + 'T00:00:00')) / 86400000);
    warnEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;background:#fef3c7;border-left:3px solid #d97706;padding:8px 14px;border-radius:0 4px 4px 0;font-size:13px;color:#92400e;margin-top:6px">
        <svg width="15" height="15" fill="none" stroke="#d97706" stroke-width="2.5" viewBox="0 0 24 24" style="flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>Project forecast is <strong>${days} day${days !== 1 ? 's' : ''} past NPD target</strong> (${fmtDate(p.target_date)}). Review the schedule or update the commitment.</span>
      </div>`;
  } else {
    warnEl.innerHTML = '';
  }
}

// ── Build tree from flat list ─────────────────────────────────────────────────
function buildTree() {
  const map  = {};
  const roots = [];
  state.tasks.forEach(t => { map[t.id] = { ...t, children: [] }; });
  state.tasks.forEach(t => {
    if (t.parent_task_id && map[t.parent_task_id]) map[t.parent_task_id].children.push(map[t.id]);
    else roots.push(map[t.id]);
  });
  return roots;
}

// Flatten tree respecting expanded state
function flattenVisible(nodes, depth = 0, result = []) {
  nodes.forEach(n => {
    result.push({ ...n, _depth: depth });
    if (n.children.length && state.expanded.has(n.id)) flattenVisible(n.children, depth + 1, result);
  });
  return result;
}

// ── Task Grid Render ──────────────────────────────────────────────────────────
function renderTaskGrid() {
  rebuildSerialIndex();
  const roots   = buildTree();
  const visible = flattenVisible(roots);
  const tbody   = document.getElementById('task-rows');
  tbody.innerHTML = '';

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state"><p>No tasks yet. Click <strong>Add Task</strong> to get started.</p></div></td></tr>`;
    return;
  }

  visible.forEach(t => {
    const isParent  = t.children && t.children.length > 0;
    const isExpanded = state.expanded.has(t.id);
    const indent    = t._depth * 18;
    const typeDot   = typeIndicator(t.task_type, t.is_milestone);
    const start     = t.computed_start || t.start_date;
    const end       = t.computed_end   || t.end_date;
    const isSelected = state.selected === t.id;
    const targetDate = state.project?.target_date;
    const isBreaching = targetDate && end && end > targetDate;
    const serial    = state.serialOf[t.id] || '';
    const predStr   = formatPredsFor(t.id);

    const tr = document.createElement('tr');
    tr.dataset.id = t.id;
    if (isSelected) tr.classList.add('selected');

    tr.innerHTML = `
      <td class="task-row-expand">
        ${isParent ? `<span onclick="toggleExpand(${t.id})">${isExpanded ? '▾' : '▸'}</span>` : ''}
      </td>
      <td style="color:var(--text-2);font-size:11px;font-weight:600;text-align:center" title="Row # (use this as predecessor reference)">${serial}</td>
      <td title="${t.wbs_number || ''}" style="color:var(--text-3);font-size:11px">${t.wbs_number || ''}</td>
      <td>
        <div class="task-name-cell">
          <span class="task-indent" style="width:${indent}px"></span>
          ${typeDot}
          <span class="task-name-text" onclick="openDrawer(${t.id})" title="${t.title}">${t.title}</span>
          ${t.is_critical ? '<span class="badge badge-red" style="font-size:10px;padding:1px 5px;margin-left:4px">CP</span>' : ''}
        </div>
      </td>
      <td style="color:var(--text-2);font-size:11px;font-family:var(--mono,monospace)" title="${predStr ? 'Predecessors: ' + predStr : 'No predecessors'}">${predStr || '<span style="color:var(--text-3)">—</span>'}</td>
      <td style="color:var(--text-2)">${t.duration_days || 1}d</td>
      <td style="color:var(--text-2);font-size:12px">${start ? fmtShort(start) : '—'}</td>
      <td style="color:${isBreaching ? '#dc2626' : 'var(--text-2)'};font-size:12px" title="${isBreaching ? 'Exceeds NPD target: ' + fmtDate(targetDate) : ''}">
        ${end ? fmtShort(end) : '—'}${isBreaching ? ' <span style="font-size:10px">⚠</span>' : ''}
      </td>
      <td title="${t.assignee_name || ''}">
        ${t.assignee_name ? `<span class="kc-avatar" style="width:20px;height:20px;font-size:9px">${initials(t.assignee_name)}</span> <span style="font-size:12px">${firstWord(t.assignee_name)}</span>` : '<span style="color:var(--text-3)">—</span>'}
      </td>
      <td style="font-size:12px">${t.percent_complete || 0}%</td>
      <td>
        <div class="flex gap-8">
          <button class="btn-ghost btn-icon" onclick="openAddTaskModal(${t.id})" title="Add subtask" style="font-size:14px;width:24px;height:24px">+</button>
          <button class="btn-ghost btn-icon" onclick="openEditTaskModal(${t.id})" title="Edit task" style="color:var(--text-2);width:24px;height:24px">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-ghost btn-icon" onclick="deleteTask(${t.id})" title="Delete" style="color:var(--text-3);width:24px;height:24px">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function typeIndicator(type, isMilestone) {
  if (isMilestone) return '<span class="task-type-dot dot-milestone" title="Milestone"></span>';
  const map = { phase:'dot-phase', task:'dot-task', subtask:'dot-subtask' };
  return `<span class="task-type-dot ${map[type] || 'dot-task'}" title="${type}"></span>`;
}

function fmtShort(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day:'2-digit', month:'short' });
}
function firstWord(s) { return s ? s.split(' ')[0] : ''; }

// ── Tree expand/collapse ──────────────────────────────────────────────────────
function toggleExpand(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  renderTaskGrid();
}
function expandAll()  { state.tasks.forEach(t => state.expanded.add(t.id));  renderTaskGrid(); }
function collapseAll(){ state.expanded.clear(); renderTaskGrid(); }

// ── Frappe Gantt ──────────────────────────────────────────────────────────────
function renderGantt() {
  const container = document.getElementById('gantt-container');

  // Build dependency map
  const depMap = {};
  state.deps.forEach(d => {
    depMap[d.successor_id] = depMap[d.successor_id] || [];
    depMap[d.successor_id].push(String(d.predecessor_id));
  });

  const today = new Date().toISOString().slice(0, 10);
  // Use project start as the fallback so tasks without dates still appear in the chart.
  const projectFallback = state.project?.start_date || today;
  const ganttTasks = state.tasks
    .map(t => {
      const s = t.computed_start || t.start_date || projectFallback;
      const e = t.computed_end   || t.end_date   || s;
      return {
        id:           String(t.id),
        name:         t.title,
        start:        s,
        end:          e,
        progress:     parseFloat(t.percent_complete) || 0,
        dependencies: (depMap[t.id] || []).join(','),
        custom_class: t.is_critical ? 'bar-critical' : '',
      };
    });

  if (!state.tasks.length) {
    container.innerHTML = `<div class="empty-state" style="margin-top:60px"><p>No tasks yet. Click <strong>Add Task</strong> to get started.</p></div>`;
    return;
  }

  container.innerHTML = '';
  try {
    state.gantt = new Gantt('#gantt-container', ganttTasks, {
      view_mode:   state.ganttMode,
      date_format: 'YYYY-MM-DD',
      bar_height:  28,
      padding:     10,
      on_click:    task => openDrawer(parseInt(task.id)),
      on_date_change: async (task, start, end) => {
        try {
          await API.put(`/api/tasks/${task.id}`, {
            start_date: start.toISOString().slice(0, 10),
            end_date:   end.toISOString().slice(0, 10),
            duration_days: Math.max(1, Math.round((end - start) / 86400000) + 1),
          });
          await refreshTasks();
        } catch(e) { toast(e.message, 'error'); }
      },
      on_progress_change: async (task, progress) => {
        try {
          await API.put(`/api/tasks/${task.id}`, { percent_complete: progress });
          await refreshTasks();
        } catch(e) { toast(e.message, 'error'); }
      },
      custom_popup_html: task => {
        const t = state.tasks.find(x => String(x.id) === String(task.id));
        if (!t) return '';
        return `<div style="padding:8px 10px;font-size:12px;max-width:200px">
          <strong>${t.title}</strong><br>
          ${t.assignee_name ? `👤 ${t.assignee_name}<br>` : ''}
          📅 ${fmtShort(task._start)} → ${fmtShort(task._end)}<br>
          ⏱ ${t.duration_days || 1}d &nbsp;|&nbsp; ${t.percent_complete || 0}% done
          ${t.is_critical ? '<br><span style="color:#dc2626;font-weight:700">⚠ Critical Path</span>' : ''}
        </div>`;
      },
    });
  } catch(e) {
    container.innerHTML = `<div class="empty-state"><p>Gantt render error: ${e.message}</p></div>`;
  }
  setupScrollSync();
}

function setGanttMode(mode, btn) {
  state.ganttMode = mode;
  document.querySelectorAll('.view-mode-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (state.gantt) state.gantt.change_view_mode(mode);
}

// ── Vertical scroll sync between task grid and Gantt panels ───────────────────
// Each panel scrolls independently in the DOM, which causes rows to drift out
// of alignment with their Gantt bars. We mirror vertical scroll position
// between the two so a task row always sits next to its bar.
let _scrollSyncBound = false;
function setupScrollSync() {
  if (_scrollSyncBound) return;
  const left  = document.getElementById('task-grid-panel');
  const right = document.getElementById('gantt-chart-panel');
  if (!left || !right) return;

  let lockSrc = null;
  const sync = (src, dst) => () => {
    if (lockSrc && lockSrc !== src) return;
    lockSrc = src;
    dst.scrollTop = src.scrollTop;
    // Release the lock after the paired scroll event has fired & settled.
    requestAnimationFrame(() => { lockSrc = null; });
  };
  left.addEventListener('scroll',  sync(left,  right), { passive: true });
  right.addEventListener('scroll', sync(right, left),  { passive: true });
  _scrollSyncBound = true;
}

// ── Refresh (after mutations) ─────────────────────────────────────────────────
async function refreshTasks() {
  const [tasks, deps] = await Promise.all([
    API.get(`/api/projects/${PID}/tasks`),
    API.get(`/api/projects/${PID}/dependencies`),
  ]);
  state.tasks = tasks;
  state.deps  = deps;
  renderTaskGrid();
  renderGantt();
  if (state.selected) openDrawer(state.selected); // refresh drawer
}

async function recomputeSchedule() {
  try {
    await API.post(`/api/projects/${PID}/schedule/recompute`);
    await refreshTasks();
    toast('Schedule recomputed', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

// ── Task Drawer ───────────────────────────────────────────────────────────────
function openDrawer(tid) {
  state.selected = tid;
  const t = state.tasks.find(x => x.id === tid);
  if (!t) return;

  document.querySelectorAll('#task-rows tr').forEach(r => {
    r.classList.toggle('selected', parseInt(r.dataset.id) === tid);
  });

  const taskDeps = state.deps.filter(d => d.successor_id === tid || d.predecessor_id === tid);
  const predecessors = taskDeps.filter(d => d.successor_id === tid);
  const successors   = taskDeps.filter(d => d.predecessor_id === tid);

  document.getElementById('drawer-title').textContent = t.title;

  document.getElementById('drawer-body').innerHTML = `
    <!-- Core fields -->
    <div class="drawer-section">
      <div class="drawer-section-title">Details</div>
      <div class="drawer-field"><span class="df-label">Status</span><span class="df-value">${statusBadge(t.status)}</span></div>
      <div class="drawer-field"><span class="df-label">Type</span><span class="df-value">${t.task_type}${t.is_milestone ? ' · milestone' : ''}</span></div>
      <div class="drawer-field"><span class="df-label">WBS</span><span class="df-value">${t.wbs_number || '—'}</span></div>
      <div class="drawer-field"><span class="df-label">Assignee</span><span class="df-value">${t.assignee_name || '—'}</span></div>
      <div class="drawer-field"><span class="df-label">Team</span><span class="df-value">${t.team_name || '—'}</span></div>
    </div>

    <!-- Timeline -->
    <div class="drawer-section">
      <div class="drawer-section-title">Timeline</div>
      <div class="drawer-field"><span class="df-label">Start</span><span class="df-value">${fmtDate(t.computed_start || t.start_date)}</span></div>
      <div class="drawer-field"><span class="df-label">Finish</span><span class="df-value">${fmtDate(t.computed_end   || t.end_date)}</span></div>
      <div class="drawer-field"><span class="df-label">Duration</span><span class="df-value">${t.duration_days || 1} day(s)</span></div>
      <div class="drawer-field"><span class="df-label">Effort</span><span class="df-value">${t.effort_days != null ? t.effort_days + ' day(s)' : '—'}</span></div>
      <div class="drawer-field"><span class="df-label">% Done</span>
        <span class="df-value">
          <div class="progress-bar" style="width:120px;display:inline-block;vertical-align:middle">
            <div class="fill" style="width:${t.percent_complete || 0}%"></div>
          </div>
          <span style="margin-left:6px;font-size:12px">${t.percent_complete || 0}%</span>
        </span>
      </div>
      ${t.is_critical ? '<div class="drawer-field"><span class="df-label">Critical</span><span class="df-value"><span class="badge badge-red">On Critical Path</span></span></div>' : ''}
    </div>

    <!-- Dependencies -->
    <div class="drawer-section">
      <div class="drawer-section-title" style="display:flex;align-items:center;justify-content:space-between">
        Predecessors
        <button class="btn btn-ghost btn-sm" onclick="openAddDepModal(${tid})">+ Add</button>
      </div>
      ${predecessors.length ? `
        <ul class="dep-list">
          ${predecessors.map(d => {
            const pred = state.tasks.find(x => x.id === d.predecessor_id);
            const ps   = state.serialOf[d.predecessor_id] || '?';
            const lag  = d.lag_days ? (d.lag_days > 0 ? `+${d.lag_days}` : `${d.lag_days}`) : '';
            return `<li class="dep-item">
              <span style="font-weight:700;color:var(--text-2);font-size:11px;min-width:22px">#${ps}</span>
              <span class="dep-type">${d.dep_type}${lag}</span>
              <span class="dep-name">${pred ? pred.title : d.predecessor_id}</span>
              <span class="dep-remove" onclick="deleteDep(${d.id})" title="Remove">✕</span>
            </li>`;
          }).join('')}
        </ul>` : '<div class="text-sm text-muted">No predecessors</div>'}
    </div>

    ${successors.length ? `
    <div class="drawer-section">
      <div class="drawer-section-title">Successors</div>
      <ul class="dep-list">
        ${successors.map(d => {
          const succ = state.tasks.find(x => x.id === d.successor_id);
          const ss   = state.serialOf[d.successor_id] || '?';
          const lag  = d.lag_days ? (d.lag_days > 0 ? `+${d.lag_days}` : `${d.lag_days}`) : '';
          return `<li class="dep-item">
            <span style="font-weight:700;color:var(--text-2);font-size:11px;min-width:22px">#${ss}</span>
            <span class="dep-type">${d.dep_type}${lag}</span>
            <span class="dep-name">${succ ? succ.title : d.successor_id}</span>
          </li>`;
        }).join('')}
      </ul>
    </div>` : ''}

    <!-- Description -->
    ${t.description ? `
    <div class="drawer-section">
      <div class="drawer-section-title">Description</div>
      <div class="text-sm" style="color:var(--text-2);line-height:1.5">${t.description}</div>
    </div>` : ''}
  `;

  const canEdit = window.__me && ['vp','pm','lead'].includes(window.__me.role);
  document.getElementById('drawer-footer').innerHTML = canEdit ? `
    <button class="btn btn-secondary" style="flex:1" onclick="openEditTaskModal(${tid})">Edit Task</button>
    <button class="btn btn-danger btn-sm" onclick="deleteTask(${tid})">Delete</button>
  ` : '';

  document.getElementById('task-drawer').classList.add('open');
}

function closeDrawer() {
  state.selected = null;
  document.getElementById('task-drawer').classList.remove('open');
  document.querySelectorAll('#task-rows tr').forEach(r => r.classList.remove('selected'));
}

// ── Add Task Modal ────────────────────────────────────────────────────────────
function openAddTaskModal(parentId) {
  const usersOpts = state.users.map(u => `<option value="${u.id}">${u.name} (${u.role})</option>`).join('');
  const parentOpts = state.tasks.map(t => `<option value="${t.id}">${t.wbs_number || ''} ${t.title}</option>`).join('');
  const selParent = parentId ? `value="${parentId}"` : '';
  const today = new Date().toISOString().slice(0,10);

  showModal(`
    <div class="form-group">
      <label>Task Name *</label>
      <input type="text" id="nt-name" placeholder="Enter task name…" autofocus>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Task Type</label>
        <select id="nt-type">
          <option value="task" selected>Task</option>
          <option value="phase">Phase</option>
          <option value="subtask">Subtask</option>
          <option value="milestone">Milestone</option>
        </select>
      </div>
      <div class="form-group">
        <label>Parent Task</label>
        <select id="nt-parent">
          <option value="">— none (root task) —</option>
          ${parentOpts}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Start Date</label>
        <input type="date" id="nt-start" value="${today}">
      </div>
      <div class="form-group">
        <label>End Date</label>
        <input type="date" id="nt-end">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Duration (days)</label>
        <input type="number" id="nt-dur" min="1" value="1">
      </div>
      <div class="form-group">
        <label>Effort (days)</label>
        <input type="number" id="nt-effort" min="0" step="0.5" placeholder="optional">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Status</label>
        <select id="nt-status">
          <option value="not_started" selected>Not Started</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
          <option value="blocked">Blocked</option>
          <option value="on_hold">On Hold</option>
        </select>
      </div>
      <div class="form-group">
        <label>% Complete</label>
        <input type="number" id="nt-pct" min="0" max="100" value="0">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Assignee</label>
        <select id="nt-assignee">
          <option value="">— unassigned —</option>
          ${usersOpts}
        </select>
      </div>
      <div class="form-group">
        <label>WBS Number</label>
        <input type="text" id="nt-wbs" placeholder="e.g. 1.2.3">
      </div>
    </div>
    <div class="form-group">
      <label>Description</label>
      <textarea id="nt-desc" rows="2"></textarea>
    </div>
    <div class="form-group" style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="nt-milestone" style="width:auto">
      <label for="nt-milestone" style="margin:0;font-weight:400">Mark as Milestone</label>
    </div>
    <div class="form-group" style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <label style="margin:0">Predecessors</label>
        <button type="button" class="btn btn-ghost btn-sm" onclick="addDepRow()">+ Add Predecessor</button>
      </div>
      <div style="font-size:11px;color:var(--text-3);margin-bottom:8px">Type the <strong>Row #</strong> (from the # column) of the predecessor task. FS = Finish→Start &nbsp;|&nbsp; SS = Start→Start &nbsp;|&nbsp; FF = Finish→Finish &nbsp;|&nbsp; SF = Start→Finish &nbsp;|&nbsp; Lag = offset in days</div>
      <div id="pending-deps-container"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitAddTask()">Add Task</button>
    </div>
  `, 'wide');
  setModalTitle('Add Task');

  // Pre-select parent
  if (parentId) document.getElementById('nt-parent').value = String(parentId);

  // Auto-calculate end from start + duration
  const startEl = document.getElementById('nt-start');
  const durEl   = document.getElementById('nt-dur');
  const endEl   = document.getElementById('nt-end');
  function autoEnd() {
    if (startEl.value && durEl.value) {
      const s = new Date(startEl.value + 'T00:00:00');
      s.setDate(s.getDate() + parseInt(durEl.value) - 1);
      endEl.value = s.toISOString().slice(0,10);
    }
  }
  startEl.addEventListener('change', autoEnd);
  durEl.addEventListener('input', autoEnd);
  autoEnd();
}

async function submitAddTask() {
  const name = document.getElementById('nt-name').value.trim();
  if (!name) { toast('Task name is required', 'error'); return; }
  const typeVal = document.getElementById('nt-type').value;
  try {
    const newTask = await API.post(`/api/projects/${PID}/tasks`, {
      title:            name,
      task_type:        typeVal,
      status:           document.getElementById('nt-status').value,
      percent_complete: parseFloat(document.getElementById('nt-pct').value) || 0,
      parent_task_id:   document.getElementById('nt-parent').value ? parseInt(document.getElementById('nt-parent').value) : null,
      start_date:       document.getElementById('nt-start').value || null,
      end_date:         document.getElementById('nt-end').value   || null,
      duration_days:    parseInt(document.getElementById('nt-dur').value)      || 1,
      effort_days:      parseFloat(document.getElementById('nt-effort').value) || null,
      assignee_id:      document.getElementById('nt-assignee').value ? parseInt(document.getElementById('nt-assignee').value) : null,
      wbs_number:       document.getElementById('nt-wbs').value || null,
      description:      document.getElementById('nt-desc').value || null,
      is_milestone:     document.getElementById('nt-milestone').checked,
    });
    // Create any predecessor dependencies that were added
    const depRows = collectDepRows();
    for (const dep of depRows) {
      try {
        await API.post('/api/dependencies', {
          predecessor_id: dep.pred_id,
          successor_id:   newTask.id,
          dep_type:       dep.dep_type,
          lag_days:       dep.lag_days,
        });
      } catch(_) {}
    }
    closeModal();
    toast('Task added', 'success');
    await refreshTasks();
  } catch(e) { toast(e.message, 'error'); }
}

// ── Edit Task Modal ───────────────────────────────────────────────────────────
function openEditTaskModal(tid) {
  const t = state.tasks.find(x => x.id === tid);
  if (!t) return;

  // Use computed dates (what the scheduler derived) as the displayed/editable dates.
  // These are what the drawer and task grid show, so the modal must match.
  const editStart = t.computed_start || t.start_date || '';
  const editEnd   = t.computed_end   || t.end_date   || '';
  // Show a hint when computed dates differ from the manually planned dates.
  const startDiffers = t.computed_start && t.start_date && t.computed_start !== t.start_date;
  const endDiffers   = t.computed_end   && t.end_date   && t.computed_end   !== t.end_date;

  const usersOpts = state.users.map(u =>
    `<option value="${u.id}" ${u.id === t.assignee_id ? 'selected' : ''}>${u.name}</option>`).join('');

  const existingPreds = state.deps.filter(d => d.successor_id === tid);
  const existingPredHtml = existingPreds.length
    ? existingPreds.map(d => {
        const pred = state.tasks.find(x => x.id === d.predecessor_id);
        const ps   = state.serialOf[d.predecessor_id] || '?';
        return `<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;padding:5px 8px;background:var(--surface-2);border-radius:4px;font-size:12px">
          <span style="font-weight:700;min-width:22px;font-size:11px;color:var(--text-2);text-align:center">#${ps}</span>
          <span style="font-weight:700;color:var(--primary);min-width:26px;font-size:11px">${d.dep_type}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${pred ? pred.title : '(task #' + d.predecessor_id + ')'}</span>
          ${d.lag_days ? `<span style="color:var(--text-3);font-size:11px">${d.lag_days > 0 ? '+' : ''}${d.lag_days}d</span>` : ''}
          <button class="btn-ghost btn-icon" type="button" onclick="deleteDepInModal(${d.id},${tid})" title="Remove dependency" style="color:var(--text-3);width:18px;height:18px;padding:0;font-size:12px;flex-shrink:0">✕</button>
        </div>`;
      }).join('')
    : `<div style="font-size:12px;color:var(--text-3);margin-bottom:4px">No predecessors defined.</div>`;

  const existingSuccs = state.deps.filter(d => d.predecessor_id === tid);
  const existingSuccHtml = existingSuccs.length
    ? existingSuccs.map(d => {
        const succ = state.tasks.find(x => x.id === d.successor_id);
        const ss   = state.serialOf[d.successor_id] || '?';
        return `<div style="display:flex;gap:6px;align-items:center;padding:5px 8px;background:var(--surface-2);border-radius:4px;font-size:12px;margin-bottom:4px">
          <span style="font-weight:700;min-width:22px;font-size:11px;color:var(--text-2);text-align:center">#${ss}</span>
          <span style="font-weight:700;color:var(--primary);min-width:26px;font-size:11px">${d.dep_type}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${succ ? succ.title : '(task #' + d.successor_id + ')'}</span>
          ${d.lag_days ? `<span style="color:var(--text-3);font-size:11px">${d.lag_days > 0 ? '+' : ''}${d.lag_days}d</span>` : ''}
        </div>`;
      }).join('')
    : `<div style="font-size:12px;color:var(--text-3)">No successors defined.</div>`;

  showModal(`
    <div class="form-group">
      <label>Task Name *</label>
      <input type="text" id="et-name" value="${t.title}">
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Status</label>
        <select id="et-status">
          ${['not_started','in_progress','completed','blocked','on_hold'].map(s =>
            `<option value="${s}" ${s===t.status?'selected':''}>${s.replace('_',' ')}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Task Type</label>
        <select id="et-type">
          ${['task','phase','subtask','milestone'].map(s =>
            `<option value="${s}" ${s===t.task_type?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Start Date ${startDiffers ? `<span style="font-weight:400;color:var(--text-3);font-size:11px">(planned: ${fmtDate(t.start_date)})</span>` : ''}</label>
        <input type="date" id="et-start" value="${editStart}">
      </div>
      <div class="form-group">
        <label>End Date ${endDiffers ? `<span style="font-weight:400;color:var(--text-3);font-size:11px">(planned: ${fmtDate(t.end_date)})</span>` : ''}</label>
        <input type="date" id="et-end" value="${editEnd}">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Duration (days)</label>
        <input type="number" id="et-dur" min="1" value="${t.duration_days || 1}">
      </div>
      <div class="form-group">
        <label>% Complete</label>
        <input type="number" id="et-pct" min="0" max="100" value="${t.percent_complete || 0}">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Assignee</label>
        <select id="et-assignee">
          <option value="">— unassigned —</option>
          ${usersOpts}
        </select>
      </div>
      <div class="form-group">
        <label>WBS Number</label>
        <input type="text" id="et-wbs" value="${t.wbs_number || ''}">
      </div>
    </div>
    <div class="form-group">
      <label>Effort (person-days)</label>
      <input type="number" id="et-effort" min="0" step="0.5" value="${t.effort_days || ''}">
    </div>
    <div class="form-group">
      <label>Description</label>
      <textarea id="et-desc" rows="2">${t.description || ''}</textarea>
    </div>

    <!-- Predecessor dependencies -->
    <div class="form-group" style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <label style="margin:0">Predecessors</label>
        <button type="button" class="btn btn-ghost btn-sm" onclick="addDepRow()">+ Add</button>
      </div>
      <div style="font-size:11px;color:var(--text-3);margin-bottom:8px">Type the <strong>Row #</strong> (from the # column) of the predecessor task. FS = Finish→Start &nbsp;|&nbsp; SS = Start→Start &nbsp;|&nbsp; FF = Finish→Finish &nbsp;|&nbsp; SF = Start→Finish &nbsp;|&nbsp; Lag = offset in days</div>
      ${existingPredHtml}
      <div id="pending-deps-container" style="margin-top:4px"></div>
    </div>

    <!-- Successor dependencies (read-only view) -->
    <div class="form-group" style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">
      <label style="margin-bottom:8px;display:block">Successors <span style="font-weight:400;color:var(--text-3);font-size:11px">(tasks that depend on this one)</span></label>
      ${existingSuccHtml}
    </div>

    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitEditTask(${tid})">Save Changes</button>
    </div>
  `, 'wide');
  setModalTitle('Edit Task');
}

async function submitEditTask(tid) {
  const name = document.getElementById('et-name').value.trim();
  if (!name) { toast('Task name is required', 'error'); return; }
  try {
    await API.put(`/api/tasks/${tid}`, {
      title:          name,
      status:         document.getElementById('et-status').value,
      task_type:      document.getElementById('et-type').value,
      start_date:     document.getElementById('et-start').value || null,
      end_date:       document.getElementById('et-end').value   || null,
      duration_days:  parseInt(document.getElementById('et-dur').value) || 1,
      percent_complete: parseFloat(document.getElementById('et-pct').value) || 0,
      assignee_id:    document.getElementById('et-assignee').value ? parseInt(document.getElementById('et-assignee').value) : null,
      wbs_number:     document.getElementById('et-wbs').value || null,
      effort_days:    parseFloat(document.getElementById('et-effort').value) || null,
      description:    document.getElementById('et-desc').value || null,
    });
    // Create any new predecessor dependencies
    const depRows = collectDepRows();
    for (const dep of depRows) {
      try {
        await API.post('/api/dependencies', {
          predecessor_id: dep.pred_id,
          successor_id:   tid,
          dep_type:       dep.dep_type,
          lag_days:       dep.lag_days,
        });
      } catch(_) {}
    }
    closeModal();
    toast('Task saved', 'success');
    await refreshTasks();
  } catch(e) { toast(e.message, 'error'); }
}

// ── Dependency row helpers (used by Add Task and Edit Task modals) ────────────
// UX: user types the Row # (from the # column in the task grid) of the
// predecessor task — no dropdown, no scrolling through long task lists.

function addDepRow() {
  const container = document.getElementById('pending-deps-container');
  if (!container) return;
  const maxSerial = Object.keys(state.bySerial).length;
  container.insertAdjacentHTML('beforeend', `
    <div class="dep-row-inline" style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
      <input type="number" class="dep-pred-serial" min="1" max="${maxSerial}"
             style="width:64px;flex:none" placeholder="Row #"
             title="Type the # of the predecessor task (see # column)">
      <span class="dep-pred-preview" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text-3)">— pick a row —</span>
      <select class="dep-type-sel" style="width:58px;flex:none" title="Dependency type">
        <option value="FS">FS</option>
        <option value="SS">SS</option>
        <option value="FF">FF</option>
        <option value="SF">SF</option>
      </select>
      <input type="number" class="dep-lag-inp" value="0" min="-30" max="365"
             style="width:52px;flex:none" placeholder="lag" title="Lag days (negative = lead time)">
      <button class="btn-ghost btn-icon" type="button" onclick="removeDepRow(this)"
              title="Remove" style="color:var(--text-3);flex:none;padding:0;width:22px;height:22px">✕</button>
    </div>`);

  // Live-preview: when user types a row #, show the task title
  const row = container.lastElementChild;
  const serialInp = row.querySelector('.dep-pred-serial');
  const preview   = row.querySelector('.dep-pred-preview');
  serialInp.addEventListener('input', () => {
    const n   = parseInt(serialInp.value);
    const tid = state.bySerial[n];
    const t   = tid ? state.tasks.find(x => x.id === tid) : null;
    if (t) {
      preview.textContent = t.title;
      preview.style.color = 'var(--text-1)';
    } else {
      preview.textContent = serialInp.value ? '⚠ no row ' + serialInp.value : '— pick a row —';
      preview.style.color = serialInp.value ? '#dc2626' : 'var(--text-3)';
    }
  });
  serialInp.focus();
}

function removeDepRow(btn) {
  btn.closest('.dep-row-inline').remove();
}

function collectDepRows() {
  const rows = document.querySelectorAll('#pending-deps-container .dep-row-inline');
  const deps = [];
  rows.forEach(row => {
    const serial  = parseInt(row.querySelector('.dep-pred-serial').value);
    const pred_id = state.bySerial[serial];
    if (!pred_id) return;
    deps.push({
      pred_id,
      dep_type: row.querySelector('.dep-type-sel').value,
      lag_days: parseInt(row.querySelector('.dep-lag-inp').value) || 0,
    });
  });
  return deps;
}

async function deleteDepInModal(depId, taskId) {
  try {
    await API.delete(`/api/dependencies/${depId}`);
    state.deps = await API.get(`/api/projects/${PID}/dependencies`);
    openEditTaskModal(taskId);
  } catch(e) { toast(e.message, 'error'); }
}

// ── Delete Task ───────────────────────────────────────────────────────────────
async function deleteTask(tid) {
  const t = state.tasks.find(x => x.id === tid);
  if (!confirm(`Delete "${t ? t.title : tid}"? This cannot be undone.`)) return;
  try {
    await API.delete(`/api/tasks/${tid}`);
    if (state.selected === tid) closeDrawer();
    toast('Task deleted', 'success');
    await refreshTasks();
  } catch(e) { toast(e.message, 'error'); }
}

// ── Dependency Modal ──────────────────────────────────────────────────────────
function openAddDepModal(successorId) {
  const t = state.tasks.find(x => x.id === successorId);
  const successorSerial = state.serialOf[successorId] || '?';
  const maxSerial = Object.keys(state.bySerial).length;

  showModal(`
    <div class="form-group">
      <label>Successor Task</label>
      <input type="text" value="#${successorSerial} — ${t ? t.title : successorId}" disabled style="background:var(--surface-2)">
    </div>
    <div class="form-group">
      <label>Predecessor Row # *</label>
      <input type="number" id="dep-pred-serial" min="1" max="${maxSerial}" placeholder="e.g. 3" autofocus>
      <div id="dep-pred-preview" style="margin-top:4px;font-size:12px;color:var(--text-3)">Type the # of the predecessor task (see the # column in the task grid).</div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Dependency Type</label>
        <select id="dep-type">
          <option value="FS">FS — Finish to Start (default)</option>
          <option value="SS">SS — Start to Start</option>
          <option value="FF">FF — Finish to Finish</option>
          <option value="SF">SF — Start to Finish</option>
        </select>
      </div>
      <div class="form-group">
        <label>Lag (days)</label>
        <input type="number" id="dep-lag" value="0" min="-30" max="365">
      </div>
    </div>
    <div class="text-sm text-muted" style="margin-bottom:12px;line-height:1.6">
      <strong>FS</strong>: successor starts after predecessor finishes.<br>
      <strong>SS</strong>: both start together.<br>
      <strong>FF</strong>: both finish together.<br>
      <strong>SF</strong>: successor finishes when predecessor starts.<br>
      Lag adds a delay (negative = lead time).
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitAddDep(${successorId})">Add Dependency</button>
    </div>
  `);
  setModalTitle('Add Dependency');

  // Live preview of which task the row # maps to
  const inp = document.getElementById('dep-pred-serial');
  const pv  = document.getElementById('dep-pred-preview');
  inp.addEventListener('input', () => {
    const n   = parseInt(inp.value);
    const tid = state.bySerial[n];
    if (tid === successorId) {
      pv.textContent = '⚠ a task cannot depend on itself';
      pv.style.color = '#dc2626';
      return;
    }
    const pred = tid ? state.tasks.find(x => x.id === tid) : null;
    if (pred) {
      pv.textContent = '→ ' + pred.title;
      pv.style.color = 'var(--text-1)';
    } else {
      pv.textContent = inp.value ? '⚠ no row ' + inp.value : 'Type the # of the predecessor task.';
      pv.style.color = inp.value ? '#dc2626' : 'var(--text-3)';
    }
  });
}

async function submitAddDep(successorId) {
  const serial = parseInt(document.getElementById('dep-pred-serial').value);
  const predId = state.bySerial[serial];
  if (!predId) { toast('Enter a valid Row #', 'error'); return; }
  if (predId === successorId) { toast('A task cannot depend on itself', 'error'); return; }
  try {
    await API.post('/api/dependencies', {
      predecessor_id: predId,
      successor_id:   successorId,
      dep_type:       document.getElementById('dep-type').value,
      lag_days:       parseInt(document.getElementById('dep-lag').value) || 0,
    });
    closeModal();
    toast('Dependency added', 'success');
    await refreshTasks();
    openDrawer(successorId);
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteDep(depId) {
  try {
    await API.delete(`/api/dependencies/${depId}`);
    toast('Dependency removed', 'success');
    const tid = state.selected;
    await refreshTasks();
    if (tid) openDrawer(tid);
  } catch(e) { toast(e.message, 'error'); }
}

// ── Edit Project Modal ────────────────────────────────────────────────────────
function openEditProjectModal() {
  const p = state.project;
  showModal(`
    <div class="form-group">
      <label>Project Name *</label>
      <input type="text" id="ep-name" value="${p.name}">
    </div>
    <div class="form-group">
      <label>Description</label>
      <textarea id="ep-desc" rows="2">${p.description || ''}</textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Priority</label>
        <select id="ep-priority">
          ${['critical','high','medium','low'].map(x => `<option value="${x}" ${x===p.priority?'selected':''}>${x}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Status</label>
        <select id="ep-status">
          ${['planning','active','on_hold','completed','cancelled'].map(x => `<option value="${x}" ${x===p.status?'selected':''}>${x.replace('_',' ')}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Start Date</label>
        <input type="date" id="ep-start" value="${p.start_date || ''}">
      </div>
      <div class="form-group">
        <label>Target Date</label>
        <input type="date" id="ep-target" value="${p.target_date || ''}">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Current Forecast Date</label>
        <input type="date" id="ep-forecast" value="${p.current_forecast_date || ''}">
      </div>
      <div class="form-group">
        <label>NPD Reference #</label>
        <input type="text" id="ep-npd" value="${p.npd_reference || ''}">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitEditProject()">Save</button>
    </div>
  `, 'wide');
  setModalTitle('Edit Project');
}

async function submitEditProject() {
  const name = document.getElementById('ep-name').value.trim();
  if (!name) { toast('Project name is required', 'error'); return; }
  try {
    const updated = await API.put(`/api/projects/${PID}`, {
      name,
      description:          document.getElementById('ep-desc').value || null,
      priority:             document.getElementById('ep-priority').value,
      status:               document.getElementById('ep-status').value,
      start_date:           document.getElementById('ep-start').value    || null,
      target_date:          document.getElementById('ep-target').value   || null,
      current_forecast_date:document.getElementById('ep-forecast').value || null,
      npd_reference:        document.getElementById('ep-npd').value      || null,
    });
    state.project = updated;
    renderHeader();
    closeModal();
    toast('Project updated', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  btn.classList.add('active');
  if (name === 'kanban')    renderKanban();
  if (name === 'resources') renderResources();
}

// ── Kanban ────────────────────────────────────────────────────────────────────
const KANBAN_COLS = [
  { key: 'not_started', label: 'Not Started' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'blocked',     label: 'Blocked' },
  { key: 'on_hold',     label: 'On Hold' },
  { key: 'completed',   label: 'Completed' },
];

function renderKanban() {
  const board = document.getElementById('kanban-board');
  const grouped = {};
  KANBAN_COLS.forEach(c => { grouped[c.key] = []; });
  state.tasks.forEach(t => {
    if (grouped[t.status] !== undefined) grouped[t.status].push(t);
    else grouped['not_started'].push(t);
  });

  board.innerHTML = KANBAN_COLS.map(col => `
    <div class="kanban-col" data-col="${col.key}">
      <div class="kanban-col-header kcol-${col.key}">
        <h3>${col.label}</h3>
        <span class="count">${grouped[col.key].length}</span>
      </div>
      <div class="kanban-cards" id="kcol-${col.key}"
           ondragover="event.preventDefault(); this.classList.add('drag-over')"
           ondragleave="this.classList.remove('drag-over')"
           ondrop="onDrop(event, '${col.key}')">
        ${grouped[col.key].map(kanbanCard).join('')}
        ${grouped[col.key].length === 0 ? '<div class="drop-zone"></div>' : ''}
      </div>
    </div>
  `).join('');
}

function kanbanCard(t) {
  return `
    <div class="kanban-card" draggable="true"
         data-id="${t.id}"
         ondragstart="onDragStart(event, ${t.id})"
         ondragend="event.target.classList.remove('dragging')"
         onclick="openDrawer(${t.id})">
      <div class="kc-title">${t.title}</div>
      <div class="kc-meta">
        <div class="kc-assignee">
          ${t.assignee_name ? `<span class="kc-avatar">${initials(t.assignee_name)}</span><span>${firstWord(t.assignee_name)}</span>` : '<span style="color:var(--text-3)">Unassigned</span>'}
        </div>
        <div>
          ${t.is_critical ? '<span class="badge badge-red" style="font-size:10px">CP</span>' : ''}
          <span style="color:var(--text-3)">${fmtShort(t.end_date) || ''}</span>
        </div>
      </div>
      ${t.percent_complete > 0 ? `<div class="progress-bar" style="margin-top:6px"><div class="fill" style="width:${t.percent_complete}%"></div></div>` : ''}
    </div>`;
}

let draggedId = null;
function onDragStart(e, id) {
  draggedId = id;
  e.target.classList.add('dragging');
}
async function onDrop(e, newStatus) {
  e.currentTarget.classList.remove('drag-over');
  if (!draggedId) return;
  const t = state.tasks.find(x => x.id === draggedId);
  if (!t || t.status === newStatus) return;
  try {
    await API.put(`/api/tasks/${draggedId}`, { status: newStatus });
    await refreshTasks();
    renderKanban();
  } catch(err) { toast(err.message, 'error'); }
  draggedId = null;
}

// ── Resources View ────────────────────────────────────────────────────────────
async function renderResources() {
  const view = document.getElementById('resources-view');
  view.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

  const today   = new Date().toISOString().slice(0,10);
  const end30   = new Date(Date.now() + 30*86400000).toISOString().slice(0,10);

  try {
    const util = await API.get(`/api/projects/${PID}/resource-utilization?start=${today}&end=${end30}`);
    const userMap = {};
    state.users.forEach(u => { userMap[u.id] = u; });

    // Compute average utilization per user
    const userUtil = {};
    Object.entries(util).forEach(([uid, dayMap]) => {
      const vals = Object.values(dayMap);
      userUtil[uid] = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;
    });

    const rows = state.users.filter(u => state.tasks.some(t => t.assignee_id === u.id)).map(u => {
      const avg = userUtil[u.id] || 0;
      const barClass = avg > 100 ? 'over' : avg > 80 ? 'warn' : '';
      const taskCount = state.tasks.filter(t => t.assignee_id === u.id && t.status !== 'completed').length;
      return `<tr>
        <td>
          <div class="flex items-center gap-8">
            <span class="kc-avatar" style="width:28px;height:28px;font-size:12px">${initials(u.name)}</span>
            <div>
              <div style="font-weight:500">${u.name}</div>
              <div class="text-sm text-muted">${roleLabel(u.role)}</div>
            </div>
          </div>
        </td>
        <td>${taskCount} active</td>
        <td style="width:180px">
          <div class="util-bar"><div class="util-fill ${barClass}" style="width:${Math.min(avg,100)}%"></div></div>
        </td>
        <td>${Math.round(avg)}%</td>
        <td>${avg > 100 ? '<span class="badge badge-red">Overloaded</span>' : avg > 80 ? '<span class="badge badge-yellow">High Load</span>' : '<span class="badge badge-green">OK</span>'}</td>
      </tr>`;
    }).join('');

    view.innerHTML = `
      <div class="section-title" style="margin-bottom:12px">Resource Utilization — Next 30 Days</div>
      <div class="card" style="margin-bottom:20px">
        <div class="card-body" style="padding:0">
          <table class="data-table resource-table">
            <thead><tr><th>Member</th><th>Tasks</th><th style="width:180px">Allocation</th><th>Avg %</th><th>Status</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-3)">No assigned resources</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <div class="text-sm text-muted">Allocation % = percentage of working time allocated across all tasks in the next 30 days. &gt;100% = overloaded.</div>
    `;
  } catch(e) {
    view.innerHTML = `<div class="empty-state"><p>Could not load resource data: ${e.message}</p></div>`;
  }
}

function roleLabel(r) {
  return { vp:'VP R&D', pm:'Project Manager', lead:'Team Lead', member:'Team Member' }[r] || r;
}
function firstWord(s) { return s ? s.split(' ')[0] : ''; }
