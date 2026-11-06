"""Servidor local para testar o site: python tests/serve.py (abre em http://127.0.0.1:8766)."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


handler = partial(Handler, directory=str(Path(__file__).resolve().parents[1]))
print("http://127.0.0.1:8766")
ThreadingHTTPServer(("127.0.0.1", 8766), handler).serve_forever()
