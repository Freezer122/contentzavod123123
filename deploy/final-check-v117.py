"""Verify persistence by an idle restart after all four reviewed LIVE operations. No dispatch or LLM calls."""
import json, subprocess, urllib.parse, urllib.request, time, hashlib, os
from pathlib import Path
env=dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
db=urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
def sql(q):
 return subprocess.check_output(['/usr/sbin/runuser','-u','postgres','--','psql','-d',db,'-At','-c',q],text=True,cwd='/tmp').strip()
def doc(key):
 return json.loads(sql("SELECT value FROM system_settings WHERE id='"+key.replace("'","''")+"'"))
a=doc('v117-acceptance');ids=[a['postSlotId'],*a['replySlotIds']]
def plans():
 return json.loads(sql("SELECT json_agg(json_build_object('id',id,'plan',value::jsonb) ORDER BY id) FROM system_settings WHERE id LIKE 'autopilot-plan-threads02-"+str(a['epoch'])+"-%'"))
def fingerprint():
 p=plans();slots=[s for x in p for s in x['plan']['slots']]
 stable={'schedule':sorted([{'id':s['id'],'at':s['at'],'type':s['kind'],'day':s['localDate']} for s in slots],key=lambda x:x['id']),
  'published':sorted([{'id':s['id'],'status':s['status'],'url':s.get('permalink'),'publishedAt':s.get('publishedAt')} for s in slots if s['id'] in ids],key=lambda x:x['id'])}
 assert len(stable['published'])==4 and all(s['status']=='PUBLISHED' and s['url'] for s in stable['published'])
 return hashlib.sha256(json.dumps(stable,sort_keys=True).encode()).hexdigest()
def safety():
 ap=doc('autopilot-account-threads02')
 assert ap['state']=='RUNNING' and ap['mode']=='LIVE' and ap['epoch']==a['epoch'],'OWNER_SCOPE_CHANGED'
 assert doc('automationPaused') is False and doc('emergencyStop') is False
 assert sql("SELECT count(*) FROM publishing_jobs WHERE status='RUNNING'")=='0','PUBLICATION_BUSY'
 assert sql("SELECT count(*) FROM system_settings WHERE id LIKE 'generation-task-%' AND value::jsonb->>'status' IN ('RUNNING','QUEUED')")=='0','GENERATION_BUSY'
def health():
 r=urllib.request.Request('http://127.0.0.1:3000/health',headers={'Authorization':'Bearer '+env['INTERNAL_API_TOKEN']})
 return json.load(urllib.request.urlopen(r,timeout=15))
safety();h=health();assert h['activeBrowsers']==h['providerSessions']==0,'PROFILE_BUSY'
units=['content-factory-telegram','content-factory-vps-worker','content-factory-api']
enabled={u:subprocess.check_output(['systemctl','is-enabled',u],text=True).strip() for u in units}
manual=Path('/etc/content-factory/manual-settings.env').read_bytes()
subprocess.run(['systemctl','stop',*units],check=True)
try:
 safety();before=fingerprint()
finally:
 subprocess.run(['systemctl','start',*units],check=True)
 subprocess.run(['systemctl','is-active','--quiet',*units],check=True)
for _ in range(10):
 try:h=health();break
 except Exception:time.sleep(1)
time.sleep(15)
after=fingerprint();assert before==after,'SCHEDULE_OR_PUBLICATION_CHANGED'
assert Path('/etc/content-factory/manual-settings.env').read_bytes()==manual
ap=doc('autopilot-account-threads02');assert ap['state']=='RUNNING'
audits=[]
for p in a['prepared'][1:]:
 job=p['slot']['publishingJobId'];n=int(sql("SELECT count(*) FROM audit_logs WHERE action='ENGAGEMENT_SEND_STARTED' AND \"entityId\"='"+job+"'"));assert n==1,'DUPLICATE_REPLY_SUBMIT';audits.append({'jobId':job,'sendBarriers':n})
post=a['prepared'][0]['slot']['publishingJobId'];assert sql("SELECT attempts FROM publishing_jobs WHERE id='"+post+"'")=='1','DUPLICATE_POST_ATTEMPT'
# Check only the allowed profile's activity endpoint, without launching it.
url=env['ADSPOWER_BASE_URL'].rstrip('/')+'/api/v1/browser/active?user_id=k1j71gt4'
r=urllib.request.Request(url,headers={'Authorization':'Bearer '+env.get('ADSPOWER_API_KEY','')})
profile=json.load(urllib.request.urlopen(r,timeout=20));assert profile['code']==0
disk=os.statvfs('/')
out={'checkedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'release':str(Path('/opt/content-factory/current').resolve()),'scheduleAndUrlsSurvivedRestart':before==after,'fingerprint':after,'unitsEnabled':enabled,'unitsActive':True,'autopilot':ap['state'],'mode':ap['mode'],'epoch':ap['epoch'],'manualUnchanged':True,'replySendBarriers':audits,'postAttempts':1,'profileStatus':profile['data']['status'],'freeGiB':round(disk.f_bavail*disk.f_frsize/2**30,2),'heartbeat':doc('autopilot-scheduler-heartbeat')}
p=Path('/var/lib/content-factory/reports/KEEP-v117-final-check.json');p.write_text(json.dumps(out,ensure_ascii=False,indent=2));p.chmod(0o600)
print(json.dumps(out,ensure_ascii=False))
