"""Build independent dependency views from reviewed pins, without importing old environments."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from venv_paths import relocate_environment


def validate_recipe(value):
    required = {'version', 'python', 'requirements', 'buildRequirements', 'buildEnvironment', 'buildGroups', 'systemPackages', 'provenance'}
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - {'sourceArchives'} or value['version'] != 1:
        raise ValueError('Invalid dependency recipe')
    if not isinstance(value['python'], str) or not re.fullmatch(r'3\.(7|8|9|10|11)\.\d+', value['python']):
        raise ValueError('Unsupported interpreter')
    pins = value['requirements']
    if not isinstance(pins, list) or not 0 < len(pins) <= 500 or any(not isinstance(pin, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]*==[0-9][A-Za-z0-9.!+_-]*', pin) for pin in pins):
        raise ValueError('Only pinned public packages are allowed')
    names = [re.sub(r'[-_.]+', '-', pin.split('==')[0]).lower() for pin in pins]
    if len(set(names)) != len(names):
        raise ValueError('Duplicate dependency name')
    build=value['buildRequirements']
    if not isinstance(build,list) or len(build)>100 or any(not isinstance(pin,str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]*==[0-9][A-Za-z0-9.!+_-]*',pin) for pin in build):
        raise ValueError('Invalid build requirements')
    variables=value['buildEnvironment']
    if not isinstance(variables,dict) or any(not re.fullmatch(r'[A-Z_][A-Z0-9_]*',key) or not isinstance(item,str) or len(item)>1000 for key,item in variables.items()):
        raise ValueError('Invalid build environment')
    groups=value['buildGroups']
    if not isinstance(groups,list) or len(groups)>32:
        raise ValueError('Invalid build groups')
    for group in groups:
        if not isinstance(group,dict) or set(group)!={'packages','requirements'} or not isinstance(group['packages'],list) or not group['packages'] or any(pin not in pins for pin in group['packages']):
            raise ValueError('Build groups must use frozen runtime pins')
        if not isinstance(group['requirements'],list) or any(not isinstance(pin,str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]*==[0-9][A-Za-z0-9.!+_-]*',pin) for pin in group['requirements']):
            raise ValueError('Invalid grouped build requirements')
    return value


def main():
    recipe = validate_recipe(json.loads(Path(sys.argv[1]).read_text()))
    root = Path('/opt/hicode-swe')
    seed = root/'seed'
    for name in ('seed', 'actor', 'verifier'):
        if (root/name).exists():
            raise ValueError('Dependency view already exists')
    env = dict(os.environ, UV_PYTHON_INSTALL_DIR=str(root/'python'), UV_NO_PROGRESS='1', UV_LINK_MODE='copy',
               UV_HTTP_TIMEOUT='60', UV_CONCURRENT_DOWNLOADS='3', UV_CONCURRENT_BUILDS='1', MAKEFLAGS='-j2', NPY_NUM_BUILD_JOBS='2')
    env.update(recipe['buildEnvironment'])
    def run(args):
        subprocess.run(args, env=env, check=True, timeout=1800)
    run(['uv', 'python', 'install', recipe['python']])
    run(['uv', 'venv', '--seed', '--python', recipe['python'], str(seed)])
    pins = recipe['requirements']
    build = [pin for pin in pins if pin.split('==')[0].lower() in {'pip', 'setuptools', 'wheel'}]
    if build:
        run(['uv', 'pip', 'install', '--python', str(seed/'bin/python'), '--no-deps', *build])
    if recipe['buildRequirements']:
        run(['uv', 'pip', 'install', '--python', str(seed/'bin/python'), '--no-deps', *recipe['buildRequirements']])
    for group in recipe['buildGroups']:
        if group['requirements']:
            run(['uv','pip','install','--python',str(seed/'bin/python'),'--no-deps',*group['requirements']])
        run(['uv','pip','install','--python',str(seed/'bin/python'),'--no-deps','--no-build-isolation',*group['packages']])
    if recipe['buildGroups'] and recipe['buildRequirements']:
        run(['uv','pip','install','--python',str(seed/'bin/python'),'--no-deps',*recipe['buildRequirements']])
    requirements = root/'requirements.lock'
    requirements.write_text('\n'.join(pins)+'\n')
    run(['uv', 'pip', 'install', '--python', str(seed/'bin/python'), '--no-deps', '--no-build-isolation', '-r', str(requirements)])
    runtime_names={re.sub(r'[-_.]+','-',pin.split('==')[0]).lower() for pin in pins}
    build_pins=recipe['buildRequirements']+[pin for group in recipe['buildGroups'] for pin in group['requirements']]
    build_only=sorted({pin.split('==')[0] for pin in build_pins if re.sub(r'[-_.]+','-',pin.split('==')[0]).lower() not in runtime_names})
    if build_only:
        run(['uv','pip','uninstall','--python',str(seed/'bin/python'),*build_only])
    installed_rows = json.loads(subprocess.check_output(['uv', 'pip', 'list', '--python', str(seed/'bin/python'), '--format', 'json'], env=env, text=True, timeout=30))
    normalize = lambda name: re.sub(r'[-_.]+', '-', name).lower()
    installed = {normalize(row['name']): row['version'] for row in installed_rows}
    differences = [(pin, installed.get(normalize(pin.split('==')[0]))) for pin in pins
                   if installed.get(normalize(pin.split('==')[0])) != pin.split('==')[1]]
    if differences:
        raise ValueError('Installed versions differ from recipe: '+repr(differences))
    (seed/'.ready.json').write_text(json.dumps({'version':2,'python':recipe['python'],'requirements':pins,'mode':'clean-recipe'}))
    for name in ('actor', 'verifier'):
        target = root/name
        shutil.copytree(seed, target, symlinks=True)
        relocate_environment(target, str(seed))
        for directory, dirs, files in os.walk(target, followlinks=False):
            os.chown(directory, 20000, 20000)
            for entry in dirs+files:
                os.chown(Path(directory)/entry, 20000, 20000, follow_symlinks=False)
    shutil.rmtree(seed)


if __name__ == '__main__':
    main()
