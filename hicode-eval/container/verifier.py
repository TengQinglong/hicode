"""Run the original pytest checks; infrastructure failure is not a failed answer."""
import os
import json
import signal
import subprocess
import time


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
                            if report_path.is_symlink() or report_path.stat().st_size > 16 * 1024 * 1024:
                                raise ValueError('Invalid report file')
                            report = json.loads(report_path.read_text())['results']
                            summary, tests = report['summary'], report['tests']
                            counts = {key: summary[key] for key in ['passed', 'failed', 'skipped', 'pending', 'other']}
                            if (type(summary['tests']) is not int or summary['tests'] <= 0
                                    or any(type(n) is not int or n < 0 for n in counts.values())
                                    or sum(counts.values()) != summary['tests'] or len(tests) != summary['tests']
                                    or any(sum(t['status'] == key for t in tests) != n for key, n in counts.items())
                                    or (code == 0) != (counts['failed'] == 0)):
                                raise ValueError('Report and exit status disagree')
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
    with output_path.open('rb') as output:
        output.seek(0, 2)
        output.seek(max(0, output.tell() - 64000))
        text = output.read().decode('utf-8', errors='replace')
    return grade, text
