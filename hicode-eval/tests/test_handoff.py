import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from protocol import atomic_json, wait_verifier_handoff


class HandoffTest(unittest.TestCase):
    run_id = '0123456789abcdef'

    def run_wait(self, action, cancelled=lambda:False):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            clock=[0]
            def sleep(_):
                clock[0]+=1
                action(root,clock[0])
            with patch('protocol.time.monotonic',side_effect=lambda:clock[0]),patch('protocol.time.sleep',side_effect=sleep):
                return wait_verifier_handoff(root,self.run_id,cancelled)

    def receipt(self,root,status,**extra):
        atomic_json(root/'verification.json',{'version':1,'runId':self.run_id,'status':status,**extra})

    def test_upload_longer_than_old_deadline_after_ack(self):
        def action(root,elapsed):
            if elapsed==1:self.receipt(root,'accepted')
            if elapsed==45:self.receipt(root,'ready')
        self.assertTrue(self.run_wait(action))

    def test_missing_ack_has_bounded_wait(self):
        with self.assertRaisesRegex(RuntimeError,'acknowledgement timed out'):
            self.run_wait(lambda *_:None)

    def test_repeated_ack_does_not_extend_total_deadline(self):
        with self.assertRaisesRegex(RuntimeError,'upload timed out'):
            self.run_wait(lambda root,_:self.receipt(root,'accepted'))

    def test_upload_failure_preserves_real_error(self):
        with self.assertRaisesRegex(RuntimeError,'upload failed: copy failed'):
            self.run_wait(lambda root,_:self.receipt(root,'failed',message='copy failed'))

    def test_wrong_run_and_unversioned_receipts_rejected(self):
        for value in [{'version':1,'runId':'fedcba9876543210','status':'ready'},
                      {'runId':self.run_id,'status':'ready'}]:
            with self.subTest(value=value),self.assertRaisesRegex(ValueError,'identity/state'):
                self.run_wait(lambda root,_:atomic_json(root/'verification.json',value))

    def test_cancel_does_not_trigger_verification(self):
        self.assertFalse(self.run_wait(lambda *_:None,lambda:True))

    def test_cancel_during_acknowledged_upload(self):
        cancelled=[False]
        def action(root,elapsed):
            if elapsed==1:self.receipt(root,'accepted')
            if elapsed==3:cancelled[0]=True
        self.assertFalse(self.run_wait(action,lambda:cancelled[0]))

    def test_ready_without_observing_intermediate_ack(self):
        # An atomic ready receipt may replace accepted between two polls.
        self.assertTrue(self.run_wait(lambda root,_:self.receipt(root,'ready')))

    def test_symlink_receipt_rejected(self):
        with self.assertRaisesRegex(ValueError,'handoff file'):
            self.run_wait(lambda root,_:(root/'verification.json').symlink_to(root/'missing'))
