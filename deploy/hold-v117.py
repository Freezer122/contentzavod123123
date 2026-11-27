"""Hold ONLY the exact V1.17 rehearsal post, then restore the worker with sending blocked."""
import json,re,subprocess,urllib.parse
from pathlib import Path
e=dict(l.split('=',1) for l in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in l and not l.startswith('#'));db=urllib.parse.urlsplit(e['DATABASE_URL']).path.lstrip('/')
def sql(q):return subprocess.check_output(['/usr/sbin/runuser','-u','postgres','--','psql','-d',db,'-At','-c',q],cwd='/tmp',text=True).strip()
def doc(k):return json.loads(sql("SELECT value FROM system_settings WHERE id='"+k+"'"))
a=doc('v117-acceptance');ap=doc('autopilot-account-threads02');assert ap['state']=='ERROR' and doc('automationPaused') is True
plan=doc('autopilot-plan-threads02-'+str(ap['epoch'])+'-2026-11-21');slot=next(s for s in plan['slots'] if s['id']==a['postSlotId']);job=slot['publishingJobId'];assert re.fullmatch('[a-f0-9-]{36}',job)
grant=doc('autopilot-grant-'+job);assert grant['accountId']=='threads02' and grant['mode']=='LIVE' and grant['createdAt']>=a['startedAt']
print(sql("UPDATE publishing_jobs SET status='PAUSED' WHERE id='"+job+"' AND status='QUEUED' AND post_submit_at IS NULL RETURNING id"))
subprocess.run(['systemctl','start','content-factory-api','content-factory-telegram','content-factory-vps-worker'],check=True)
print('EXACT_REHEARSAL_JOB_HELD_SERVICES_RESTORED_AUTOPILOT_ERROR_NO_SUBMIT')
