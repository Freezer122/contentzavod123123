#!/usr/bin/env python3
import os,pwd,subprocess
from pathlib import Path
root=Path('/opt/content-factory/current').resolve()
env=dict(os.environ)
for file in ['/etc/content-factory/worker.env','/etc/content-factory/openai-settings.env','/etc/content-factory/manual-settings.env']:
 env.update(dict(line.split('=',1) for line in Path(file).read_text().splitlines() if '=' in line and not line.startswith('#')))
env['PROCESS_ROLE']='worker'
code=r'''
import {createApplication} from './dist/app.js';
import {loadConfig} from './dist/core/config.js';
import {BrowserCoordinator} from './dist/browser/coordinator.js';
import {writeFile} from 'node:fs/promises';
const config=loadConfig(process.env), app=await createApplication(config);
const id='2c6ddd0c-b0f5-4071-9e8d-9847c4345802';
try {
 const v=await app.services.engagement.jobView(id);
 const pub=await app.db.get('publishJob','3a54f7b8-c10c-48d6-9726-b118718f1446'); const generated=await app.db.get('generated',pub.generatedId);
 v.draft.text=generated.text;v.candidate.url='https://www.threads.com/@beh4ppy01';
 const access=new BrowserCoordinator(app.db,app.services.providers);
 const result=await access.use('threads02','REPLY',async(page,a)=>{
  const inspect=async(url)=>{
   await page.goto(url,{waitUntil:'domcontentloaded'});
   await page.waitForTimeout(2500);
   const exact=page.getByText(v.draft.text,{exact:true});
   const rows=page.locator("div[data-pressable-container='true']").filter({has:exact}).filter({has:page.locator("a[href='/@"+a.username+"']")}).filter({visible:true});
   const minimal=rows.filter({hasNot:rows});
   const parents=exact.locator('xpath=ancestor::div[@data-pressable-container="true"][1]');
   return {draftText:v.draft.text,bodyIncludesPlain:(await page.locator('body').innerText()).replace(/\s+/g,' ').includes(v.draft.text.replace(/\s+/g,' ').trim()),url:page.url(),title:await page.title(),exactMatches:await exact.count(),matchingRows:await rows.count(),minimalRows:await minimal.count(),sourceAssociation:await page.locator("a[href='/@qyr.balasy/post/DCtkaXFCgrd']").count(),nearest:await parents.evaluateAll(ns=>ns.map(n=>({text:n.innerText,links:[...n.querySelectorAll('a[href]')].map(a=>({href:a.href,raw:a.getAttribute('href'),text:a.innerText})),times:[...n.querySelectorAll('time')].map(t=>({date:t.getAttribute('datetime'),title:t.getAttribute('title'),text:t.textContent}))}))),times:await page.locator('time').evaluateAll(ns=>ns.map(t=>({date:t.getAttribute('datetime'),title:t.getAttribute('title'),text:t.textContent,href:t.closest('a')?.href}))),postLinks:await page.locator('a[href*="/post/"]').evaluateAll(ns=>[...new Set(ns.map(a=>a.href))]),text: (await page.locator('body').innerText()).slice(0,14000)};
  };
  const profile=await inspect(v.candidate.url); const link=profile.nearest.flatMap(n=>n.links).find(l=>l.href.includes('/@beh4ppy01/post/'));
  return {source:profile,profileReplies:link?await inspect(link.href):await inspect(v.candidate.url)};
 });
 await writeFile('/var/lib/content-factory/reports/KEEP-v113-own-post-dom.json',JSON.stringify(result,null,2),{mode:0o600});
 console.log(JSON.stringify(Object.fromEntries(Object.entries(result).map(([k,v])=>[k,{url:v.url,exactMatches:v.exactMatches,matchingRows:v.matchingRows,minimalRows:v.minimalRows,sourceAssociation:v.sourceAssociation,nearest:v.nearest,draftText:v.draftText,bodyIncludesPlain:v.bodyIncludesPlain,text:v.text}]))));
} finally {await app.close();}
'''
u=pwd.getpwnam('contentfactory')
r=subprocess.run(['/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin/node','--input-type=module','-e',code],cwd=root,env=env,user=u.pw_uid,group=u.pw_gid)
raise SystemExit(r.returncode)
