"""Static dev server: no-cache headers, correct AVIF/WebP types, dual-stack."""
import http.server, socket, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5178

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.avif': 'image/avif',
        '.webp': 'image/webp',
        '.json': 'application/json',
        '.js':   'text/javascript',
    }
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()
    def log_message(self, *a):
        pass

class Server(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True
    address_family = socket.AF_INET6            # dual-stack: serves ::1 and 127.0.0.1

# on Windows IPV6_V6ONLY must be cleared before bind
httpd = Server(('::', PORT), Handler, bind_and_activate=False)
httpd.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
httpd.server_bind()
httpd.server_activate()
print(f'serving on http://localhost:{PORT}', flush=True)
httpd.serve_forever()
