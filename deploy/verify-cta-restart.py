"""Idle-only restart acceptance after the approved LIVE CTA is confirmed."""
import datetime, json, subprocess, time, urllib.parse, urllib.request
from pathlib import Path

env = dict(line.split('=', 1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
db = urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
proof = json.loads(Path('/var/lib/content-factory/reports/KEEP-cta-approved-live.json').read_text())
assert proof['child']['status'] == 'PUBLISHED', 'LIVE_CTA_NOT_CONFIRMED'
job_id, parent_id = proof['job']['id'], proof['parent']['id']

def sql(q):
    return subprocess.check_output(['/usr/sbin/runuser', '-u', 'postgres', '--', 'psql', '-d', db, '-At', '-c', q], text=True, cwd='/tmp', timeout=20).strip()

def idle():
    assert sql("SELECT count(*) FROM publishing_jobs WHERE status='RUNNING'") == '0', 'PUBLICATION_BUSY'
    assert sql("SELECT count(*) FROM system_settings WHERE id LIKE 'generation-task-%' AND value::jsonb->>'status'='RUNNING'") == '0', 'GENERATION_BUSY'
    request = urllib.request.Request('http://127.0.0.1:3000/health', headers={'Authorization': 'Bearer ' + env['INTERNAL_API_TOKEN']})
    health = json.load(urllib.request.urlopen(request, timeout=20))
    assert health['activeBrowsers'] == health['providerSessions'] == 0, 'BROWSER_BUSY'

def snapshot():
    return {
        'postCount': sql("SELECT count(*) FROM published_posts WHERE \"jobId\"='" + job_id + "'"),
        'commentCount': sql("SELECT count(*) FROM published_comments WHERE \"postId\"='" + parent_id + "'"),
        'parentJob': sql("SELECT row_to_json(j) FROM publishing_jobs j WHERE id='" + job_id + "'"),
        'child': sql("SELECT (value::jsonb - 'notifiedSignature') FROM system_settings WHERE id='cta-task-" + job_id + "'"),
        'autopilot': sql("SELECT value FROM system_settings WHERE id='autopilot-account-threads02'"),
    }

idle()
before = snapshot()
assert before['postCount'] == before['commentCount'] == '1', 'RESULT_COUNTS_INVALID'
subprocess.run(['systemctl', 'stop', 'content-factory-vps-worker'], check=True)
try:
    idle()
    assert before == snapshot(), 'STATE_CHANGED_DURING_STOP'
finally:
    subprocess.run(['systemctl', 'start', 'content-factory-vps-worker'], check=True)
subprocess.run(['systemctl', 'is-active', '--quiet', 'content-factory-vps-worker'], check=True)
time.sleep(25)  # More than two regular queue ticks; never calls execute/enqueue itself.
after = snapshot()
assert before == after, 'STATE_CHANGED_AFTER_RESTART'
result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'jobId': job_id,
          'postCount': 1, 'commentCount': 1, 'parentAndChildUnchanged': True,
          'autopilotUnchanged': True, 'workerActive': True, 'observationSeconds': 25}
p = Path('/var/lib/content-factory/reports/KEEP-cta-restart.json')
p.write_text(json.dumps(result, indent=2)); p.chmod(0o600)
print(json.dumps(result))
