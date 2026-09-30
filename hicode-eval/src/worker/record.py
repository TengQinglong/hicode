"""tmux pipe-pane sink; raw bytes preserve the real terminal behavior."""
import json, os, sys, time
from pathlib import Path
path = Path(sys.argv[1])
size = 0
with path.open('xb', buffering=0) as output, path.with_suffix('.index.jsonl').open('x', buffering=1) as index:
    os.chmod(path, 0o600)
    while True:
        data = os.read(0, 65536)
        if not data: break
        if size + len(data) > 256 * 1024 * 1024:
            path.with_suffix('.overflow').write_text('Terminal recording exceeded 256 MiB')
            break
        output.write(data)
        index.write(json.dumps({'at': time.time(), 'offset': size, 'bytes': len(data)}) + '\n')
        size += len(data)
