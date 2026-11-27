#!/usr/bin/env python3
"""One owner-only real Telegram button; no callback emulation or publication."""
import os,subprocess,pwd
from pathlib import Path
env=dict(os.environ)
for name in ['/etc/content-factory/worker.env','/etc/content-factory-secrets/telegram.env','/etc/content-factory/telegram.env','/etc/content-factory-secrets/openai.env','/etc/content-factory/openai-settings.env','/etc/content-factory/manual-settings.env']:
 env.update(dict(line.split('=',1) for line in Path(name).read_text().splitlines() if '=' in line and not line.startswith('#')))
env['PATH']='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin'
code="""
import {createApplication} from './dist-tools/src/app.js';
import {loadConfig} from './dist-tools/src/core/config.js';
import {getDocument,putDocument} from './dist-tools/src/db/documents.js';
import {InlineKeyboard} from 'grammy';
const cfg=loadConfig({...process.env,PROCESS_ROLE:'bot'}),app=await createApplication(cfg);
try{
 if(!await getDocument(app.db,'v115-mass-card-sent')){
  const msg=await app.bot.api.sendMessage(Number(cfg.TELEGRAM_OWNER_ID),'Проверка массовой подготовки V1.15. Остались три свежих кандидата. Эта кнопка только готовит черновики, не отправляет их в Threads. Нажми её один раз, дождись трёх результатов, затем нажми ещё раз для проверки честного нуля',{reply_markup:new InlineKeyboard().text('Подготовить три ответа без публикации','v18batch:threads02')});
  await putDocument(app.db,'v115-mass-card-sent',{messageId:msg.message_id,at:new Date().toISOString()});
  console.log(JSON.stringify({messageId:msg.message_id}));
 }
}finally{await app.close();}
"""
user=pwd.getpwnam('contentfactory')
p=subprocess.run(['node','--input-type=module'],cwd=Path('/opt/content-factory/current').resolve(),env=env,user=user.pw_uid,group=user.pw_gid,input=code,text=True,timeout=45)
raise SystemExit(p.returncode)
