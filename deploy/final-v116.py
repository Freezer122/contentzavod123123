#!/usr/bin/env python3
"""Read-only final audit. No command lines, credentials or raw env are printed."""
import json,subprocess,urllib.parse,urllib.request,datetime
from pathlib import Path
env={}
for file in ['/etc/content-factory/worker.env','/etc/content-factory-secrets/telegram.env']:
 env.update(dict(line.split('=',1) for line in Path(file).read_text().splitlines() if '=' in line and not line.startswith('#')))
db=urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
def sql(q):return subprocess.check_output(['/usr/sbin/runuser','-u','postgres','--','psql','-d',db,'-At','-c',q],text=True,cwd='/tmp').strip()
def doc(k):
 value=sql("SELECT value FROM system_settings WHERE id='"+k+"'");return json.loads(value) if value else None
def grouped(q):return json.loads(sql("SELECT coalesce(json_agg(x),'[]') FROM ("+q+") x"))
request=urllib.request.Request('http://127.0.0.1:3000/health',headers={'Authorization':'Bearer '+env['INTERNAL_API_TOKEN']})
health=json.load(urllib.request.urlopen(request,timeout=20))
services=[]
for unit in ['content-factory-api','content-factory-telegram','content-factory-vps-worker']:
 pid=int(subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value']))
 cfg=dict(v.split('=',1) for v in Path(f'/proc/{pid}/environ').read_text().split('\0') if '=' in v)
 services.append({'unit':unit,'active':subprocess.check_output(['systemctl','is-active',unit],text=True).strip(),'enabled':subprocess.check_output(['systemctl','is-enabled',unit],text=True).strip(),'cwd':str(Path(f'/proc/{pid}/cwd').resolve()),'safeConfig':{k:cfg.get(k) for k in ['PROCESS_ROLE','BROWSER_EXECUTION_MODE','ENGAGEMENT_EXECUTION_MODE','PROFILE_CHANGES_ALLOWED','BROWSER_CONCURRENCY','MANUAL_LIVE_ALLOWED','POST_MODEL','REPLY_MODEL','AI_TOTAL_LIMIT_USD']}})
try:
 url='https://api.telegram.org/bot'+env['TELEGRAM_BOT_TOKEN']+'/getWebhookInfo'
 data=json.load(urllib.request.urlopen(url,timeout=20));webhook={'configured':bool(data.get('result',{}).get('url')),'pending':data.get('result',{}).get('pending_update_count')}
except Exception as e:webhook={'readErrorType':type(e).__name__}
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'services':services,'health':health,'webhook':webhook,'autopilot':doc('autopilot-account-threads02'),'readiness':doc('autopilot-readiness-v116'),'manual':doc('manual-policy-threads02'),'factoryPaused':doc('factoryPaused'),'automationPaused':doc('automationPaused'),'emergencyStop':doc('emergencyStop'),'generation':grouped("SELECT value::jsonb->>'kind' AS kind,value::jsonb->>'status' AS status,count(*) FROM system_settings WHERE id LIKE 'generation-task-%' GROUP BY 1,2"),'publishing':grouped('SELECT status,"postStatus","commentStatus",count(*) FROM publishing_jobs GROUP BY 1,2,3'),'autoGrants':grouped("SELECT value::jsonb->>'kind' AS kind,value::jsonb->>'mode' AS mode,count(*) FROM system_settings WHERE id LIKE 'autopilot-grant-%' GROUP BY 1,2"),'autoWork':grouped("SELECT value::jsonb->>'kind' AS kind,value::jsonb->>'status' AS status,count(*) FROM system_settings WHERE id LIKE 'autopilot-work-%' GROUP BY 1,2"),'ai':grouped('SELECT model,status,count(*),sum("inputTokens") AS input,sum("outputTokens") AS output,sum("costUsd") AS cost FROM ai_requests GROUP BY model,status'),'uiActions':grouped("SELECT actor,detail,\"createdAt\" FROM audit_logs WHERE action='TELEGRAM_ACTION' AND detail LIKE 'ap:%' ORDER BY \"createdAt\" DESC LIMIT 35"),'acceptance':doc('v116-acceptance')}
p=Path('/var/lib/content-factory/reports/KEEP-v116-final.json');p.write_text(json.dumps(report,ensure_ascii=False,indent=2));p.chmod(0o600)
assert report['autopilot']['state']=='OFF'
assert report['factoryPaused'] and report['automationPaused']
assert not report['emergencyStop']
assert health['activeBrowsers']==health['providerSessions']==0
assert not any(g['mode']=='LIVE' for g in report['autoGrants'])
assert not webhook.get('configured')
assert all(x['safeConfig']['BROWSER_EXECUTION_MODE']==x['safeConfig']['ENGAGEMENT_EXECUTION_MODE']=='DRY_RUN' for x in services)
print(json.dumps({'at':report['at'],'state':report['autopilot']['state'],'readiness':report['readiness'],'health':health,'webhook':webhook,'autoGrants':report['autoGrants'],'autoWork':report['autoWork'],'generation':report['generation'],'publishing':report['publishing'],'ai':report['ai'],'services':services},ensure_ascii=False))
