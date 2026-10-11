import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import network_entry


class NetworkEntryTest(unittest.TestCase):
    def test_continuation_preserves_the_wire_endpoint_used_by_reasoning_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'settings.json'
            path.write_text(json.dumps({'sources':{'fixture':{'baseUrl':'https://offline.invalid/v1'}}}))
            with patch.dict(os.environ,{'HICODE_EVAL_BRIDGE_PORT':'49152'}),\
                 patch('sys.argv',['network_entry','/model.sock',str(path),'fake-actor']),\
                 patch.object(network_entry,'Bridge') as server,patch.object(network_entry.threading,'Thread'),\
                 patch.object(network_entry.signal,'signal'),patch.object(network_entry.subprocess,'Popen') as child:
                server.return_value.server_address=('127.0.0.1',49152)
                child.return_value.wait.return_value=0;child.return_value.poll.return_value=0
                self.assertEqual(network_entry.main(),0)
                server.assert_called_once_with(('127.0.0.1',49152),network_entry.Relay)
                self.assertEqual(json.loads(path.read_text())['sources']['fixture']['baseUrl'],'http://127.0.0.1:49152/v1')
                server.return_value.server_close.assert_called_once()

    def test_privileged_or_invalid_checkpoint_ports_never_start_a_listener(self):
        for port in ['80','0','65536','invalid']:
            with self.subTest(port=port),patch.dict(os.environ,{'HICODE_EVAL_BRIDGE_PORT':port}),\
                 patch('sys.argv',['network_entry','/model.sock','unused','fake-actor']),patch.object(network_entry,'Bridge') as server:
                with self.assertRaises(ValueError):network_entry.main()
                server.assert_not_called()
