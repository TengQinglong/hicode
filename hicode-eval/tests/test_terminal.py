import unittest
from unittest.mock import patch
from terminal import capture, settle, submit_prompt


class TerminalTest(unittest.TestCase):
    def test_prompt_enter_is_separated_from_paste_and_sent_only_once(self):
        calls=[]
        with patch('terminal.time.sleep',side_effect=lambda seconds:calls.append(('delay',seconds))):
            submit_prompt(lambda *args:calls.append(args),'/run/test/prompt.txt')
        self.assertEqual([c[0] for c in calls],['load-buffer','paste-buffer','delay','send-keys'])
        self.assertGreaterEqual(calls[2][1],.5)
        self.assertEqual(calls[-1][-1],'Enter')

    def test_completion_waits_for_delayed_paint_and_keeps_last_frame(self):
        clock = [0.0]
        packets = []
        def tmux(*args, **kwargs):
            self.assertEqual(args[0], 'capture-pane')
            return 'Generating response' if clock[0] < .7 else 'Complete final answer\nWorked for 5m'
        def sleep(seconds): clock[0] += seconds
        with patch('terminal.time.monotonic', side_effect=lambda: clock[0]), patch('terminal.time.sleep', side_effect=sleep):
            self.assertTrue(settle(tmux, lambda kind, **p: packets.append(p['screen']), lambda: False))
        self.assertGreaterEqual(clock[0], 1.7)
        self.assertEqual(packets, ['Generating response', 'Complete final answer\nWorked for 5m'])

    def test_animation_is_bounded_and_cancellation_does_not_wait(self):
        clock = [0.0]
        def tmux(*args, **kwargs): return str(clock[0])
        def sleep(seconds): clock[0] += seconds
        with patch('terminal.time.monotonic', side_effect=lambda: clock[0]), patch('terminal.time.sleep', side_effect=sleep):
            self.assertFalse(settle(tmux, lambda *args, **kwargs: None, lambda: False))
            self.assertLess(clock[0], 5.2)
            before = clock[0]
            self.assertFalse(settle(tmux, lambda *args, **kwargs: None, lambda: True))
            self.assertEqual(clock[0], before)

    def test_final_capture_is_not_throttled_or_skipped_if_screen_unchanged(self):
        packets = []
        for _ in range(2): capture(lambda *a, **kw: 'final', lambda kind, **p: packets.append(p))
        self.assertEqual(packets, [{'screen': 'final'}, {'screen': 'final'}])
