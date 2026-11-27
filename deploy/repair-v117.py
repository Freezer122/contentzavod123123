"""Resume the four reviewed jobs only after the owner's explicit LIVE approval. No direct submit."""
import os, subprocess, pwd, urllib.parse, urllib.request, json
from pathlib import Path
release = Path('/opt/content-factory/current').resolve()
assert release.name == '20261121-v117-production-r2'
next_release=Path('/opt/content-factory/releases/20261121-v117-production-r3')
env = dict(os.environ)
for name in ['/etc/content-factory/worker.env','/etc/content-factory-secrets/telegram.env','/etc/content-factory/telegram.env','/etc/content-factory-secrets/openai.env','/etc/content-factory/openai-settings.env','/etc/content-factory/manual-settings.env']:
 env.update(dict(line.split('=',1) for line in Path(name).read_text().splitlines() if '=' in line and not line.startswith('#')))
env.update(PATH='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin',V117_WORKER_STOPPED='1')
db = urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
def sql(q):
 return subprocess.check_output(['/usr/sbin/runuser','-u','postgres','--','psql','-d',db,'-At','-c',q],text=True,cwd='/tmp').strip()
request = urllib.request.Request('http://127.0.0.1:3000/health',headers={'Authorization':'Bearer '+env['INTERNAL_API_TOKEN']})
h=json.load(urllib.request.urlopen(request,timeout=20))
assert h['activeBrowsers']==h['providerSessions']==0
assert sql("SELECT count(*) FROM publishing_jobs WHERE status='RUNNING'")=='0'
units=['content-factory-telegram','content-factory-vps-worker','content-factory-api']
user=pwd.getpwnam('contentfactory')
subprocess.run(['systemctl','stop',*units],check=True)
try:
 link=Path('/opt/content-factory/current-v117-r3');link.symlink_to(next_release);link.replace('/opt/content-factory/current')
 subprocess.run(['node','dist-tools/scripts/repair-v117-reply.js'],cwd=next_release,env=env,user=user.pw_uid,group=user.pw_gid,check=True,timeout=90)
except Exception:
 sql("UPDATE system_settings SET value=jsonb_set(jsonb_set(value::jsonb,'{state}','\"ERROR\"'::jsonb),'{error}','\"V117_REPLY_RECOVERY_FAILED: inspect schedule before resume\"'::jsonb)::text WHERE id='autopilot-account-threads02'")
 sql("UPDATE system_settings SET value='true' WHERE id='automationPaused'")
 raise
finally:
 subprocess.run(['systemctl','start',*units],check=True)
 subprocess.run(['systemctl','is-active','--quiet',*units],check=True)
print(json.dumps({'autopilot':'RUNNING','epoch':8,'limits':'5/20 09–22 Moscow','cta':False,'services':'active'}))
