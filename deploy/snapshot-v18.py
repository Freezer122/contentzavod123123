#!/usr/bin/env python3
"""Freeze ONLY Content Factory on source; leave all other projects untouched."""
import os, subprocess, json, hashlib
from pathlib import Path
cwd = '/opt/content-factory/current'
env = dict(os.environ)
env.update(dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#')))
assert env['BROWSER_EXECUTION_MODE'] == 'DRY_RUN'
subprocess.run(['systemctl','stop','content-factory-vps-worker','content-factory-telegram'], check=True)
out = Path('/var/lib/content-factory/KEEP-v18-transfer')
out.mkdir(mode=0o700, exist_ok=True)
node = '/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin/node'
for script, extra in [('migration-audit',{'MIGRATION_AUDIT_PATH':str(out/'audit.json')}),('migrate-redis',{'REDIS_MIGRATION_MODE':'export','REDIS_SNAPSHOT_PATH':str(out/'redis.json')})]:
    p = subprocess.run([node,f'dist-tools/scripts/{script}.js'],env={**env,**extra},cwd=cwd,capture_output=True,text=True)
    if p.returncode: raise SystemExit(f'{script}: SNAPSHOT_FAILED')
    print(p.stdout.strip())
with open(out/'database.dump','wb') as f:
    p = subprocess.run(['runuser','-u','postgres','--','pg_dump','--format=custom','--no-owner','content_factory'],stdout=f,stderr=subprocess.PIPE,cwd='/tmp')
if p.returncode: raise SystemExit('PG_DUMP_FAILED')
os.chmod(out/'database.dump',0o600)
archive='/var/lib/content-factory/backups/KEEP-v18-transfer.tgz'
paths=['etc/content-factory','etc/content-factory-secrets/telegram.env','var/lib/content-factory/KEEP-v18-transfer','var/lib/content-factory/approvals','var/lib/content-factory/media','var/lib/content-factory/artifacts','var/lib/content-factory/reports','var/lib/content-factory/backups']
p=subprocess.run(['tar','-czf',archive,'--exclude=var/lib/content-factory/backups/KEEP-v18-transfer.tgz','-C','/',*paths],stderr=subprocess.PIPE)
if p.returncode: raise SystemExit('STATE_ARCHIVE_FAILED')
os.chmod(archive,0o600)
digest=hashlib.sha256(Path(archive).read_bytes()).hexdigest()
Path(archive+'.sha256').write_text(digest+'\n')
print(json.dumps({'frozen':True,'archiveSha256':digest,'archiveBytes':os.stat(archive).st_size}))
