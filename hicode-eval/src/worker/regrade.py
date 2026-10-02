"""Host-only recheck of a sealed patch. No Actor, model gateway or run submission."""
import hashlib
import json
from pathlib import Path
import pwd
import re
import shutil
import signal
import subprocess
import sys
from protocol import atomic_json
from swe import grade_swe_patch, git


def regrade(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir(): raise ValueError('Invalid recheck root')
    config = json.loads((root/'job.json').read_text())
    patch = (root/'model.patch').read_bytes()
    receipt = json.loads((root/'input.json').read_text())
    task = config['swe']
    if (not re.fullmatch(r'[a-f0-9]{64}', receipt['patchSha256']) or
            hashlib.sha256(patch).hexdigest() != receipt['patchSha256'] or
            receipt['instanceId'] != task['instanceId'] or
            receipt['baseCommit'] != task['baseCommit'] or
            git(['rev-parse', 'HEAD'], root/'baseline').decode().strip() != task['baselineCommit']):
        raise ValueError('Recheck patch or trusted baseline identity changed')
    account = pwd.getpwnam('node')
    cancelled = False
    def stop(*_):
        nonlocal cancelled
        cancelled = True
    signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
    grade, reason = 'unavailable', None
    try:
        if task['repo'] in {'pytest-dev/pytest', 'pydata/xarray'}:
            from source_version import prepare_source_version
            version = prepare_source_version(task['repo'], root/'baseline', task['baseCommit'],
                                             Path(task['environment'])/'bin/python',
                                             Path('/opt/hicode-swe/upstream-metadata')/(task['repo'].split('/')[-1]+'.git'))
            atomic_json(root/'source-version.json', version)
        grade, reason = grade_swe_patch(root, config, account.pw_uid, account.pw_gid,
                                       lambda: cancelled, patch.decode('utf-8', errors='strict'))
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as error:
        reason = 'Recheck unavailable: ' + str(error)[-4000:]
    finally:
        # Ephemeral clones have no Actor-owned data. Preserve the sealed input
        # and verifier evidence; never remove anything from the original run.
        for path in [root/'grading-project', root/'grading-home', root/'baseline',
                     Path('/eval/swe-grader-envs')/root.name]:
            if path.is_dir() and not path.is_symlink(): shutil.rmtree(path)
    result = {'version': 1, 'runId': receipt['runId'], 'instanceId': task['instanceId'],
              'patchSha256': receipt['patchSha256'], 'grading': grade, 'reason': reason,
              'originalExecution': receipt['originalExecution'], 'modelCalls': 0}
    atomic_json(root/'result.json', result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    regrade(sys.argv[1])
