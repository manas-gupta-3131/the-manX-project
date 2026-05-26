# V-Guard R&D PM Platform

A full-stack Project & Resource Management platform built for the V-Guard R&D Electronics division. Manages the entire NPD (New Product Development) lifecycle — from concept through DVT and mass production — with Gantt scheduling, dependency cascade, critical path analysis, and resource utilization tracking.

**Live demo:** https://pm-application.onrender.com
> Cold starts on the free tier take ~30 seconds. Login: `admin@vguard.in` / `password123`

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.11 · Flask · Flask-Login · SQLAlchemy |
| Database | SQLite (file: `instance/pm.db`) |
| Frontend | Vanilla JS (no framework) · Frappe Gantt |
| Auth | Session-based via Flask-Login · Werkzeug password hashing |

---

## Setup & Running Locally

### Prerequisites

- Python 3.10 or higher (`python --version` to check)
- pip (comes with Python)
- Git

### 1. Clone the repository

```bash
git clone https://github.com/manas-gupta-3131/the-manX-project.git
cd the-manX-project
```

### 2. Create a virtual environment (recommended)

```bash
# Windows
python -m venv venv
venv\Scripts\activate

# macOS / Linux
python3 -m venv venv
source venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Run the development server

```bash
python app.py
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000) in your browser.

The database is created and **auto-seeded with demo data on the very first run** — no extra step needed.

### 5. Log in

Use any account from the table below. All passwords are `password123`.

| Email | Role | Access level |
|-------|------|-------------|
| `admin@vguard.in` | VP (Admin) | Full access — all projects, teams, users |
| `priya.nair@vguard.in` | PM | Owns Smart Energy Meter & Voltage Stabilizer |
| `arjun.mehta@vguard.in` | PM | Owns IoT Gateway & Solar Charge Controller |
| `kavitha.reddy@vguard.in` | Team Lead | Hardware Design team |
| `suresh.pillai@vguard.in` | Team Lead | Firmware & Embedded team |
| `deepa.krishnan@vguard.in` | Team Lead | Software & Cloud team |
| `vikram.rao@vguard.in` | Member | Hardware Design — individual contributor |
| `kiran.patel@vguard.in` | Member | Firmware & Embedded — individual contributor |

### Re-seeding the database

To wipe all data and reload the demo dataset from scratch:

```bash
python seed.py
```

### Changing the secret key

For local development the default key in `app.py` is fine. For any shared or production deployment set the `SECRET_KEY` environment variable:

```bash
# Windows PowerShell
$env:SECRET_KEY = "your-random-secret-here"
python app.py

# macOS / Linux
SECRET_KEY="your-random-secret-here" python app.py
```

---

## Project Structure

```
PM Application/
├── app.py          — All Flask routes and API endpoints
├── models.py       — SQLAlchemy ORM models
├── scheduler.py    — Scheduling engine (cascade, critical path, delay impact)
├── database.py     — DB initialisation
├── db_seed.py      — Seed logic (called automatically on first run)
├── seed.py         — CLI wrapper: python seed.py to manually re-seed
├── render.yaml     — Render deployment config
├── requirements.txt
├── templates/
│   ├── base.html   — Nav, sidebar, user menu
│   ├── login.html  — Login page
│   ├── dashboard.html
│   └── project.html
└── static/
    ├── css/main.css
    └── js/
        ├── api.js       — Fetch wrapper, toasts, modals
        ├── dashboard.js — Portfolio, Teams, Members, Alerts tabs
        └── project.js   — Gantt, Kanban, Resources views
```

---

## Roles & Permissions

| Role | Can Do |
|------|--------|
| **VP R&D** | Everything: create/delete projects & teams, manage all users, approve gates |
| **PM** | Create projects & teams, manage tasks, create approvals |
| **Team Lead** | Create/edit/delete tasks, manage dependencies, view resources |
| **Member** | View projects assigned to them, update % complete on their own tasks |

---

## Data Model

```
User ──── Team           (many users per team, one lead per team)
User ──── Project        (owner)
Project ── Task          (many tasks, hierarchical via parent_task_id)
Task ──── Task           (parent → children: phase → task → subtask)
Task ──── Dependency     (predecessor/successor, typed: FS/SS/FF/SF + lag)
Task ──── Allocation     (user allocated % to a task)
Task ──── Approval       (approval gates per task per approver)
User/Task → AuditLog    (field-level change history)
```

---

## Scheduling Engine (`scheduler.py`)

This is the core algorithmic layer. Every task/dependency mutation triggers `run_full_schedule(project_id)` which does three passes:

### Pass 1 — Topological Sort (Kahn's BFS)
Converts the dependency graph (DAG) into a linear processing order. Detects cycles and aborts if found.

### Pass 2 — Status-Aware Forward Pass
Computes `computed_start` and `computed_end` for every task, cascading from predecessors to successors.

The key innovation is **`effective_end_date(task, today)`** — instead of using the planned end date for a predecessor, it returns the *realistic* finish date based on current task state:

| Task State | Effective End Date |
|------------|-------------------|
| `completed` | Stored `end_date` — done is done, no slip |
| `in_progress` 60% | `today + ceil(duration × 40%)` days |
| `blocked` or `on_hold` | `today + remaining work` (no progress assumed) |
| `not_started`, overdue | Starts today → `today + duration − 1` |
| `not_started`, future | Planned: `start_date + duration − 1` |

**Result:** If Task A (10 days, 50% done) is running late, Task B (FS dependency on A) automatically shifts its `computed_start` to `today + 5`. Task C (FS on B) shifts further. The entire downstream chain cascades in one forward pass.

### Pass 3 — Backward Pass → Critical Path
Walks tasks in reverse order, computing Latest Start/Finish for each. Tasks with `Total Float = Latest Start − Earliest Start = 0` are on the **Critical Path** — any delay to these tasks directly delays the project end date.

### Dependency Types

| Type | Meaning | Candidate Start Formula |
|------|---------|------------------------|
| **FS** (default) | Successor starts after predecessor finishes | `pred.end + 1 + lag` |
| **SS** | Both start at the same time | `pred.start + lag` |
| **FF** | Both finish at the same time | `pred.end + lag − dur + 1` |
| **SF** | Rare: successor finishes when predecessor starts | `pred.start + lag − dur + 1` |

Lag in calendar days. Negative lag = lead time (overlap allowed).

### Delay Impact API

```
GET /api/tasks/<tid>/delay-impact?days=N
```

Simulates adding N days to task `tid` and returns every downstream task with how many days it slips. Use this to show the user the ripple effect before confirming a date change.

**Example response:**
```json
{
  "delayed_task": {"id": 5, "title": "PCB Layout"},
  "extra_days": 7,
  "impact": [
    {"task_id": 6, "title": "EVT Testing", "days_slipped": 7, "is_critical": true},
    {"task_id": 7, "title": "DVT Sign-off", "days_slipped": 7, "is_critical": true},
    {"task_id": 8, "title": "BIS Certification", "days_slipped": 4, "is_critical": false}
  ]
}
```

---

## Key API Endpoints

### Auth
| Method | URL | Description |
|--------|-----|-------------|
| POST | `/api/auth/login` | Login with email + password |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Current user info |
| POST | `/api/auth/register` | Register new user |
| PUT | `/api/auth/password` | Change password |

### Projects
| Method | URL | Description |
|--------|-----|-------------|
| GET | `/api/projects` | List all projects |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/<id>` | Get project |
| PUT | `/api/projects/<id>` | Update project |
| DELETE | `/api/projects/<id>` | Delete project |

### Tasks
| Method | URL | Description |
|--------|-----|-------------|
| GET | `/api/projects/<pid>/tasks` | List tasks |
| POST | `/api/projects/<pid>/tasks` | Create task |
| PUT | `/api/tasks/<id>` | Update task (triggers schedule recompute) |
| DELETE | `/api/tasks/<id>` | Delete task |
| GET | `/api/tasks/<id>/delay-impact?days=N` | Simulate N-day delay |

### Dependencies
| Method | URL | Description |
|--------|-----|-------------|
| GET | `/api/projects/<pid>/dependencies` | List dependencies |
| POST | `/api/dependencies` | Create dependency |
| PUT | `/api/dependencies/<id>` | Update lag / type |
| DELETE | `/api/dependencies/<id>` | Remove dependency |

### Resources & Schedule
| Method | URL | Description |
|--------|-----|-------------|
| POST | `/api/projects/<pid>/schedule/recompute` | Force full reschedule |
| GET | `/api/projects/<pid>/critical-path` | Get critical task IDs |
| GET | `/api/projects/<pid>/resource-utilization` | Utilization by user |
| GET | `/api/projects/<pid>/gantt-data` | Gantt-formatted tasks |

---

## Dashboard Features

- **Portfolio tab** — project cards with progress bars, status/priority badges, filter
- **Teams tab** — click any team to drill into member workload, resource utilization bars, and all tasks assigned to the team across projects
- **Members tab** — all users with role, team, capacity; edit name/role/team/capacity
- **Alerts tab** — overdue tasks, pending approvals, at-risk projects

## Project View Features

- **Gantt** — Frappe Gantt chart with drag-to-reschedule and progress-drag; critical path tasks shown in red
- **Kanban** — drag cards between status columns
- **Resources** — per-member utilization bar for the next 30 days

---

## Adding a New Project (Step-by-Step)

1. Click **"+ New Project"** on the dashboard
2. Fill: Name, Description, Priority, Status, Start Date, Target Date, NPD Reference, Owner
3. Click **Create Project** → lands on the project Gantt view
4. Click **"+ Add Task"** to create phases and tasks
5. In the task drawer (click any task name), click **"+ Add"** under Predecessors to wire up dependencies
6. Click **Recompute** to propagate the full schedule

---

## Deployment (Render)

The app is configured for one-click deploy to [Render](https://render.com) via `render.yaml`.

### Deploy your own instance

1. Fork / push this repo to GitHub
2. Go to [render.com](https://render.com) → **New + → Web Service**
3. Connect your GitHub repo — Render auto-detects `render.yaml`
4. Click **Apply** — build and deploy takes ~2–3 minutes
5. Your URL: `https://<service-name>.onrender.com`

### How it works in production

| Concern | Approach |
|---------|---------|
| WSGI server | Gunicorn (replaces Flask dev server) |
| Database | SQLite, stored in container filesystem |
| First run | `create_app()` auto-seeds all demo data if DB is empty |
| Re-deploy | SQLite is wiped on each new deploy; auto-seed repopulates it |
| Secret key | Render generates a random `SECRET_KEY` via `render.yaml` env var |
| Cold starts | Free tier sleeps after 15 min idle; first request takes ~30s |

### Environment variables (set automatically by render.yaml)

| Variable | Value |
|----------|-------|
| `SECRET_KEY` | Auto-generated random value |
| `PYTHON_VERSION` | `3.11.0` |

---

## Sample Data (seed.py)

| Entity | Count | Notes |
|--------|-------|-------|
| Users | 15 | 1 VP, 2 PMs, 5 Leads, 7 Members |
| Teams | 5 | Hardware, Firmware, Software, QA, Manufacturing |
| Projects | 4 | Smart Energy Meter (active/critical), IoT Gateway (active), Voltage Stabilizer (planning), Solar Charge Controller (on hold) |
| Tasks | 56 | Phases, tasks, milestones with WBS numbers |
| Dependencies | 43 | FS chains across all projects |
| Allocations | 14 | Resource allocations |
| Approvals | 10 | Mix of pending/approved gate reviews |
| Audit Logs | 8 | Sample change history |
