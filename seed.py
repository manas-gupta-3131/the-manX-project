"""
Seed script — populates all tables with realistic V-Guard R&D sample data.
Run once: python seed.py
"""
from app import create_app
from database import db
from db_seed import seed_db
from models import Allocation, Approval, AuditLog, Dependency, Project, Task, Team, User

app = create_app()

with app.app_context():
    seed_db()
    print("Seed complete.")
    print(f"  Users   : {User.query.count()}")
    print(f"  Teams   : {Team.query.count()}")
    print(f"  Projects: {Project.query.count()}")
    print(f"  Tasks   : {Task.query.count()}")
    print(f"  Deps    : {Dependency.query.count()}")
    print(f"  Allocs  : {Allocation.query.count()}")
    print(f"  Approvs : {Approval.query.count()}")
    print(f"  Audits  : {AuditLog.query.count()}")
