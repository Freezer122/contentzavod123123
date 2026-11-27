#!/usr/bin/env python3
"""Code-only cutover. Refuse to interrupt any browser or publication operation."""
import os,subprocess,json,urllib.request,urllib.parse
from pathlib import Path
root=Path('/opt/content-factory');release=root/'releases/20261121-v116-production'
previous=(root/'current').resolve()
env=dict(os.environ)
env.update(dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#')))
env['PATH']='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin'
assert env['BROWSER_EXECUTION_MODE']==env['ENGAGEMENT_EXECUTION_MODE']=='DRY_RUN'
assert env['PROFILE_CHANGES_ALLOWED']=='0'
db=urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
def sql(q):return subprocess.check_output(['runuser','-u','postgres','--','psql','-d',db,'-At','-c',q],text=True,cwd='/tmp').strip()
request=urllib.request.Request('http://127.0.0.1:3000/health',headers={'Authorization':'Bearer '+env['INTERNAL_API_TOKEN']})
health=json.load(urllib.request.urlopen(request,timeout=20))
assert health['activeBrowsers']==health['providerSessions']==0,'BROWSER_BUSY'
assert sql("SELECT count(*) FROM publishing_jobs WHERE status='RUNNING'")=='0','PUBLICATION_BUSY'
assert sql("SELECT count(*) FROM system_settings WHERE id LIKE 'generation-task-%' AND value::jsonb->>'status' IN ('RUNNING','QUEUED')")=='0','GENERATION_BUSY'
units=['content-factory-telegram','content-factory-vps-worker','content-factory-api']
manual_env=Path('/etc/content-factory/manual-settings.env').read_bytes()
subprocess.run(['systemctl','stop',*units],check=True)
try:
 backup=Path('/var/lib/content-factory/backups/KEEP-before-v116-production');backup.mkdir(mode=0o700,exist_ok=True)
 result=subprocess.run(['node','scripts/backup.mjs'],cwd=release,env={**env,'BACKUP_DIR':str(backup)},capture_output=True)
 assert result.returncode==0,'BACKUP_FAILED'
 link=root/'current-v116-next';link.symlink_to(release);link.replace(root/'current')
 subprocess.run(['systemctl','start',*units],check=True)
 assert Path('/etc/content-factory/manual-settings.env').read_bytes()==manual_env
 subprocess.run(['systemctl','is-active','--quiet',*units],check=True)
except Exception:
 subprocess.run(['systemctl','stop',*units],check=True)
 link=root/'current-v116-rollback';link.symlink_to(previous);link.replace(root/'current')
 subprocess.run(['systemctl','start',*units],check=True)
 raise
print(json.dumps({'release':str(release),'environmentUnchanged':True,'manualPolicyUnchanged':True,'publishing':'DRY_RUN','engagement':'DRY_RUN'}))
