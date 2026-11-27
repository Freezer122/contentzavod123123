#!/usr/bin/env python3
"""Explicit owner-approved one-time server capability; never enables an account policy."""
import json
import os
import subprocess
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

root = Path('/opt/content-factory')
release = (root / 'current').resolve()
assert release.name == '20261120-v112-ux', 'UNEXPECTED_RELEASE'
worker = dict(line.split('=', 1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
db = urllib.parse.urlsplit(worker['DATABASE_URL']).path.lstrip('/')
units = ['content-factory-api', 'content-factory-telegram', 'content-factory-vps-worker']
def sql(query):
    return subprocess.check_output(['runuser', '-u', 'postgres', '--', 'psql', '-d', db, '-At', '-c', query], text=True, cwd='/tmp').strip()
def snapshot():
    return {
        'factoryPaused': sql("SELECT value FROM system_settings WHERE id='factoryPaused'"),
        'automationPaused': sql("SELECT value FROM system_settings WHERE id='automationPaused'"),
        'emergencyStop': sql("SELECT value FROM system_settings WHERE id='emergencyStop'"),
        'manualPolicies': sql("SELECT coalesce(jsonb_object_agg(id,value::jsonb),'{}'::jsonb)::text FROM system_settings WHERE id LIKE 'manual-policy-%'"),
        'enabledManualPolicies': int(sql("SELECT count(*) FROM system_settings WHERE id LIKE 'manual-policy-%' AND value::jsonb->>'manualLiveEnabled'='true'")),
        'posts': int(sql('SELECT count(*) FROM published_posts')),
        'comments': int(sql('SELECT count(*) FROM published_comments')),
        'submittedEngagements': int(sql("SELECT count(*) FROM system_settings WHERE id LIKE 'engagement-job-%' AND value::jsonb->>'submittedAt' IS NOT NULL")),
    }
assert worker['BROWSER_EXECUTION_MODE'] == 'DRY_RUN'
assert worker['ENGAGEMENT_EXECUTION_MODE'] == 'DRY_RUN'
assert worker['PROFILE_CHANGES_ALLOWED'] == '0'
before = snapshot()
assert before['factoryPaused'] == before['automationPaused'] == 'true'
assert before['enabledManualPolicies'] == 0, 'ACCOUNT_MANUAL_ALREADY_ENABLED_ABORT'
assert sql("SELECT count(*) FROM publishing_jobs WHERE status='RUNNING'") == '0', 'PUBLISHING_IN_PROGRESS'
settings = Path('/etc/content-factory/manual-settings.env')
original = settings.read_bytes()
lines = original.decode().splitlines(keepends=True)
keys = [i for i, line in enumerate(lines) if line.startswith('MANUAL_LIVE_ALLOWED=')]
assert len(keys) == 1, 'INVALID_SERVER_SETTINGS'
old = lines[keys[0]].strip().split('=', 1)[1]
assert old in ('0', '1')
backup = Path('/etc/content-factory/manual-settings.env.before-owner-allow-v112')
changed = old == '0'
try:
    if changed:
        if not backup.exists():
            with backup.open('xb') as target:
                os.chmod(backup, 0o600)
                target.write(original)
        lines[keys[0]] = 'MANUAL_LIVE_ALLOWED=1\n'
        settings.write_text(''.join(lines))
        subprocess.run(['systemctl', 'restart', *units], check=True)
    subprocess.run(['python3', str(release / 'deploy/verify-v112.py'), '--server-manual-allowed', '1'], check=True, stdout=subprocess.DEVNULL)
    after = snapshot()
    assert after == before, 'PUBLISHING_STATE_CHANGED'
except Exception:
    if changed:
        settings.write_bytes(original)
        subprocess.run(['systemctl', 'restart', *units], check=True)
    raise
proof = {'ok': True, 'at': datetime.now(timezone.utc).isoformat(), 'authorizedByOwner': True, 'serverManualAllowed': True, 'manualLiveEnabled': False, 'publishingStateUnchanged': True, 'factoryPaused': True, 'automationPaused': True, 'posts': after['posts'], 'comments': after['comments'], 'submittedEngagements': after['submittedEngagements'], 'changed': changed}
path = Path('/var/lib/content-factory/reports/KEEP-v112-server-manual-allowed.json')
path.write_text(json.dumps(proof, indent=2)); path.chmod(0o600)
print(json.dumps(proof))
