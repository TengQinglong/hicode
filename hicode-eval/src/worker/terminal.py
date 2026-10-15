"""Capture the terminal after completion, independently of the live sampling interval."""
import time
import re
import subprocess
from protocol import CommandFailure, atomic_json


class ScreenSampler:
    """Live terminal images are observational after the CLI identity is pinned."""
    def __init__(self, tmux, emit, diagnostic_path):
        self.tmux = tmux
        self.emit = emit
        self.diagnostic_path = diagnostic_path
        self.next_sample = 0
        self.previous = None
        self.failures = 0
        self.diagnostic = {'version': 1, 'totalFailures': 0}

    def poll(self, *, required):
        now = time.monotonic()
        if now < self.next_sample:
            return
        self.next_sample = now + 1
        try:
            screen = read_screen(self.tmux)
        except (CommandFailure, OSError, subprocess.TimeoutExpired) as error:
            # Startup and prompt delivery still require a working terminal.
            if required:
                raise
            self.failures += 1
            self.next_sample = time.monotonic() + min(8, 2 ** min(self.failures, 3))
            self.diagnostic.update(state='degraded', consecutiveFailures=self.failures,
                                   totalFailures=self.diagnostic['totalFailures'] + 1,
                                   lastFailureAt=time.time(), lastError=str(error)[-2000:])
            atomic_json(self.diagnostic_path, self.diagnostic)
            if self.diagnostic['totalFailures'] == 1:
                self.emit('error', message='Live terminal sampling failed; CLI liveness and execution events remain authoritative. '
                          'See terminal-diagnostics.json. ' + str(error)[-500:])
            return
        if self.failures:
            self.failures = 0
            self.diagnostic.update(state='recovered', consecutiveFailures=0, recoveredAt=time.time())
            atomic_json(self.diagnostic_path, self.diagnostic)
        if screen != self.previous:
            self.emit('screen', screen=screen)
            self.previous = screen


def _input_preview(screen):
    plain = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', screen)
    for line in reversed(plain.splitlines()):
        if line.lstrip().startswith('❯'):
            return line.strip()
    return None


def submit_prompt(tmux, path, cancelled):
    # A ready event may precede Ink's paint. Observe the input before pasting;
    # elapsed wall time alone does not prove the PTY paste has been consumed.
    deadline = time.monotonic() + 15
    while True:
        if cancelled(): return False
        before = _input_preview(read_screen(tmux))
        if before is not None: break
        if time.monotonic() >= deadline:
            raise RuntimeError('Prompt input did not become visible; no Enter sent')
        time.sleep(.1)
    tmux('load-buffer', str(path))
    tmux('paste-buffer', '-p', '-t', 'hicode:0.0')
    previous = None
    unchanged_since = time.monotonic()
    while True:
        if cancelled(): return False
        screen = read_screen(tmux)
        now = time.monotonic()
        preview = _input_preview(screen)
        if now >= deadline:
            raise RuntimeError('Prompt paste did not settle in the input; no Enter sent')
        if preview is not None and preview != before:
            if screen != previous:
                previous, unchanged_since = screen, now
            elif now - unchanged_since >= .5:
                # Send once only. Model-stream acknowledgement remains authoritative.
                tmux('send-keys', '-t', 'hicode:0.0', 'Enter')
                return True
        else:
            previous, unchanged_since = None, now
        time.sleep(.1)


def read_screen(tmux):
    screen = tmux('capture-pane', '-p', '-e', '-S', '-20000', '-t', 'hicode:0.0', timeout=2)
    if len(screen.encode()) > 8 * 1024 * 1024:
        raise ValueError('Terminal exceeds budget')
    return screen


def capture(tmux, emit):
    screen = read_screen(tmux)
    emit('screen', screen=screen)
    return screen


def settle(tmux, emit, cancelled):
    # A saved completion event precedes Ink's final paint and PTY delivery.
    # Require a quiet screen after that event; never wait indefinitely on an animation.
    deadline = time.monotonic() + 5
    previous = None
    unchanged_since = time.monotonic()
    while True:
        screen = read_screen(tmux)
        now = time.monotonic()
        if screen != previous:
            previous, unchanged_since = screen, now
            emit('screen', screen=screen)
        elif now - unchanged_since >= 1:
            return True
        if cancelled() or now >= deadline:
            return False
        time.sleep(.1)
