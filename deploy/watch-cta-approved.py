"""Read-only observation of the already approved 19:13 slot. Never enqueues or submits."""
import datetime, json, os, pwd, subprocess, time, urllib.parse
from pathlib import Path

env = dict(line.split('=', 1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
db = urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
slot_id = 'ac01ec49f3a7eb84b0ff43'
plan_id = 'autopilot-plan-threads02-8-2026-11-21'
due = datetime.datetime.fromisoformat('2026-11-21T16:13:00+00:00').timestamp()
deadline = due + 15 * 60
last = None

def query(sql):
    raw = subprocess.check_output(['/usr/sbin/runuser', '-u', 'postgres', '--', 'psql', '-d', db, '-At', '-c', sql], text=True, cwd='/tmp', timeout=20).strip()
    return json.loads(raw) if raw else None

def save(result):
    p = Path('/var/lib/content-factory/reports/KEEP-cta-approved-live.json')
    p.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    p.chmod(0o600)
    owner = pwd.getpwnam('contentfactory')
    os.chown(p, owner.pw_uid, owner.pw_gid)

while True:
    plan = query("SELECT value::jsonb FROM system_settings WHERE id='" + plan_id + "'")
    slot = next((s for s in (plan or {}).get('slots', []) if s['id'] == slot_id), None)
    ap = query("SELECT value::jsonb FROM system_settings WHERE id='autopilot-account-threads02'")
    job_id = slot.get('publishingJobId') if slot else None
    job = query("SELECT row_to_json(j) FROM publishing_jobs j WHERE id='" + job_id + "'") if job_id else None
    child = query("SELECT value::jsonb FROM system_settings WHERE id='cta-task-" + job_id + "'") if job_id else None
    parent = query("SELECT row_to_json(p) FROM published_posts p WHERE \"jobId\"='" + job_id + "'") if job_id else None
    comments = query("SELECT coalesce(json_agg(c),'[]') FROM published_comments c WHERE \"postId\"='" + parent['id'] + "'") if parent else []
    snapshot = {'slot': slot, 'job': job, 'child': child, 'parent': parent, 'comments': comments,
                'autopilot': {'state': (ap or {}).get('state'), 'epoch': (ap or {}).get('epoch'), 'allowCTA': (ap or {}).get('config', {}).get('allowCTA')}}
    signature = json.dumps({'slotStatus': (slot or {}).get('status'), 'jobStatus': (job or {}).get('status'),
                            'postStatus': (job or {}).get('postStatus'), 'ctaStatus': (child or {}).get('status'),
                            'ap': snapshot['autopilot']}, sort_keys=True)
    if signature != last:
        print(json.dumps({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), **snapshot}, ensure_ascii=False), flush=True)
        last = signature
    terminal = (child or {}).get('status') in ['PUBLISHED', 'UNCERTAIN', 'FAILED', 'DISABLED']
    failed_slot = (slot or {}).get('status') in ['FAILED', 'SKIPPED', 'UNCERTAIN']
    if terminal or failed_slot or (ap or {}).get('state') != 'RUNNING':
        result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'observerReadOnly': True, **snapshot}
        if job and job.get('post_submit_at') and job.get('cta_submit_at'):
            result['submitIntervalSeconds'] = (datetime.datetime.fromisoformat(job['cta_submit_at']) - datetime.datetime.fromisoformat(job['post_submit_at'])).total_seconds()
        save(result)
        print(json.dumps({'terminal': True, **result}, ensure_ascii=False), flush=True)
        raise SystemExit(0)
    if time.time() >= deadline:
        break
    time.sleep(3 if time.time() >= due - 60 else 30)

save({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'observerReadOnly': True, 'timedOut': True, **snapshot})
print('CTA_OBSERVATION_DEADLINE', flush=True)
