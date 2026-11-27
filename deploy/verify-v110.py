#!/usr/bin/env python3
"""Read-only final proof. Never prints environment secrets or source bodies."""
import json, subprocess, urllib.parse, urllib.request
from pathlib import Path
env=dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
db=urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
def sql(q):
    return subprocess.check_output(['runuser','-u','postgres','--','psql','-d',db,'-At','-c',q],text=True,cwd='/tmp').strip()
units=['content-factory-api','content-factory-telegram','content-factory-vps-worker']
processes=[]
for unit in units:
    assert subprocess.check_output(['systemctl','is-active',unit],text=True).strip()=='active'
    assert subprocess.check_output(['systemctl','is-enabled',unit],text=True).strip()=='enabled'
    pid=int(subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value']))
    values=dict(x.split('=',1) for x in Path(f'/proc/{pid}/environ').read_text().split('\0') if '=' in x)
    assert values['BROWSER_EXECUTION_MODE']=='DRY_RUN' and values['ENGAGEMENT_EXECUTION_MODE']=='DRY_RUN' and values['PROFILE_CHANGES_ALLOWED']=='0'
    assert values['LLM_PROVIDER']=='openai' and values.get('OPENAI_API_KEY')
    processes.append({'unit':unit,'active':True,'enabled':True,'role':values['PROCESS_ROLE'],'keyPresent':True,'release':str(Path(f'/proc/{pid}/cwd').resolve())})
    logs=subprocess.check_output(['journalctl','-u',unit,'--since','2026-11-20 08:00:00 UTC','--no-pager'],text=True)
    assert values['OPENAI_API_KEY'] not in logs,'SECRET_IN_LOG'
request=urllib.request.Request('http://127.0.0.1:3000/health',headers={'Authorization':'Bearer '+env['INTERNAL_API_TOKEN']})
health=json.load(urllib.request.urlopen(request,timeout=20))
assert health['database']=='OK' and health['redis']=='PONG'
assert health['activeBrowsers']==0 and health['providerSessions']==0
paused=sql("SELECT value FROM system_settings WHERE id='factoryPaused'")
assert paused=='true'
schedule=json.loads(sql("SELECT value FROM system_settings WHERE id='engagement-schedule-threads02'"))
proof={'ok':True,'processes':processes,'factoryPaused':True,'health':health,'posts':int(sql('SELECT count(*) FROM published_posts')),'comments':int(sql('SELECT count(*) FROM published_comments')),'schedule':schedule,'workerHeartbeat':json.loads(sql("SELECT value FROM system_settings WHERE id='engagement-queue-state'")),'secretMode':oct(Path('/etc/content-factory-secrets/openai.env').stat().st_mode&0o777),'keyAbsentFromJournals':True}
assert proof['posts']==1 and proof['comments']==1
path=Path('/var/lib/content-factory/reports/KEEP-v110-final-state.json')
path.write_text(json.dumps(proof,ensure_ascii=False,indent=2));path.chmod(0o600)
print(json.dumps(proof,ensure_ascii=False))
