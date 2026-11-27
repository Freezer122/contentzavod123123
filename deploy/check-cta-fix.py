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
import {ctaTasks} from './dist/cta/tasks.js';
const app=await createApplication(loadConfig({...process.env,PROCESS_ROLE:'bot'}));
try {
 const ap=await app.services.autopilotPolicy.settings('threads02');
 const children=await ctaTasks(app.db);
 if(ap.state!=='RUNNING'||ap.config.allowCTA!==false) throw new Error('UNEXPECTED_CTA_STATE');
 const response=await fetch('http://127.0.0.1:3000/health',{headers:{Authorization:'Bearer '+process.env.INTERNAL_API_TOKEN}});
 if(!response.ok) throw new Error('HEALTH_FAILED');
 const health=await response.json();
 if(health.activeBrowsers!==0||health.providerSessions!==0) throw new Error('BROWSER_NOT_IDLE');
 await app.bot.api.sendMessage(7842338078,'CTA FIX установлен. Проверены три сегодняшних поста и редактор с фотографией без отправки. CTA сейчас ВЫКЛЮЧЕН, старые посты не досылаются. Включение в разделе CTA разрешает комментарии под будущими собственными постами автоматически',{reply_markup:{inline_keyboard:[[{text:'Автопилот → CTA',callback_data:'ac:home:threads02'}]]}});
 console.log(JSON.stringify({at:new Date().toISOString(),autopilot:ap.state,epoch:ap.epoch,version:ap.version,ctaEnabled:ap.config.allowCTA,childTasks:children.length,activeBrowsers:health.activeBrowsers,providerSessions:health.providerSessions,telegramCardSent:true}));
} finally {await app.close();}
"""
p=subprocess.run(['node','--input-type=module','-e',script],cwd=release,env=env,user=user.pw_uid,group=user.pw_gid,timeout=60)
raise SystemExit(p.returncode)
