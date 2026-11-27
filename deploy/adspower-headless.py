#!/usr/bin/env python3
"""Vendor-supported headless launch; key stays out of unit text and captured logs."""
import json
import os
import signal
import subprocess
import sys
key=os.environ['ADSPOWER_API_KEY']
child=subprocess.Popen(['/opt/AdsPower Global/adspower_global','--headless=true','--api-key='+key,'--api-port=50325'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
def stop(_signum,_frame):
    if child.poll() is None:child.terminate()
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
assert child.stdout is not None
for line in child.stdout:
    print(json.dumps({'service':'adspower','message':line.rstrip().replace(key,'[REDACTED]')[:5000]}),flush=True)
sys.exit(child.wait())
