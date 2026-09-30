"""Run the original pytest checks; infrastructure failure is not a failed answer."""
import os
import json
import signal
import stat
import subprocess
import time
import re


def verifier_environment(config, home):
    paths=[]
    if config.get('verifierPackages'):paths.append('/app/.eval-verifier-python')
    if config.get('packages'):paths.append('/app/.eval-python')
    paths.append(str(home / '.local/lib/python3.13/site-packages'))
    return {'PATH':'/opt/hicode-verifier/bin:/opt/python313/bin:'+str(home / '.local/bin')+':'+str(home / 'bin')+':'+os.environ['PATH'],
            'HOME':str(home),'LANG':'C.UTF-8','PYTHONPATH':os.pathsep.join(paths)}


def display_output(path):
    with path.open('rb') as stream:
        data = stream.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            stream.seek(0, 2)
            stream.seek(max(0, stream.tell() - 64000))
            return stream.read().decode('utf-8', errors='replace')
    text = data.decode('utf-8', errors='replace')
    warning = re.search(r'^=+ warnings summary =+\s*$', text, re.M)
    end = text.find('-- Docs:', warning.end()) if warning else -1
    if warning and end >= 0:
        newline = text.find('\n', end)
        summary = text[newline + 1:] if newline >= 0 else ''
        count = re.search(r'\b(\d+) warnings?\b', summary)
        text = text[:warning.start()] + f"Warnings: {count.group(1) if count else 'see raw log'}; full details in logs/verifier/output.txt\n" + summary
    return text[-64000:]


def validate_report(report_path, code):
    fd = os.open(report_path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('Invalid report file')
        data = stream.read(16 * 1024 * 1024 + 1)
        if len(data) > 16 * 1024 * 1024:
            raise ValueError('Invalid report size')
    validate_report_data(json.loads(data), code)


def validate_report_data(data, code):
    report = data['results']
    summary, tests = report['summary'], report['tests']
    counts = {key: summary[key] for key in ['passed', 'failed', 'skipped', 'pending', 'other']}
    if (type(summary['tests']) is not int or summary['tests'] <= 0
            or any(type(n) is not int or n < 0 for n in counts.values())
            or sum(counts.values()) != summary['tests'] or len(tests) != summary['tests']
            or any(sum(t['status'] == key for t in tests) != n for key, n in counts.items())
            or (code == 0) != (counts['failed'] == 0)):
        raise ValueError('Report and exit status disagree')


def verify(args, *, timeout, output_path, report_path, cwd, env, preexec_fn, cancelled):
    grade = 'unavailable'
    reason = None
    process = None
    report_path.unlink(missing_ok=True)
    with output_path.open('w') as output:
        try:
            process = subprocess.Popen(args, cwd=cwd, env=env, preexec_fn=preexec_fn,
                                       start_new_session=True, stdout=output, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + timeout
            while True:
                if cancelled():
                    reason = 'Verification cancelled'
                    break
                code = process.poll()
                if code is not None:
                    # pytest: 0=passed, 1=tests failed; 2..5 are interrupted/internal/usage/no tests.
                    if code in (0, 1):
                        try:
                            validate_report(report_path, code)
                            grade = 'passed' if code == 0 else 'failed'
                        except (OSError, ValueError, KeyError, TypeError) as error:
                            reason = f'No valid pytest report; no score produced: {error}'
                    else:
                        reason = f'Verifier could not produce a score (exit {code})'
                    break
                if time.monotonic() >= deadline:
                    reason = 'Verifier timed out; no score produced'
                    break
                time.sleep(.1)
        except OSError as error:
            reason = f'Verifier could not start: {error}'
        finally:
            if process is not None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
        if reason:
            output.write('\n' + reason + '\n')
    # Full output remains on disk, while the control protocol carries a bounded tail.
    return grade, display_output(output_path)
