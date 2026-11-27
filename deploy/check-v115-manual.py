#!/usr/bin/env python3
"""Read-only attribution of any independent manual actions during QA."""
exec(__import__('pathlib').Path('/opt/content-factory/current/deploy/audit-v115.py').read_text().split("task=doc(")[0])
state=doc('v115-hotfix-acceptance')
tasks=docs('generation-task-')
jobs=docs('engagement-job-')
new_jobs=[j for j in jobs if j.get('submittedAt','')>=state['startedAt']]
cards=[c for c in docs('manual-card-') if c.get('used')]
permissions=docs('reply-permission-')
report={'manual':doc('manual-policy-threads02'),'factoryPaused':doc('factoryPaused'),'automationPaused':doc('automationPaused'),'emergencyStop':doc('emergencyStop'),'newSentJobs':new_jobs,'sendTasks':[t for t in tasks if t.get('createdAt','')>=state['startedAt'] and t['kind']=='REPLY_SEND'],'usedCards':[c for c in cards if c.get('resultId') in [j['id'] for j in new_jobs] or c.get('entityId') in [j.get('draftId') for j in new_jobs]],'permissions':[p for p in permissions if p.get('jobId') in [j['id'] for j in new_jobs]],'selections':[a for a in json.loads(sql("SELECT coalesce(json_agg(x),'[]') FROM (SELECT actor,action,detail,\"createdAt\" FROM audit_logs WHERE action='REPLY_SELECTION' ORDER BY \"createdAt\" DESC LIMIT 8) x"))]}
report['processes']=[]
for unit in ['content-factory-api','content-factory-telegram','content-factory-vps-worker']:
 pid=int(subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value']))
 report['processes'].append({'unit':unit,'cwd':str(Path(f'/proc/{pid}/cwd').resolve())})
report['newPreparationTasks']=[t for t in tasks if t.get('createdAt','')>=state['startedAt'] and t['kind']=='REPLY']
report['lastSelection']=doc('reply-selection-threads02-7842338078')
report['compiledBotHasHotfix']='replySelection' in Path('/opt/content-factory/current/dist/bot/extensions-v18.js').read_text()
report['compiledQueueHasSelectionAudit']='REPLY_SELECTION' in Path('/opt/content-factory/current/dist/content/jobs.js').read_text()
report['newAuditActions']=json.loads(sql("SELECT coalesce(json_agg(x),'[]') FROM (SELECT actor,action,\"entityId\",\"createdAt\" FROM audit_logs WHERE \"createdAt\">='"+state['startedAt']+"'::timestamptz ORDER BY \"createdAt\" DESC LIMIT 25) x"))
for p in report['permissions']:p.pop('manual',None)
path=Path('/var/lib/content-factory/reports/KEEP-v115-independent-manual-actions.json');path.write_text(json.dumps(report,ensure_ascii=False,indent=2));path.chmod(0o600)
print(json.dumps(report,ensure_ascii=False))
