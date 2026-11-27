#!/usr/bin/env python3
"""Read-only pre-AUTOPILOT audit. Credentials are read privately, never printed."""
import json,subprocess,urllib.parse,urllib.request,datetime
from pathlib import Path
env=dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
db=urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
def sql(q):return subprocess.check_output(['runuser','-u','postgres','--','psql','-d',db,'-At','-c',q],text=True,cwd='/tmp').strip()
def doc(k):
 v=sql("SELECT value FROM system_settings WHERE id='"+k+"'");return json.loads(v) if v else None
def grouped(q):return json.loads(sql("SELECT coalesce(json_agg(x),'[]') FROM ("+q+") x"))
units=[]
for unit in ['content-factory-api','content-factory-telegram','content-factory-vps-worker']:
 pid=int(subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value']))
 vals=dict(v.split('=',1) for v in Path(f'/proc/{pid}/environ').read_text().split('\0') if '=' in v)
 units.append({'unit':unit,'active':subprocess.check_output(['systemctl','is-active',unit],text=True).strip(),'cwd':str(Path(f'/proc/{pid}/cwd').resolve()),'safeConfig':{k:vals.get(k) for k in ['BROWSER_EXECUTION_MODE','ENGAGEMENT_EXECUTION_MODE','PROFILE_CHANGES_ALLOWED','BROWSER_CONCURRENCY','MANUAL_LIVE_ALLOWED','POST_MODEL','REPLY_MODEL','AI_TOTAL_LIMIT_USD']}})
request=urllib.request.Request('http://127.0.0.1:3000/health',headers={'Authorization':'Bearer '+env['INTERNAL_API_TOKEN']})
health=json.load(urllib.request.urlopen(request,timeout=20))
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'units':units,'health':health,'manual':doc('manual-policy-threads02'),'factoryPaused':doc('factoryPaused'),'automationPaused':doc('automationPaused'),'emergencyStop':doc('emergencyStop'),'autopilot':doc('autopilot-config-threads02'),'v115Verified':doc('v115-generation-hotfix-verified'),'lastReplySelection':doc('reply-selection-threads02-7842338078'),'engagement':doc('engagement-config-threads02'),'generation':grouped("SELECT value::jsonb->>'kind' AS kind,value::jsonb->>'status' AS status,count(*) FROM system_settings WHERE id LIKE 'generation-task-%' GROUP BY 1,2"),'publishing':grouped('SELECT status,"postStatus","commentStatus",count(*) FROM publishing_jobs GROUP BY 1,2,3'),'ai':grouped('SELECT model,count(*),sum("inputTokens") AS input,sum("outputTokens") AS output,sum("costUsd") AS cost FROM ai_requests GROUP BY model'),'publishedPosts':grouped('SELECT p.id,p.url,p."jobId",p."generatedId" FROM published_posts p'),'publishedCtas':grouped('SELECT id,"postId",url,text FROM published_comments'),'recentManualAudit':grouped("SELECT actor,action,\"entityId\",detail,\"createdAt\" FROM audit_logs WHERE action IN ('MANUAL_CTA_RESUMED','MANUAL_CTA_CONFIRMED','MANUAL_REPLY_CONFIRMED','TELEGRAM_ACTION','CREATE_BATCH') ORDER BY \"createdAt\" DESC LIMIT 20"),'humanExamples':int(sql("SELECT count(*) FROM system_settings WHERE id LIKE 'quality-human-%' AND NOT (value::jsonb ? 'deletedAt')"))}
p=Path('/var/lib/content-factory/reports/KEEP-v116-before.json');p.write_text(json.dumps(report,ensure_ascii=False,indent=2));p.chmod(0o600)
print(json.dumps(report,ensure_ascii=False))
