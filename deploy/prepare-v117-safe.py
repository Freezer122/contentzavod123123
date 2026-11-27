"""Deploy and rehearse with no publishing consumer; hold every new send for explicit approval."""
import os,json,subprocess,urllib.parse,urllib.request,time
from pathlib import Path
root=Path('/opt/content-factory');release=root/'releases/20261121-v117-production';previous=(root/'current').resolve()
env={**os.environ,'PATH':'/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/sbin:/usr/bin:/bin'}
env.update(dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#')))
db=urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
def sql(q):return subprocess.check_output(['/usr/sbin/runuser','-u','postgres','--','psql','-d',db,'-At','-c',q],text=True,cwd='/tmp').strip()
request=urllib.request.Request('http://127.0.0.1:3000/health',headers={'Authorization':'Bearer '+env['INTERNAL_API_TOKEN']});h=json.load(urllib.request.urlopen(request,timeout=20));assert h['activeBrowsers']==h['providerSessions']==0,'PROFILE_BUSY'
assert sql("SELECT count(*) FROM publishing_jobs WHERE status IN ('RUNNING','QUEUED')")=='0','EXISTING_PUBLICATION_WORK'
assert sql("SELECT count(*) FROM system_settings WHERE id LIKE 'generation-task-%' AND value::jsonb->>'status' IN ('RUNNING','QUEUED')")=='0','GENERATION_BUSY'
units=['content-factory-telegram','content-factory-vps-worker','content-factory-api'];subprocess.run(['systemctl','stop',*units],check=True)
result=None
try:
 b=Path('/var/lib/content-factory/backups/KEEP-before-v117');b.mkdir(mode=0o700,exist_ok=True)
 p=subprocess.run(['node','scripts/backup.mjs'],cwd=release,env={**env,'BACKUP_DIR':str(b)},capture_output=True);assert p.returncode==0,'BACKUP_FAILED'
 link=root/'current-v117-safe';link.symlink_to(release);link.replace(root/'current')
 result=subprocess.run(['/usr/bin/python3',str(release/'deploy/run-v117.py')],cwd=release,env={**env,'V117_PHASE':'prepare','V117_WORKER_STOPPED':'1'})
finally:
 sql("UPDATE system_settings SET value=jsonb_set(jsonb_set(value::jsonb,'{state}','\"ERROR\"'::jsonb),'{error}','\"AUTO_REVIEW_APPROVAL_REQUIRED: LIVE-тест требует отдельного подтверждения; submit заблокирован\"'::jsonb)::text WHERE id='autopilot-account-threads02'")
 sql("UPDATE system_settings SET value='true' WHERE id='automationPaused'")
 sql("UPDATE publishing_jobs SET status='PAUSED',\"lastError\"='V117_DRY_COMPLETE_AWAITING_EXPLICIT_APPROVAL' WHERE status='QUEUED' AND post_submit_at IS NULL AND id IN (SELECT value::jsonb->>'jobId' FROM system_settings WHERE id LIKE 'autopilot-grant-%' AND value::jsonb->>'accountId'='threads02' AND value::jsonb->>'createdAt'>=(SELECT value::jsonb->>'startedAt' FROM system_settings WHERE id='v117-acceptance'))")
 subprocess.run(['systemctl','start',*units],check=True)
 subprocess.run(['systemctl','is-active','--quiet',*units],check=True)
print(json.dumps({'release':str(release),'dryExitCode':result.returncode if result else None,'autopilot':'ERROR_APPROVAL_REQUIRED','liveSubmit':False,'servicesRestarted':True}))
if result and result.returncode:raise SystemExit(result.returncode)
