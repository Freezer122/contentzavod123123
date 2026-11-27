#!/usr/bin/env python3
"""Use existing private env and user for bounded V1.15 diagnostics/acceptance. No polling."""
import os,subprocess,pwd
from pathlib import Path
release=Path('/opt/content-factory/current').resolve()
script=os.environ.get('V115_SCRIPT','acceptance-v115')
assert script in ['inspect-v115','acceptance-v115','experiment-v115']
env=dict(os.environ)
for name in ['/etc/content-factory/worker.env','/etc/content-factory-secrets/telegram.env','/etc/content-factory/telegram.env','/etc/content-factory-secrets/openai.env','/etc/content-factory/openai-settings.env','/etc/content-factory/manual-settings.env']:
 env.update(dict(line.split('=',1) for line in Path(name).read_text().splitlines() if '=' in line and not line.startswith('#')))
env['PATH']='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin'
user=pwd.getpwnam('contentfactory')
p=subprocess.run(['node','dist-tools/scripts/'+script+'.js'],cwd=release,env=env,user=user.pw_uid,group=user.pw_gid,timeout=300)
raise SystemExit(p.returncode)
