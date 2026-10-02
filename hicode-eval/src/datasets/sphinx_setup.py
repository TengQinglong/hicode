"""Reviewed Sphinx 3.1–7.2 setup from SWE-bench harness 4.1.0.
Only dependency declarations and test reporting are adjusted, as in the upstream recipe.
"""
import hashlib
import json
from pathlib import Path

VERSIONS = ('3.1', '3.2', '3.3', '3.4', '3.5', '4.0', '4.1', '4.2', '4.3', '5.0', '5.1', '5.2', '7.1', '7.2')
COMMON_REPLACEMENTS = (
    ('Jinja2>=2.3', 'Jinja2<3.0'),
    ('sphinxcontrib-applehelp', 'sphinxcontrib-applehelp<=1.0.7'),
    ('sphinxcontrib-devhelp', 'sphinxcontrib-devhelp<=1.0.5'),
    ('sphinxcontrib-qthelp', 'sphinxcontrib-qthelp<=1.0.6'),
    ('alabaster>=0.7,<0.8', 'alabaster>=0.7,<0.7.12'),
    ("'packaging',", "'packaging', 'markupsafe<=2.0.1',"),
)

def replacements(version, text):
    if version not in VERSIONS: raise ValueError('Unsupported Sphinx version')
    if version not in VERSIONS[:9]: return ()
    result = list(COMMON_REPLACEMENTS)
    for package, minimum, maximum in [('sphinxcontrib-htmlhelp', '2.0.0', '2.0.4'),
                                      ('sphinxcontrib-serializinghtml', '1.1.5', '1.1.9')]:
        qualified = package + '>=' + minimum
        if version in ('4.2', '4.3') or (version == '4.1' and qualified in text):
            result.append((qualified, qualified + ',<=' + maximum))
        else: result.append((package, package + '<=' + maximum))
    return tuple(result)

def reviewed_recipe(version):
    if version not in VERSIONS: raise ValueError('Unsupported Sphinx version')
    commands = ["sed -i 's/pytest/pytest -rA/' tox.ini"]
    if version in VERSIONS[:9]:
        for old, new in COMMON_REPLACEMENTS:
            if old == "'packaging',":
                commands.append('sed -i "s/\'packaging\',/\'packaging\', \'markupsafe<=2.0.1\',/" setup.py')
            else: commands.append("sed -i 's/" + old + '/' + new + "/' setup.py")
        for package, minimum, maximum in [('sphinxcontrib-htmlhelp', '2.0.0', '2.0.4'),
                                          ('sphinxcontrib-serializinghtml', '1.1.5', '1.1.9')]:
            qualified = package + '>=' + minimum
            first = "sed -i 's/" + qualified + '/' + qualified + ',<=' + maximum + "/' setup.py"
            fallback = "sed -i 's/" + package + '/' + package + '<=' + maximum + "/' setup.py"
            if version in ('4.2', '4.3'): commands.append(first)
            elif version == '4.1': commands.append("grep -q '" + qualified + "' setup.py && " + first + ' || ' + fallback)
            else: commands.append(fallback)
    if version == '7.2': commands.append('apt-get update && apt-get install -y graphviz')
    return {'python':'3.9', 'pip_packages':['tox==4.16.0','tox-current-env==0.0.11','Jinja2==3.0.3'],
            'install':'python -m pip install -e .[test]', 'pre_install':commands,
            'test_cmd':'tox --current-env -epy39 -v --'}

def apply_setup(project, version):
    if version not in VERSIONS: raise ValueError('Unsupported Sphinx version')
    project = Path(project)
    tox = project/'tox.ini'
    # sed without g replaces only the first match on each line.
    tox.write_text(''.join(line.replace('pytest', 'pytest -rA', 1) for line in tox.read_text().splitlines(keepends=True)))
    if version in VERSIONS[:9]:
        setup = project/'setup.py'; text = setup.read_text()
        for old, new in replacements(version, text):
            text = ''.join(line.replace(old, new, 1) for line in text.splitlines(keepends=True))
        setup.write_text(text)

def dependency_identity(project):
    project = Path(project)
    declarations = {name: hashlib.sha256((project/name).read_bytes()).hexdigest()
                    for name in ('setup.py','setup.cfg','pyproject.toml') if (project/name).is_file()}
    if not declarations: raise ValueError('Missing Sphinx packaging declarations')
    return json.dumps(declarations, sort_keys=True)


def build_requirements(project):
    # Preparation runs in the Linux machine's Python 3.11 host, not task Python 3.9.
    import tomllib
    path = Path(project)/'pyproject.toml'
    if not path.is_file(): return []
    requirements = tomllib.loads(path.read_text()).get('build-system', {}).get('requires', [])
    if not isinstance(requirements, list) or any(not isinstance(item, str) for item in requirements):
        raise ValueError('Invalid Sphinx build requirements')
    return requirements
