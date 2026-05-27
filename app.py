from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import re
import socket
import struct
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
UPLOAD_DIR = ROOT / "uploads"
PORT = int(os.environ.get("PORT", "3000"))
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

UPLOAD_DIR.mkdir(exist_ok=True)

state_lock = threading.RLock()
clients_lock = threading.Lock()
clients: set[socket.socket] = set()
state = {
    "audio": None,
    "playing": False,
    "position": 0.0,
    "updatedAt": time.time(),
}


def now_ms() -> int:
    return int(time.time() * 1000)


def effective_position() -> float:
    with state_lock:
        if not state["playing"]:
            return float(state["position"])
        return float(state["position"]) + (time.time() - float(state["updatedAt"]))


def set_playback(playing: bool, position: float) -> None:
    with state_lock:
        state["playing"] = bool(playing)
        state["position"] = max(0.0, float(position or 0))
        state["updatedAt"] = time.time()


def state_message(kind: str = "state") -> dict:
    with state_lock:
        message = {
            "type": kind,
            "audio": state["audio"],
            "playing": state["playing"],
            "position": effective_position(),
            "serverTime": now_ms(),
        }
    return message


def frame_text(payload: dict) -> bytes:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if len(data) < 126:
        return bytes([0x81, len(data)]) + data
    if len(data) < 65536:
        return bytes([0x81, 126]) + struct.pack("!H", len(data)) + data
    return bytes([0x81, 127]) + struct.pack("!Q", len(data)) + data


def send_json(conn: socket.socket, payload: dict) -> None:
    try:
        conn.sendall(frame_text(payload))
    except OSError:
        with clients_lock:
            clients.discard(conn)


def broadcast(payload: dict, except_conn: socket.socket | None = None) -> None:
    with clients_lock:
        targets = list(clients)
    for conn in targets:
        if conn is not except_conn:
            send_json(conn, payload)


def read_frame(conn: socket.socket) -> str | None:
    header = conn.recv(2)
    if len(header) < 2:
        return None
    opcode = header[0] & 0x0F
    if opcode == 0x8:
        return None

    length = header[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", conn.recv(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", conn.recv(8))[0]

    masked = bool(header[1] & 0x80)
    mask = conn.recv(4) if masked else b"\x00\x00\x00\x00"
    data = bytearray()
    while len(data) < length:
        chunk = conn.recv(length - len(data))
        if not chunk:
            return None
        data.extend(chunk)

    if masked:
        for index in range(length):
            data[index] ^= mask[index % 4]
    return data.decode("utf-8")


def websocket_loop(conn: socket.socket) -> None:
    with clients_lock:
        clients.add(conn)
    send_json(conn, state_message())
    try:
        while True:
            text = read_frame(conn)
            if text is None:
                break
            try:
                message = json.loads(text)
            except json.JSONDecodeError:
                continue

            if message.get("type") == "sync-request":
                send_json(conn, state_message())
            elif message.get("type") == "ping":
                send_json(
                    conn,
                    {
                        "type": "pong",
                        "clientTime": message.get("clientTime"),
                        "serverTime": now_ms(),
                    },
                )
            elif message.get("type") == "playback":
                set_playback(bool(message.get("playing")), float(message.get("position") or 0))
                payload = state_message("playback")
                broadcast(payload, except_conn=conn)
    finally:
        with clients_lock:
            clients.discard(conn)
        try:
            conn.close()
        except OSError:
            pass


def safe_upload_name(original_name: str) -> str:
    suffix = Path(original_name).suffix.lower() or ".mp3"
    safe_suffix = suffix if re.match(r"^\.[a-z0-9]{1,8}$", suffix) else ".mp3"
    return f"{int(time.time() * 1000)}-{os.urandom(4).hex()}{safe_suffix}"


def lan_urls() -> list[str]:
    urls = []
    try:
        host_name = socket.gethostname()
        for _, _, _, _, sockaddr in socket.getaddrinfo(host_name, PORT, family=socket.AF_INET):
            ip = sockaddr[0]
            if not ip.startswith("127.") and f"http://{ip}:{PORT}" not in urls:
                urls.append(f"http://{ip}:{PORT}")
    except socket.gaierror:
        pass
    return urls


def likely_phone_url(urls: list[str]) -> str | None:
    for url in urls:
        if url.startswith("http://192.168."):
            return url
    for url in urls:
        if url.startswith("http://10.") or url.startswith("http://172."):
            return url
    return urls[0] if urls else None


class Handler(SimpleHTTPRequestHandler):
    server_version = "LanSyncAudio/1.0"

    def handle(self) -> None:
        try:
            super().handle()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
            pass

    def do_GET(self) -> None:
        if self.headers.get("Upgrade", "").lower() == "websocket":
            self.handle_websocket()
            return
        try:
            super().do_GET()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
            pass

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/upload":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length > 150 * 1024 * 1024:
            self.send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return

        original_name = unquote(self.headers.get("X-File-Name", "audio"))
        filename = safe_upload_name(original_name)
        target = UPLOAD_DIR / filename
        target.write_bytes(self.rfile.read(length))

        with state_lock:
            state["audio"] = {
                "url": f"/uploads/{quote(filename)}",
                "name": original_name,
                "type": self.headers.get("Content-Type", "audio/mpeg"),
            }
            state["playing"] = False
            state["position"] = 0.0
            state["updatedAt"] = time.time()

        payload = state_message("audio")
        broadcast(payload)
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def translate_path(self, request_path: str) -> str:
        parsed = urlparse(request_path)
        path_part = unquote(parsed.path)
        if path_part.startswith("/uploads/"):
            relative = path_part.removeprefix("/uploads/")
            target = (UPLOAD_DIR / relative).resolve()
            if not target.is_relative_to(UPLOAD_DIR.resolve()):
                return str((UPLOAD_DIR / "__not_found__").resolve())
            return str(target)
        if path_part == "/":
            path_part = "/index.html"
        relative = path_part.lstrip("/")
        target = (PUBLIC_DIR / relative).resolve()
        if not target.is_relative_to(PUBLIC_DIR.resolve()):
            return str((PUBLIC_DIR / "__not_found__").resolve())
        return str(target)

    def guess_type(self, path: str) -> str:
        if path.endswith(".js"):
            return "text/javascript; charset=utf-8"
        if path.endswith(".css"):
            return "text/css; charset=utf-8"
        return mimetypes.guess_type(path)[0] or "application/octet-stream"

    def end_headers(self) -> None:
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def handle_websocket(self) -> None:
        key = self.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(hashlib.sha1(f"{key}{GUID}".encode()).digest()).decode()
        self.send_response(HTTPStatus.SWITCHING_PROTOCOLS)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()

        conn = self.connection
        self.close_connection = True
        try:
            websocket_loop(conn)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
            pass

    def log_message(self, format: str, *args) -> None:
        return


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"本机: http://localhost:{PORT}")
    urls = lan_urls()
    phone_url = likely_phone_url(urls)
    if phone_url:
        print(f"手机优先试: {phone_url}")
    for url in urls:
        print(f"局域网: {url}")
    print("按 Ctrl+C 停止")
    server.serve_forever()


if __name__ == "__main__":
    main()
