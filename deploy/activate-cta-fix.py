"""Code-only cutover while the approved LIVE schedule remains unchanged. Never activates publication."""
import os, json, subprocess, urllib.request, urllib.parse
from pathlib import Path
root = Path('/opt/content-factory')
release = root/'releases/20261121-cta-fix'
previous = (root/'current').resolve()
env = dict(os.environ)
env.update(dict(line.split('=', 1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#')))
db = urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
def sql(q):
 return subprocess.check_output(['/usr/sbin/runuser','-u','postgres','--','psql','-d',db,'-At','-c',q],text=True,cwd='/tmp').strip()
def safety():
 assert sql("SELECT value::jsonb->>'state' FROM system_settings WHERE id='autopilot-account-threads02'") == 'RUNNING'
 assert sql("SELECT value FROM system_settings WHERE id='automationPaused'") == 'false'
 assert sql("SELECT value::jsonb->'config'->>'allowCTA' FROM system_settings WHERE id='autopilot-account-threads02'") == 'false'
 assert sql("SELECT count(*) FROM publishing_jobs WHERE status='RUNNING'") == '0'
 assert sql("SELECT count(*) FROM system_settings WHERE id LIKE 'generation-task-%' AND value::jsonb->>'status'='RUNNING'") == '0'
safety()
request = urllib.request.Request('http://127.0.0.1:3000/health',headers={'Authorization':'Bearer '+env['INTERNAL_API_TOKEN']})
h = json.load(urllib.request.urlopen(request, timeout=20))
assert h['activeBrowsers'] == h['providerSessions'] == 0
plan_query = "SELECT id,value FROM system_settings WHERE id LIKE 'autopilot-plan-threads02-%' ORDER BY id"
plans = sql(plan_query)
autopilot = sql("SELECT value FROM system_settings WHERE id='autopilot-account-threads02'")
children = sql("SELECT count(*) FROM system_settings WHERE id LIKE 'cta-task-%'")
manual = Path('/etc/content-factory/manual-settings.env').read_bytes()
units = ['content-factory-telegram','content-factory-vps-worker','content-factory-api']
subprocess.run(['systemctl','stop',*units],check=True)
try:
 safety()
 link = root/'current-cta-fix'; link.symlink_to(release); link.replace(root/'current')
 subprocess.run(['systemctl','start',*units],check=True)
 subprocess.run(['systemctl','is-active','--quiet',*units],check=True)
 safety()
 assert plans == sql(plan_query), 'SCHEDULE_CHANGED_AFTER_RESTART'
 assert manual == Path('/etc/content-factory/manual-settings.env').read_bytes()
 assert autopilot == sql("SELECT value FROM system_settings WHERE id='autopilot-account-threads02'")
 assert children == sql("SELECT count(*) FROM system_settings WHERE id LIKE 'cta-task-%'"), 'BACKFILL_CREATED'
except Exception:
 subprocess.run(['systemctl','stop',*units],check=True)
 link = root/'current-cta-fix-rollback'; link.symlink_to(previous); link.replace(root/'current')
 subprocess.run(['systemctl','start',*units],check=True)
 raise
print(json.dumps({'release':str(release),'services':'active','plansSurvivedRestart':True,'manualUnchanged':True,'autopilot':'RUNNING','liveSubmit':False}))
