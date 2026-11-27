"""Candidate-only native rehearsal; loads private environment, never starts polling/consumers."""
import os,subprocess,pwd
from pathlib import Path
env=dict(os.environ)
for name in ['/etc/content-factory/worker.env','/etc/content-factory-secrets/telegram.env','/etc/content-factory/telegram.env','/etc/content-factory-secrets/openai.env','/etc/content-factory/openai-settings.env','/etc/content-factory/manual-settings.env']:
 env.update(dict(l.split('=',1) for l in Path(name).read_text().splitlines() if '=' in l and not l.startswith('#')))
env['PATH']='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin'
user=pwd.getpwnam('contentfactory')
release=Path('/opt/content-factory/releases/20261121-cta-fix')
p=subprocess.run(['node','dist-tools/scripts/cta-fix-acceptance.js'],cwd=release,env=env,user=user.pw_uid,group=user.pw_gid,timeout=240)
raise SystemExit(p.returncode)
