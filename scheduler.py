"""
Scheduling engine — dependency cascade, critical path, delay impact.

════════════════════════════════════════════════════════════════════════════════
ALGORITHM OVERVIEW
════════════════════════════════════════════════════════════════════════════════

Every time a task is created, updated, or deleted, run_full_schedule() is
called automatically. It does three things in order:

────────────────────────────────────────────────────────────────────────────────
STEP 1 · TOPOLOGICAL SORT  (Kahn's BFS algorithm)
────────────────────────────────────────────────────────────────────────────────
The dependency graph is a Directed Acyclic Graph (DAG): tasks are nodes,
dependencies are directed edges (predecessor → successor).

Kahn's algorithm works by repeatedly removing nodes with no incoming edges:

  1. Count in-degree (number of predecessors) for every task.
  2. Seed a queue with all tasks that have zero predecessors.
  3. Pop a task, append it to the sorted order, reduce in-degree of its
     successors by 1, and enqueue any that drop to zero.
  4. If the final order contains every task → valid DAG.
     If not → cycle detected; return None (caller skips scheduling).

Result: a linear sequence where every predecessor appears before its successors.

────────────────────────────────────────────────────────────────────────────────
STEP 2 · STATUS-AWARE FORWARD PASS  (compute_scheduled_dates)
────────────────────────────────────────────────────────────────────────────────
Walk tasks in topological order. For each task compute:
  • computed_start — the earliest date it can begin
  • computed_end   — the realistic date it will finish

For tasks with NO predecessors:
  computed_start = task.start_date
  computed_end   = effective_end_date(task, today)

For tasks WITH predecessors:
  For every predecessor P, compute a "candidate start" for this task based on
  the dependency type and any lag:

    FS (Finish-to-Start) [DEFAULT]:
        candidate_start = P.computed_end + 1 day + lag
        "This task cannot begin until P has finished."

    SS (Start-to-Start):
        candidate_start = P.computed_start + lag
        "Both tasks can run in parallel from the same point."

    FF (Finish-to-Finish):
        candidate_start = P.computed_end + lag − duration + 1
        "Both tasks must finish at roughly the same time."

    SF (Start-to-Finish):
        candidate_start = P.computed_start + lag − duration + 1
        "Rare: successor must finish before predecessor starts."

  computed_start = MAX(all candidate starts across all predecessors)
  computed_end   = effective_end_date(task with new start, today)

WHY effective_end_date MATTERS (the cascade mechanism):
  The classic mistake is using the stored `end_date` for predecessors. That
  only reflects the original plan. effective_end_date looks at the task's
  CURRENT STATE and returns the date it will ACTUALLY finish:

    • completed          → stored end_date (done is done; successors unaffected)
    • in_progress 60%    → today + ceil(duration × 40%) days remaining
                           e.g., 10-day task, 60% done → 4 more days → end = today+3
    • blocked / on_hold  → today + all remaining work (no progress being made)
    • not_started, overdue start → assumes it starts TODAY; end = today + duration−1
    • not_started, future start  → planned end = start_date + duration−1

  This means: if Task A (10 days, 50% done) slips, its computed_end shifts to
  today+4. Task B (FS on A) gets computed_start = today+5. Task C (FS on B)
  cascades further. The ENTIRE downstream chain shifts automatically, in one
  pass, every time the schedule is recomputed.

────────────────────────────────────────────────────────────────────────────────
STEP 3 · BACKWARD PASS → TOTAL FLOAT → CRITICAL PATH  (find_critical_path)
────────────────────────────────────────────────────────────────────────────────
Walk tasks in REVERSE topological order. For each task compute:
  • latest_finish (LF) — latest it can finish without delaying the project
  • latest_start  (LS) — latest it can start   (LS = LF − duration + 1)

For tasks with NO successors:
  LF = project.target_date  (the hard deadline)

For tasks WITH successors:
  Mirror of the forward pass: for each successor S, compute the constraint it
  places on this task's LF, then take the MINIMUM across all successors.

Total Float = Latest Start − Earliest Start
  Float == 0 → task is on the CRITICAL PATH.
  Any delay to a critical task directly delays the project end date.
  Delaying a non-critical task by ≤ float days has no project impact.

────────────────────────────────────────────────────────────────────────────────
DELAY IMPACT SIMULATION  (compute_delay_impact)
────────────────────────────────────────────────────────────────────────────────
Given a task and a hypothetical delay of N extra days, this function returns
{task_id: days_slipped} for every downstream task that would be affected.

It works by:
  1. Cloning the tasks_dict and adding N days to the delayed task's duration.
  2. Running the forward pass twice — with and without the extra days.
  3. Diffing computed_start for every downstream task.

Use this BEFORE confirming a date change to show the user the ripple effect.
════════════════════════════════════════════════════════════════════════════════
"""

import copy
import math
from collections import defaultdict, deque
from datetime import date, timedelta


# ── Topological sort ──────────────────────────────────────────────────────────

def topological_sort(task_ids, edges):
    """
    Kahn's BFS algorithm.
    Returns a list of task_ids in dependency order, or None if a cycle exists.
    """
    in_degree = {t: 0 for t in task_ids}
    adj = defaultdict(list)
    for pred, succ in edges:
        if pred in in_degree and succ in in_degree:
            adj[pred].append(succ)
            in_degree[succ] += 1

    queue = deque(t for t in task_ids if in_degree[t] == 0)
    order = []
    while queue:
        node = queue.popleft()
        order.append(node)
        for nb in adj[node]:
            in_degree[nb] -= 1
            if in_degree[nb] == 0:
                queue.append(nb)

    return order if len(order) == len(task_ids) else None  # None = cycle


# ── Status-aware realistic end date ───────────────────────────────────────────

def effective_end_date(task_state, today):
    """
    Return the date this task will realistically finish, given its current state.

    This is the core of the cascade mechanism: downstream tasks plan their start
    around this date, not the original scheduled end_date.

    task_state keys used: status, percent_complete, duration_days,
                          start_date, end_date, computed_start, computed_end
    """
    status  = task_state.get('status') or 'not_started'
    pct     = float(task_state.get('percent_complete') or 0)
    dur     = max(int(task_state.get('duration_days') or 1), 1)
    c_start = task_state.get('computed_start') or task_state.get('start_date')
    c_end   = task_state.get('computed_end')   or task_state.get('end_date')

    if status == 'completed':
        # Done is done — successors can proceed from this date unchanged.
        return c_end or c_start

    # Remaining work in calendar days (ceiling so we don't under-estimate).
    remaining = max(1, math.ceil(dur * (1.0 - pct / 100.0)))

    if status in ('in_progress', 'blocked', 'on_hold'):
        # For in_progress: remaining work starts today.
        # For blocked/on_hold: no progress is being made; treat same way
        # (the slip accumulates each day we recompute).
        return today + timedelta(days=remaining - 1)

    # not_started
    if c_start and c_start <= today:
        # Overdue start: assume the task begins today.
        return today + timedelta(days=dur - 1)

    # Future start: plan is still valid.
    return (c_start + timedelta(days=dur - 1)) if c_start else c_end


# ── Forward pass ─────────────────────────────────────────────────────────────

def compute_scheduled_dates(tasks_dict, dependencies, today=None):
    """
    Status-aware forward pass: compute (computed_start, computed_end) for every
    task, cascading delays through all dependency types.

    tasks_dict  : {id: {start_date, end_date, duration_days, status,
                         percent_complete, ...}}
    dependencies: [{predecessor_id, successor_id, dep_type, lag_days}]
    today       : date override for testing; defaults to date.today()

    Returns: {task_id: {computed_start: date|None, computed_end: date|None}}
    """
    if today is None:
        today = date.today()

    edges = [(d['predecessor_id'], d['successor_id']) for d in dependencies]
    order = topological_sort(list(tasks_dict.keys()), edges)
    if order is None:
        return {}  # cycle detected — caller should surface an error

    dep_by_succ = defaultdict(list)
    for d in dependencies:
        dep_by_succ[d['successor_id']].append(d)

    computed = {}

    for tid in order:
        task  = tasks_dict[tid]
        dur   = max(int(task.get('duration_days') or 1), 1)
        preds = dep_by_succ[tid]

        if not preds:
            # Root task — use its own planned start date.
            start = task.get('start_date')
            c_end = effective_end_date(
                {**task, 'computed_start': start, 'computed_end': None},
                today
            ) if start else None
            computed[tid] = {'computed_start': start, 'computed_end': c_end}
            continue

        # Collect earliest-start candidates from all predecessors.
        earliest = None
        for dep in preds:
            pid   = dep['predecessor_id']
            dtype = dep.get('dep_type', 'FS')
            lag   = int(dep.get('lag_days') or 0)

            pc  = computed.get(pid, {})
            # Use the cascade-propagated dates from the forward pass (already computed
            # because we process in topological order).
            ps  = pc.get('computed_start') or tasks_dict[pid].get('start_date')
            pe  = pc.get('computed_end')   or effective_end_date(
                {**tasks_dict[pid], 'computed_start': ps},
                today,
            )

            if dtype == 'FS':
                # Successor starts the day after predecessor finishes (+lag).
                candidate = (pe + timedelta(days=1 + lag)) if pe else None
            elif dtype == 'SS':
                # Successor starts when predecessor starts (+lag).
                candidate = (ps + timedelta(days=lag)) if ps else None
            elif dtype == 'FF':
                # Successor must finish when predecessor finishes; back-calculate start.
                candidate = (pe + timedelta(days=lag - dur + 1)) if pe else None
            elif dtype == 'SF':
                # Rare: successor finishes when predecessor starts.
                candidate = (ps + timedelta(days=lag - dur + 1)) if ps else None
            else:
                candidate = None

            if candidate and (earliest is None or candidate > earliest):
                earliest = candidate

        # Task's own start_date is a lower-bound constraint: the task cannot start
        # before its planned start even if all predecessors finish earlier.
        own_start = task.get('start_date')
        if own_start and (earliest is None or own_start > earliest):
            earliest = own_start

        c_end = effective_end_date(
            {**task, 'computed_start': earliest, 'computed_end': None},
            today,
        ) if earliest else None

        computed[tid] = {'computed_start': earliest, 'computed_end': c_end}

    return computed


# ── Backward pass → Critical Path ─────────────────────────────────────────────

def find_critical_path(tasks_dict, dependencies, project_end, today=None):
    """
    Returns the set of task IDs on the critical path (total float == 0).

    The critical path is the longest chain of dependent tasks.  Any slip on a
    critical task directly extends the project end date.
    """
    if today is None:
        today = date.today()

    computed = compute_scheduled_dates(tasks_dict, dependencies, today)
    if not computed:
        return set()

    edges = [(d['predecessor_id'], d['successor_id']) for d in dependencies]
    order = topological_sort(list(tasks_dict.keys()), edges)
    if not order:
        return set()

    dep_by_pred = defaultdict(list)
    for d in dependencies:
        dep_by_pred[d['predecessor_id']].append(d)

    latest = {}
    for tid in reversed(order):
        dur   = max(int(tasks_dict[tid].get('duration_days') or 1), 1)
        succs = dep_by_pred[tid]

        if not succs:
            lf = project_end
            ls = lf - timedelta(days=dur - 1)
        else:
            lf = None
            for dep in succs:
                sid   = dep['successor_id']
                dtype = dep.get('dep_type', 'FS')
                lag   = int(dep.get('lag_days') or 0)
                sl    = latest.get(sid, {})
                sls   = sl.get('ls')
                slf   = sl.get('lf')

                if dtype == 'FS':
                    cand = (sls - timedelta(days=1 + lag)) if sls else None
                elif dtype == 'SS':
                    cand = (sls - timedelta(days=lag) + timedelta(days=dur - 1)) if sls else None
                elif dtype == 'FF':
                    cand = (slf - timedelta(days=lag)) if slf else None
                elif dtype == 'SF':
                    cand = (slf - timedelta(days=lag) + timedelta(days=dur - 1)) if slf else None
                else:
                    cand = None

                if cand and (lf is None or cand < lf):
                    lf = cand

            if lf is None:
                lf = project_end
            ls = lf - timedelta(days=dur - 1)

        latest[tid] = {'lf': lf, 'ls': ls}

    critical = set()
    for tid in tasks_dict:
        es = computed.get(tid, {}).get('computed_start')
        ls = latest.get(tid, {}).get('ls')
        if es and ls and (ls - es).days == 0:
            critical.add(tid)

    return critical


# ── Delay impact simulation ────────────────────────────────────────────────────

def compute_delay_impact(tasks_dict, dependencies, delayed_task_id, extra_days, today=None):
    """
    Simulate adding `extra_days` to a task and return the ripple effect.

    Returns: {task_id: days_slipped} for every downstream task that moves.

    Use this BEFORE persisting a change to warn the user:
        "Delaying Task A by 5 days will push Task B by 5 days and Task C by 3 days."
    """
    if today is None:
        today = date.today()
    if extra_days <= 0 or delayed_task_id not in tasks_dict:
        return {}

    # Compute baseline schedule
    baseline = compute_scheduled_dates(tasks_dict, dependencies, today)

    # Clone and extend the delayed task
    modified = copy.deepcopy(tasks_dict)
    t = modified[delayed_task_id]
    t['duration_days'] = (t.get('duration_days') or 1) + extra_days
    if t.get('end_date'):
        t['end_date'] = t['end_date'] + timedelta(days=extra_days)

    # Compute shifted schedule
    shifted = compute_scheduled_dates(modified, dependencies, today)

    impact = {}
    for tid, s_sched in shifted.items():
        if tid == delayed_task_id:
            continue
        b_start = baseline.get(tid, {}).get('computed_start')
        s_start = s_sched.get('computed_start')
        if b_start and s_start and s_start > b_start:
            impact[tid] = (s_start - b_start).days

    return impact


# ── Resource utilization ──────────────────────────────────────────────────────

def compute_resource_utilization(tasks_list, range_start, range_end):
    """
    Returns {user_id: {date_str: percent}} for overload detection.
    tasks_list: [{assignee_id, start_date, end_date, allocation_percent}]
    """
    util = defaultdict(lambda: defaultdict(float))
    for task in tasks_list:
        uid = task.get('assignee_id')
        ts  = task.get('start_date')
        te  = task.get('end_date')
        if not uid or not ts or not te:
            continue
        ts = max(ts, range_start)
        te = min(te, range_end)
        if ts > te:
            continue
        pct = task.get('allocation_percent', 100) or 100
        cur = ts
        while cur <= te:
            util[uid][cur.isoformat()] += pct
            cur += timedelta(days=1)
    return {k: dict(v) for k, v in util.items()}


# ── Orchestrator ──────────────────────────────────────────────────────────────

def run_full_schedule(project_id, today=None):
    """
    Recompute and persist computed_start, computed_end, and is_critical for
    every task in the project.  Call after any task or dependency mutation.
    """
    from models import Task, Dependency, Project
    from database import db

    if today is None:
        today = date.today()

    project = Project.query.get(project_id)
    if not project:
        return

    tasks = Task.query.filter_by(project_id=project_id).all()
    deps  = (Dependency.query
             .join(Task, Dependency.predecessor_id == Task.id)
             .filter(Task.project_id == project_id)
             .all())

    # Include status + percent_complete so effective_end_date can cascade delays.
    tasks_dict = {t.id: {
        'start_date':       t.start_date,
        'end_date':         t.end_date,
        'duration_days':    t.duration_days or 1,
        'status':           t.status,
        'percent_complete': float(t.percent_complete or 0),
    } for t in tasks}

    dep_list = [{
        'predecessor_id': d.predecessor_id,
        'successor_id':   d.successor_id,
        'dep_type':       d.dep_type,
        'lag_days':       d.lag_days or 0,
    } for d in deps]

    computed = compute_scheduled_dates(tasks_dict, dep_list, today)
    project_end = project.target_date or today
    critical    = find_critical_path(tasks_dict, dep_list, project_end, today)

    # ── Parent/phase task date rollup (bottom-up, post-order) ────────────────
    # A parent (phase/summary) task's span is purely derived from its children:
    #   Parent.computed_start = MIN(child.computed_start)
    #   Parent.computed_end   = MAX(child.computed_end)
    # We compute depth for every task, then process tasks in DECREASING depth
    # order so that all children are finalized before their parent is evaluated.
    # This lets parent dates BOTH grow and shrink as child dates change.
    task_map = {t.id: t for t in tasks}
    children_of = defaultdict(list)
    for t in tasks:
        if t.parent_task_id and t.parent_task_id in task_map:
            children_of[t.parent_task_id].append(t.id)

    def depth_of(tid, _cache={}):
        if tid in _cache:
            return _cache[tid]
        t = task_map.get(tid)
        if not t or not t.parent_task_id or t.parent_task_id not in task_map:
            _cache[tid] = 0
        else:
            _cache[tid] = 1 + depth_of(t.parent_task_id)
        return _cache[tid]

    # Deepest tasks first → their parents next → grandparents last.
    for t in sorted(tasks, key=lambda x: depth_of(x.id), reverse=True):
        kids = children_of.get(t.id)
        if not kids:
            continue
        child_starts = [computed[k]['computed_start'] for k in kids
                        if computed.get(k, {}).get('computed_start')]
        child_ends   = [computed[k]['computed_end']   for k in kids
                        if computed.get(k, {}).get('computed_end')]
        if child_starts and child_ends:
            computed[t.id] = {
                'computed_start': min(child_starts),
                'computed_end':   max(child_ends),
            }

    for t in tasks:
        c = computed.get(t.id, {})
        t.computed_start = c.get('computed_start')
        t.computed_end   = c.get('computed_end')
        t.is_critical    = t.id in critical

    # Auto-update project forecast date to the latest task end in the project.
    all_ends = [c.get('computed_end') for c in computed.values() if c.get('computed_end')]
    if all_ends:
        project.current_forecast_date = max(all_ends)

    db.session.commit()
