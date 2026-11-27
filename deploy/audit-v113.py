#!/usr/bin/env python3
"""Targeted read-only investigation, no submit, retry, polling, or browser start."""
import json,subprocess,urllib.parse,urllib.request
from pathlib import Path
from datetime import datetime,timezone
env=dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
db=urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
def sql(q): return subprocess.check_output(['runuser','-u','postgres','--','psql','-d',db,'-At','-c',q],text=True,cwd='/tmp').strip()
def doc(key):
    value=sql("SELECT value FROM system_settings WHERE id='"+key+"'")
    return json.loads(value) if value else None
key='041227a7e77d34f71b3d28ebd494fe8b'
task=doc('generation-task-'+key)
job=doc('engagement-job-'+task['replyJobId']) if task and task.get('replyJobId') else None
draft=doc('engagement-draft-'+job['accountId']+'-'+job['draftId']) if job and job.get('draftId') else None
candidate=doc('engagement-candidate-'+job['accountId']+'-'+job['candidateId']) if job else None
permission=doc('reply-permission-'+task['permissionId']) if task and task.get('permissionId') else None
if permission: permission.pop('manual',None)
ids=[key]+([job['id'],job.get('draftId','')] if job else [])
inlist=','.join("'"+x+"'" for x in ids)
audit=json.loads(sql('SELECT coalesce(json_agg(r),\'[]\') FROM (SELECT action,actor,"entityId",detail,"createdAt" FROM audit_logs WHERE "entityId" IN ('+inlist+') ORDER BY "createdAt") r'))
status=None
try:
    url=env['ADSPOWER_BASE_URL'].rstrip('/')+'/api/v1/browser/active?user_id=k1j71gt4'
    req=urllib.request.Request(url,headers={'Authorization':'Bearer '+env['ADSPOWER_API_KEY']})
    r=json.load(urllib.request.urlopen(req,timeout=15))
    status={'code':r.get('code'),'status':r.get('data',{}).get('status')}
except Exception as e: status={'errorType':type(e).__name__}
units=['content-factory-api','content-factory-telegram','content-factory-vps-worker']
services={u:subprocess.check_output(['systemctl','is-active',u],text=True).strip() for u in units}
report={'at':datetime.now(timezone.utc).isoformat(),'release':str(Path('/opt/content-factory/current').resolve()),'task':task,'job':job,'draft':draft,'candidate':candidate,'permission':permission,'audit':audit,'manualPolicy':doc('manual-policy-threads02'),'factoryPaused':doc('factoryPaused'),'automationPaused':doc('automationPaused'),'emergencyStop':doc('emergencyStop'),'adsPowerStatus':status,'services':services,'publishedPosts':int(sql('SELECT count(*) FROM published_posts')),'publishedCtas':int(sql('SELECT count(*) FROM published_comments'))}
path=Path('/var/lib/content-factory/reports/KEEP-v113-reply-audit.json');path.write_text(json.dumps(report,ensure_ascii=False,indent=2));path.chmod(0o600)
print(json.dumps({k:report[k] for k in ['at','release','task','job','permission','audit','manualPolicy','factoryPaused','automationPaused','emergencyStop','adsPowerStatus','services','publishedPosts','publishedCtas']},ensure_ascii=False))
