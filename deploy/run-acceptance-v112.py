#!/usr/bin/env python3
"""Run one bounded acceptance pass; no polling, no LLM generation, no LIVE."""
import os,subprocess,pwd
from pathlib import Path
release=Path('/opt/content-factory/current').resolve()
assert release.name=='20261120-v112-ux'
env=dict(os.environ)
for name in ['/etc/content-factory/worker.env','/etc/content-factory-secrets/telegram.env','/etc/content-factory/telegram.env','/etc/content-factory-secrets/openai.env','/etc/content-factory/openai-settings.env','/etc/content-factory/manual-settings.env']:
    env.update(dict(line.split('=',1) for line in Path(name).read_text().splitlines() if '=' in line and not line.startswith('#')))
env['PATH']='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin'
env['V112_PHASE']=os.environ.get('V112_PHASE','cards')
user=pwd.getpwnam('contentfactory')
p=subprocess.run(['node','dist-tools/scripts/acceptance-v112.js'],cwd=release,env=env,user=user.pw_uid,group=user.pw_gid)
raise SystemExit(p.returncode)
