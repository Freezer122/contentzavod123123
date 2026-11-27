#!/usr/bin/env python3
"""Read-only final proof. Never prints environment secrets or source bodies."""
import json, subprocess, urllib.parse, urllib.request, urllib.error, time
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
    assert not any(values.get(k) for k in ['ONE_SHOT_REPLY_JOB_ID','ONE_SHOT_REPLY_USER_ID','ONE_SHOT_REPLY_EXPIRES_AT'])
    processes.append({'unit':unit,'active':True,'enabled':True,'role':values['PROCESS_ROLE'],'keyPresent':True,'release':str(Path(f'/proc/{pid}/cwd').resolve())})
    logs=subprocess.check_output(['journalctl','-u',unit,'--since','2026-11-20 08:00:00 UTC','--no-pager'],text=True)
    assert values['OPENAI_API_KEY'] not in logs,'SECRET_IN_LOG'
request=urllib.request.Request('http://127.0.0.1:3000/health',headers={'Authorization':'Bearer '+env['INTERNAL_API_TOKEN']})
for attempt in range(10):
    try:
        health=json.load(urllib.request.urlopen(request,timeout=20));break
    except urllib.error.URLError:
        if attempt==9:raise
        time.sleep(2)
assert health['database']=='OK' and health['redis']=='PONG'
assert health['activeBrowsers']==0 and health['providerSessions']==0
paused=sql("SELECT value FROM system_settings WHERE id='factoryPaused'")
assert paused=='true'
schedule=json.loads(sql("SELECT value FROM system_settings WHERE id='engagement-schedule-threads02'"))
proof={'ok':True,'processes':processes,'factoryPaused':True,'health':health,'posts':int(sql('SELECT count(*) FROM published_posts')),'comments':int(sql('SELECT count(*) FROM published_comments')),'schedule':schedule,'workerHeartbeat':json.loads(sql("SELECT value FROM system_settings WHERE id='engagement-queue-state'")),'secretMode':oct(Path('/etc/content-factory-secrets/openai.env').stat().st_mode&0o777),'keyAbsentFromJournals':True}
assert proof['posts']==1 and proof['comments']==1
proof['operatorLiveAuthorization']=False
proof['sunBrowserProcesses']=sum(1 for p in Path('/proc').glob('[0-9]*/exe') if 'sunbrowser' in str(p.resolve()).lower())
assert proof['sunBrowserProcesses']==0
state=json.loads(sql("SELECT value FROM system_settings WHERE id='v111-acceptance'"))
synthetic={str(x) for x in state.get('syntheticUpdates',[])}
actions=json.loads(sql("SELECT coalesce(json_agg(json_build_object('id',\"entityId\",'at',\"createdAt\",'detail',detail)),'[]') FROM audit_logs WHERE actor='7842338078' AND action='TELEGRAM_ACTION' AND detail LIKE 'v111%'"))
proof['realTelegramButtons']=[{'action':x['detail'].split(':')[0],'at':x['at']} for x in actions if x['id'] not in synthetic]
jobs=json.loads(sql("SELECT coalesce(json_agg(value::jsonb),'[]') FROM system_settings WHERE id LIKE 'engagement-job-%'"))
assert not any(j.get('submittedAt') or j.get('url') for j in jobs)
proof['userApprovedWaiting']=sum(1 for j in jobs if j.get('executionStatus')=='WAITING' and str(j.get('actor','')).isdigit() and j.get('kind')=='REPLY')
proof['replyJobs']=len(jobs)
proof['publishedReplies']=0
proof['consumedPermissions']=int(sql("SELECT count(*) FROM system_settings WHERE id LIKE 'reply-permission-%' AND value::jsonb->>'state'='CONSUMED'"))
assert proof['consumedPermissions']==0
path=Path('/var/lib/content-factory/reports/KEEP-v111-final-state.json')
path.write_text(json.dumps(proof,ensure_ascii=False,indent=2));path.chmod(0o600)
print(json.dumps(proof,ensure_ascii=False))
