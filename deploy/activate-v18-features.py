#!/usr/bin/env python3
"""Activate reviewed V1.8 extensions; no LIVE flags are changed."""
import os,subprocess,json
from pathlib import Path
release=Path('/opt/content-factory/releases/20261119-v18-features')
node='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin/node'
env=dict(os.environ)
env.update(dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#')))
assert env['BROWSER_EXECUTION_MODE']=='DRY_RUN'
config=Path('/etc/content-factory/worker.env')
values=dict(line.split('=',1) for line in config.read_text().splitlines() if '=' in line and not line.startswith('#'))
values.update(PROFILE_CHANGES_ALLOWED='0',ENGAGEMENT_EXECUTION_MODE='DRY_RUN')
config.write_text(''.join(f'{key}={value}\n' for key,value in values.items()))
os.chmod(config,0o640)
env.update(PROFILE_CHANGES_ALLOWED='0',ENGAGEMENT_EXECUTION_MODE='DRY_RUN',PATH='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin')
units=['content-factory-telegram','content-factory-vps-worker','content-factory-api']
subprocess.run(['systemctl','stop',*units],check=True)
try:
    backup=Path('/var/lib/content-factory/backups/KEEP-before-v18-extensions');backup.mkdir(mode=0o700,exist_ok=True)
    p=subprocess.run([node,'scripts/backup.mjs'],env={**env,'BACKUP_DIR':str(backup)},cwd=release,capture_output=True,text=True)
    if p.returncode:raise RuntimeError('PRE_EXTENSION_BACKUP_FAILED')
    p=subprocess.run([node,'node_modules/prisma/build/index.js','migrate','deploy'],env=env,cwd=release,capture_output=True,text=True)
    if p.returncode:raise RuntimeError('EXTENSION_MIGRATION_FAILED')
    print(p.stdout)
    nextlink=Path('/opt/content-factory/current-next');nextlink.symlink_to(release);nextlink.replace('/opt/content-factory/current')
finally:
    subprocess.run(['systemctl','start',*units],check=True)
print(json.dumps({'release':str(release),'publishingMode':'DRY_RUN','profileChangesAllowed':False,'engagementMode':'DRY_RUN'}))
