"""Read-only bounded observation of the four approved jobs. Never dispatches work."""
import json, subprocess, urllib.parse, time, datetime
from pathlib import Path
env=dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
db=urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
def sql(q):
 return subprocess.check_output(['/usr/sbin/runuser','-u','postgres','--','psql','-d',db,'-At','-c',q],text=True,cwd='/tmp').strip()
def doc(key):
 return json.loads(sql("SELECT value FROM system_settings WHERE id='"+key+"'"))
a=doc('v117-acceptance');ids=[a['postSlotId'],*a['replySlotIds']]
changes=[];last=None;beat=0;deadline=time.monotonic()+5100
while time.monotonic()<deadline:
 ap=doc('autopilot-account-threads02')
 plan=doc('autopilot-plan-threads02-'+str(a['epoch'])+'-2026-11-21')
 slots=[s for s in plan['slots'] if s['id'] in ids]
 state={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'autopilot':ap['state'],'error':ap.get('error'),'watched':[]}
 for s in sorted(slots,key=lambda x:x['at']):
  if s['kind']=='POST':
   raw=sql("SELECT row_to_json(x) FROM (SELECT status,\"postStatus\",\"lastError\",post_submit_at,post_confirmed_at FROM publishing_jobs WHERE id='"+s['publishingJobId']+"') x")
   job=json.loads(raw)
  else:
   j=doc('engagement-job-'+s['publishingJobId'])
   job={k:j.get(k) for k in ['status','phase','submittedAt','confirmedAt','url','error']}
  state['watched'].append({k:s.get(k) for k in ['id','kind','at','status','publishedAt','permalink','failureReason']}|{'job':job})
 signature=json.dumps({k:v for k,v in state.items() if k!='at'},sort_keys=True)
 if signature!=last:
  print(json.dumps(state,ensure_ascii=False),flush=True);changes.append(state);last=signature
 elif time.monotonic()-beat>45:
  print(json.dumps({'at':state['at'],'watching':True,'published':sum(s['status']=='PUBLISHED' for s in slots)}),flush=True)
 beat=time.monotonic() if time.monotonic()-beat>45 else beat
 out=Path('/var/lib/content-factory/reports/KEEP-v117-watch.json');out.write_text(json.dumps({'latest':state,'changes':changes},ensure_ascii=False,indent=2));out.chmod(0o600)
 if len(slots)==4 and all(s['status']=='PUBLISHED' and s.get('permalink') for s in slots):
  print(json.dumps({'complete':True,'at':state['at']}),flush=True);break
 if any(s['status'] in ['FAILED','UNCERTAIN'] for s in slots) or ap['state']=='ERROR':
  raise SystemExit(2)
 time.sleep(15)
else:
 raise SystemExit(3)
