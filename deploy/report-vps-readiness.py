#!/usr/bin/env python3
"""Export measurements and safe deployment state; never export environment secrets."""
import collections
import datetime
import json
import pathlib
import statistics
import subprocess

root = pathlib.Path('/var/lib/content-factory/reports')
rows = [json.loads(line) for line in (root / 'resources/samples.jsonl').read_text().splitlines()]
phases = {}
for phase in sorted({r['phase'] for r in rows}):
    samples = [r for r in rows if r['phase'] == phase]
    phases[phase] = {
        'samples': len(samples),
        'cpuMeanPercent': round(statistics.mean(r['cpuPercent'] for r in samples), 2),
        'cpuPeakPercent': max(r['cpuPercent'] for r in samples),
        'usedPeakMiB': max(r['usedMiB'] for r in samples),
        'availableMinMiB': min(r['availableMiB'] for r in samples),
        'swapPeakMiB': max(r['swapMiB'] for r in samples),
        'pssPeakMiB': {group: max(r['pssMiB'][group] for r in samples) for group in ['adspower', 'browser', 'node']},
    }


def sql(statement):
    return subprocess.check_output(['runuser', '-u', 'postgres', '--', 'psql', '-d', 'content_factory', '-At', '-c', statement], cwd='/tmp', text=True).strip()


state = {
    'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'factoryPaused': sql("SELECT value FROM system_settings WHERE id='factoryPaused'"),
    'accountStatus': sql("SELECT status FROM threads_accounts WHERE id='threads02'"),
    'publishJobs': int(sql('SELECT count(*) FROM publishing_jobs')),
    'publishedPosts': int(sql('SELECT count(*) FROM published_posts')),
    'publishedComments': int(sql('SELECT count(*) FROM published_comments')),
    'llmRequests': int(sql('SELECT count(*) FROM ai_requests')),
    'migrations': sql('SELECT string_agg(migration_name, chr(44) ORDER BY migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL'),
    'services': {},
    'resources': phases,
}
for unit in ['content-factory-display', 'content-factory-window-manager', 'content-factory-adspower', 'content-factory-vps-worker', 'content-factory-v14-api-guard']:
    state['services'][unit] = {key: subprocess.getoutput(f'systemctl {key} {unit}') for key in ['is-active', 'is-enabled']}
env = dict(line.split('=', 1) for line in pathlib.Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
state['executionMode'] = env['BROWSER_EXECUTION_MODE']
state['concurrency'] = int(env['BROWSER_CONCURRENCY'])
state['allowedProfileIds'] = env['ADSPOWER_ALLOWED_PROFILE_IDS']
state['activeBrowserProcessCount'] = len(subprocess.getoutput('pgrep -u contentfactory -x SunBrowser').splitlines())
disk = __import__('shutil').disk_usage('/')
state['diskFreeMiB'] = round(disk.free / 1024 / 1024, 1)
(root / 'vps-readiness.json').write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(state, ensure_ascii=False))
