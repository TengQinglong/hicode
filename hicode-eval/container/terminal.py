"""Capture the terminal after completion, independently of the live sampling interval."""
import time


def submit_prompt(tmux, path):
    tmux('load-buffer', str(path))
    tmux('paste-buffer', '-p', '-t', 'hicode:0.0')
    # Keep Enter out of the PTY paste burst. The runner still requires model_stream_start.
    time.sleep(.5)
    tmux('send-keys', '-t', 'hicode:0.0', 'Enter')


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
