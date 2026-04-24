"""
Scheduling engine: all dependency resolution and critical path logic lives here.
Frontend only renders; backend computes all dates.
"""
from collections import defaultdict, deque
from datetime import date, timedelta


def topological_sort(task_ids, edges):
    """Kahn's algorithm. Returns ordered list or None if cycle detected."""
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

    return order if len(order) == len(task_ids) else None


def compute_scheduled_dates(tasks_dict, dependencies):
    """
    Forward pass: derive earliest start/end for every task based on dependencies.

    tasks_dict: {id: {start_date: date, end_date: date, duration_days: int, ...}}
    dependencies: [{predecessor_id, successor_id, dep_type, lag_days}]
    Returns: {task_id: {computed_start: date, computed_end: date}}
    """
    edges = [(d['predecessor_id'], d['successor_id']) for d in dependencies]
    order = topological_sort(list(tasks_dict.keys()), edges)
    if order is None:
        return {}  # cycle — return empty, caller handles

    dep_by_succ = defaultdict(list)
    for d in dependencies:
        dep_by_succ[d['successor_id']].append(d)

    computed = {}
    for tid in order:
        task = tasks_dict[tid]
        duration = max(task.get('duration_days') or 1, 1)
        preds = dep_by_succ[tid]

        if not preds:
            start = task.get('start_date')
            computed[tid] = {
                'computed_start': start,
                'computed_end': (start + timedelta(days=duration - 1)) if start else None,
            }
            continue

        earliest = None
        for dep in preds:
            pid = dep['predecessor_id']
            dtype = dep.get('dep_type', 'FS')
            lag = dep.get('lag_days', 0) or 0
            pc = computed.get(pid, {})
            ps = pc.get('computed_start') or tasks_dict[pid].get('start_date')
            pe = pc.get('computed_end') or tasks_dict[pid].get('end_date')

            if dtype == 'FS':
                candidate = (pe + timedelta(days=1 + lag)) if pe else None
            elif dtype == 'SS':
                candidate = (ps + timedelta(days=lag)) if ps else None
            elif dtype == 'FF':
                candidate = (pe + timedelta(days=lag - duration + 1)) if pe else None
            elif dtype == 'SF':
                candidate = (ps + timedelta(days=lag - duration + 1)) if ps else None
            else:
                candidate = None

            if candidate and (earliest is None or candidate > earliest):
                earliest = candidate

        if earliest is None:
            earliest = task.get('start_date')

        computed[tid] = {
            'computed_start': earliest,
            'computed_end': (earliest + timedelta(days=duration - 1)) if earliest else None,
        }

    return computed


def find_critical_path(tasks_dict, dependencies, project_end):
    """
    Returns set of task ids that lie on the critical path (total float == 0).
    """
    computed = compute_scheduled_dates(tasks_dict, dependencies)
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
        task = tasks_dict[tid]
        duration = max(task.get('duration_days') or 1, 1)
        succs = dep_by_pred[tid]

        if not succs:
            lf = project_end
            ls = lf - timedelta(days=duration - 1)
        else:
            lf = None
            for dep in succs:
                sid = dep['successor_id']
                dtype = dep.get('dep_type', 'FS')
                lag = dep.get('lag_days', 0) or 0
                sl = latest.get(sid, {})
                sls = sl.get('ls')
                slf = sl.get('lf')

                if dtype == 'FS':
                    cand_lf = (sls - timedelta(days=1 + lag)) if sls else None
                elif dtype == 'SS':
                    cand_lf = (sls - timedelta(days=lag) + timedelta(days=duration - 1)) if sls else None
                elif dtype == 'FF':
                    cand_lf = (slf - timedelta(days=lag)) if slf else None
                elif dtype == 'SF':
                    cand_lf = (slf - timedelta(days=lag) + timedelta(days=duration - 1)) if slf else None
                else:
                    cand_lf = None

                if cand_lf and (lf is None or cand_lf < lf):
                    lf = cand_lf

            if lf is None:
                lf = project_end
            ls = lf - timedelta(days=duration - 1)

        latest[tid] = {'lf': lf, 'ls': ls}

    critical = set()
    for tid in tasks_dict:
        es = computed.get(tid, {}).get('computed_start')
        ls = latest.get(tid, {}).get('ls')
        if es and ls and (ls - es).days == 0:
            critical.add(tid)

    return critical


def compute_resource_utilization(tasks_list, range_start, range_end):
    """
    Returns {user_id: {date_str: percent}} for overload detection.
    tasks_list: list of dicts with assignee_id, start_date, end_date, allocation_percent
    """
    util = defaultdict(lambda: defaultdict(float))
    for task in tasks_list:
        uid = task.get('assignee_id')
        ts = task.get('start_date')
        te = task.get('end_date')
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


def run_full_schedule(project_id):
    """
    Re-compute and persist scheduled dates + critical path for all tasks in a project.
    Call this after any task/dependency change.
    """
    from models import Task, Dependency, Project
    from database import db

    project = Project.query.get(project_id)
    if not project:
        return

    tasks = Task.query.filter_by(project_id=project_id).all()
    deps = (Dependency.query
            .join(Task, Dependency.predecessor_id == Task.id)
            .filter(Task.project_id == project_id)
            .all())

    tasks_dict = {t.id: {
        'start_date': t.start_date,
        'end_date': t.end_date,
        'duration_days': t.duration_days or 1,
    } for t in tasks}

    dep_list = [{'predecessor_id': d.predecessor_id,
                 'successor_id': d.successor_id,
                 'dep_type': d.dep_type,
                 'lag_days': d.lag_days or 0} for d in deps]

    computed = compute_scheduled_dates(tasks_dict, dep_list)
    project_end = project.target_date or date.today()
    critical = find_critical_path(tasks_dict, dep_list, project_end)

    for t in tasks:
        c = computed.get(t.id, {})
        t.computed_start = c.get('computed_start')
        t.computed_end = c.get('computed_end')
        t.is_critical = t.id in critical

    db.session.commit()
