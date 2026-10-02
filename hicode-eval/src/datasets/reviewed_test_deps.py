"""Narrow compatibility pins grounded in each frozen project's public declarations."""
from pathlib import Path


def reviewed_test_dependencies(repo, version, project=None):
    pins = {
        ('pytest-dev/pytest', '5.4'): ('wcwidth==0.2.13', 'iniconfig==2.0.0', 'toml==0.10.2'),
        ('pytest-dev/pytest', '6.0'): ('iniconfig==2.0.0',),
        ('sphinx-doc/sphinx', '3.5'): ('docutils==0.16',),
    }.get((repo, version), ())
    if project is not None and pins:
        project = Path(project)
        if repo == 'pytest-dev/pytest':
            declarations = [project/name for name in ('setup.py','setup.cfg')]
            if any(path.is_symlink() for path in declarations):
                raise ValueError('Symlinked original package declaration')
            text = '\n'.join(path.read_text() for path in declarations if path.is_file())
            pins = [pin for pin in pins if pin.split('==')[0] in text]
            if not pins: raise ValueError('Original source does not declare a reviewed test dependency')
        else:
            declaration = project/'setup.py'; required = "'docutils>=0.12'"
            if declaration.is_symlink() or not declaration.is_file() or required not in declaration.read_text():
                raise ValueError('Original source does not declare the reviewed test dependency')
    return list(pins)
