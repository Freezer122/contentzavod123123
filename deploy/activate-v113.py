#!/usr/bin/env python3
"""Code-only V1.13 cutover; account manual policy and all environment flags are preserved."""
import os,subprocess,json
from pathlib import Path
root=Path('/opt/content-factory');release=root/'releases/20261120-v113-feed'
previous=(root/'current').resolve()
env=dict(os.environ)
env.update(dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#')))
env['PATH']='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin'
assert env['BROWSER_EXECUTION_MODE']=='DRY_RUN' and env['ENGAGEMENT_EXECUTION_MODE']=='DRY_RUN'
assert env['PROFILE_CHANGES_ALLOWED']=='0'
units=['content-factory-telegram','content-factory-vps-worker','content-factory-api']
manual_env=Path('/etc/content-factory/manual-settings.env').read_bytes()
subprocess.run(['systemctl','stop',*units],check=True)
try:
 backup=Path('/var/lib/content-factory/backups/KEEP-before-v113');backup.mkdir(mode=0o700,exist_ok=True)
 result=subprocess.run(['node','scripts/backup.mjs'],cwd=release,env={**env,'BACKUP_DIR':str(backup)},capture_output=True)
 assert result.returncode==0,'BACKUP_FAILED'
 link=root/'current-v113-next';link.symlink_to(release);link.replace(root/'current')
 subprocess.run(['systemctl','start',*units],check=True)
 assert Path('/etc/content-factory/manual-settings.env').read_bytes()==manual_env
 subprocess.run(['systemctl','is-active','--quiet',*units],check=True)
except Exception:
 subprocess.run(['systemctl','stop',*units],check=True)
 link=root/'current-v113-rollback';link.symlink_to(previous);link.replace(root/'current')
 subprocess.run(['systemctl','start',*units],check=True)
 raise
print(json.dumps({'release':str(release),'environmentUnchanged':True,'manualPolicyUnchanged':True,'publishing':'DRY_RUN','engagement':'DRY_RUN'}))
