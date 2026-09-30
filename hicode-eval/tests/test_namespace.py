import unittest
import tempfile
from unittest.mock import patch
from pathlib import Path
from protocol import namespace_argv, package_install_argv

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

    def test_control_is_read_only_even_for_preauthorized_commands(self):
        a=namespace_argv(['git','status'],'/eval/a/project','/eval/a/home','/eval/a/logs','/run/a')
        i=a.index('/run/a')
        self.assertEqual(a[i-1], '--ro-bind')

    def test_only_verifier_can_use_private_root_overlay_or_compile_tests(self):
        for option in [{'root_overlay':True},{'writable_tests':True}]:
            with self.assertRaises(ValueError):namespace_argv(['python'],'/p','/h','/l','/c',**option)
        a=namespace_argv(['python'],'/p','/h','/l','/c','/t',root_overlay=True)
        self.assertEqual(a[a.index('--tmpfs')+1],'/')
        i=a.index('/etc');self.assertEqual(a[i-1],'--ro-bind')
        i=a.index('/t');self.assertEqual(a[i-1],'--ro-bind')
        b=namespace_argv(['python'],'/p','/h','/l','/c','/t',writable_tests=True)
        i=b.index('/t');self.assertEqual(b[i-1],'--bind')

    def test_headless_verifier_does_not_inherit_another_runs_server_directory(self):
        with patch('protocol.os.listdir',return_value=['etc','usr','server']):
            a=namespace_argv(['python'],'/p','/h','/l','/c','/t',root_overlay=True)
        self.assertNotIn('/server',a)
        self.assertIn('/etc',a);self.assertIn('/usr',a)

    def test_cached_pins_install_without_network_and_validate_requirements(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache=Path(tmp)
            (cache/'numpy-2.2.5').mkdir()
            argv,offline=package_install_argv(['numpy==2.2.5'],'/app/.eval-python',cache)
            self.assertTrue(offline)
            self.assertIn('--no-index',argv)
            self.assertIn(str(cache/'numpy-2.2.5'),argv)
            argv,offline=package_install_argv(['numpy==2.3.1'],'/app/.eval-verifier-python',cache)
            self.assertFalse(offline)
            self.assertIn('--timeout',argv)
            for invalid in ['numpy','../../outside==1','numpy==1/../../outside']:
                with self.assertRaises(ValueError): package_install_argv([invalid],'/app/x',cache)
