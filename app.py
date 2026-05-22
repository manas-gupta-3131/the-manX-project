"""
Flask application entry point. All API routes live here.
Auth: session-based via flask-login.
"""
from datetime import date, datetime
from functools import wraps

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from flask_login import (LoginManager, current_user, login_required,
                         login_user, logout_user)

from database import db
from models import (Allocation, Approval, AuditLog, Dependency, Project,
                    ProjectAccess, Task, Team, User)
from scheduler import (compute_delay_impact, compute_resource_utilization,
                       find_critical_path, run_full_schedule)


def create_app(config=None):
    app = Flask(__name__)
    app.config['SECRET_KEY'] = 'change-me-in-production'
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///pm.db'
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

    if config:
        app.config.update(config)

    db.init_app(app)

    login_manager = LoginManager(app)
    login_manager.login_view = 'login_page'

    @login_manager.user_loader
    def load_user(uid):
        return User.query.get(int(uid))

    with app.app_context():
        db.create_all()
        # Additive migration: add is_admin column if the users table predates it.
        # SQLite supports ALTER TABLE ADD COLUMN only when a DEFAULT is provided.
        from sqlalchemy import text
        with db.engine.connect() as _conn:
            try:
                _conn.execute(text('ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0'))
                _conn.commit()
            except Exception:
                pass  # column already exists — safe to ignore

        # Bootstrap: if no admin exists yet, promote the first VP (or first user).
        if not User.query.filter_by(is_admin=True).first():
            first_admin = (User.query.filter_by(role='vp').first()
                           or User.query.order_by(User.id).first())
            if first_admin:
                first_admin.is_admin = True
                db.session.commit()

        # Auto-seed demo data on first run (empty database).
        if User.query.count() == 0:
            from db_seed import seed_db
            seed_db()

    # ── helpers ──────────────────────────────────────────────────────────────

    def role_required(*roles):
        def decorator(f):
            @wraps(f)
            def wrapped(*args, **kwargs):
                if not current_user.is_authenticated:
                    return jsonify({'error': 'Authentication required'}), 401
                if current_user.role not in roles:
                    return jsonify({'error': 'Insufficient permissions'}), 403
                return f(*args, **kwargs)
            return wrapped
        return decorator

    def _audit(entity_type, entity_id, field, old, new):
        db.session.add(AuditLog(
            actor_id=current_user.id if current_user.is_authenticated else None,
            entity_type=entity_type,
            entity_id=entity_id,
            field_changed=field,
            old_value=str(old) if old is not None else None,
            new_value=str(new) if new is not None else None,
        ))

    def _parse_date(val):
        if not val:
            return None
        if isinstance(val, date):
            return val
        return date.fromisoformat(val)

    # ── html pages ───────────────────────────────────────────────────────────

    @app.route('/')
    def index():
        if current_user.is_authenticated:
            return redirect('/dashboard')
        return redirect('/login')

    @app.route('/login')
    def login_page():
        if current_user.is_authenticated:
            return redirect('/dashboard')
        return render_template('login.html')

    @app.route('/dashboard')
    @login_required
    def dashboard_page():
        return render_template('dashboard.html')

    @app.route('/projects/<int:pid>')
    @login_required
    def project_page(pid):
        project = Project.query.get_or_404(pid)
        return render_template('project.html', project_id=pid, project_name=project.name)

    # ── gantt data ────────────────────────────────────────────────────────────

    @app.route('/api/projects/<int:pid>/gantt-data', methods=['GET'])
    @login_required
    def gantt_data(pid):
        Project.query.get_or_404(pid)
        tasks = (Task.query.filter_by(project_id=pid)
                 .order_by(Task.display_order, Task.id).all())
        deps = (Dependency.query
                .join(Task, Dependency.predecessor_id == Task.id)
                .filter(Task.project_id == pid).all())

        dep_map = {}
        for d in deps:
            dep_map.setdefault(d.successor_id, []).append(str(d.predecessor_id))

        from datetime import timedelta
        result = []
        for t in tasks:
            start = t.computed_start or t.start_date
            end = t.computed_end or t.end_date
            if not start:
                continue
            if not end:
                end = start + timedelta(days=(t.duration_days or 1) - 1)
            result.append({
                'id': str(t.id),
                'name': t.title,
                'start': start.isoformat(),
                'end': end.isoformat(),
                'progress': float(t.percent_complete or 0),
                'dependencies': ','.join(dep_map.get(t.id, [])),
                'custom_class': 'bar-critical' if t.is_critical else '',
                'task_type': t.task_type,
                'wbs': t.wbs_number or '',
                'assignee': t.assignee.name if t.assignee else '',
                'assignee_id': t.assignee_id,
                'parent_task_id': t.parent_task_id,
                'is_milestone': t.is_milestone,
                'status': t.status,
                'duration_days': t.duration_days or 1,
            })
        return jsonify(result)

    # ── auth ─────────────────────────────────────────────────────────────────

    @app.route('/api/auth/login', methods=['POST'])
    def auth_login():
        data = request.get_json() or {}
        user = User.query.filter_by(email=data.get('email', '').lower()).first()
        if not user or not user.check_password(data.get('password', '')):
            return jsonify({'error': 'Invalid credentials'}), 401
        login_user(user, remember=data.get('remember', False))
        return jsonify(user.to_dict())

    @app.route('/api/auth/logout', methods=['POST'])
    @login_required
    def auth_logout():
        logout_user()
        return jsonify({'ok': True})

    @app.route('/api/auth/me', methods=['GET'])
    @login_required
    def auth_me():
        return jsonify(current_user.to_dict())

    @app.route('/api/auth/register', methods=['POST'])
    def auth_register():
        data = request.get_json() or {}
        email = (data.get('email') or '').lower()
        if not email or not data.get('name') or not data.get('password'):
            return jsonify({'error': 'name, email, and password are required'}), 400
        if User.query.filter_by(email=email).first():
            return jsonify({'error': 'Email already registered'}), 409
        role = data.get('role', 'member')
        if role not in ('vp', 'pm', 'lead', 'member'):
            return jsonify({'error': 'Invalid role'}), 400
        user = User(name=data['name'], email=email, role=role,
                    capacity_hours_per_day=data.get('capacity_hours_per_day', 8.0))
        user.set_password(data['password'])
        db.session.add(user)
        db.session.commit()
        login_user(user)
        return jsonify(user.to_dict()), 201

    @app.route('/api/auth/password', methods=['PUT'])
    @login_required
    def auth_change_password():
        data = request.get_json() or {}
        if not current_user.check_password(data.get('current_password', '')):
            return jsonify({'error': 'Current password incorrect'}), 400
        new_pw = data.get('new_password', '')
        if len(new_pw) < 8:
            return jsonify({'error': 'Password must be at least 8 characters'}), 400
        current_user.set_password(new_pw)
        db.session.commit()
        return jsonify({'ok': True})

    # ── users ─────────────────────────────────────────────────────────────────

    @app.route('/api/users', methods=['GET'])
    @login_required
    def list_users():
        users = User.query.order_by(User.name).all()
        return jsonify([u.to_dict() for u in users])

    @app.route('/api/users/<int:uid>', methods=['GET'])
    @login_required
    def get_user(uid):
        user = User.query.get_or_404(uid)
        return jsonify(user.to_dict())

    @app.route('/api/users/<int:uid>', methods=['PUT'])
    @login_required
    def update_user(uid):
        if current_user.id != uid and current_user.role not in ('vp',):
            return jsonify({'error': 'Forbidden'}), 403
        user = User.query.get_or_404(uid)
        data = request.get_json() or {}
        for field in ('name', 'capacity_hours_per_day', 'team_id'):
            if field in data:
                setattr(user, field, data[field])
        if 'role' in data and current_user.role == 'vp':
            user.role = data['role']
        db.session.commit()
        return jsonify(user.to_dict())

    # ── teams ─────────────────────────────────────────────────────────────────

    @app.route('/api/teams', methods=['GET'])
    @login_required
    def list_teams():
        return jsonify([t.to_dict() for t in Team.query.order_by(Team.name).all()])

    @app.route('/api/teams', methods=['POST'])
    @login_required
    @role_required('vp', 'pm')
    def create_team():
        data = request.get_json() or {}
        if not data.get('name'):
            return jsonify({'error': 'name is required'}), 400
        team = Team(name=data['name'], lead_id=data.get('lead_id'),
                    parent_team_id=data.get('parent_team_id'),
                    description=data.get('description'))
        db.session.add(team)
        db.session.commit()
        return jsonify(team.to_dict()), 201

    @app.route('/api/teams/<int:tid>', methods=['PUT'])
    @login_required
    @role_required('vp', 'pm')
    def update_team(tid):
        team = Team.query.get_or_404(tid)
        data = request.get_json() or {}
        for field in ('name', 'lead_id', 'parent_team_id', 'description'):
            if field in data:
                setattr(team, field, data[field])
        db.session.commit()
        return jsonify(team.to_dict())

    @app.route('/api/teams/<int:tid>', methods=['DELETE'])
    @login_required
    @role_required('vp')
    def delete_team(tid):
        team = Team.query.get_or_404(tid)
        db.session.delete(team)
        db.session.commit()
        return jsonify({'ok': True})

    # ── projects ──────────────────────────────────────────────────────────────

    @app.route('/api/projects', methods=['GET'])
    @login_required
    def list_projects():
        """
        Visibility rules (additive — any matching rule grants access):
          admin / vp  → all projects
          pm          → projects they own  OR  admin-granted
          lead        → projects where their team has ≥1 task  OR  admin-granted
          member      → admin-granted only
        """
        if current_user.is_admin or current_user.role == 'vp':
            projects = Project.query.order_by(Project.updated_at.desc()).all()

        elif current_user.role == 'pm':
            granted_pids = (db.session.query(ProjectAccess.project_id)
                            .filter_by(user_id=current_user.id))
            projects = (Project.query
                        .filter((Project.owner_id == current_user.id) |
                                Project.id.in_(granted_pids))
                        .order_by(Project.updated_at.desc()).all())

        elif current_user.role == 'lead':
            # teams this user leads → projects that have at least one task in those teams
            lead_team_ids = (db.session.query(Team.id)
                             .filter_by(lead_id=current_user.id))
            team_pids = (db.session.query(Task.project_id)
                         .filter(Task.team_id.in_(lead_team_ids)).distinct())
            granted_pids = (db.session.query(ProjectAccess.project_id)
                            .filter_by(user_id=current_user.id))
            projects = (Project.query
                        .filter(Project.id.in_(team_pids) |
                                Project.id.in_(granted_pids))
                        .order_by(Project.updated_at.desc()).all())

        else:  # member — only explicit admin grants
            granted_pids = (db.session.query(ProjectAccess.project_id)
                            .filter_by(user_id=current_user.id))
            projects = (Project.query
                        .filter(Project.id.in_(granted_pids))
                        .order_by(Project.updated_at.desc()).all())

        return jsonify([p.to_dict() for p in projects])

    @app.route('/api/projects/consolidation', methods=['GET'])
    @login_required
    def projects_consolidation():
        """
        Returns all projects the current user can see, formatted for the
        portfolio-level Gantt chart (one bar per project, no task dependencies).
        Uses the same visibility logic as list_projects.
        """
        if current_user.is_admin or current_user.role == 'vp':
            projects = Project.query.order_by(Project.start_date).all()
        elif current_user.role == 'pm':
            granted_pids = (db.session.query(ProjectAccess.project_id)
                            .filter_by(user_id=current_user.id))
            projects = (Project.query
                        .filter((Project.owner_id == current_user.id) |
                                Project.id.in_(granted_pids))
                        .order_by(Project.start_date).all())
        elif current_user.role == 'lead':
            lead_team_ids = (db.session.query(Team.id)
                             .filter_by(lead_id=current_user.id))
            team_pids = (db.session.query(Task.project_id)
                         .filter(Task.team_id.in_(lead_team_ids)).distinct())
            granted_pids = (db.session.query(ProjectAccess.project_id)
                            .filter_by(user_id=current_user.id))
            projects = (Project.query
                        .filter(Project.id.in_(team_pids) |
                                Project.id.in_(granted_pids))
                        .order_by(Project.start_date).all())
        else:
            granted_pids = (db.session.query(ProjectAccess.project_id)
                            .filter_by(user_id=current_user.id))
            projects = (Project.query
                        .filter(Project.id.in_(granted_pids))
                        .order_by(Project.start_date).all())

        today = date.today()
        result = []
        for p in projects:
            start = p.start_date
            # Use forecast if available and later than target, else use target
            end = p.current_forecast_date or p.target_date
            if not start or not end:
                # Skip projects with no dates — they can't be rendered on a Gantt
                continue
            pd = p.to_dict()
            result.append({
                'id':           str(p.id),
                'name':         p.name,
                'start':        start.isoformat(),
                'end':          end.isoformat(),
                'progress':     pd['progress'],
                'custom_class': f'proj-bar proj-{p.status}',
                'status':       p.status,
                'priority':     p.priority,
                'owner_name':   p.owner.name if p.owner else '',
                'npd_reference': p.npd_reference or '',
                'target_date':  p.target_date.isoformat() if p.target_date else None,
                'forecast_date': p.current_forecast_date.isoformat() if p.current_forecast_date else None,
                'is_breaching': bool(p.current_forecast_date and p.target_date and
                                     p.current_forecast_date > p.target_date),
                'task_count':   pd['task_count'],
                'completed_task_count': pd['completed_task_count'],
            })
        return jsonify(result)

    @app.route('/api/projects', methods=['POST'])
    @login_required
    @role_required('vp', 'pm')
    def create_project():
        data = request.get_json() or {}
        if not data.get('name'):
            return jsonify({'error': 'name is required'}), 400
        project = Project(
            name=data['name'],
            description=data.get('description'),
            owner_id=data.get('owner_id') or current_user.id,
            priority=data.get('priority', 'medium'),
            start_date=_parse_date(data.get('start_date')),
            target_date=_parse_date(data.get('target_date')),
            status=data.get('status', 'planning'),
            npd_reference=data.get('npd_reference'),
        )
        db.session.add(project)
        db.session.commit()
        return jsonify(project.to_dict()), 201

    @app.route('/api/projects/<int:pid>', methods=['GET'])
    @login_required
    def get_project(pid):
        return jsonify(Project.query.get_or_404(pid).to_dict())

    @app.route('/api/projects/<int:pid>', methods=['PUT'])
    @login_required
    @role_required('vp', 'pm')
    def update_project(pid):
        project = Project.query.get_or_404(pid)
        data = request.get_json() or {}
        date_fields = {'start_date', 'target_date', 'current_forecast_date'}
        scalar_fields = {'name', 'description', 'owner_id', 'priority', 'status', 'npd_reference'}
        for field in scalar_fields:
            if field in data:
                old = getattr(project, field)
                setattr(project, field, data[field])
                if old != data[field]:
                    _audit('project', pid, field, old, data[field])
        for field in date_fields:
            if field in data:
                new_val = _parse_date(data[field])
                old = getattr(project, field)
                setattr(project, field, new_val)
                if old != new_val:
                    _audit('project', pid, field, old, new_val)
        db.session.commit()
        return jsonify(project.to_dict())

    @app.route('/api/projects/<int:pid>', methods=['DELETE'])
    @login_required
    @role_required('vp', 'pm')
    def delete_project(pid):
        project = Project.query.get_or_404(pid)
        db.session.delete(project)
        db.session.commit()
        return jsonify({'ok': True})

    # ── tasks ─────────────────────────────────────────────────────────────────

    @app.route('/api/projects/<int:pid>/tasks', methods=['GET'])
    @login_required
    def list_tasks(pid):
        Project.query.get_or_404(pid)
        tasks = (Task.query.filter_by(project_id=pid)
                 .order_by(Task.display_order, Task.id).all())
        return jsonify([t.to_dict() for t in tasks])

    @app.route('/api/projects/<int:pid>/tasks', methods=['POST'])
    @login_required
    @role_required('vp', 'pm', 'lead')
    def create_task(pid):
        Project.query.get_or_404(pid)
        data = request.get_json() or {}
        if not data.get('title'):
            return jsonify({'error': 'title is required'}), 400
        task = Task(
            project_id=pid,
            parent_task_id=data.get('parent_task_id'),
            wbs_number=data.get('wbs_number'),
            title=data['title'],
            description=data.get('description'),
            assignee_id=data.get('assignee_id'),
            team_id=data.get('team_id'),
            start_date=_parse_date(data.get('start_date')),
            end_date=_parse_date(data.get('end_date')),
            duration_days=data.get('duration_days', 1),
            effort_days=data.get('effort_days'),
            percent_complete=data.get('percent_complete', 0),
            status=data.get('status', 'not_started'),
            task_type=data.get('task_type', 'task'),
            is_milestone=data.get('is_milestone', False),
            display_order=data.get('display_order', 0),
        )
        db.session.add(task)
        db.session.flush()
        db.session.commit()
        run_full_schedule(pid)
        return jsonify(task.to_dict()), 201

    @app.route('/api/tasks/<int:tid>', methods=['GET'])
    @login_required
    def get_task(tid):
        return jsonify(Task.query.get_or_404(tid).to_dict())

    @app.route('/api/tasks/<int:tid>', methods=['PUT'])
    @login_required
    @role_required('vp', 'pm', 'lead')
    def update_task(tid):
        task = Task.query.get_or_404(tid)
        data = request.get_json() or {}
        date_fields = {'start_date', 'end_date'}
        scalar_fields = {'title', 'description', 'assignee_id', 'team_id',
                         'duration_days', 'effort_days', 'percent_complete',
                         'status', 'task_type', 'is_milestone', 'display_order',
                         'wbs_number', 'parent_task_id'}
        for field in scalar_fields:
            if field in data:
                old = getattr(task, field)
                setattr(task, field, data[field])
                if old != data[field]:
                    _audit('task', tid, field, old, data[field])
        for field in date_fields:
            if field in data:
                new_val = _parse_date(data[field])
                old = getattr(task, field)
                setattr(task, field, new_val)
                if old != new_val:
                    _audit('task', tid, field, old, new_val)

        # members can update percent_complete on their own tasks
        if current_user.role == 'member':
            if task.assignee_id != current_user.id:
                return jsonify({'error': 'Forbidden'}), 403

        db.session.commit()
        run_full_schedule(task.project_id)
        return jsonify(task.to_dict())

    @app.route('/api/tasks/<int:tid>', methods=['DELETE'])
    @login_required
    @role_required('vp', 'pm', 'lead')
    def delete_task(tid):
        task = Task.query.get_or_404(tid)
        pid = task.project_id
        db.session.delete(task)
        db.session.commit()
        run_full_schedule(pid)
        return jsonify({'ok': True})

    # bulk reorder (display_order patch)
    @app.route('/api/projects/<int:pid>/tasks/reorder', methods=['POST'])
    @login_required
    @role_required('vp', 'pm', 'lead')
    def reorder_tasks(pid):
        """Body: [{id, display_order}]"""
        Project.query.get_or_404(pid)
        items = request.get_json() or []
        for item in items:
            Task.query.filter_by(id=item['id'], project_id=pid).update(
                {'display_order': item['display_order']})
        db.session.commit()
        return jsonify({'ok': True})

    # ── dependencies ──────────────────────────────────────────────────────────

    @app.route('/api/projects/<int:pid>/dependencies', methods=['GET'])
    @login_required
    def list_dependencies(pid):
        Project.query.get_or_404(pid)
        deps = (Dependency.query
                .join(Task, Dependency.predecessor_id == Task.id)
                .filter(Task.project_id == pid)
                .all())
        return jsonify([d.to_dict() for d in deps])

    @app.route('/api/dependencies', methods=['POST'])
    @login_required
    @role_required('vp', 'pm', 'lead')
    def create_dependency():
        data = request.get_json() or {}
        pred_id = data.get('predecessor_id')
        succ_id = data.get('successor_id')
        if not pred_id or not succ_id:
            return jsonify({'error': 'predecessor_id and successor_id required'}), 400
        if pred_id == succ_id:
            return jsonify({'error': 'Self-dependency not allowed'}), 400
        pred = Task.query.get_or_404(pred_id)
        Task.query.get_or_404(succ_id)
        dep = Dependency(
            predecessor_id=pred_id,
            successor_id=succ_id,
            dep_type=data.get('dep_type', 'FS'),
            lag_days=data.get('lag_days', 0),
        )
        db.session.add(dep)
        db.session.commit()
        run_full_schedule(pred.project_id)
        return jsonify(dep.to_dict()), 201

    @app.route('/api/dependencies/<int:did>', methods=['PUT'])
    @login_required
    @role_required('vp', 'pm', 'lead')
    def update_dependency(did):
        dep = Dependency.query.get_or_404(did)
        data = request.get_json() or {}
        if 'dep_type' in data:
            dep.dep_type = data['dep_type']
        if 'lag_days' in data:
            dep.lag_days = data['lag_days']
        db.session.commit()
        run_full_schedule(dep.predecessor.project_id)
        return jsonify(dep.to_dict())

    @app.route('/api/dependencies/<int:did>', methods=['DELETE'])
    @login_required
    @role_required('vp', 'pm', 'lead')
    def delete_dependency(did):
        dep = Dependency.query.get_or_404(did)
        pid = dep.predecessor.project_id
        db.session.delete(dep)
        db.session.commit()
        run_full_schedule(pid)
        return jsonify({'ok': True})

    # ── allocations ───────────────────────────────────────────────────────────

    @app.route('/api/tasks/<int:tid>/allocations', methods=['GET'])
    @login_required
    def list_allocations(tid):
        Task.query.get_or_404(tid)
        return jsonify([a.to_dict() for a in Allocation.query.filter_by(task_id=tid).all()])

    @app.route('/api/tasks/<int:tid>/allocations', methods=['POST'])
    @login_required
    @role_required('vp', 'pm', 'lead')
    def create_allocation(tid):
        Task.query.get_or_404(tid)
        data = request.get_json() or {}
        if not data.get('user_id'):
            return jsonify({'error': 'user_id required'}), 400
        alloc = Allocation(
            user_id=data['user_id'],
            task_id=tid,
            percent=data.get('percent', 100),
            start_date=_parse_date(data.get('start_date')),
            end_date=_parse_date(data.get('end_date')),
        )
        db.session.add(alloc)
        db.session.commit()
        return jsonify(alloc.to_dict()), 201

    @app.route('/api/allocations/<int:aid>', methods=['DELETE'])
    @login_required
    @role_required('vp', 'pm', 'lead')
    def delete_allocation(aid):
        alloc = Allocation.query.get_or_404(aid)
        db.session.delete(alloc)
        db.session.commit()
        return jsonify({'ok': True})

    @app.route('/api/projects/<int:pid>/resource-utilization', methods=['GET'])
    @login_required
    def resource_utilization(pid):
        Project.query.get_or_404(pid)
        range_start = _parse_date(request.args.get('start')) or date.today()
        range_end = _parse_date(request.args.get('end')) or date.today().replace(month=12, day=31)
        tasks = Task.query.filter_by(project_id=pid).all()
        task_dicts = []
        for t in tasks:
            s = t.computed_start or t.start_date
            e = t.computed_end or t.end_date
            if s and e:
                task_dicts.append({
                    'assignee_id': t.assignee_id,
                    'start_date': s,
                    'end_date': e,
                    'allocation_percent': 100,
                })
        util = compute_resource_utilization(task_dicts, range_start, range_end)
        return jsonify(util)

    # ── approvals ─────────────────────────────────────────────────────────────

    @app.route('/api/tasks/<int:tid>/approvals', methods=['GET'])
    @login_required
    def list_approvals(tid):
        Task.query.get_or_404(tid)
        return jsonify([a.to_dict() for a in Approval.query.filter_by(task_id=tid).all()])

    @app.route('/api/tasks/<int:tid>/approvals', methods=['POST'])
    @login_required
    @role_required('vp', 'pm')
    def create_approval(tid):
        Task.query.get_or_404(tid)
        data = request.get_json() or {}
        if not data.get('approver_id'):
            return jsonify({'error': 'approver_id required'}), 400
        approval = Approval(
            task_id=tid,
            approver_id=data['approver_id'],
            stage=data.get('stage'),
            status='pending',
            due_date=_parse_date(data.get('due_date')),
            notes=data.get('notes'),
        )
        db.session.add(approval)
        db.session.commit()
        return jsonify(approval.to_dict()), 201

    @app.route('/api/approvals/<int:aid>', methods=['PUT'])
    @login_required
    def update_approval(aid):
        approval = Approval.query.get_or_404(aid)
        if (current_user.role not in ('vp', 'pm') and
                approval.approver_id != current_user.id):
            return jsonify({'error': 'Forbidden'}), 403
        data = request.get_json() or {}
        if 'status' in data:
            if data['status'] not in ('pending', 'approved', 'rejected', 'escalated'):
                return jsonify({'error': 'Invalid status'}), 400
            approval.status = data['status']
            if data['status'] in ('approved', 'rejected'):
                approval.completed_at = datetime.utcnow()
        if 'notes' in data:
            approval.notes = data['notes']
        db.session.commit()
        return jsonify(approval.to_dict())

    # ── schedule ──────────────────────────────────────────────────────────────

    @app.route('/api/projects/<int:pid>/schedule/recompute', methods=['POST'])
    @login_required
    @role_required('vp', 'pm', 'lead')
    def recompute_schedule(pid):
        Project.query.get_or_404(pid)
        run_full_schedule(pid)
        tasks = (Task.query.filter_by(project_id=pid)
                 .order_by(Task.display_order, Task.id).all())
        return jsonify([t.to_dict() for t in tasks])

    @app.route('/api/projects/<int:pid>/critical-path', methods=['GET'])
    @login_required
    def critical_path(pid):
        project = Project.query.get_or_404(pid)
        tasks = Task.query.filter_by(project_id=pid).all()
        deps = (Dependency.query
                .join(Task, Dependency.predecessor_id == Task.id)
                .filter(Task.project_id == pid).all())
        tasks_dict = {t.id: {
            'start_date': t.start_date,
            'end_date': t.end_date,
            'duration_days': t.duration_days or 1,
        } for t in tasks}
        dep_list = [{'predecessor_id': d.predecessor_id,
                     'successor_id': d.successor_id,
                     'dep_type': d.dep_type,
                     'lag_days': d.lag_days or 0} for d in deps]
        project_end = project.target_date or date.today()
        critical_ids = find_critical_path(tasks_dict, dep_list, project_end)
        return jsonify({'critical_task_ids': list(critical_ids)})

    @app.route('/api/tasks/<int:tid>/delay-impact', methods=['GET'])
    @login_required
    def task_delay_impact(tid):
        """
        Simulate delaying task `tid` by ?days=N and return downstream impact.
        Response: {
          "delayed_task": {id, title},
          "extra_days": N,
          "impact": [{task_id, title, wbs_number, days_slipped, is_critical}]
        }
        """
        task = Task.query.get_or_404(tid)
        extra_days = int(request.args.get('days', 1))
        if extra_days < 1:
            return jsonify({'error': 'days must be >= 1'}), 400

        tasks = Task.query.filter_by(project_id=task.project_id).all()
        deps  = (Dependency.query
                 .join(Task, Dependency.predecessor_id == Task.id)
                 .filter(Task.project_id == task.project_id).all())

        tasks_dict = {t.id: {
            'start_date':       t.start_date,
            'end_date':         t.end_date,
            'duration_days':    t.duration_days or 1,
            'status':           t.status,
            'percent_complete': float(t.percent_complete or 0),
        } for t in tasks}
        dep_list = [{'predecessor_id': d.predecessor_id,
                     'successor_id':   d.successor_id,
                     'dep_type':       d.dep_type,
                     'lag_days':       d.lag_days or 0} for d in deps]

        impact_map = compute_delay_impact(tasks_dict, dep_list, tid, extra_days)

        task_lookup = {t.id: t for t in tasks}
        impact_list = []
        for affected_id, days_slipped in sorted(impact_map.items(),
                                                key=lambda x: -x[1]):
            t = task_lookup.get(affected_id)
            if t:
                impact_list.append({
                    'task_id':     t.id,
                    'title':       t.title,
                    'wbs_number':  t.wbs_number,
                    'days_slipped': days_slipped,
                    'is_critical': t.is_critical,
                })

        return jsonify({
            'delayed_task': {'id': task.id, 'title': task.title},
            'extra_days':   extra_days,
            'impact':       impact_list,
        })

    # ── audit log ─────────────────────────────────────────────────────────────

    @app.route('/api/projects/<int:pid>/audit-log', methods=['GET'])
    @login_required
    @role_required('vp', 'pm')
    def project_audit_log(pid):
        Project.query.get_or_404(pid)
        task_ids = [t.id for t in Task.query.filter_by(project_id=pid).with_entities(Task.id)]
        logs = (AuditLog.query
                .filter(
                    ((AuditLog.entity_type == 'project') & (AuditLog.entity_id == pid)) |
                    ((AuditLog.entity_type == 'task') & (AuditLog.entity_id.in_(task_ids)))
                )
                .order_by(AuditLog.timestamp.desc())
                .limit(500)
                .all())
        return jsonify([l.to_dict() for l in logs])

    # ── admin — project visibility control ───────────────────────────────────

    def _admin_required(f):
        """Decorator: 403 unless current_user.is_admin."""
        @wraps(f)
        def wrapped(*args, **kwargs):
            if not current_user.is_authenticated:
                return jsonify({'error': 'Authentication required'}), 401
            if not current_user.is_admin:
                return jsonify({'error': 'Admin access required'}), 403
            return f(*args, **kwargs)
        return wrapped

    @app.route('/api/admin/access-matrix', methods=['GET'])
    @login_required
    @_admin_required
    def admin_access_matrix():
        """
        Returns the full user × project visibility matrix.
        For each (user, project) cell the value is:
          'auto'    — access granted by role rules (VP/PM-own/Lead-team), non-revokable
          'granted' — admin explicitly granted access via ProjectAccess table
          'none'    — no access
        """
        users    = User.query.order_by(User.name).all()
        projects = Project.query.order_by(Project.name).all()

        # Collect all explicit grants into a set for O(1) lookup
        grant_set = {(g.user_id, g.project_id)
                     for g in ProjectAccess.query.all()}

        # For 'lead' auto-access: build lead_id → set of project_ids
        # Step 1: team_id → project_ids (projects with ≥1 task in that team)
        team_project_map = {}
        for task in Task.query.with_entities(Task.team_id, Task.project_id).all():
            if task.team_id:
                team_project_map.setdefault(task.team_id, set()).add(task.project_id)
        # Step 2: lead_id → union of project_ids from all their teams
        lead_project_map = {}
        for team in Team.query.with_entities(Team.id, Team.lead_id).all():
            if team.lead_id:
                pids = team_project_map.get(team.id, set())
                lead_project_map.setdefault(team.lead_id, set()).update(pids)

        all_project_ids = {p.id for p in projects}
        pm_project_map  = {}  # owner_id → set of project_ids
        for p in projects:
            if p.owner_id:
                pm_project_map.setdefault(p.owner_id, set()).add(p.id)

        access = {}
        for u in users:
            row = {}
            for p in projects:
                if u.is_admin or u.role == 'vp':
                    row[p.id] = 'auto'
                elif u.role == 'pm' and p.id in pm_project_map.get(u.id, set()):
                    row[p.id] = 'auto'
                elif u.role == 'lead' and p.id in lead_project_map.get(u.id, set()):
                    row[p.id] = 'auto'
                elif (u.id, p.id) in grant_set:
                    row[p.id] = 'granted'
                else:
                    row[p.id] = 'none'
            access[u.id] = row

        return jsonify({
            'users':    [u.to_dict()  for u in users],
            'projects': [p.to_dict()  for p in projects],
            'access':   access,
        })

    @app.route('/api/admin/access', methods=['POST'])
    @login_required
    @_admin_required
    def admin_set_access():
        """
        Toggle a single (user, project) explicit grant.
        Body: { user_id, project_id, grant: true|false }
        Silently ignores attempts to revoke auto-access (role-based) — those
        are not stored in ProjectAccess and can't be deleted.
        """
        data       = request.get_json() or {}
        user_id    = data.get('user_id')
        project_id = data.get('project_id')
        grant      = data.get('grant')

        if user_id is None or project_id is None or grant is None:
            return jsonify({'error': 'user_id, project_id, and grant are required'}), 400

        User.query.get_or_404(int(user_id))
        Project.query.get_or_404(int(project_id))

        existing = ProjectAccess.query.filter_by(
            user_id=int(user_id), project_id=int(project_id)).first()

        if grant:
            if not existing:
                db.session.add(ProjectAccess(
                    user_id=int(user_id),
                    project_id=int(project_id),
                    granted_by=current_user.id,
                ))
                db.session.commit()
        else:
            if existing:
                db.session.delete(existing)
                db.session.commit()

        return jsonify({'ok': True})

    @app.route('/api/admin/users/<int:uid>/make-admin', methods=['POST'])
    @login_required
    @_admin_required
    def admin_make_admin(uid):
        """Toggle is_admin on another user."""
        user = User.query.get_or_404(uid)
        data = request.get_json() or {}
        user.is_admin = bool(data.get('is_admin', False))
        db.session.commit()
        return jsonify(user.to_dict())

    # ── dashboard ─────────────────────────────────────────────────────────────

    @app.route('/api/dashboard', methods=['GET'])
    @login_required
    def dashboard():
        projects = Project.query.filter(
            Project.status.in_(['planning', 'active', 'on_hold'])
        ).all()
        today = date.today()
        overdue_tasks = (Task.query
                         .filter(Task.end_date < today,
                                 Task.status.notin_(['completed', 'cancelled']))
                         .all())
        pending_approvals = (Approval.query
                             .filter_by(approver_id=current_user.id, status='pending')
                             .all())
        return jsonify({
            'active_project_count': len(projects),
            'overdue_task_count': len(overdue_tasks),
            'my_pending_approvals': len(pending_approvals),
            'projects_summary': [p.to_dict() for p in projects[:10]],
        })

    return app


if __name__ == '__main__':
    app = create_app()
    app.run(debug=True)
