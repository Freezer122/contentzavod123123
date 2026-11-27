#!/usr/bin/env python3
"""Run a bounded owner-only preview, using private VPS env. No bot polling."""
import os,subprocess,pwd
from pathlib import Path
release=Path('/opt/content-factory/current').resolve()
assert release.name=='20261120-v114-human'
env=dict(os.environ)
for name in ['/etc/content-factory/worker.env','/etc/content-factory-secrets/telegram.env','/etc/content-factory/telegram.env','/etc/content-factory-secrets/openai.env','/etc/content-factory/openai-settings.env','/etc/content-factory/manual-settings.env']:
    env.update(dict(line.split('=',1) for line in Path(name).read_text().splitlines() if '=' in line and not line.startswith('#')))
env['PATH']='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin'
env['V114_PHASE']=os.environ.get('V114_PHASE','configure')
user=pwd.getpwnam('contentfactory')
p=subprocess.run(['node','dist-tools/scripts/acceptance-v114.js'],cwd=release,env=env,user=user.pw_uid,group=user.pw_gid,timeout=180)
raise SystemExit(p.returncode)
