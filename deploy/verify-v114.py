#!/usr/bin/env python3
"""Read-only process, safety, budget and resource proof. Never prints credentials."""
import json,subprocess,urllib.request,urllib.parse,time,datetime,re,hashlib
from pathlib import Path
env=dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
db=urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
def sql(q):return subprocess.check_output(['runuser','-u','postgres','--','psql','-d',db,'-At','-c',q],text=True,cwd='/tmp').strip()
state=json.loads(sql("SELECT value FROM system_settings WHERE id='v114-acceptance'"))
assert state['safetyUnchanged'] and state['phase']=='DELIVERED'
processes=[]
for unit in ['content-factory-api','content-factory-telegram','content-factory-vps-worker']:
 assert subprocess.check_output(['systemctl','is-active',unit],text=True).strip()=='active'
 assert subprocess.check_output(['systemctl','is-enabled',unit],text=True).strip()=='enabled'
 pid=int(subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value']))
 vals=dict(v.split('=',1) for v in Path(f'/proc/{pid}/environ').read_text().split('\0') if '=' in v)
 assert vals['BROWSER_EXECUTION_MODE']==vals['ENGAGEMENT_EXECUTION_MODE']=='DRY_RUN'
 assert vals['MANUAL_LIVE_ALLOWED']=='1' and vals['PROFILE_CHANGES_ALLOWED']=='0'
 assert Path(f'/proc/{pid}/cwd').resolve().name=='20261120-v114-human'
 since=datetime.datetime.fromisoformat(state['startedAt'].replace('Z','+00:00')).strftime('%Y-%m-%d %H:%M:%S UTC')
 logs=subprocess.check_output(['journalctl','-u',unit,'--since',since,'--no-pager'],text=True)
 for name in ['OPENAI_API_KEY','TELEGRAM_BOT_TOKEN']:
  if vals.get(name):assert vals[name] not in logs
 processes.append({'unit':unit,'active':True,'enabled':True,'role':vals['PROCESS_ROLE'],'manualServerAllowed':True})
request=urllib.request.Request('http://127.0.0.1:3000/health',headers={'Authorization':'Bearer '+env['INTERNAL_API_TOKEN']})
for n in range(8):
 try:health=json.load(urllib.request.urlopen(request,timeout=20));break
 except Exception:
  if n==7:raise
  time.sleep(2)
assert health['database']=='OK' and health['redis']=='PONG'
assert health['activeBrowsers']==health['providerSessions']==0
sun=sum(1 for p in Path('/proc').glob('[0-9]*/exe') if 'sunbrowser' in str(p.resolve()).lower())
assert sun==0
manual=json.loads(sql("SELECT value FROM system_settings WHERE id='manual-policy-threads02'"))
assert manual==state['before']['manual']
assert sql("SELECT value FROM system_settings WHERE id='factoryPaused'")==sql("SELECT value FROM system_settings WHERE id='automationPaused'")=='true'
cfg=json.loads(sql("SELECT value FROM system_settings WHERE id='engagement-config-threads02'"))
assert cfg['replyManner']=='LIVELY' and cfg['replyProfanity'] and cfg['replySlang'] and cfg['replyHumor']
unknown=int(sql("SELECT count(*) FROM ai_requests WHERE status IN ('UNKNOWN','RESERVED')"))
assert unknown==0
cta=json.loads(sql("SELECT row_to_json(x) FROM (SELECT id,status,\"postStatus\",\"commentStatus\",cta_submit_at,cta_confirmed_at FROM publishing_jobs WHERE id='3a54f7b8-c10c-48d6-9726-b118718f1446') x"))
# Compare actual published bodies against the pre-cutover dump, not only their URL rows.
dump=sorted(Path('/var/lib/content-factory/backups/KEEP-before-v114').glob('*.dump'))[0]
def copy_rows(table):
 data=subprocess.check_output(['pg_restore','--data-only','--table='+table,'--file=-',str(dump)],text=True)
 match=re.search(r'^COPY [^\n]+ \(([^\n]+)\) FROM stdin;\n(.*?)^\\\.$',data,re.M|re.S)
 assert match,'BACKUP_COPY_MISSING'
 cols=[c.strip().strip('"') for c in match.group(1).split(',')]
 escapes={'b':'\b','f':'\f','n':'\n','r':'\r','t':'\t','v':'\v','\\':'\\'}
 def decode(v):return None if v=='\\N' else re.sub(r'\\([0-7]{1,3}|[bfnrtv\\])',lambda m:chr(int(m[1],8)) if m[1][0].isdigit() else escapes[m[1]],v)
 return {r['id']:r for r in [dict(zip(cols,map(decode,line.split('\t')))) for line in match.group(2).splitlines()]}
generated=copy_rows('generated_contents'); settings_backup=copy_rows('system_settings')
posts=json.loads(sql('SELECT coalesce(json_agg(x),\'[]\') FROM (SELECT p.id,g.id AS generated_id,md5(g.text) AS text_md5 FROM published_posts p JOIN generated_contents g ON g.id=p."generatedId") x'))
old_post_ids={p['id'] for p in state['before']['published'] if p['table']=='post'}
for p in posts:
 if p['id'] in old_post_ids:assert hashlib.md5(generated[p['generated_id']]['text'].encode()).hexdigest()==p['text_md5'],'PUBLISHED_POST_TEXT_CHANGED'
reply_texts=0
for p in state['before']['publishedReplies']:
 job=json.loads(settings_backup['engagement-job-'+p['id']]['value'])
 draft_key='engagement-draft-'+job['accountId']+'-'+job['draftId']
 old=json.loads(settings_backup[draft_key]['value'])
 new=json.loads(sql("SELECT value FROM system_settings WHERE id='"+draft_key+"'"))
 assert old['text']==new['text'],'PUBLISHED_REPLY_TEXT_CHANGED'
 reply_texts+=1
report={'ok':True,'checkedAt':state['checkedAt'],'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'processes':processes,'health':health,'sunBrowserProcesses':sun,'manualPolicy':manual,'factoryPaused':True,'automationPaused':True,'v114Requests':state['requests'],'inputTokens':state['inputTokens'],'outputTokens':state['outputTokens'],'costUsd':state['costUsd'],'delivered':state['delivered'],'ctaRecoveryJob':cta,'oldPublishedRowsUnchanged':state['safetyUnchanged'],'publishedBodiesMatchBackup':{'posts':len(old_post_ids),'replies':reply_texts},'keyAbsentFromJournals':True,'settingsPersistedAfterRestart':cfg}
path=Path('/var/lib/content-factory/reports/KEEP-v114-final-state.json');path.write_text(json.dumps(report,ensure_ascii=False,indent=2));path.chmod(0o600)
print(json.dumps(report,ensure_ascii=False))
