#!/usr/bin/env python3
"""Targeted read-only generation audit. No model calls, browser, polling or sends."""
import json,subprocess,urllib.parse
from pathlib import Path
env=dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
db=urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
def sql(q):return subprocess.check_output(['runuser','-u','postgres','--','psql','-d',db,'-At','-c',q],text=True,cwd='/tmp').strip()
def doc(k):
 v=sql("SELECT value FROM system_settings WHERE id='"+k+"'");return json.loads(v) if v else None
def docs(prefix):return json.loads(sql("SELECT coalesce(json_agg(value::jsonb),'[]') FROM system_settings WHERE id LIKE '"+prefix+"%'"))
task=doc('generation-task-c1fc7049bcf995a0e5316c3f49e476cf')
candidate=doc('engagement-candidate-'+task['accountId']+'-'+task['candidateId']) if task else None
drafts=docs('engagement-draft-threads02-')
related=[d for d in drafts if task and d['candidateId']==task['candidateId']]
ai=json.loads(sql('SELECT coalesce(json_agg(x),\'[]\') FROM (SELECT id,"createdAt",model,purpose,status,"inputTokens","outputTokens","costUsd","providerResponseId" FROM ai_requests ORDER BY "createdAt" DESC LIMIT 30) x'))
caches=[v for v in docs('aux-cache-') if v.get('requestId') in [d.get('requestId') for d in related]]
logs={u:subprocess.check_output(['journalctl','-u',u,'--since','2026-11-20 19:00:00 UTC','--no-pager','-o','cat'],text=True) for u in ['content-factory-telegram','content-factory-vps-worker']}
safe_logs={u:[l for l in s.splitlines() if any(k in l for k in ['GENERATION','Generation','delivery','Delivery','BOT_STAGE','Error','error','403','400','429'])][-100:] for u,s in logs.items()}
report={'task':task,'candidate':candidate,'relatedDrafts':related,'relatedCache':caches,'ai':ai,'candidates':docs('engagement-candidate-threads02-'),'drafts':drafts,'tasks':docs('generation-task-'),'settings':doc('engagement-config-threads02'),'flow':doc('v18-flow-7842338078'),'manual':doc('manual-policy-threads02'),'factoryPaused':doc('factoryPaused'),'automationPaused':doc('automationPaused'),'emergencyStop':doc('emergencyStop'),'services':{u:subprocess.check_output(['systemctl','is-active',u],text=True).strip() for u in ['content-factory-telegram','content-factory-vps-worker','content-factory-api']},'logs':safe_logs}
path=Path('/var/lib/content-factory/reports/KEEP-v115-generation-before.json');path.write_text(json.dumps(report,ensure_ascii=False,indent=2));path.chmod(0o600)
print(json.dumps({'task':task,'candidate':candidate,'drafts':related,'cache':caches,'aiCount':len(ai),'services':report['services'],'candidateStates':{s:sum(c['status']==s for c in report['candidates']) for s in ['NEW','DRAFTED','REJECTED','HANDLED']},'logs':safe_logs},ensure_ascii=False))
