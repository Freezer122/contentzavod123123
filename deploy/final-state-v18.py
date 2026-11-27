#!/usr/bin/env python3
import json,subprocess,os,pathlib,pwd,datetime,shutil
root=pathlib.Path('/var/lib/content-factory/reports')
services={}
for name in ['content-factory-api','content-factory-telegram','content-factory-vps-worker','content-factory-adspower','content-factory-api-guard','content-factory-maintenance.timer','content-factory-backup.timer','postgresql','redis-server']:
 services[name]={k:subprocess.run(['systemctl',k,name],capture_output=True,text=True).stdout.strip() for k in ['is-active','is-enabled']}
env=dict(line.split('=',1) for line in pathlib.Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
sql='''SELECT json_build_object('factoryPaused',(SELECT value FROM system_settings WHERE id='factoryPaused'),'accounts',(SELECT json_agg(json_build_object('id',id,'status',status)) FROM threads_accounts),'posts',(SELECT count(*) FROM published_posts),'comments',(SELECT count(*) FROM published_comments),'llmRequests',(SELECT count(*) FROM ai_requests),'migrations',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL),'engagement',(SELECT value::json FROM system_settings WHERE id='engagement-config-threads02'),'engagementJobs',(SELECT json_agg(json_build_object('status',value::json->>'status','actor',value::json->>'actor')) FROM system_settings WHERE id LIKE 'engagement-job-%'));'''
state=json.loads(subprocess.check_output(['runuser','-u','postgres','--','psql','-X','-At','-d','content_factory','-c',sql],cwd='/tmp',text=True))
uid=pwd.getpwnam('contentfactory').pw_uid
browsers=0
for p in pathlib.Path('/proc').iterdir():
 try:
  if p.name.isdigit() and p.stat().st_uid==uid and 'sunbrowser' in (p/'comm').read_text().lower():browsers+=1
 except OSError:pass
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'services':services,'state':state,'executionMode':env['BROWSER_EXECUTION_MODE'],'profileChangesAllowed':env.get('PROFILE_CHANGES_ALLOWED','0'),'engagementMode':env.get('ENGAGEMENT_EXECUTION_MODE','DRY_RUN'),'browserConcurrency':env['BROWSER_CONCURRENCY'],'activeSunBrowserProcesses':browsers,'diskFreeGiB':round(shutil.disk_usage('/').free/1024**3,2),'release':os.path.realpath('/opt/content-factory/current'),'coreCommands':json.loads((root/'KEEP-v18-telegram-handlers.json').read_text()),'system':json.loads((root/'KEEP-v18-system.json').read_text()),'features':json.loads((root/'KEEP-v18-feature-check.json').read_text()),'like':json.loads((root/'KEEP-v18-like-check.json').read_text())}
assert report['executionMode']=='DRY_RUN' and report['profileChangesAllowed']=='0' and report['engagementMode']=='DRY_RUN'
assert state['factoryPaused']=='true' and all(a['status']=='PAUSED' for a in state['accounts'])
assert not state['engagement']['enabled'] and not state['engagement']['likes']
assert state['posts']==1 and state['comments']==1 and state['llmRequests']==0 and browsers==0
assert report['coreCommands']['ok'] and report['system']['notificationDelivered'] and report['features']['ok'] and report['like']['ok']
assert all(v['is-active']=='active' and v['is-enabled']=='enabled' for v in services.values())
path=root/'KEEP-v18-final-state.json';path.write_text(json.dumps(report,ensure_ascii=False,indent=2));os.chmod(path,0o600)
print(json.dumps(report,ensure_ascii=False))
