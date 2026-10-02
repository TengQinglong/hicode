"""Read build-version provenance from the protected prepared baseline."""
import json
from pathlib import Path
import re


def read_source_version(project, base_commit=None):
    path = Path(project) / '.git/hicode-source-version.json'
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 4096:
        raise ValueError('Missing trusted source-version metadata; prepare this task again')
    receipt = json.loads(path.read_text())
    if (set(receipt) != {'baseCommit', 'describe', 'version'} or
            not isinstance(receipt['baseCommit'], str) or not re.fullmatch(r'[a-f0-9]{40}', receipt['baseCommit']) or
            (base_commit is not None and receipt['baseCommit'] != base_commit) or
            not isinstance(receipt['describe'], str) or not re.fullmatch(r'v?[0-9]+(?:\.[0-9]+)+(?:[ab]\d+|rc\d+)?(?:\.dev\d+)?-\d+-g[a-f0-9]+', receipt['describe']) or
            not isinstance(receipt['version'], str) or not re.fullmatch(r'[0-9]+(?:\.[0-9]+)+(?:[ab]\d+|rc\d+)?(?:\.dev[0-9]+\+g[a-f0-9]+|\+[0-9]+\.g[a-f0-9]+)?', receipt['version'])):
        raise ValueError('Invalid trusted source-version metadata')
    return receipt
