#!/usr/bin/env python3
"""Final V1.13 read-only proof; credentials never leave process memory."""
import json,subprocess,urllib.request,urllib.error,urllib.parse,time
from pathlib import Path
env=dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
db=urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
def sql(q):return subprocess.check_output(['runuser','-u','postgres','--','psql','-d',db,'-At','-c',q],text=True,cwd='/tmp').strip()
state=json.loads(sql("SELECT value FROM system_settings WHERE id='v113-acceptance'"))
processes=[]
for unit in ['content-factory-api','content-factory-telegram','content-factory-vps-worker']:
 assert subprocess.check_output(['systemctl','is-active',unit],text=True).strip()=='active'
 assert subprocess.check_output(['systemctl','is-enabled',unit],text=True).strip()=='enabled'
 pid=int(subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value']))
 vals=dict(v.split('=',1) for v in Path(f'/proc/{pid}/environ').read_text().split('\0') if '=' in v)
 assert vals['BROWSER_EXECUTION_MODE']==vals['ENGAGEMENT_EXECUTION_MODE']=='DRY_RUN'
 assert vals['MANUAL_LIVE_ALLOWED']=='1' and vals['PROFILE_CHANGES_ALLOWED']=='0'
 assert str(Path(f'/proc/{pid}/cwd').resolve()).endswith('20261120-v113-feed')
 logs=subprocess.check_output(['journalctl','-u',unit,'--since','2026-11-20 11:50:00 UTC','--no-pager'],text=True)
 assert vals['OPENAI_API_KEY'] not in logs
 processes.append({'unit':unit,'active':True,'enabled':True,'role':vals['PROCESS_ROLE'],'manualServerAllowed':True})
request=urllib.request.Request('http://127.0.0.1:3000/health',headers={'Authorization':'Bearer '+env['INTERNAL_API_TOKEN']})
for n in range(10):
 try:health=json.load(urllib.request.urlopen(request,timeout=20));break
 except urllib.error.URLError:
  if n==9:raise
  time.sleep(2)
assert health['database']=='OK' and health['redis']=='PONG'
assert health['activeBrowsers']==health['providerSessions']==0
sun=sum(1 for p in Path('/proc').glob('[0-9]*/exe') if 'sunbrowser' in str(p.resolve()).lower())
assert sun==0
manual=json.loads(sql("SELECT value FROM system_settings WHERE id='manual-policy-threads02'"))
assert manual==state['manualBefore']
assert sql("SELECT value FROM system_settings WHERE id='factoryPaused'")==sql("SELECT value FROM system_settings WHERE id='automationPaused'")=='true'
posts=int(sql('SELECT count(*) FROM published_posts'));comments=int(sql('SELECT count(*) FROM published_comments'))
user_posts=json.loads(sql("SELECT coalesce(json_agg(x),'[]') FROM (SELECT p.id,p.\"jobId\",p.url FROM published_posts p JOIN system_settings s ON s.id='manual-post-'||p.\"jobId\" WHERE p.\"createdAt\">='"+state['startedAt']+"'::timestamptz AND s.value::jsonb->>'actor'='7842338078') x"))
assert posts==state['postsBefore']+len(user_posts)
user_comments=int(sql("SELECT count(*) FROM published_comments c JOIN published_posts p ON p.id=c.\"postId\" WHERE p.\"createdAt\">='"+state['startedAt']+"'::timestamptz"))
assert comments==state['commentsBefore']+user_comments
jobs=json.loads(sql("SELECT coalesce(json_agg(value::jsonb),'[]') FROM system_settings WHERE id LIKE 'engagement-job-%'"))
submitted={j['id']:j['submittedAt'] for j in jobs if j.get('submittedAt')}
assert submitted=={j['id']:j['at'] for j in state['submittedBefore']}
report={'ok':True,'processes':processes,'health':health,'sunBrowserProcesses':sun,'manualPolicy':manual,'factoryPaused':True,'automationPaused':True,'posts':posts,'comments':comments,'userInitiatedPublications':user_posts,'submittedEngagements':submitted,'verifiedReply':state.get('verifiedReply'),'feed':state.get('feed'),'dryResult':state.get('dryResult'),'llmRequests':int(sql('SELECT count(*) FROM ai_requests')),'llmTotalUsd':float(sql('SELECT coalesce(sum("costUsd"),0) FROM ai_requests')),'keyAbsentFromJournals':True}
path=Path('/var/lib/content-factory/reports/KEEP-v113-final-state.json');path.write_text(json.dumps(report,ensure_ascii=False,indent=2));path.chmod(0o600)
print(json.dumps(report,ensure_ascii=False))
