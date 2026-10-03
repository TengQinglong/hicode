import http.client
import http.server
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest
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
        self.gateway = Gateway(self.path, f'http://127.0.0.1:{self.upstream.server_port}'+path, 'fixture', 'server-secret')

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

    def test_client_cancel_closes_slow_upstream(self):
        self.start('/slow')
        client=UnixHTTP(self.path)
        client.request('POST','/v1/chat/completions',body=self.body())
        response=client.getresponse()
        self.assertIn(b'delta',response.fp.readline())
        response.close();client.close()
        self.assertTrue(self.disconnected.wait(2))

    def test_all_current_provider_options_and_inline_images(self):
        body=self.body(stream_options={'include_usage':True},enable_thinking=True,preserve_thinking=True,
                       thinking={'type':'enabled'},provider={'require_parameters':True},
                       tools=[{'type':'function','function':{'name':'bash','parameters':{'type':'object'}}}],
                       messages=[{'role':'user','content':[{'type':'image_url','image_url':{'url':'data:image/png;base64,AAAA'}}]}])
        self.assertEqual(validate_request(body,'fixture')['model'],'fixture')
        with self.assertRaises(ValueError):validate_request(self.body(provider={'web_search':True}),'fixture')

    def test_invalid_credential_is_rejected_without_exposing_it(self):
        with self.assertRaisesRegex(ValueError,'^Invalid model credential format$'):
            Gateway(self.path,'https://example.invalid/v1','fixture','secret\r\nInjected: x')
        self.assertFalse(self.path.exists())
