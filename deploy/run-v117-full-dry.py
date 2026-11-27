#!/usr/bin/env python3
"""Run bounded native acceptance as the existing service user; no second polling loop."""
import os,subprocess,pwd,time,json,statistics
from pathlib import Path
release=Path('/opt/content-factory/current').resolve();env=dict(os.environ)
for name in ['/etc/content-factory/worker.env','/etc/content-factory-secrets/telegram.env','/etc/content-factory/telegram.env','/etc/content-factory-secrets/openai.env','/etc/content-factory/openai-settings.env','/etc/content-factory/manual-settings.env']:
 env.update(dict(line.split('=',1) for line in Path(name).read_text().splitlines() if '=' in line and not line.startswith('#')))
env['PATH']='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin'
user=pwd.getpwnam('contentfactory')
import urllib.request
h=json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:3000/health',headers={'Authorization':'Bearer '+env['INTERNAL_API_TOKEN']}),timeout=20))
assert h['activeBrowsers']==h['providerSessions']==0,'PROFILE_BUSY'
units=['content-factory-telegram','content-factory-vps-worker','content-factory-api']
subprocess.run(['systemctl','stop',*units],check=True)
try:
 p=subprocess.run(['node','dist-tools/scripts/diagnose-v117-reply.js'],cwd=release,env={**env,'V117_WORKER_STOPPED':'1','V117_FULL_QUEUE_DRY':'1'},user=user.pw_uid,group=user.pw_gid,timeout=180)
finally:
 subprocess.run(['systemctl','start',*units],check=True)
 subprocess.run(['systemctl','is-active','--quiet',*units],check=True)
raise SystemExit(p.returncode)
