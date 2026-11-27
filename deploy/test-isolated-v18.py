#!/usr/bin/env python3
"""Root setup; ALL test writes are confined to scratch PostgreSQL + Redis DB14."""
import os,subprocess,pwd,grp
from pathlib import Path
from urllib.parse import urlparse,urlunparse
env=dict(os.environ)
env.update(dict(line.split('=',1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#')))
u=urlparse(env['DATABASE_URL'])
env['TEST_DATABASE_URL']=urlunparse(u._replace(path='/cf_v18_test_isolated',query=''))
env['TEST_REDIS_URL']='redis://127.0.0.1:6379/14'
assert subprocess.check_output(['redis-cli','-n','14','DBSIZE'],text=True).strip()=='0', 'SCRATCH_REDIS_NOT_EMPTY'
subprocess.run(['runuser','-u','postgres','--','createdb','-O','cf_factory','cf_v18_test_isolated'],cwd='/tmp',check=True)
try:
    env['PATH']='/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin'
    user=pwd.getpwnam('contentfactory')
    p=subprocess.run(['node','node_modules/vitest/vitest.mjs','run','tests/production.integration.test.ts'],cwd=os.environ.get('CF_TEST_RELEASE','/opt/content-factory/current'),env=env,user=user.pw_uid,group=user.pw_gid)
    if p.returncode: raise SystemExit(p.returncode)
finally:
    subprocess.run(['runuser','-u','postgres','--','dropdb','cf_v18_test_isolated'],cwd='/tmp',check=True)
print('ISOLATED_PRODUCTION_TESTS_OK')
