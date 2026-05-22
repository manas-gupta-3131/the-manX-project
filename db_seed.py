"""
Seed logic extracted into a callable function.
Called automatically from create_app() when the database is empty,
and also invoked by seed.py for manual re-seeding.
"""
from datetime import date, datetime, timedelta

from database import db
from models import (Allocation, Approval, AuditLog, Dependency,
                    Project, Task, Team, User)


def seed_db():
    def d(offset_days, base=date(2026, 1, 6)):
        return base + timedelta(days=offset_days)

    # ── wipe existing non-admin data ─────────────────────────────────────────
    AuditLog.query.delete()
    Approval.query.delete()
    Allocation.query.delete()
    Dependency.query.delete()
    Task.query.delete()
    Project.query.delete()
    User.query.filter(User.email != 'admin@vguard.in').delete()
    Team.query.delete()
    db.session.commit()

    # ── teams ────────────────────────────────────────────────────────────────
    t_hw  = Team(name='Hardware Design',     description='PCB layout, analog & power electronics')
    t_fw  = Team(name='Firmware & Embedded', description='Microcontroller firmware, RTOS, drivers')
    t_sw  = Team(name='Software & Cloud',    description='Mobile app, cloud backend, OTA')
    t_qa  = Team(name='Quality & Testing',   description='DVT, EMC, safety certification, field trials')
    t_mfg = Team(name='Manufacturing Eng',   description='DFM, tooling, production ramp-up')
    for t in (t_hw, t_fw, t_sw, t_qa, t_mfg):
        db.session.add(t)
    db.session.flush()

    # ── users ────────────────────────────────────────────────────────────────
    def make_user(name, email, role, team, cap=8.0):
        u = User(name=name, email=email, role=role,
                 team_id=team.id if team else None,
                 capacity_hours_per_day=cap)
        u.set_password('password123')
        db.session.add(u)
        return u

    admin = User.query.filter_by(email='admin@vguard.in').first()
    if not admin:
        admin = User(email='admin@vguard.in', is_admin=True)
        db.session.add(admin)
    admin.name = 'Rajesh Sharma'
    admin.role = 'vp'
    admin.is_admin = True
    admin.set_password('password123')

    pm1  = make_user('Priya Nair',     'priya.nair@vguard.in',     'pm',     None)
    pm2  = make_user('Arjun Mehta',    'arjun.mehta@vguard.in',    'pm',     None)
    l_hw = make_user('Kavitha Reddy',  'kavitha.reddy@vguard.in',  'lead',   t_hw)
    l_fw = make_user('Suresh Pillai',  'suresh.pillai@vguard.in',  'lead',   t_fw)
    l_sw = make_user('Deepa Krishnan', 'deepa.krishnan@vguard.in', 'lead',   t_sw)
    l_qa = make_user('Ramesh Iyer',    'ramesh.iyer@vguard.in',    'lead',   t_qa)
    l_mf = make_user('Anitha Bose',    'anitha.bose@vguard.in',    'lead',   t_mfg)
    m1   = make_user('Vikram Rao',     'vikram.rao@vguard.in',     'member', t_hw)
    m2   = make_user('Shalini Menon',  'shalini.menon@vguard.in',  'member', t_hw)
    m3   = make_user('Kiran Patel',    'kiran.patel@vguard.in',    'member', t_fw)
    m4   = make_user('Neha Gupta',     'neha.gupta@vguard.in',     'member', t_fw)
    m5   = make_user('Arun Joshi',     'arun.joshi@vguard.in',     'member', t_sw)
    m6   = make_user('Pooja Varma',    'pooja.varma@vguard.in',    'member', t_qa)
    m7   = make_user('Ravi Kumar',     'ravi.kumar@vguard.in',     'member', t_mfg)
    db.session.flush()

    t_hw.lead_id  = l_hw.id
    t_fw.lead_id  = l_fw.id
    t_sw.lead_id  = l_sw.id
    t_qa.lead_id  = l_qa.id
    t_mfg.lead_id = l_mf.id
    db.session.flush()

    # ── projects ─────────────────────────────────────────────────────────────
    p1 = Project(
        name='Smart Energy Meter Gen-3',
        description='Next-gen residential smart meter with 4G+BLE, tamper detection and DLMS/COSEM compliance.',
        owner_id=pm1.id, priority='critical', status='active',
        npd_reference='NPD-2026-001',
        start_date=d(0), target_date=d(180),
        current_forecast_date=d(195),
    )
    p2 = Project(
        name='V-Guard IoT Home Gateway',
        description='Wi-Fi+Zigbee gateway for home automation; integrates with V-Smart app.',
        owner_id=pm2.id, priority='high', status='active',
        npd_reference='NPD-2026-002',
        start_date=d(14), target_date=d(150),
        current_forecast_date=d(155),
    )
    p3 = Project(
        name='Voltage Stabilizer Mk-V',
        description='Digital servo stabilizer with LCD, smart cut-off and energy logging.',
        owner_id=pm1.id, priority='medium', status='planning',
        npd_reference='NPD-2026-003',
        start_date=d(30), target_date=d(210),
        current_forecast_date=d(210),
    )
    p4 = Project(
        name='Solar Charge Controller Pro',
        description='MPPT-based 40A charge controller with Bluetooth monitoring.',
        owner_id=pm2.id, priority='high', status='on_hold',
        npd_reference='NPD-2025-047',
        start_date=d(-60), target_date=d(120),
        current_forecast_date=d(145),
    )
    for p in (p1, p2, p3, p4):
        db.session.add(p)
    db.session.flush()

    # ── task helper ──────────────────────────────────────────────────────────
    def task(proj_id, title, wbs, ttype, start_off, dur, pct, status,
             assignee=None, team=None, parent_id=None, milestone=False,
             critical=False, effort=None, order=0):
        sd = d(start_off)
        ed = sd + timedelta(days=dur - 1)
        t = Task(
            project_id=proj_id, wbs_number=wbs, title=title,
            task_type=ttype, start_date=sd, end_date=ed,
            duration_days=dur, effort_days=effort or dur,
            percent_complete=pct, status=status,
            assignee_id=assignee.id if assignee else None,
            team_id=team.id if team else None,
            parent_task_id=parent_id,
            is_milestone=milestone, is_critical=critical,
            computed_start=sd, computed_end=ed,
            display_order=order,
        )
        db.session.add(t)
        db.session.flush()
        return t

    # ═══ PROJECT 1 — Smart Energy Meter Gen-3 ════════════════════════════════
    ph1  = task(p1.id, 'Phase 1: Concept & Feasibility', '1', 'phase', 0, 21, 100, 'completed', team=t_hw, order=0)
    t1_1 = task(p1.id, 'Market & regulatory analysis',   '1.1', 'task', 0, 7, 100, 'completed', pm1, None, ph1.id, order=1)
    t1_2 = task(p1.id, 'BOM cost estimation',            '1.2', 'task', 7, 7, 100, 'completed', l_hw, t_hw, ph1.id, order=2)
    t1_3 = task(p1.id, 'Feasibility sign-off',           '1.3', 'milestone', 14, 1, 100, 'completed', admin, None, ph1.id, milestone=True, order=3)
    t1_4 = task(p1.id, 'Architecture freeze',            '1.4', 'task', 14, 7, 100, 'completed', l_fw, t_fw, ph1.id, order=4)

    ph2  = task(p1.id, 'Phase 2: Hardware & Firmware Design', '2', 'phase', 21, 63, 80, 'in_progress', team=t_hw, order=5)
    t2_1 = task(p1.id, 'Schematic design — metering AFE',     '2.1', 'task', 21, 21, 100, 'completed', l_hw, t_hw, ph2.id, critical=True, order=6)
    t2_2 = task(p1.id, 'Schematic design — 4G modem board',   '2.2', 'task', 21, 21, 100, 'completed', m1, t_hw, ph2.id, order=7)
    t2_3 = task(p1.id, 'PCB layout — layer stack review',     '2.3', 'task', 42, 14, 90, 'in_progress', m2, t_hw, ph2.id, critical=True, order=8)
    t2_4 = task(p1.id, 'Firmware — bootloader & HAL',         '2.4', 'task', 21, 28, 100, 'completed', l_fw, t_fw, ph2.id, order=9)
    t2_5 = task(p1.id, 'Firmware — DLMS/COSEM stack',         '2.5', 'task', 49, 28, 60, 'in_progress', m3, t_fw, ph2.id, critical=True, order=10)
    t2_6 = task(p1.id, 'Firmware — 4G data push',             '2.6', 'task', 56, 21, 40, 'in_progress', m4, t_fw, ph2.id, order=11)
    t2_7 = task(p1.id, 'Design review gate',                  '2.7', 'milestone', 84, 1, 0, 'not_started', admin, None, ph2.id, milestone=True, order=12)

    ph3  = task(p1.id, 'Phase 3: Prototype Build & EVT',  '3', 'phase', 84, 42, 0, 'not_started', team=t_qa, order=13)
    t3_1 = task(p1.id, 'Gerber release & PCB fabrication','3.1', 'task', 84, 10, 0, 'not_started', l_hw, t_hw, ph3.id, critical=True, order=14)
    t3_2 = task(p1.id, 'Component procurement',           '3.2', 'task', 84, 14, 0, 'not_started', m7, t_mfg, ph3.id, order=15)
    t3_3 = task(p1.id, 'PCB assembly & bringup',          '3.3', 'task', 94, 7, 0, 'not_started', l_hw, t_hw, ph3.id, order=16)
    t3_4 = task(p1.id, 'EVT functional testing',          '3.4', 'task', 101, 14, 0, 'not_started', l_qa, t_qa, ph3.id, critical=True, order=17)
    t3_5 = task(p1.id, 'EVT sign-off milestone',          '3.5', 'milestone', 125, 1, 0, 'not_started', admin, None, ph3.id, milestone=True, order=18)

    ph4  = task(p1.id, 'Phase 4: DVT & Certification',        '4', 'phase', 126, 42, 0, 'not_started', team=t_qa, order=19)
    t4_1 = task(p1.id, 'EMC pre-compliance testing',          '4.1', 'task', 126, 14, 0, 'not_started', m6, t_qa, ph4.id, order=20)
    t4_2 = task(p1.id, 'BIS/MID certification submission',    '4.2', 'task', 140, 21, 0, 'not_started', pm1, None, ph4.id, critical=True, order=21)
    t4_3 = task(p1.id, 'Field trial — 50 units',              '4.3', 'task', 140, 21, 0, 'not_started', l_qa, t_qa, ph4.id, order=22)
    t4_4 = task(p1.id, 'DVT sign-off & mass production go',   '4.4', 'milestone', 167, 1, 0, 'not_started', admin, None, ph4.id, milestone=True, order=23)

    for pred, succ in [
        (t1_1, t1_2), (t1_2, t1_3), (t1_3, t1_4),
        (t1_4, t2_1), (t1_4, t2_2),
        (t2_1, t2_3), (t2_4, t2_5), (t2_5, t2_6),
        (t2_3, t2_7), (t2_6, t2_7),
        (t2_7, t3_1), (t3_1, t3_3), (t3_2, t3_3),
        (t3_3, t3_4), (t3_4, t3_5),
        (t3_5, t4_1), (t4_1, t4_2), (t3_5, t4_3),
        (t4_2, t4_4), (t4_3, t4_4),
    ]:
        db.session.add(Dependency(predecessor_id=pred.id, successor_id=succ.id, dep_type='FS'))

    # ═══ PROJECT 2 — IoT Home Gateway ════════════════════════════════════════
    g_ph1 = task(p2.id, 'Phase 1: Definition',             '1',   'phase',     14,  14, 100, 'completed', team=t_sw, order=0)
    g1_1  = task(p2.id, 'User story mapping',              '1.1', 'task',      14,   7, 100, 'completed', l_sw, t_sw, g_ph1.id, order=1)
    g1_2  = task(p2.id, 'RF band regulatory check',        '1.2', 'task',      14,   7, 100, 'completed', l_hw, t_hw, g_ph1.id, order=2)
    g1_3  = task(p2.id, 'SoC selection (ESP32-S3)',        '1.3', 'milestone', 21,   1, 100, 'completed', admin, None, g_ph1.id, milestone=True, order=3)

    g_ph2 = task(p2.id, 'Phase 2: HW + FW Development',   '2',   'phase',     28,  56,  65, 'in_progress', team=t_hw, order=4)
    g2_1  = task(p2.id, 'Carrier board schematic',         '2.1', 'task',      28,  14, 100, 'completed', m1, t_hw, g_ph2.id, critical=True, order=5)
    g2_2  = task(p2.id, 'Zigbee module integration',       '2.2', 'task',      42,  14,  80, 'in_progress', m2, t_hw, g_ph2.id, order=6)
    g2_3  = task(p2.id, 'Zigbee FW — pairing & registry', '2.3', 'task',      42,  21,  70, 'in_progress', l_fw, t_fw, g_ph2.id, critical=True, order=7)
    g2_4  = task(p2.id, 'MQTT cloud connector',            '2.4', 'task',      49,  21,  50, 'in_progress', m5, t_sw, g_ph2.id, order=8)
    g2_5  = task(p2.id, 'OTA firmware update service',     '2.5', 'task',      56,  21,  30, 'in_progress', l_sw, t_sw, g_ph2.id, order=9)

    g_ph3 = task(p2.id, 'Phase 3: App & Integration',              '3',   'phase',      84,  42,   5, 'in_progress', team=t_sw, order=10)
    g3_1  = task(p2.id, 'V-Smart Android app — gateway module',    '3.1', 'task',       84,  21,  10, 'in_progress', m5, t_sw, g_ph3.id, order=11)
    g3_2  = task(p2.id, 'V-Smart iOS app — gateway module',        '3.2', 'task',       84,  21,   5, 'in_progress', l_sw, t_sw, g_ph3.id, order=12)
    g3_3  = task(p2.id, 'End-to-end integration test',             '3.3', 'task',      105,  14,   0, 'not_started', l_qa, t_qa, g_ph3.id, critical=True, order=13)
    g3_4  = task(p2.id, 'Beta launch milestone',                   '3.4', 'milestone', 118,   1,   0, 'not_started', admin, None, g_ph3.id, milestone=True, order=14)

    for pred, succ in [
        (g1_1, g1_3), (g1_2, g1_3),
        (g1_3, g2_1), (g2_1, g2_2), (g2_2, g2_3), (g2_3, g2_4),
        (g2_4, g2_5), (g2_5, g_ph3),
        (g3_1, g3_3), (g3_2, g3_3), (g3_3, g3_4),
    ]:
        db.session.add(Dependency(predecessor_id=pred.id, successor_id=succ.id, dep_type='FS'))

    # ═══ PROJECT 3 — Voltage Stabilizer Mk-V ════════════════════════════════
    s_ph1 = task(p3.id, 'Phase 1: Concept',         '1',   'phase',     30,  21,  20, 'in_progress', team=t_hw, order=0)
    s1_1  = task(p3.id, 'Competitor benchmarking',  '1.1', 'task',      30,  10,  50, 'in_progress', pm1, None, s_ph1.id, order=1)
    s1_2  = task(p3.id, 'Power topology selection', '1.2', 'task',      40,   7,   0, 'not_started', l_hw, t_hw, s_ph1.id, order=2)
    s1_3  = task(p3.id, 'Concept approval',         '1.3', 'milestone', 51,   1,   0, 'not_started', admin, None, s_ph1.id, milestone=True, order=3)

    s_ph2 = task(p3.id, 'Phase 2: Design',                          '2',   'phase',      52,  60,   0, 'not_started', team=t_hw, order=4)
    s2_1  = task(p3.id, 'Servo motor control PCB design',           '2.1', 'task',       52,  21,   0, 'not_started', l_hw, t_hw, s_ph2.id, critical=True, order=5)
    s2_2  = task(p3.id, 'LCD display firmware',                     '2.2', 'task',       52,  14,   0, 'not_started', m3, t_fw, s_ph2.id, order=6)
    s2_3  = task(p3.id, 'Energy logging & Bluetooth interface',     '2.3', 'task',       73,  21,   0, 'not_started', l_fw, t_fw, s_ph2.id, order=7)
    s2_4  = task(p3.id, 'Design review',                            '2.4', 'milestone', 112,   1,   0, 'not_started', admin, None, s_ph2.id, milestone=True, order=8)

    for pred, succ in [
        (s1_1, s1_2), (s1_2, s1_3), (s1_3, s2_1),
        (s1_3, s2_2), (s2_1, s2_3), (s2_2, s2_3), (s2_3, s2_4),
    ]:
        db.session.add(Dependency(predecessor_id=pred.id, successor_id=succ.id, dep_type='FS'))

    # ═══ PROJECT 4 — Solar Charge Controller ════════════════════════════════
    sc_ph1 = task(p4.id, 'Phase 1: MPPT Algorithm R&D',          '1',   'phase',     -60,  30, 100, 'completed', team=t_fw, order=0)
    sc1_1  = task(p4.id, 'Literature review & simulation',        '1.1', 'task',      -60,  14, 100, 'completed', l_fw, t_fw, sc_ph1.id, order=1)
    sc1_2  = task(p4.id, 'Perturb & observe vs INC benchmark',   '1.2', 'task',      -46,  10, 100, 'completed', m3, t_fw, sc_ph1.id, order=2)
    sc1_3  = task(p4.id, 'Algorithm selection freeze',            '1.3', 'milestone', -36,   1, 100, 'completed', admin, None, sc_ph1.id, milestone=True, order=3)

    sc_ph2 = task(p4.id, 'Phase 2: Hardware Design (ON HOLD)',    '2',   'phase',     -35,  60,  30, 'on_hold', team=t_hw, order=4)
    sc2_1  = task(p4.id, 'Power stage schematic (40A MOSFET)',    '2.1', 'task',      -35,  21,  60, 'on_hold', m1, t_hw, sc_ph2.id, order=5)
    sc2_2  = task(p4.id, 'Gate driver & protection circuit',      '2.2', 'task',      -14,  14,  20, 'on_hold', m2, t_hw, sc_ph2.id, order=6)
    sc2_3  = task(p4.id, 'BLE stack integration',                 '2.3', 'task',      -14,  21,   0, 'not_started', m4, t_fw, sc_ph2.id, order=7)

    for pred, succ in [
        (sc1_1, sc1_2), (sc1_2, sc1_3), (sc1_3, sc2_1),
        (sc2_1, sc2_2), (sc2_1, sc2_3),
    ]:
        db.session.add(Dependency(predecessor_id=pred.id, successor_id=succ.id, dep_type='FS'))

    db.session.commit()

    # ── allocations ──────────────────────────────────────────────────────────
    for user, task_obj, pct in [
        (l_hw, t2_1, 80), (m1, t2_1, 100), (m2, t2_3, 100),
        (l_fw, t2_4, 100), (m3, t2_5, 100), (m4, t2_6, 80),
        (m5, g3_1, 100), (l_sw, g3_2, 100), (l_fw, g2_3, 80),
        (m1, g2_2, 60), (l_hw, s2_1, 100), (m3, s2_2, 80),
        (m1, sc2_1, 100), (m2, sc2_2, 100),
    ]:
        db.session.add(Allocation(
            user_id=user.id, task_id=task_obj.id, percent=pct,
            start_date=task_obj.start_date, end_date=task_obj.end_date,
        ))

    # ── approvals ────────────────────────────────────────────────────────────
    def d_date(offset_days):
        return d(offset_days)

    for task_obj, approver, stage, status, due in [
        (t1_3, admin, 'Feasibility Gate',   'approved', d_date(14)),
        (t2_7, pm1,   'Design Review',      'pending',  d_date(84)),
        (t2_7, admin, 'VP Sign-off',        'pending',  d_date(86)),
        (t3_5, pm1,   'EVT Gate',           'pending',  d_date(126)),
        (t3_5, admin, 'VP EVT Sign-off',    'pending',  d_date(128)),
        (t4_4, admin, 'Mass Production Go', 'pending',  d_date(168)),
        (g1_3, pm2,   'SoC Selection',      'approved', d_date(21)),
        (g3_4, admin, 'Beta Launch Gate',   'pending',  d_date(119)),
        (s1_3, pm1,   'Concept Approval',   'pending',  d_date(51)),
        (sc1_3, pm2,  'Algorithm Freeze',   'approved', d_date(-36)),
    ]:
        db.session.add(Approval(
            task_id=task_obj.id, approver_id=approver.id,
            stage=stage, status=status, due_date=due,
            notes='Auto-generated sample approval.' if status == 'pending'
                  else 'Reviewed and approved in design review meeting.',
            completed_at=datetime.utcnow() if status == 'approved' else None,
        ))

    # ── audit log ────────────────────────────────────────────────────────────
    ts = datetime.utcnow() - timedelta(days=10)
    for actor, etype, eid, field, old, new in [
        (pm1,  'project', p1.id,   'status',                'planning',    'active'),
        (l_hw, 'task',    t2_3.id, 'percent_complete',      '75',          '90'),
        (m3,   'task',    t2_5.id, 'percent_complete',      '40',          '60'),
        (pm2,  'project', p2.id,   'priority',              'medium',      'high'),
        (l_fw, 'task',    g2_3.id, 'percent_complete',      '50',          '70'),
        (pm1,  'project', p4.id,   'status',                'active',      'on_hold'),
        (admin,'project', p1.id,   'current_forecast_date', '2026-06-04',  '2026-07-14'),
        (m1,   'task',    g2_2.id, 'percent_complete',      '60',          '80'),
    ]:
        db.session.add(AuditLog(
            actor_id=actor.id, entity_type=etype, entity_id=eid,
            field_changed=field, old_value=old, new_value=new,
            timestamp=ts,
        ))
        ts += timedelta(hours=8)

    db.session.commit()
