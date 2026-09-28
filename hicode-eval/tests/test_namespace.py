import unittest
from protocol import namespace_argv

class NamespaceTest(unittest.TestCase):
    def test_task_keeps_app_path_and_does_not_mount_tests(self):
        a=namespace_argv(['bun','entry.ts'],'/eval/runs/a/project','/eval/runs/a/home','/eval/runs/a/logs','/run/a')
        self.assertIn('--unshare-user',a)
        self.assertEqual(a[a.index('--ro-bind')+1:a.index('--ro-bind')+3],['/','/'])
        self.assertIn('/app',a);self.assertNotIn('/tests',a)
        self.assertEqual(a[-2:],['bun','entry.ts'])

    def test_independent_tasks_share_no_writable_workspace(self):
        a=namespace_argv(['python'],'/eval/a/project','/eval/a/home','/eval/a/logs','/run/a')
        b=namespace_argv(['python'],'/eval/b/project','/eval/b/home','/eval/b/logs','/run/b')
        def writable(args):return [args[i+1] for i,v in enumerate(args) if v=='--bind']
        self.assertFalse(set(writable(a)) & set(writable(b)))

    def test_verifier_gets_read_only_original_tests_and_its_own_logs(self):
        a=namespace_argv(['python','-m','pytest'],'/eval/a/project','/eval/a/home','/eval/a/logs','/run/a','/eval/a/tests')
        i=a.index('/eval/a/tests');self.assertEqual(a[i-1],'--ro-bind');self.assertEqual(a[i+1],'/tests')
        self.assertIn('/eval/a/logs/verifier',a)
