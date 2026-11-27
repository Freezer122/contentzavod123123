#!/usr/bin/env python3
"""Restore an already verified frozen dump, then independently audit before app startup."""
import os, subprocess, json, grp, pwd, sys
from pathlib import Path
from urllib.parse import urlparse, unquote
root=Path('/var/lib/content-factory/KEEP-v18-transfer')
source=root/'var/lib/content-factory/KEEP-v18-transfer'
env=dict(os.environ)
env.update(dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#')))
u=urlparse(env['DATABASE_URL'])
pg={**env,'PGHOST':u.hostname,'PGPORT':str(u.port or 5432),'PGDATABASE':u.path[1:],'PGUSER':unquote(u.username),'PGPASSWORD':unquote(u.password),'PGOPTIONS':'-c timezone=UTC'}
if '--verify-only' not in sys.argv:
    result=subprocess.run(['pg_restore','--exit-on-error','--no-owner','--no-acl','--dbname',u.path[1:],str(source/'database.dump')],env=pg,capture_output=True)
    if result.returncode: raise SystemExit('PG_RESTORE_FAILED')
node='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin/node'
cwd='/opt/content-factory/releases/20261119-v18'
for script,extra in [('migration-audit',{'MIGRATION_AUDIT_PATH':str(root/'restored-audit.json')}),('migrate-redis',{'REDIS_MIGRATION_MODE':'import','REDIS_SNAPSHOT_PATH':str(source/'redis.json')})]:
    p=subprocess.run([node,f'dist-tools/scripts/{script}.js'],env={**env,**extra},cwd=cwd,capture_output=True,text=True)
    if p.returncode: raise SystemExit(f'{script}: VERIFY_FAILED')
    print(p.stdout.strip())
before=json.loads((source/'audit.json').read_text())
after=json.loads((root/'restored-audit.json').read_text())
assert before['tables']==after['tables'], 'LOGICAL_DATA_DIFFERENT'
assert before['migrations']==after['migrations'], 'MIGRATION_HISTORY_DIFFERENT'
check=subprocess.run(['psql','-X','-At','-c',"SELECT (SELECT value FROM system_settings WHERE id='factoryPaused'), (SELECT count(*) FROM threads_accounts WHERE status='ACTIVE'), (SELECT count(*) FROM publishing_jobs WHERE status='RUNNING'), (SELECT count(*) FROM system_settings WHERE id='v15-verified-legacy-prisma-timezone')"],env=pg,capture_output=True,text=True,check=True).stdout.strip()
assert check=='true|0|0|0', 'UNSAFE_RESTORED_STATE'
# A real restore test into an independent temporary database, including history.
subprocess.run(['runuser','-u','postgres','--','createdb','-O','cf_factory','cf_v18_restore_check'],cwd='/tmp',check=True)
try:
    p=subprocess.run(['pg_restore','--exit-on-error','--no-owner','--no-acl','--dbname','cf_v18_restore_check',str(source/'database.dump')],env=pg,capture_output=True)
    if p.returncode: raise SystemExit('RESTORE_TEST_FAILED')
finally:
    subprocess.run(['runuser','-u','postgres','--','dropdb','cf_v18_restore_check'],cwd='/tmp',check=True)
report={'logicalDataEqual':True,'tables':len(before['tables']),'logicalHash':before['logicalHash'],'migrationHistoryEqual':True,'migrationCount':len(before['migrations']),'restoreTest':True,'factoryPaused':True,'workerMode':'DRY_RUN'}
Path('/var/lib/content-factory/reports/KEEP-v18-migration-validation.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
