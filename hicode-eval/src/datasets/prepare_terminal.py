"""Prepare declared tools and pinned wheels, only on an idle eval machine."""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--context',default='colima-hicode');parser.add_argument('--machine',default='hicode-eval-linux')
    parser.add_argument('--tasks',nargs='+',default=['large-scale-text-editing','break-filter-js-from-html'])
    args=parser.parse_args();docker=['docker','--context',args.context]
    info=json.loads(subprocess.check_output([*docker,'inspect',args.machine]))[0]
    if not info['State']['Running'] or info['Config']['Labels'].get('dev.hicode.role')!='eval':raise ValueError('Dedicated evaluation machine required')
    probe=subprocess.run([*docker,'exec',args.machine,'pgrep','-f','[r]unner.py'],stdout=subprocess.PIPE)
    if probe.returncode!=1:raise ValueError('Wait for active evaluation runners')
    def run(cmd,timeout=600):subprocess.run([*docker,'exec',args.machine,*cmd],check=True,timeout=timeout)
    profiles=json.loads((Path(__file__).resolve().parents[2]/'config/terminal-bench.json').read_text())
    if not args.tasks or len(set(args.tasks))!=len(args.tasks) or any(id not in profiles for id in args.tasks):raise ValueError('Unknown or duplicate reviewed task')
    tools={'vim':'vim','chromium':'chromium','chromedriver':'chromium-driver','file':'file','xxd':'xxd','sqlite3':'sqlite3','ffmpeg':'ffmpeg'}
    missing=json.loads(subprocess.check_output([*docker,'exec',args.machine,'python3','-c',
        'import json,shutil;print(json.dumps([x for x in '+repr(list(tools))+' if not shutil.which(x)]))']))
    if missing:
        run(['apt-get','-o','Acquire::Retries=1','-o','Acquire::http::Timeout=20','-o','Acquire::https::Timeout=20','update'])
        run(['apt-get','install','-y','--no-install-recommends',*[tools[t] for t in missing]])
    pip=subprocess.run([*docker,'exec',args.machine,'/opt/python313/bin/pip3','--version'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if pip.returncode:run(['/opt/python313/bin/python3.13','-m','pip','install','--no-input','--disable-pip-version-check','--timeout','15','--retries','1','--force-reinstall','pip==25.2'])
    run(['/opt/python313/bin/pip3','--version'])
    for id in args.tasks:
        row=profiles[id]
        for pin in sorted(set(row['packages']+row['verifierPackages'])):
            target='/opt/hicode-eval/wheels/'+pin.replace('==','-')
            run(['mkdir','-p',target])
            run(['/opt/python313/bin/python3.13','-m','pip','download','--only-binary=:all:','--dest',target,pin])
    run(['chromium','--version']);run(['chromedriver','--version']);run(['vim','--version'])
    print(json.dumps({'prepared':args.tasks,'modelAttempts':0,'hiddenAssertionsExecuted':False}))
if __name__=='__main__':main()
