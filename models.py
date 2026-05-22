from datetime import datetime
from database import db
from werkzeug.security import generate_password_hash, check_password_hash
from flask_login import UserMixin


class User(UserMixin, db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(256))
    role = db.Column(db.String(20), nullable=False)  # vp, pm, lead, member
    is_admin = db.Column(db.Boolean, default=False)  # system-level admin flag
    team_id = db.Column(db.Integer, db.ForeignKey('teams.id'), nullable=True)
    capacity_hours_per_day = db.Column(db.Float, default=8.0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    team = db.relationship('Team', foreign_keys=[team_id], backref='members')

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'email': self.email,
            'role': self.role,
            'is_admin': bool(self.is_admin),
            'team_id': self.team_id,
            'team_name': self.team.name if self.team else None,
            'capacity_hours_per_day': self.capacity_hours_per_day,
        }


class Team(db.Model):
    __tablename__ = 'teams'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    lead_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True)
    parent_team_id = db.Column(db.Integer, db.ForeignKey('teams.id'), nullable=True)
    description = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    lead = db.relationship('User', foreign_keys=[lead_id])
    children = db.relationship('Team', backref=db.backref('parent', remote_side=[id]))

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'lead_id': self.lead_id,
            'lead_name': self.lead.name if self.lead else None,
            'parent_team_id': self.parent_team_id,
            'description': self.description,
            'member_count': len(self.members),
        }


class Project(db.Model):
    __tablename__ = 'projects'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'))
    priority = db.Column(db.String(20), default='medium')  # critical, high, medium, low
    start_date = db.Column(db.Date)
    target_date = db.Column(db.Date)
    current_forecast_date = db.Column(db.Date)
    status = db.Column(db.String(20), default='planning')  # planning, active, on_hold, completed, cancelled
    npd_reference = db.Column(db.String(100))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    owner = db.relationship('User', foreign_keys=[owner_id])
    tasks = db.relationship('Task', backref='project', cascade='all, delete-orphan',
                            primaryjoin='Project.id == Task.project_id')

    def to_dict(self):
        completed = sum(1 for t in self.tasks if t.status == 'completed')
        total = len(self.tasks)
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'owner_id': self.owner_id,
            'owner_name': self.owner.name if self.owner else None,
            'priority': self.priority,
            'start_date': self.start_date.isoformat() if self.start_date else None,
            'target_date': self.target_date.isoformat() if self.target_date else None,
            'current_forecast_date': self.current_forecast_date.isoformat() if self.current_forecast_date else None,
            'status': self.status,
            'npd_reference': self.npd_reference,
            'task_count': total,
            'completed_task_count': completed,
            'progress': round((completed / total * 100) if total else 0, 1),
        }


class Task(db.Model):
    __tablename__ = 'tasks'
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey('projects.id'), nullable=False)
    parent_task_id = db.Column(db.Integer, db.ForeignKey('tasks.id'), nullable=True)
    wbs_number = db.Column(db.String(20))
    title = db.Column(db.String(300), nullable=False)
    description = db.Column(db.Text)
    assignee_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True)
    team_id = db.Column(db.Integer, db.ForeignKey('teams.id'), nullable=True)
    start_date = db.Column(db.Date)
    end_date = db.Column(db.Date)
    duration_days = db.Column(db.Integer, default=1)
    effort_days = db.Column(db.Float)
    percent_complete = db.Column(db.Float, default=0)
    status = db.Column(db.String(20), default='not_started')  # not_started, in_progress, completed, blocked, on_hold
    task_type = db.Column(db.String(20), default='task')  # phase, task, subtask, milestone
    is_milestone = db.Column(db.Boolean, default=False)
    display_order = db.Column(db.Integer, default=0)
    is_critical = db.Column(db.Boolean, default=False)
    computed_start = db.Column(db.Date)
    computed_end = db.Column(db.Date)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    assignee = db.relationship('User', foreign_keys=[assignee_id])
    team = db.relationship('Team', foreign_keys=[team_id])
    children = db.relationship('Task', backref=db.backref('parent', remote_side=[id]),
                               cascade='all, delete-orphan')

    def to_dict(self):
        return {
            'id': self.id,
            'project_id': self.project_id,
            'parent_task_id': self.parent_task_id,
            'wbs_number': self.wbs_number,
            'title': self.title,
            'description': self.description,
            'assignee_id': self.assignee_id,
            'assignee_name': self.assignee.name if self.assignee else None,
            'team_id': self.team_id,
            'team_name': self.team.name if self.team else None,
            'start_date': self.start_date.isoformat() if self.start_date else None,
            'end_date': self.end_date.isoformat() if self.end_date else None,
            'duration_days': self.duration_days,
            'effort_days': self.effort_days,
            'percent_complete': self.percent_complete,
            'status': self.status,
            'task_type': self.task_type,
            'is_milestone': self.is_milestone,
            'display_order': self.display_order,
            'is_critical': self.is_critical,
            'computed_start': self.computed_start.isoformat() if self.computed_start else None,
            'computed_end': self.computed_end.isoformat() if self.computed_end else None,
            'has_children': len(self.children) > 0,
        }


class Dependency(db.Model):
    __tablename__ = 'dependencies'
    id = db.Column(db.Integer, primary_key=True)
    predecessor_id = db.Column(db.Integer, db.ForeignKey('tasks.id'), nullable=False)
    successor_id = db.Column(db.Integer, db.ForeignKey('tasks.id'), nullable=False)
    dep_type = db.Column(db.String(5), default='FS')  # FS, SS, FF, SF
    lag_days = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    predecessor = db.relationship('Task', foreign_keys=[predecessor_id])
    successor = db.relationship('Task', foreign_keys=[successor_id])

    def to_dict(self):
        return {
            'id': self.id,
            'predecessor_id': self.predecessor_id,
            'predecessor_title': self.predecessor.title if self.predecessor else None,
            'successor_id': self.successor_id,
            'successor_title': self.successor.title if self.successor else None,
            'dep_type': self.dep_type,
            'lag_days': self.lag_days,
        }


class Allocation(db.Model):
    __tablename__ = 'allocations'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    task_id = db.Column(db.Integer, db.ForeignKey('tasks.id'), nullable=False)
    percent = db.Column(db.Float, default=100)
    start_date = db.Column(db.Date)
    end_date = db.Column(db.Date)

    user = db.relationship('User', foreign_keys=[user_id])
    task = db.relationship('Task', foreign_keys=[task_id])

    def to_dict(self):
        return {
            'id': self.id,
            'user_id': self.user_id,
            'user_name': self.user.name if self.user else None,
            'task_id': self.task_id,
            'percent': self.percent,
            'start_date': self.start_date.isoformat() if self.start_date else None,
            'end_date': self.end_date.isoformat() if self.end_date else None,
        }


class Approval(db.Model):
    __tablename__ = 'approvals'
    id = db.Column(db.Integer, primary_key=True)
    task_id = db.Column(db.Integer, db.ForeignKey('tasks.id'), nullable=False)
    approver_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    stage = db.Column(db.String(100))
    status = db.Column(db.String(20), default='pending')  # pending, approved, rejected, escalated
    due_date = db.Column(db.Date)
    completed_at = db.Column(db.DateTime)
    notes = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    task = db.relationship('Task', foreign_keys=[task_id])
    approver = db.relationship('User', foreign_keys=[approver_id])

    def to_dict(self):
        return {
            'id': self.id,
            'task_id': self.task_id,
            'task_title': self.task.title if self.task else None,
            'approver_id': self.approver_id,
            'approver_name': self.approver.name if self.approver else None,
            'stage': self.stage,
            'status': self.status,
            'due_date': self.due_date.isoformat() if self.due_date else None,
            'notes': self.notes,
            'created_at': self.created_at.isoformat(),
        }


class AuditLog(db.Model):
    __tablename__ = 'audit_logs'
    id = db.Column(db.Integer, primary_key=True)
    actor_id = db.Column(db.Integer, db.ForeignKey('users.id'))
    entity_type = db.Column(db.String(50))
    entity_id = db.Column(db.Integer)
    field_changed = db.Column(db.String(100))
    old_value = db.Column(db.Text)
    new_value = db.Column(db.Text)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)

    actor = db.relationship('User', foreign_keys=[actor_id])

    def to_dict(self):
        return {
            'id': self.id,
            'actor_name': self.actor.name if self.actor else 'System',
            'entity_type': self.entity_type,
            'entity_id': self.entity_id,
            'field_changed': self.field_changed,
            'old_value': self.old_value,
            'new_value': self.new_value,
            'timestamp': self.timestamp.isoformat(),
        }


class ProjectAccess(db.Model):
    """
    Explicit admin grant: user_id can see project_id.
    Composite PK ensures exactly one record per (user, project) pair.
    This table is ONLY used for admin-granted access; role-based automatic
    access (VP sees all, PM sees own, Lead sees team projects) is computed
    at query time and does NOT require rows here.
    """
    __tablename__ = 'project_access'
    user_id    = db.Column(db.Integer, db.ForeignKey('users.id'),    primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey('projects.id'), primary_key=True)
    granted_by = db.Column(db.Integer, db.ForeignKey('users.id'),    nullable=True)
    granted_at = db.Column(db.DateTime, default=datetime.utcnow)

    user    = db.relationship('User',    foreign_keys=[user_id])
    project = db.relationship('Project', foreign_keys=[project_id])
    granter = db.relationship('User',    foreign_keys=[granted_by])
