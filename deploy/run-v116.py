#!/usr/bin/env python3
"""Run bounded native acceptance as the existing service user; no second polling loop."""
import os,subprocess,pwd,time,json,statistics
from pathlib import Path
release=Path('/opt/content-factory/current').resolve();env=dict(os.environ)
for name in ['/etc/content-factory/worker.env','/etc/content-factory-secrets/telegram.env','/etc/content-factory/telegram.env','/etc/content-factory-secrets/openai.env','/etc/content-factory/openai-settings.env','/etc/content-factory/manual-settings.env']:
 env.update(dict(line.split('=',1) for line in Path(name).read_text().splitlines() if '=' in line and not line.startswith('#')))
env['PATH']='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin'
user=pwd.getpwnam('contentfactory')
sampler=None
out=Path('/var/lib/content-factory/reports/KEEP-v116-resources')
if env.get('V116_PHASE') in ['rehearse','revalidate']:
 out.mkdir(mode=0o700,exist_ok=True);os.chown(out,user.pw_uid,user.pw_gid)
 (out/'phase').write_text('SERVICES_IDLE');os.chown(out/'phase',user.pw_uid,user.pw_gid)
 sampler=subprocess.Popen(['/usr/bin/python3',str(release/'deploy/sample-resources.py')],env={**env,'RESOURCE_OUTPUT_DIR':str(out)})
 time.sleep(3)
try:
 p=subprocess.run(['node','dist-tools/scripts/acceptance-v116.js'],cwd=release,env=env,user=user.pw_uid,group=user.pw_gid,timeout=480)
finally:
 if sampler:
  (out/'phase').write_text('AFTER_CLOSE');time.sleep(3);sampler.terminate();sampler.wait()
  rows=[json.loads(x) for x in (out/'samples.jsonl').read_text().splitlines()]
  phases={name:{'samples':len(a),'cpuMeanPercent':round(statistics.mean(r['cpuPercent'] for r in a),2),'cpuPeakPercent':max(r['cpuPercent'] for r in a),'availableMinMiB':min(r['availableMiB'] for r in a),'usedPeakMiB':max(r['usedMiB'] for r in a),'swapPeakMiB':max(r['swapMiB'] for r in a),'pssPeakMiB':{k:max(r['pssMiB'][k] for r in a) for k in ['adspower','browser','node']}} for name in set(r['phase'] for r in rows) if (a:=[r for r in rows if r['phase']==name])}
  (out/'summary.json').write_text(json.dumps(phases,indent=2))
raise SystemExit(p.returncode)
