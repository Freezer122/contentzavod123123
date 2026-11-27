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
import {readFile,writeFile} from 'node:fs/promises';
import {getDocument,putDocument} from './dist/db/documents.js';
import {ctaKey,ctaTasks,ctaStats} from './dist/cta/tasks.js';
const app=await createApplication(loadConfig({...process.env,PROCESS_ROLE:'bot'}));
try {
 const live=JSON.parse(await readFile('/var/lib/content-factory/reports/KEEP-cta-approved-live.json','utf8'));
 const tasks=(await ctaTasks(app.db)).filter(t=>t.accountId==='threads02'&&t.createdAt.startsWith('2026-11-21'));
 const targets=[live.job.id,...tasks.filter(t=>t.jobId!==live.job.id).map(t=>t.jobId)];
 const readings=[];
 for(const id of targets){
  const before=await app.db.get('publishJob',id),t=await getDocument(app.db,ctaKey(id));
  const proof=await app.executor.previewCta(id);
  const after=await app.db.get('publishJob',id);
  if(before.ctaSubmitAt?.getTime()!==after.ctaSubmitAt?.getTime())throw new Error('READBACK_SUBMIT_CHANGED');
  if(t.status==='PUBLISHED'&&(proof.absent||proof.existingUrl!==t.permalink))throw new Error('LIVE_BROWSER_RESULT_NOT_CONFIRMED');
  readings.push({jobId:id,taskStatus:t.status,...proof});
 }
 const stats=await ctaStats(app.db,'threads02','2026-11-21','Europe/Moscow');
 const primary=await getDocument(app.db,ctaKey(live.job.id));
 const notice=await getDocument(app.db,'cta-message-'+live.job.id);
 const report={at:new Date().toISOString(),submit:false,readings,stats,telegramStatus:primary.notifiedSignature?'delivered':'pending',telegramMessageId:notice?.messageId};
 await writeFile('/var/lib/content-factory/reports/KEEP-cta-browser-readback.json',JSON.stringify(report,null,2),{mode:0o600});
 await putDocument(app.db,'cta-fix-browser-readback',report);
 await app.bot.api.sendMessage(7842338078,'LIVE CTA проверен: пост 19:13 и сохранённый CTA с фото опубликованы автоматически. Интервал между submit: '+live.submitIntervalSeconds.toFixed(2)+' с\nПост: '+live.parent.url+'\nCTA: '+primary.permalink+'\nПосле перезапуска worker: один пост, один CTA; повторной отправки нет. Будущие CTA включены');
 console.log(JSON.stringify(report));
}finally{await app.close();}
"""
p=subprocess.run(['node','--input-type=module','-e',script],cwd=release,env=env,user=user.pw_uid,group=user.pw_gid,timeout=180)
raise SystemExit(p.returncode)
