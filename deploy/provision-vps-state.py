#!/usr/bin/env python3
"""Run as root on the authorized VPS. Secrets are generated/stored on the server."""
import grp
import json
import os
from pathlib import Path
import secrets
import subprocess

config = Path('/etc/content-factory/worker.env')
if config.exists():
    print('EXISTING_ENV_PRESERVED')
    raise SystemExit(0)
key = Path('/etc/content-factory-secrets/adspower.env').read_text().strip().split('=', 1)[1]
if not key or '\n' in key or '\r' in key:
    raise SystemExit('INVALID_API_KEY_FILE')
password = secrets.token_hex(32)
sql = f"CREATE ROLE cf_factory LOGIN PASSWORD '{password}';\nCREATE DATABASE content_factory OWNER cf_factory;\n"
result = subprocess.run(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1'],
                        input=sql, text=True, capture_output=True, cwd='/tmp')
if result.returncode:
    raise SystemExit('DATABASE_PROVISION_FAILED')
values = {
    'APP_MODE': 'production', 'PROCESS_ROLE': 'worker', 'TIMEZONE': 'Europe/Moscow',
    'BROWSER_EXECUTION_MODE': 'DRY_RUN', 'BROWSER_CONCURRENCY': '1',
    'DATABASE_URL': f'postgresql://cf_factory:{password}@127.0.0.1:5432/content_factory',
    'REDIS_URL': 'redis://127.0.0.1:6379/15', 'PUBLISH_QUEUE_NAME': 'cf_threads02_publishing',
    'INTERNAL_API_TOKEN': secrets.token_hex(32), 'TRACKING_HASH_SECRET': secrets.token_hex(32),
    'PUBLIC_BASE_URL': 'https://factory.invalid', 'TELEGRAM_TARGET': 'https://t.me/fixture_not_approved',
    'TELEGRAM_BOT_TOKEN': '', 'TELEGRAM_ALLOWED_IDS': '', 'LLM_API_KEY': '',
    'ADSPOWER_BASE_URL': 'http://127.0.0.1:50325', 'ADSPOWER_API_KEY': key,
    'ADSPOWER_ALLOWED_PROFILE_IDS': 'k1j71gt4',
    'THREADS_SELECTORS_PATH': '/opt/content-factory/current/fixtures/threads-selectors.json',
    'ARTIFACTS_DIR': '/var/lib/content-factory/artifacts',
    'PLAYWRIGHT_BROWSERS_PATH': '/var/lib/content-factory/browsers',
    'PROBE_EXPECTED_PROFILE_ID': 'k1j71gt4', 'PROBE_EXPECTED_USERNAME': 'beh4ppy01',
    'PROBE_OUTPUT_DIR': '/var/lib/content-factory/reports/preflight',
    'PROBE_VERIFY_IP': '1', 'PROBE_RECORD_STRUCTURE': '1',
    'PROBE_DRAFT_PATH': '/var/lib/content-factory/preflight-draft.txt',
    'REHEARSAL_OUTPUT_DIR': '/var/lib/content-factory/reports/rehearsal',
}
config.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
with os.fdopen(fd, 'w') as file:
    file.write(''.join(f'{name}={value}\n' for name, value in values.items()))
os.chown(config, 0, grp.getgrnam('contentfactory').gr_gid)
os.chmod(config, 0o640)
draft = Path('/var/lib/content-factory/preflight-draft.txt')
draft.write_text('DRY RUN. Проверка ввода текста на VPS без отправки публикации.')
os.chown(draft, -1, grp.getgrnam('contentfactory').gr_gid)
os.chmod(draft, 0o640)
print(json.dumps({'databaseCreated': True, 'workerMode': 'DRY_RUN', 'allowedProfile': 'k1j71gt4', 'envMode': '0640'}))
