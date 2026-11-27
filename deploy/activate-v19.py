#!/usr/bin/env python3
"""Activate V1.9 only after the two saved previews; never submit content."""
import json
import os
import subprocess
from pathlib import Path

release = Path('/opt/content-factory/releases/20261120-v19-openai')
root = Path('/opt/content-factory')
report = json.loads(Path('/var/lib/content-factory/reports/KEEP-v19-openai-test.json').read_text())
assert report['ok'] and report['telegramDelivered'] and report['normalizerEnabled']
assert report['factoryPaused'] == 'true'
assert len(report['usage']) == 2 and report['totalCostUsd'] < 5
assert {r['model'] for r in report['usage']} == {'gpt-6.2-sol', 'gpt-6.1-terra'}
assert all(report[k] == 0 for k in ['postsSent', 'repliesSent', 'likesSent'])
env = dict(line.split('=', 1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
assert env['BROWSER_EXECUTION_MODE'] == 'DRY_RUN'
assert env['ENGAGEMENT_EXECUTION_MODE'] == 'DRY_RUN'
assert env['PROFILE_CHANGES_ALLOWED'] == '0'
secret = Path('/etc/content-factory-secrets/openai.env')
assert secret.stat().st_mode & 0o777 == 0o600 and secret.stat().st_uid == 0
assert secret.read_text().startswith('OPENAI_API_KEY=')
units = ['content-factory-telegram', 'content-factory-vps-worker', 'content-factory-api']
previous = (root / 'current').resolve()
dropins = []
subprocess.run(['systemctl', 'stop', *units], check=True)
try:
    for unit in units:
        folder = Path('/etc/systemd/system') / (unit + '.service.d')
        folder.mkdir(exist_ok=True)
        target = folder / '50-openai-v19.conf'
        dropins.append((target, target.read_bytes() if target.exists() else None))
        target.write_text('[Service]\nEnvironmentFile=/etc/content-factory-secrets/openai.env\nEnvironmentFile=/etc/content-factory/openai-settings.env\n')
    nextlink = root / 'current-v19-next'
    nextlink.symlink_to(release)
    nextlink.replace(root / 'current')
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'start', *units], check=True)
    subprocess.run(['systemctl', 'is-active', '--quiet', *units], check=True)
except Exception:
    subprocess.run(['systemctl', 'stop', *units], check=True)
    for target, old in dropins:
        if old is None:
            target.unlink(missing_ok=True)
        else:
            target.write_bytes(old)
    rollback = root / 'current-v19-rollback'
    rollback.symlink_to(previous)
    rollback.replace(root / 'current')
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'start', *units], check=True)
    raise
print(json.dumps({'release': str(release), 'provider': 'openai', 'publishing': 'DRY_RUN', 'profileChangesAllowed': False}))
