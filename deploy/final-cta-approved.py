"""Candidate-only native rehearsal; loads private environment, never starts polling/consumers."""
import os,subprocess,pwd
from pathlib import Path
env=dict(os.environ)
for name in ['/etc/content-factory/worker.env','/etc/content-factory-secrets/telegram.env','/etc/content-factory/telegram.env','/etc/content-factory-secrets/openai.env','/etc/content-factory/openai-settings.env','/etc/content-factory/manual-settings.env']:
 env.update(dict(l.split('=',1) for l in Path(name).read_text().splitlines() if '=' in l and not l.startswith('#')))
env['PATH']='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin'
user=pwd.getpwnam('contentfactory')
release=Path('/opt/content-factory/releases/20261121-cta-fix')
script = r"""
import {createApplication} from './dist/app.js';
import {loadConfig} from './dist/core/config.js';
import {ctaStats,ctaTasks} from './dist/cta/tasks.js';
const app=await createApplication(loadConfig({...process.env,PROCESS_ROLE:'bot'}));
try {
 const ap=await app.services.autopilotPolicy.settings('threads02');
 const response=await fetch('http://127.0.0.1:3000/health',{headers:{Authorization:'Bearer '+process.env.INTERNAL_API_TOKEN}});
 if(!response.ok)throw new Error('HEALTH_FAILED');
 const health=await response.json();
 if(health.activeBrowsers!==0||health.providerSessions!==0||!ap.config.allowCTA||ap.state!=='RUNNING')throw new Error('FINAL_STATE_INVALID');
 console.log(JSON.stringify({at:new Date().toISOString(),autopilot:ap.state,ctaEnabled:ap.config.allowCTA,epoch:ap.epoch,version:ap.version,limits:{posts:ap.config.posts,replies:ap.config.replies,start:ap.config.start,end:ap.config.end},activeBrowsers:health.activeBrowsers,providerSessions:health.providerSessions,sent:await app.services.autopilotPolicy.sent('threads02'),ctaStats:await ctaStats(app.db,'threads02','2026-11-21'),tasks:(await ctaTasks(app.db)).map(t=>({jobId:t.jobId,status:t.status,manual:!!t.manualRequestedBy}))}));
}finally{await app.close();}
"""
p=subprocess.run(['node','--input-type=module','-e',script],cwd=release,env=env,user=user.pw_uid,group=user.pw_gid,timeout=60)
raise SystemExit(p.returncode)
