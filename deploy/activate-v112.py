#!/usr/bin/env python3
"""Switch code on the same VPS, retaining all safety flags and private env files."""
import os, subprocess, json
from pathlib import Path
root = Path('/opt/content-factory')
release = root / 'releases/20261120-v112-ux'
env = dict(os.environ)
env.update(dict(line.split('=', 1) for line in Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#')))
assert env['BROWSER_EXECUTION_MODE'] == 'DRY_RUN'
assert env['ENGAGEMENT_EXECUTION_MODE'] == 'DRY_RUN'
assert env['PROFILE_CHANGES_ALLOWED'] == '0'
env['PATH'] = '/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin:/usr/bin:/bin'
units = ['content-factory-telegram','content-factory-vps-worker','content-factory-api']
previous = (root/'current').resolve()
subprocess.run(['systemctl','stop',*units],check=True)
try:
    backup = Path('/var/lib/content-factory/backups/KEEP-before-v112')
    backup.mkdir(mode=0o700,exist_ok=True)
    result = subprocess.run(['node','scripts/backup.mjs'],cwd=release,env={**env,'BACKUP_DIR':str(backup)},capture_output=True)
    assert result.returncode == 0, 'BACKUP_FAILED'
    settings=Path('/etc/content-factory/manual-settings.env')
    settings.write_text('MANUAL_LIVE_ALLOWED=0\nTELEGRAM_OWNER_ID=7842338078\nTELEGRAM_ALLOWED_IDS=7842338078\n')
    settings.chmod(0o640)
    import grp
    os.chown(settings,0,grp.getgrnam('contentfactory').gr_gid)
    for unit in units:
        directory=Path('/etc/systemd/system')/(unit+'.service.d')
        directory.mkdir(exist_ok=True)
        (directory/'60-manual-v112.conf').write_text('[Service]\nEnvironmentFile=/etc/content-factory/manual-settings.env\n')
    subprocess.run(['systemctl','daemon-reload'],check=True)
    nextlink = root / 'current-v112-next' 
    nextlink.symlink_to(release)
    nextlink.replace(root/'current')
    subprocess.run(['systemctl','start',*units],check=True)
    subprocess.run(['systemctl','is-active','--quiet',*units],check=True)
except Exception:
    for unit in units:
        (Path('/etc/systemd/system')/(unit+'.service.d')/'60-manual-v112.conf').unlink(missing_ok=True)
    subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['systemctl','stop',*units],check=True)
    rollback = root/'current-v112-rollback'
    rollback.symlink_to(previous)
    rollback.replace(root/'current')
    subprocess.run(['systemctl','start',*units],check=True)
    raise
print(json.dumps({'release':str(release),'publishing':'DRY_RUN','engagement':'DRY_RUN','profileChangesAllowed':False}))
