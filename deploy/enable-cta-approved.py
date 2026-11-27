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
import {getDocument,putDocument,hashDocument,listDocuments} from './dist/db/documents.js';
import {base} from './dist/db/database.js';
import {ctaSignature} from './dist/cta/service.js';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const app=await createApplication(loadConfig({...process.env,PROCESS_ROLE:'bot'}));
try {
 const policy=app.services.autopilotPolicy, before=await policy.settings('threads02');
 const c=await app.services.ctas.ensure('threads02');
 const approved='5 простых правил построения капитала с 1000$ до 100000$. все выкладываю в канале в шапке профиля\nзаявки принимаю сразу';
 const image='fb63a9451922e1f7984d35cc670dd46cd15f01333b0d681dd558a5c206c5bc94';
 if(before.state!=='RUNNING'||before.mode!=='LIVE'||c.text!==approved||c.url||c.mediaSha256!==image) throw new Error('APPROVED_CONFIG_CHANGED');
 if(createHash('sha256').update(await readFile(c.mediaPath)).digest('hex')!==image) throw new Error('IMAGE_CHANGED');
 const plans=await listDocuments(app.db,'autopilot-plan-threads02-');
 const plan=plans.find(p=>p.epoch===before.epoch&&p.day==='2026-11-21');
 const slots=plan?.slots??plans.flatMap(p=>p.slots??[]).filter(x=>x.scheduleId==='autopilot-plan-threads02-'+before.epoch+'-2026-11-21');
 const target=slots.find(s=>s.kind==='POST'&&s.at==='2026-11-21T16:13:00.000Z');
 if(!target) throw new Error('APPROVED_SLOT_NOT_FOUND');
 const consentId='cta-owner-consent-20261121-1913';
 const prior=await getDocument(app.db,consentId);
 if(!prior) {
  await app.db.transaction(async tx=>{
   await putDocument(tx,consentId,{actor:'7842338078',at:new Date().toISOString(),source:'explicit_user_reply',scope:'CTA at approved 19:13 slot and future own posts; no historical backfill',slotId:target.id,parentScheduleAt:target.at,contentHash:hashDocument(approved),imageHash:image});
   await tx.insert('audit',{...base(),actor:'7842338078',action:'CTA_LIVE_OWNER_CONSENT',entityId:'threads02',detail:JSON.stringify({slotId:target.id,at:target.at,futureOwnPosts:true,historical:false})});
  });
  if(!before.config.allowCTA) await policy.setCta('threads02',true,'7842338078',ctaSignature(c));
 } else if(!before.config.allowCTA) throw new Error('CONSENT_ALREADY_CONSUMED_CTA_NOW_OFF');
 const after=await policy.settings('threads02');
 if(after.epoch!==before.epoch||after.version!==before.version||!after.config.allowCTA) throw new Error('ENABLE_STATE_INVALID');
 await app.bot.api.sendMessage(7842338078,'CTA включён по твоему разрешению. Первый LIVE-тест: собственный плановый пост 21 ноября, 19:13 МСК; после подтверждения поста сохранённый CTA с фотографией отправится автоматически с целью 20 секунд от submit. Будущие собственные посты также получают CTA. Старые посты не досылаются',{reply_markup:{inline_keyboard:[[{text:'Автопилот → CTA',callback_data:'ac:home:threads02'}]]}});
 console.log(JSON.stringify({at:new Date().toISOString(),autopilot:after.state,epoch:after.epoch,version:after.version,ctaEnabled:after.config.allowCTA,ctaVersion:(await app.services.ctas.ensure('threads02')).version,target,consentId,liveSubmit:false}));
}finally{await app.close();}
"""
p=subprocess.run(['node','--input-type=module','-e',script],cwd=release,env=env,user=user.pw_uid,group=user.pw_gid,timeout=60)
raise SystemExit(p.returncode)
