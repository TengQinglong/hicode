import json
import unittest
from protocol import Events

class ProtocolTest(unittest.TestCase):
    def test_ready_does_not_acknowledge_prompt_submission(self):
        stream=Events()
        stream.accept(self.record(1,type='ready'))
        self.assertFalse(stream.started)
        stream.accept(self.record(2,type='state',busy=False,waitingForApproval=False))
        self.assertFalse(stream.started)
        stream.accept(self.record(3,type='agent_event',event={'type':'iteration','current':1}))
        self.assertFalse(stream.started)
        stream.accept(self.record(4,type='agent_event',event={'type':'model_stream_start'}))
        self.assertTrue(stream.started)

    def record(self, seq, **event):return (json.dumps({'version':1,'sequence':seq,'sessionId':'a',**event})+'\n').encode()
    def test_partial_event_and_child_guard(self):
        stream=Events();data=self.record(1,type='ready',sessionId='a')
        stream.accept(data[:7]);self.assertFalse(stream.ready)
        stream.accept(data[7:]);self.assertTrue(stream.ready)
        stream.accept(self.record(2,type='agent_event',event={'type':'turn_end','input':{'persistence_status':'saved'}}))
        stream.accept(self.record(3,type='settled',reason='completed',runningAgents=1,pendingAgentMessages=0,sealed=True))
        self.assertFalse(stream.complete())
        stream.accept(self.record(4,type='settled',reason='completed',runningAgents=0,pendingAgentMessages=0,sealed=True))
        self.assertTrue(stream.complete())
        stream.accept(self.record(5,type='settled',reason='completed',runningAgents=0,pendingAgentMessages=1,sealed=False))
        self.assertFalse(stream.complete())
    def test_missing_sequence_and_failed_persistence(self):
        stream=Events()
        with self.assertRaises(ValueError):stream.accept(self.record(2,type='ready'))
        stream=Events()
        stream.accept(self.record(1,type='settled',reason='completed',runningAgents=0,pendingAgentMessages=0,sealed=True))
        stream.accept(self.record(2,type='agent_event',event={'type':'turn_end','input':{'persistence_status':'failed'}}))
        self.assertFalse(stream.complete())
    def test_invalid_counters_and_mixed_sessions(self):
        stream=Events()
        with self.assertRaises(ValueError):stream.accept(self.record(1,type='settled',reason='completed',runningAgents=False,pendingAgentMessages=0,sealed=True))
        stream=Events();stream.accept(self.record(1,type='ready'))
        with self.assertRaises(ValueError):stream.accept(self.record(2,type='ready',sessionId='different'))

    def test_saved_turn_requires_execution_seal(self):
        stream=Events()
        stream.accept(self.record(1,type='agent_event',event={'type':'turn_end','input':{'persistence_status':'saved'}}))
        stream.accept(self.record(2,type='settled',reason='completed',runningAgents=0,pendingAgentMessages=0,sealed=False))
        self.assertFalse(stream.complete())
