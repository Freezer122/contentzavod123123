#!/usr/bin/env python3
"""Root-only migration configuration. Input preserves all original application secrets."""
import os, grp, secrets, subprocess
from pathlib import Path

root = Path('/var/lib/content-factory/KEEP-v18-transfer')
target = Path('/etc/content-factory')
gid = grp.getgrnam('contentfactory').gr_gid
def save(path, value, mode=0o640):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)
    os.chown(path, 0, gid)
    os.chmod(path, mode)

values = dict(line.split('=', 1) for line in (root/'etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
if not (target/'worker.env').exists():
    password = secrets.token_hex(32)
    sql = f"CREATE ROLE cf_factory LOGIN PASSWORD '{password}'; CREATE DATABASE content_factory OWNER cf_factory;"
    result = subprocess.run(['runuser','-u','postgres','--','psql','-X','-q','-v','ON_ERROR_STOP=1'], input=sql, text=True, capture_output=True, cwd='/tmp')
    if result.returncode: raise SystemExit('DATABASE_PROVISION_FAILED')
    values.update(DATABASE_URL=f'postgresql://cf_factory:{password}@127.0.0.1:5432/content_factory', BROWSER_EXECUTION_MODE='DRY_RUN', BROWSER_CONCURRENCY='1', ADSPOWER_HEADLESS='1', LOG_DIR='/var/lib/content-factory/logs', LOG_MAX_BYTES='10485760')
    values['TELEGRAM_BOT_TOKEN'] = ''
    save(target/'worker.env', ''.join(f'{k}={v}\n' for k,v in values.items()))
save(target/'telegram.env', 'PROCESS_ROLE=bot\nTELEGRAM_ALLOWED_IDS=7842338078\n')
save(target/'api.env', 'PROCESS_ROLE=api\nHOST=127.0.0.1\nPORT=3000\nTELEGRAM_ALLOWED_IDS=7842338078\n')
save(Path('/etc/content-factory-secrets/telegram.env'), (root/'etc/content-factory-secrets/telegram.env').read_text(), 0o600)
Path('/etc/systemd/journald.conf.d').mkdir(exist_ok=True)
save(Path('/etc/systemd/journald.conf.d/content-factory.conf'), '[Journal]\nSystemMaxUse=200M\nRuntimeMaxUse=50M\nMaxRetentionSec=7day\n',0o644)
subprocess.run(['systemctl','restart','systemd-journald'],check=True)
subprocess.run(['systemctl','enable','--now','postgresql','redis-server'],check=True)
for category, days in [('normal',7),('debug',3),('critical',30)]:
    save(Path(f'/etc/logrotate.d/content-factory-{category}'), f'/var/lib/content-factory/logs/*-{category}.log /var/lib/content-factory/logs/*-{category}.log.rollover {{\n daily\n rotate {days}\n maxage {days}\n maxsize 10M\n missingok\n notifempty\n compress\n delaycompress\n su contentfactory contentfactory\n create 0600 contentfactory contentfactory\n}}\n',0o644)
print('V18_CONFIGURATION_READY_SECRETS_PRESERVED')
