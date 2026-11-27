#!/usr/bin/env python3
import os,subprocess,pathlib,grp
release=pathlib.Path('/opt/content-factory/releases/20261120-v19-openai');node='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin/node'
env=dict(os.environ);env.update(dict(line.split('=',1) for line in pathlib.Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#')));env['PATH']='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin'
assert env['BROWSER_EXECUTION_MODE']=='DRY_RUN'
access=__import__('json').loads(pathlib.Path('/var/lib/content-factory/reports/KEEP-v19-model-access.json').read_text());assert not access['missing']
settings=pathlib.Path('/etc/content-factory/openai-settings.env');settings.write_text('LLM_PROVIDER=openai\nPOST_MODEL=gpt-6.2-sol\nREPLY_MODEL=gpt-6.1-terra\nBIO_MODEL=gpt-6.1-terra\nLLM_MAX_TOKENS=2048\nAI_TOTAL_LIMIT_USD=5\nAI_WARNING_USD=3\nAI_DAILY_LIMIT_USD=5\nAI_MONTHLY_LIMIT_USD=5\n');settings.chmod(0o640);os.chown(settings,0,grp.getgrnam('contentfactory').gr_gid)
subprocess.run(['systemctl','stop','content-factory-telegram','content-factory-api','content-factory-vps-worker'],check=True)
try:
 backup='/var/lib/content-factory/backups/KEEP-before-v19';pathlib.Path(backup).mkdir(mode=0o700,exist_ok=True)
 p=subprocess.run([node,'scripts/backup.mjs'],cwd=release,env={**env,'BACKUP_DIR':backup},capture_output=True);assert p.returncode==0,'BACKUP_FAILED'
 p=subprocess.run([node,'node_modules/prisma/build/index.js','migrate','deploy'],cwd=release,env=env,capture_output=True,text=True);assert p.returncode==0,'MIGRATION_FAILED';print(p.stdout)
finally:subprocess.run(['systemctl','start','content-factory-telegram','content-factory-api','content-factory-vps-worker'],check=True)
os.chown('/var/lib/content-factory/reports/KEEP-v19-model-access.json',__import__('pwd').getpwnam('contentfactory').pw_uid,grp.getgrnam('contentfactory').gr_gid)
print('V19_STAGED_OLD_SERVICES_RETAINED_NO_LIVE')
