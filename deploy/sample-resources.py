#!/usr/bin/env python3
"""Record numeric VPS resource measurements, without command lines or secrets."""
import json
import os
import pathlib
import pwd
import time

out = pathlib.Path(os.environ.get('RESOURCE_OUTPUT_DIR','/var/lib/content-factory/reports/resources'))
out.mkdir(mode=0o700, exist_ok=True)
uid = pwd.getpwnam('contentfactory').pw_uid


def cpu():
    values = list(map(int, pathlib.Path('/proc/stat').read_text().splitlines()[0].split()[1:9]))
    return sum(values), values[3] + values[4]


previous = cpu()
with (out / 'samples.jsonl').open('a', buffering=1) as stream:
    for _ in range(1800):
        time.sleep(1)
        now = cpu()
        total, idle = now[0] - previous[0], now[1] - previous[1]
        previous = now
        mem = {line.split(':')[0]: int(line.split()[1]) for line in pathlib.Path('/proc/meminfo').read_text().splitlines()}
        groups = {'adspower': 0, 'browser': 0, 'node': 0}
        for path in pathlib.Path('/proc').iterdir():
            try:
                if not path.name.isdigit() or path.stat().st_uid != uid:
                    continue
                name = (path / 'comm').read_text().strip().lower()
                group = 'browser' if 'sunbrowser' in name else 'adspower' if 'adspower' in name else 'node' if 'node' in name else None
                if group:
                    groups[group] += next(int(line.split()[1]) for line in (path / 'smaps_rollup').read_text().splitlines() if line.startswith('Pss:'))
            except (OSError, StopIteration, ValueError):
                pass
        phase = (out / 'phase').read_text().strip() if (out / 'phase').exists() else 'IDLE'
        stream.write(json.dumps({'time': time.time(), 'phase': phase, 'cpuPercent': round(100 * (total - idle) / max(1, total), 2), 'usedMiB': round((mem['MemTotal'] - mem['MemAvailable']) / 1024, 1), 'availableMiB': round(mem['MemAvailable'] / 1024, 1), 'swapMiB': round((mem['SwapTotal'] - mem['SwapFree']) / 1024, 1), 'pssMiB': {key: round(value / 1024, 1) for key, value in groups.items()}}) + '\n')
