import http.client
import http.server
import json
from pathlib import Path
import socket
import ssl
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from model_proxy import Gateway, validate_request


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=3)
        self.path = str(path)
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class ModelProxyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)/'model.sock'
        self.requests = []
        self.disconnected = threading.Event()
        fixture = self
        class Upstream(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):pass
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                fixture.requests.append((self.path, self.headers.get('Authorization'), json.loads(body)))
                if self.path.startswith('/redirect'):
                    self.send_response(302);self.send_header('Location','http://never-contact.invalid');self.end_headers();return
                if self.path.startswith('/error'):
                    self.send_response(403);self.end_headers()
                    self.wfile.write(b'{"error":{"code":"data_inspection_failed","message":"bad key server-secret"}}');return
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
                self.wfile.write(b'data: {"delta":"ok"}\n\n');self.wfile.flush()
                if self.path.startswith('/slow'):
                    self.connection.settimeout(3)
                    if self.connection.recv(1) == b'':fixture.disconnected.set()
                else:self.wfile.write(b'data: [DONE]\n\n')
        self.upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        self.thread = threading.Thread(target=self.upstream.serve_forever, daemon=True);self.thread.start()
        self.gateway = None

    def tearDown(self):
        if self.gateway:self.gateway.close()
        self.upstream.shutdown();self.upstream.server_close();self.thread.join();self.tmp.cleanup()

    def start(self, path='/fixed/v1'):
        self.gateway = Gateway(self.path, f'http://127.0.0.1:{self.upstream.server_port}'+path, 'fixture', 'server-secret', {'effort':'default'})

    def body(self, **kwargs):
        return json.dumps({'model':'fixture','stream':True,'messages':[{'role':'user','content':'test'}],**kwargs}).encode()

    def request(self, path='/v1/chat/completions', body=None):
        client=UnixHTTP(self.path)
        try:
            try:
                client.request('POST',path,body=self.body() if body is None else body,
                               headers={'Content-Type':'application/json','Authorization':'Bearer actor-placeholder'})
            except BrokenPipeError:
                # A rejected URL can receive its HTTP response before the body is sent.
                pass
            response=client.getresponse()
            return response.status,response.read()
        finally:client.close()

    def test_stream_fixed_destination_and_credential_never_returned(self):
        self.start()
        status,body=self.request()
        self.assertEqual(status,200);self.assertIn(b'[DONE]',body)
        self.assertNotIn(b'server-secret',body)
        self.assertEqual(self.requests[0][:2],('/fixed/v1/chat/completions','Bearer server-secret'))
        self.assertEqual(self.path.stat().st_mode & 0o777,0o600)

    def test_arbitrary_targets_builtin_search_and_remote_images_are_rejected(self):
        self.start()
        for path,body in [('/v1/chat/completions?url=https://example.com',self.body()),
                          ('https://example.com',self.body()),
                          ('/v1/chat/completions',self.body(enable_search=True)),
                          ('/v1/chat/completions',self.body(model='other')),
                          ('/v1/chat/completions',self.body(tools=[{'type':'web_search'}])),
                          ('/v1/chat/completions',self.body(messages=[{'role':'user','content':[
                              {'type':'image_url','image_url':{'url':'https://example.com/a.png'}}]}]))]:
            self.assertEqual(self.request(path,body)[0],403)
        self.assertEqual(self.requests,[])

    def test_redirect_does_not_contact_another_destination(self):
        self.start('/redirect')
        self.assertEqual(self.request()[0],502)
        self.assertEqual(len(self.requests),1)

    def test_provider_error_keeps_code_without_leaking_a_reflected_credential(self):
        self.start('/error')
        status,body=self.request()
        self.assertEqual(status,403)
        self.assertIn(b'data_inspection_failed',body)
        self.assertNotIn(b'server-secret',body)

    def test_gateway_failures_identify_stage_and_kind_without_exception_text(self):
        self.start()
        for method, error, stage, kind in [
            ('connect', socket.timeout('server-secret'), 'connect', 'timeout'),
            ('connect', TimeoutError('server-secret'), 'connect', 'timeout'),
            ('connect', socket.gaierror('server-secret'), 'connect', 'dns'),
            ('connect', ssl.SSLError('server-secret'), 'connect', 'tls'),
            ('request', ConnectionResetError('server-secret'), 'send_request', 'connection'),
            ('getresponse', http.client.BadStatusLine('server-secret'), 'wait_response', 'protocol'),
        ]:
            with self.subTest(stage=stage, kind=kind):
                upstream = Mock()
                closed = threading.Event()
                upstream.close.side_effect = closed.set
                getattr(upstream, method).side_effect = error
                with patch('model_proxy.http.client.HTTPConnection', return_value=upstream), patch('model_proxy.sys.stderr') as stderr:
                    status, body = self.request()
                    self.assertTrue(closed.wait(2))
                self.assertEqual(status, 502)
                details = json.loads(body)['error']
                self.assertEqual(details['stage'], stage)
                self.assertEqual(details['code'], 'model_gateway_' + kind)
                self.assertGreaterEqual(details['elapsed_ms'], 0)
                self.assertNotIn(b'server-secret', body)
                self.assertNotIn('server-secret', str(stderr.write.call_args_list))
                upstream.close.assert_called_once()

    def test_stream_timeout_reports_error_without_completion_or_second_http_response(self):
        self.start()
        upstream = Mock()
        response = upstream.getresponse.return_value
        response.status = 200
        response.getheader.return_value = 'text/event-stream'
        response.read1.side_effect = [b'data: {"delta":"partial"}\n\n', TimeoutError('server-secret')]
        with patch('model_proxy.http.client.HTTPConnection', return_value=upstream), patch('model_proxy.sys.stderr') as stderr:
            status, body = self.request()
        self.assertEqual(status, 200)
        self.assertIn(b'data: {"delta":"partial"}', body)
        event = json.loads(body.split(b'data: ')[-1])['error']
        self.assertEqual(event['stage'], 'read_stream')
        self.assertEqual(event['code'], 'model_gateway_timeout')
        self.assertNotIn(b'[DONE]', body)
        self.assertNotIn(b'HTTP/', body)
        self.assertNotIn(b'server-secret', body)
        self.assertNotIn('server-secret', str(stderr.write.call_args_list))

    def test_error_body_timeout_keeps_gateway_diagnostics(self):
        self.start()
        upstream = Mock()
        response = upstream.getresponse.return_value
        response.status = 429
        response.read.side_effect = TimeoutError('server-secret')
        with patch('model_proxy.http.client.HTTPConnection', return_value=upstream), patch('model_proxy.sys.stderr'):
            status, body = self.request()
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body)['error']['stage'], 'read_error_response')
        self.assertNotIn(b'server-secret', body)

    def test_client_cancel_closes_slow_upstream(self):
        self.start('/slow')
        client=UnixHTTP(self.path)
        client.request('POST','/v1/chat/completions',body=self.body())
        response=client.getresponse()
        self.assertIn(b'delta',response.fp.readline())
        response.close();client.close()
        self.assertTrue(self.disconnected.wait(2))

    def test_frozen_reasoning_allows_auxiliary_off_but_rejects_changed_or_conflicting_levels(self):
        policy={'switch':'enable_thinking','efforts':['default','off','low','high','max'],'effort':'max','reviewEffort':'off'}
        value=validate_request(self.body(enable_thinking=True,reasoning_effort='max'),'fixture',policy)
        self.assertEqual(value['reasoning_effort'],'max')
        validate_request(self.body(enable_thinking=False),'fixture',policy)
        for fields in [dict(enable_thinking=True,reasoning_effort='high'),dict(enable_thinking=True),
                       dict(thinking={'type':'enabled'},reasoning_effort='max'),
                       dict(enable_thinking=False,reasoning_effort='max'),
                       dict(enable_thinking=True,reasoning_effort=99),dict(enable_thinking='true'),
                       dict(enable_thinking=False,preserve_thinking=True),dict(thinking={'type':'other'}),
                       dict(reasoning_effort={'malformed':'value'})]:
            with self.assertRaises(ValueError):validate_request(self.body(**fields),'fixture',policy)
        policy['effort']='default'
        validate_request(self.body(enable_thinking=True),'fixture',policy)
        with self.assertRaises(ValueError):validate_request(self.body(enable_thinking=True,reasoning_effort='max'),'fixture',policy)
        policy['effort']='off'
        with self.assertRaises(ValueError):validate_request(self.body(enable_thinking=True),'fixture',policy)
        native={'switch':'thinking','efforts':['default','off','low','high','max'],'effort':'low','reviewEffort':'off'}
        validate_request(self.body(thinking={'type':'enabled'},reasoning_effort='low'),'fixture',native)
        validate_request(self.body(thinking={'type':'disabled'}),'fixture',native)

    def test_ark_effort_only_protocol_freezes_main_and_allows_review_none(self):
        policy={'switch':'reasoning_effort','efforts':['default','off','low','high','max'],'effort':'max','reviewEffort':'off'}
        validate_request(self.body(reasoning_effort='max'),'fixture',policy)
        validate_request(self.body(reasoning_effort='none'),'fixture',policy)
        for fields in [dict(),dict(reasoning_effort='high'),dict(reasoning_effort='medium'),
                       dict(reasoning_effort='off'),dict(reasoning_effort='max',thinking={'type':'enabled'}),
                       dict(reasoning_effort='none',enable_thinking=False),dict(preserve_thinking=True),
                       dict(reasoning={'effort':'max'})]:
            with self.assertRaises(ValueError):validate_request(self.body(**fields),'fixture',policy)
        policy['effort']='default'
        validate_request(self.body(),'fixture',policy)
        validate_request(self.body(reasoning_effort='none'),'fixture',policy)
        with self.assertRaises(ValueError):validate_request(self.body(reasoning_effort='high'),'fixture',policy)
        policy['effort']='off'
        validate_request(self.body(reasoning_effort='none'),'fixture',policy)
        for fields in [dict(),dict(reasoning_effort='low')]:
            with self.assertRaises(ValueError):validate_request(self.body(**fields),'fixture',policy)
        other={'switch':'thinking','efforts':policy['efforts'],'effort':'max','reviewEffort':'off'}
        with self.assertRaises(ValueError):validate_request(self.body(reasoning_effort='none'),'fixture',other)

    def test_forced_thinking_accepts_frozen_effort_or_review_low_and_never_off(self):
        policy={'switch':'thinking','efforts':['default','low','high','max'],'effort':'max','reviewEffort':'low'}
        for effort in ['max','low']:
            validate_request(self.body(thinking={'type':'enabled'},reasoning_effort=effort),'fixture',policy)
        for fields in [dict(thinking={'type':'disabled'}),dict(thinking={'type':'enabled'},reasoning_effort='high'),
                       dict(reasoning_effort='max'),dict(thinking={'type':'enabled'},reasoning_effort='medium')]:
            with self.assertRaises(ValueError):validate_request(self.body(**fields),'fixture',policy)
        policy['effort']='default'
        validate_request(self.body(thinking={'type':'enabled'}),'fixture',policy)
        validate_request(self.body(thinking={'type':'enabled'},reasoning_effort='low'),'fixture',policy)
        with self.assertRaises(ValueError):validate_request(self.body(thinking={'type':'enabled'},reasoning_effort='max'),'fixture',policy)

    def test_all_current_provider_options_and_inline_images(self):
        body=self.body(stream_options={'include_usage':True},enable_thinking=True,preserve_thinking=True,
                       thinking={'type':'enabled'},provider={'require_parameters':True},
                       tools=[{'type':'function','function':{'name':'bash','parameters':{'type':'object'}}}],
                       messages=[{'role':'user','content':[{'type':'image_url','image_url':{'url':'data:image/png;base64,AAAA'}}]}])
        self.assertEqual(validate_request(body,'fixture')['model'],'fixture')
        with self.assertRaises(ValueError):validate_request(self.body(provider={'web_search':True}),'fixture')

    def test_invalid_credential_is_rejected_without_exposing_it(self):
        with self.assertRaisesRegex(ValueError,'^Invalid model credential format$'):
            Gateway(self.path,'https://example.invalid/v1','fixture','secret\r\nInjected: x',{'effort':'default'})
        self.assertFalse(self.path.exists())
