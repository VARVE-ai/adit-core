import http.client
import ipaddress
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


@unittest.skipUnless(os.environ.get("MITMDUMP"), "Set MITMDUMP to run the real HTTPS proxy test")
class ProxyTests(unittest.TestCase):
    def test_https_sse_is_forwarded_and_only_usage_is_written(self):
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID

        events = [
            {"type": "message_start", "message": {"id": "msg-local-test", "model": "local-test", "usage": {
                "input_tokens": 10, "output_tokens": 0, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 0}}},
            {"type": "content_block_delta", "delta": {"text": "private response code"}},
            {"type": "message_delta", "usage": {"output_tokens": 5}},
            {"type": "message_stop"},
        ]
        body = b"".join(b"data: " + json.dumps(event).encode() + b"\n\n" for event in events)

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("request-id", "request-local-test")
                self.end_headers()
                for position in range(0, len(body), 7):
                    self.wfile.write(body[position:position + 7])
                    self.wfile.flush()

            def log_message(self, *args):
                pass

        with tempfile.TemporaryDirectory(prefix="adit-usage-proxy-") as temporary:
            directory = Path(temporary)
            key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
            certificate = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
                .public_key(key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=1))
                .not_valid_after(datetime.now(timezone.utc) + timedelta(days=1))
                .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
                .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
                .sign(key, hashes.SHA256()))
            certificate_path = directory / "upstream.pem"
            key_path = directory / "upstream-key.pem"
            certificate_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
            key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            upstream = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(certificate_path, key_path)
            upstream.socket = context.wrap_socket(upstream.socket, server_side=True)
            worker = threading.Thread(target=upstream.serve_forever, daemon=True)
            worker.start()
            with socket.socket() as port_socket:
                port_socket.bind(("127.0.0.1", 0))
                port = port_socket.getsockname()[1]
            output = directory / "capture.jsonl"
            command = [os.environ["MITMDUMP"], "--listen-host", "127.0.0.1", "--listen-port", str(port),
                       "-s", str(Path(__file__).with_name("capture.py")), "--set", f"confdir={directory / 'mitm'}",
                       "--set", "usage_hosts=127.0.0.1", "--set", f"usage_output={output}",
                       "--set", f"ssl_verify_upstream_trusted_ca={certificate_path}",
                       "--set", "termlog_verbosity=error", "--set", "flow_detail=0"]
            proxy = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            try:
                ca = directory / "mitm" / "mitmproxy-ca-cert.pem"
                ready = False
                for attempt in range(100):
                    if proxy.poll() is not None:
                        self.fail(proxy.stdout.read().decode(errors="replace"))
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                            ready = ca.exists()
                        if ready:
                            break
                    except OSError:
                        pass
                    time.sleep(0.1)
                self.assertTrue(ready)
                client = http.client.HTTPSConnection("127.0.0.1", port, context=ssl.create_default_context(cafile=str(ca)), timeout=10)
                client.set_tunnel("127.0.0.1", upstream.server_port)
                client.request("POST", "/v1/messages", body=b'{"prompt":"private prompt"}', headers={"Authorization": "Bearer private-test-key"})
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), body)
                client.close()
                for attempt in range(30):
                    if output.exists() and '"finished"' in output.read_text(encoding="utf-8"):
                        break
                    time.sleep(0.1)
                captured_text = output.read_text(encoding="utf-8")
                self.assertNotIn("private", captured_text)
                entries = [json.loads(line) for line in captured_text.splitlines()]
                self.assertEqual([entry["phase"] for entry in entries], ["scope", "started", "finished"])
                captured = entries[-1]
                self.assertTrue(captured["complete"])
                self.assertEqual(captured["raw"]["output_tokens"], 5)
                self.assertEqual(captured["responseId"], "msg-local-test")
                self.assertEqual(captured["requestId"], "request-local-test")
            finally:
                proxy.terminate()
                try:
                    proxy.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    proxy.kill()
                    proxy.communicate()
                upstream.shutdown()
                upstream.server_close()
                worker.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
