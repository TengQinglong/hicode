"""Task UID teardown tolerates processes disappearing, but never hides access failures."""
import os
import signal
import time
from pathlib import Path
from protocol import atomic_json


def stop_task_processes(uid):
    if type(uid) is not int or uid < 20000:
        raise ValueError('Expected an evaluation task UID')
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            if path.stat().st_uid == uid:
                os.kill(int(path.name), signal.SIGKILL)
        except (FileNotFoundError, ProcessLookupError):
            pass
    for _ in range(50):
        alive = False
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                if path.stat().st_uid == uid:
                    state = path.joinpath('stat').read_text().rsplit(')', 1)[1].split()[0]
                    if state != 'Z':
                        alive = True
            except (FileNotFoundError, ProcessLookupError):
                # A process may vanish between directory enumeration, stat and read.
                pass
        if not alive:
            return
        time.sleep(.1)
    raise RuntimeError('Task processes could not be stopped')


def finalize_task(root, result):
    # An outcome is evidence, not proof that cleanup has completed.
    atomic_json(root / 'outcome.json', result)
    stop_task_processes(result['uid'])
    atomic_json(root / 'result.json', result)
