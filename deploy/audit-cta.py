"""Read-only diagnosis of account CTA, published parents, queue and media integrity."""
import json,subprocess,urllib.parse,hashlib,datetime
from pathlib import Path
env=dict(l.split('=',1) for l in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
db=urllib.parse.urlsplit(env['DATABASE_URL']).path.lstrip('/')
def q(s):return subprocess.check_output(['/usr/sbin/runuser','-u','postgres','--','psql','-d',db,'-At','-c',s],text=True,cwd='/tmp').strip()
def rows(s):return json.loads(q("SELECT coalesce(json_agg(t),'[]') FROM ("+s+") t"))
x={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
'settings':rows("SELECT id,value::jsonb AS value FROM system_settings WHERE id IN ('autopilot-account-threads02','factoryPaused','automationPaused','emergencyStop')"),
'cta':rows("SELECT * FROM cta_templates WHERE \"accountId\"='threads02'"),
'jobs':rows("SELECT j.*,p.id AS parent_id,p.url AS parent_url,c.url AS cta_result,c.status AS cta_result_status FROM publishing_jobs j LEFT JOIN published_posts p ON p.\"jobId\"=j.id LEFT JOIN published_comments c ON c.\"postId\"=p.id WHERE j.\"accountId\"='threads02' ORDER BY j.\"createdAt\" DESC LIMIT 18"),
'audit':rows("SELECT action,actor,\"entityId\",detail,\"createdAt\" FROM audit_logs WHERE action LIKE '%CTA%' ORDER BY \"createdAt\" DESC LIMIT 20"),
'events':rows("SELECT code,message,\"createdAt\" FROM system_events WHERE code IN ('CTA_DELAY','WORKER','AUTOPILOT_CRITICAL') ORDER BY \"createdAt\" DESC LIMIT 10"),
'redisKeys':subprocess.check_output(['redis-cli','-n','15','--scan','--pattern','bull:*'],text=True).splitlines()}
for c in x['cta']:
 p=Path(c['mediaPath']) if c.get('mediaPath') else None
 c['mediaExists']=p.is_file() if p else False
 c['actualMediaSha256']=hashlib.sha256(p.read_bytes()).hexdigest() if p and p.is_file() else None
print(json.dumps(x,ensure_ascii=False))
