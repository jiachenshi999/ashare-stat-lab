# -*- coding: utf-8 -*-
"""
本地服务入口（纯 Python 标准库，无第三方依赖）。

- 仅绑定 127.0.0.1，不开放局域网/公网；
- 断网也可正常服务已缓存的历史数据与统计；
- 启动后浏览器打开 http://127.0.0.1:8765
"""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402

STATS_DIR = os.path.join(config.PROCESSED_DIR, "stats")
MANIFEST_PATH = os.path.join(config.PROCESSED_DIR, "manifest.json")

# 静态文件 MIME
MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".csv": "text/csv; charset=utf-8",
}


def load_indices_meta() -> dict:
    """合并 config 的默认指数 + manifest 中的采集元数据。"""
    meta = {k: dict(v) for k, v in config.DEFAULT_INDICES.items()}
    if os.path.exists(MANIFEST_PATH):
        try:
            with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
                manifest = json.load(f)
            for r in manifest.get("indices", []):
                key = r.get("key")
                if key in meta:
                    meta[key].update(r)
        except Exception:  # noqa: BLE001
            pass
    # 补充是否有已计算的 stats
    for key in meta:
        meta[key]["has_stats"] = os.path.exists(os.path.join(STATS_DIR, f"{key}.json"))
    return meta


class Handler(BaseHTTPRequestHandler):
    server_version = "AshareStatLab/1.0"

    def _send(self, code: int, body: bytes, ctype: str = "application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(200, body)

    def do_GET(self):  # noqa: N802
        path = unquote(urlparse(self.path).path)
        try:
            if path in ("/", "/index.html"):
                return self._serve_file(os.path.join(config.FRONTEND_DIR, "index.html"))
            if path == "/api/indices":
                return self._send_json(load_indices_meta())
            if path == "/api/events":
                fp = os.path.join(config.PROJECT_ROOT, "data", "events.json")
                if os.path.exists(fp):
                    return self._serve_file(fp)
                return self._send_json({"events": []})
            if path.startswith("/api/stats/"):
                key = os.path.basename(path)
                if not key.endswith(".json"):
                    key += ".json"
                fp = os.path.join(STATS_DIR, key)
                if not os.path.abspath(fp).startswith(os.path.abspath(STATS_DIR)):
                    return self._send(400, b'{"error":"bad path"}')
                if not os.path.exists(fp):
                    return self._send(404, json.dumps({"error": "no stats for " + key}).encode("utf-8"))
                return self._serve_file(fp)
            if path.startswith("/api/csv/"):
                # 导出规范化行情 CSV
                key = os.path.basename(path)
                if not key.endswith(".csv"):
                    key += ".csv"
                fp = os.path.join(config.PROCESSED_DIR, key)
                if not os.path.exists(fp):
                    return self._send(404, b"not found")
                return self._serve_file(fp, ctype=MIME[".csv"])
            # 静态资源（仅限 frontend 目录）
            if path.startswith("/assets/") or path.endswith((".css", ".js", ".svg", ".png", ".json")):
                fp = os.path.normpath(os.path.join(config.FRONTEND_DIR, path.lstrip("/")))
                if not os.path.abspath(fp).startswith(os.path.abspath(config.FRONTEND_DIR)):
                    return self._send(400, b'{"error":"bad path"}')
                if os.path.exists(fp) and os.path.isfile(fp):
                    return self._serve_file(fp)
            return self._send(404, b'{"error":"not found"}')
        except Exception as e:  # noqa: BLE001
            return self._send(500, json.dumps({"error": f"{type(e).__name__}: {e}"}).encode("utf-8"))

    def _serve_file(self, fp: str, ctype: str | None = None):
        if not (os.path.exists(fp) and os.path.isfile(fp)):
            return self._send(404, b'{"error":"not found"}')
        ext = os.path.splitext(fp)[1].lower()
        ct = ctype or MIME.get(ext, "application/octet-stream")
        with open(fp, "rb") as f:
            body = f.read()
        self._send(200, body, ct)

    def log_message(self, fmt, *args):  # noqa: A003
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


def main() -> None:
    config.ensure_dirs()
    server = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    print(f"A股市场统计认知实验室 已启动： http://{config.HOST}:{config.PORT}")
    print("按 Ctrl+C 停止。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
        server.server_close()


if __name__ == "__main__":
    main()
