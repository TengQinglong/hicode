"""Prepare shared tools/wheels for the two reviewed Terminal expansion tasks."""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--context',default='colima-hicode');parser.add_argument('--machine',default='hicode-eval-linux')
    args=parser.parse_args();docker=['docker','--context',args.context]
    info=json.loads(subprocess.check_output([*docker,'inspect',args.machine]))[0]
    if not info['State']['Running'] or info['Config']['Labels'].get('dev.hicode.role')!='eval':raise ValueError('Dedicated evaluation machine required')
    probe=subprocess.run([*docker,'exec',args.machine,'pgrep','-f','[r]unner.py'],stdout=subprocess.PIPE)
    if probe.returncode!=1:raise ValueError('Wait for active evaluation runners')
    def run(cmd,timeout=600):subprocess.run([*docker,'exec',args.machine,*cmd],check=True,timeout=timeout)
    run(['apt-get','-o','Acquire::Retries=1','-o','Acquire::http::Timeout=20','-o','Acquire::https::Timeout=20','update'])
    run(['apt-get','install','-y','--no-install-recommends','vim','chromium','chromium-driver','libmemcached-dev','zlib1g-dev','libffi-dev'])
    profiles=json.loads((Path(__file__).resolve().parents[2]/'config/terminal-bench.json').read_text())
    for id in ['large-scale-text-editing','break-filter-js-from-html']:
        row=profiles[id]
        for pin in sorted(set(row['packages']+row['verifierPackages'])):
            target='/opt/hicode-eval/wheels/'+pin.replace('==','-')
            run(['mkdir','-p',target])
            run(['/opt/python313/bin/python3.13','-m','pip','download','--only-binary=:all:','--dest',target,pin])
    run(['chromium','--version']);run(['chromedriver','--version']);run(['vim','--version'])
    print('Two Terminal tasks have shared tools and pinned wheel caches; no model or hidden assertions executed.')
if __name__=='__main__':main()
