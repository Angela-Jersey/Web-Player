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
LIBRARY_PATH = UPLOAD_DIR / "library.json"
PORT = int(os.environ.get("PORT", "3000"))
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

UPLOAD_DIR.mkdir(exist_ok=True)

state_lock = threading.RLock()
clients_lock = threading.Lock()
clients: dict[socket.socket, dict] = {}
state = {
    "audio": None,
    "playlist": [],
    "currentIndex": -1,
    "playMode": "list",
    "controllerId": None,
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
            "playlist": state["playlist"],
            "currentIndex": state["currentIndex"],
            "playMode": state["playMode"],
            "controllerId": state["controllerId"],
            "playing": state["playing"],
            "position": effective_position(),
            "serverTime": now_ms(),
            "devices": devices_list(),
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
            clients.pop(conn, None)


def broadcast(payload: dict, except_conn: socket.socket | None = None) -> None:
    with clients_lock:
        targets = list(clients)
    for conn in targets:
        if conn is not except_conn:
            send_json(conn, payload)


def devices_list() -> list[dict]:
    with clients_lock:
        return [
            {
                "id": info["id"],
                "name": info["name"],
                "enabled": info["enabled"],
                "controller": info["id"] == state.get("controllerId"),
                "joinedAt": info["joinedAt"],
            }
            for info in clients.values()
        ]


def broadcast_devices() -> None:
    broadcast({"type": "devices", "devices": devices_list()})


def playback_payload_for(enabled: bool) -> dict:
    payload = state_message("playback")
    payload["audible"] = enabled
    return payload


def broadcast_playback() -> None:
    with clients_lock:
        targets = list(clients.items())
    for conn, info in targets:
        send_json(conn, playback_payload_for(bool(info.get("enabled"))))


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


def websocket_loop(conn: socket.socket, device_info: dict) -> None:
    with clients_lock:
        clients[conn] = device_info
    with state_lock:
        if state["controllerId"] is None:
            state["controllerId"] = device_info["id"]
    send_json(conn, {"type": "hello", "deviceId": device_info["id"]})
    send_json(conn, state_message())
    broadcast_devices()
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
                with clients_lock:
                    enabled = bool(clients.get(conn, {}).get("enabled", True))
                payload = state_message()
                payload["audible"] = enabled
                send_json(conn, payload)
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
                if device_info["id"] != state.get("controllerId"):
                    continue
                set_playback(bool(message.get("playing")), float(message.get("position") or 0))
                broadcast_playback()
            elif message.get("type") == "device-enabled":
                device_id = str(message.get("id", ""))
                enabled = bool(message.get("enabled"))
                target_conn = None
                with clients_lock:
                    for client_conn, info in clients.items():
                        if info["id"] == device_id:
                            info["enabled"] = enabled
                            target_conn = client_conn
                            break
                broadcast_devices()
                if target_conn is not None:
                    send_json(target_conn, playback_payload_for(enabled))
            elif message.get("type") == "select-track":
                if device_info["id"] != state.get("controllerId"):
                    continue
                with state_lock:
                    index = int(message.get("index", -1))
                    if 0 <= index < len(state["playlist"]):
                        state["currentIndex"] = index
                        state["audio"] = state["playlist"][index]
                        state["playing"] = False
                        state["position"] = 0.0
                        state["updatedAt"] = time.time()
                        payload = state_message("audio")
                    else:
                        payload = None
                if payload:
                    send_json(conn, payload)
                    broadcast(payload, except_conn=conn)
            elif message.get("type") == "delete-track":
                if device_info["id"] != state.get("controllerId"):
                    continue
                with state_lock:
                    index = int(message.get("index", -1))
                    if 0 <= index < len(state["playlist"]):
                        deleting_current = index == state["currentIndex"]
                        removed = state["playlist"].pop(index)
                        removed_file = track_file(removed)
                        if removed_file.exists() and removed_file.is_relative_to(UPLOAD_DIR.resolve()):
                            try:
                                removed_file.unlink()
                            except OSError:
                                pass
                        if not state["playlist"]:
                            state["currentIndex"] = -1
                            state["audio"] = None
                            state["playing"] = False
                            state["position"] = 0.0
                        elif deleting_current:
                            state["currentIndex"] = min(index, len(state["playlist"]) - 1)
                            state["audio"] = state["playlist"][state["currentIndex"]]
                            state["playing"] = False
                            state["position"] = 0.0
                        elif index < state["currentIndex"]:
                            state["currentIndex"] -= 1
                        state["updatedAt"] = time.time()
                        save_library()
                        payload = state_message("audio" if deleting_current else "playlist")
                    else:
                        payload = None
                if payload:
                    send_json(conn, payload)
                    broadcast(payload, except_conn=conn)
            elif message.get("type") == "reorder-track":
                if device_info["id"] != state.get("controllerId"):
                    continue
                with state_lock:
                    from_index = int(message.get("from", -1))
                    to_index = int(message.get("to", -1))
                    playlist = state["playlist"]
                    if 0 <= from_index < len(playlist) and 0 <= to_index < len(playlist):
                        track = playlist.pop(from_index)
                        playlist.insert(to_index, track)
                        if state["currentIndex"] == from_index:
                            state["currentIndex"] = to_index
                        elif from_index < state["currentIndex"] <= to_index:
                            state["currentIndex"] -= 1
                        elif to_index <= state["currentIndex"] < from_index:
                            state["currentIndex"] += 1
                        if 0 <= state["currentIndex"] < len(playlist):
                            state["audio"] = playlist[state["currentIndex"]]
                        save_library()
                        payload = state_message("playlist")
                    else:
                        payload = None
                if payload:
                    send_json(conn, payload)
                    broadcast(payload, except_conn=conn)
            elif message.get("type") == "play-mode":
                if device_info["id"] != state.get("controllerId"):
                    continue
                mode = message.get("mode")
                if mode in {"list", "sequence", "random", "repeat-one"}:
                    with state_lock:
                        state["playMode"] = mode
                    payload = state_message("mode")
                    send_json(conn, payload)
                    broadcast(payload, except_conn=conn)
            elif message.get("type") == "claim-controller":
                with state_lock:
                    state["controllerId"] = device_info["id"]
                payload = state_message("state")
                send_json(conn, payload)
                broadcast(payload, except_conn=conn)
                broadcast_devices()
    finally:
        with clients_lock:
            clients.pop(conn, None)
        with state_lock:
            if state.get("controllerId") == device_info["id"]:
                state["controllerId"] = None
        broadcast_devices()
        try:
            conn.close()
        except OSError:
            pass


def safe_upload_name(original_name: str) -> str:
    suffix = Path(original_name).suffix.lower() or ".mp3"
    safe_suffix = suffix if re.match(r"^\.[a-z0-9]{1,8}$", suffix) else ".mp3"
    return f"{int(time.time() * 1000)}-{os.urandom(4).hex()}{safe_suffix}"


def media_url(filename: str) -> str:
    return f"/media/{quote(filename.rsplit('.', 1)[0])}"


def track_file(track: dict) -> Path:
    return (UPLOAD_DIR / str(track.get("id", ""))).resolve()


def track_from_file(file_path: Path, saved: dict | None = None) -> dict:
    name = saved.get("name") if saved else file_path.name
    content_type = saved.get("type") if saved else mimetypes.guess_type(file_path.name)[0]
    return {
        "id": file_path.name,
        "url": media_url(file_path.name),
        "name": name or file_path.name,
        "type": content_type or "audio/mpeg",
        "size": file_path.stat().st_size,
    }


def load_library() -> list[dict]:
    saved_by_id = {}
    if LIBRARY_PATH.exists():
        try:
            data = json.loads(LIBRARY_PATH.read_text(encoding="utf-8"))
            saved_by_id = {item.get("id"): item for item in data.get("tracks", []) if item.get("id")}
        except (OSError, json.JSONDecodeError):
            saved_by_id = {}

    tracks = []
    known = set()
    for saved in saved_by_id.values():
        file_path = (UPLOAD_DIR / saved["id"]).resolve()
        if file_path.exists() and file_path.is_file() and file_path.is_relative_to(UPLOAD_DIR.resolve()):
            tracks.append(track_from_file(file_path, saved))
            known.add(file_path.name)

    for file_path in sorted(UPLOAD_DIR.iterdir(), key=lambda item: item.stat().st_mtime):
        if file_path.name == LIBRARY_PATH.name or not file_path.is_file() or file_path.name in known:
            continue
        guessed_type = mimetypes.guess_type(file_path.name)[0] or ""
        if guessed_type.startswith("audio/"):
            tracks.append(track_from_file(file_path))

    return tracks


def save_library() -> None:
    with state_lock:
        data = {"tracks": state["playlist"]}
    LIBRARY_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def find_duplicate_track(name: str, size: int) -> int:
    with state_lock:
        for index, track in enumerate(state["playlist"]):
            if track.get("name") == name and int(track.get("size") or -1) == size:
                if track_file(track).exists():
                    return index
    return -1


def initialize_library() -> None:
    tracks = load_library()
    with state_lock:
        state["playlist"] = tracks
        state["currentIndex"] = 0 if tracks else -1
        state["audio"] = tracks[0] if tracks else None
        state["playing"] = False
        state["position"] = 0.0
        state["updatedAt"] = time.time()
    save_library()


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


def device_name(user_agent: str, address: tuple) -> str:
    ua = user_agent.lower()
    if "iphone" in ua:
        kind = "iPhone"
    elif "ipad" in ua:
        kind = "iPad"
    elif "android" in ua:
        kind = "Android"
    elif "windows" in ua:
        kind = "Windows"
    elif "mac" in ua:
        kind = "Mac"
    else:
        kind = "设备"
    return f"{kind} {address[0]}"


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
        content = self.rfile.read(length)
        duplicate_index = find_duplicate_track(original_name, length)

        with state_lock:
            if duplicate_index >= 0:
                state["currentIndex"] = duplicate_index
                track = state["playlist"][duplicate_index]
            else:
                filename = safe_upload_name(original_name)
                target = UPLOAD_DIR / filename
                target.write_bytes(content)
                track = {
                    "id": filename,
                    "url": media_url(filename),
                    "name": original_name,
                    "type": self.headers.get("Content-Type", "audio/mpeg"),
                    "size": len(content),
                }
                state["playlist"].append(track)
                state["currentIndex"] = len(state["playlist"]) - 1
                save_library()
            state["audio"] = track
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
        if path_part.startswith("/media/"):
            media_id = path_part.removeprefix("/media/")
            matches = list(UPLOAD_DIR.glob(f"{media_id}.*"))
            target = matches[0].resolve() if matches else (UPLOAD_DIR / "__not_found__").resolve()
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
        if self.path.startswith(("/media/", "/uploads/")):
            self.send_header("Content-Disposition", "inline")
            self.send_header("X-Content-Type-Options", "nosniff")
        if self.path.endswith((".html", ".js", ".css")) or self.path == "/":
            self.send_header("Cache-Control", "no-store, max-age=0")
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
        device_info = {
            "id": os.urandom(6).hex(),
            "name": device_name(self.headers.get("User-Agent", ""), self.client_address),
            "enabled": True,
            "joinedAt": now_ms(),
        }
        try:
            websocket_loop(conn, device_info)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
            pass

    def log_message(self, format: str, *args) -> None:
        return


def main() -> None:
    initialize_library()
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
