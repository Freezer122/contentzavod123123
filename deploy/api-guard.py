#!/usr/bin/env python3
"""Keep all application/control/database ports private, without replacing host rules."""
import subprocess
ports='3000,50325,20725,20408,20409,5432,6379'
for executable in ['iptables','ip6tables']:
    rule=['INPUT','!','-i','lo','-p','tcp','-m','multiport','--dports',ports,'-j','DROP']
    if subprocess.run([executable,'-C',*rule],capture_output=True).returncode:
        subprocess.run([executable,'-I',*rule],check=True)
