#!/usr/bin/env python3
import os,subprocess,time,json,pathlib,statistics,urllib.request
out=pathlib.Path('/var/lib/content-factory/reports/KEEP-v18-resources')
out.mkdir(mode=0o700,exist_ok=True)
assert not (out/'samples.jsonl').exists(), 'RESOURCE_RUN_ALREADY_EXISTS'
assert subprocess.run(['systemctl','is-active','--quiet','cf-v18-tests-cdp']).returncode!=0, 'FIXTURE_BROWSER_STILL_ACTIVE'
env=dict(os.environ)
env.update(dict(line.split('=',1) for line in pathlib.Path('/etc/content-factory/worker.env').read_text().splitlines() if '=' in line and not line.startswith('#')))
def phase(name): (out/'phase').write_text(name)
phase('SERVICES_IDLE')
sampler=subprocess.Popen(['python3','deploy/sample-resources.py'],cwd='/opt/content-factory/current',env={**env,'RESOURCE_OUTPUT_DIR':str(out)})
try:
    time.sleep(5)
    phase('ADSPOWER_START')
    subprocess.run(['systemctl','restart','content-factory-adspower'],check=True)
    ready=False
    for _ in range(20):
        try:
            urllib.request.urlopen('http://127.0.0.1:50325/status',timeout=2)
            ready=True; break
        except Exception: time.sleep(2)
    assert ready,'ADSPOWER_RESTART_FAILED'
    phase('THREADS_PLAYWRIGHT_READ_ONLY')
    p=subprocess.run(['/opt/content-factory/runtime/node-v22.23.5-linux-x64/bin/node','dist-tools/scripts/benchmark-v15.js'],cwd='/opt/content-factory/current',env={**env,'BENCHMARK_OUTPUT':'/var/lib/content-factory/reports/KEEP-v18-benchmark.json'},capture_output=True,text=True)
    if p.returncode: raise SystemExit('READ_ONLY_BENCHMARK_FAILED')
    phase('AFTER_CLOSE')
    time.sleep(5)
finally:
    sampler.terminate();sampler.wait()
rows=[json.loads(x) for x in (out/'samples.jsonl').read_text().splitlines()]
phases={}
for name in sorted(set(r['phase'] for r in rows)):
    sample=[r for r in rows if r['phase']==name]
    phases[name]={'samples':len(sample),'cpuPeakPercent':max(r['cpuPercent'] for r in sample),'cpuMeanPercent':round(statistics.mean(r['cpuPercent'] for r in sample),2),'availableMinMiB':min(r['availableMiB'] for r in sample),'usedPeakMiB':max(r['usedMiB'] for r in sample),'pssPeakMiB':{k:max(r['pssMiB'][k] for r in sample) for k in ['adspower','browser','node']}}
(out/'summary.json').write_text(json.dumps(phases,indent=2))
print(json.dumps(phases))
