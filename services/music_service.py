"""
余烬 Ember · 音乐生成 HTTP 服务（stdlib，零依赖包装层）

由 server.js 在启动时作为子进程拉起，只监听 127.0.0.1。
    GET  /health    → ember_music.healthcheck()
    POST /generate  → ember_music.generate_music()（阻塞，LLM 最长约 90s）

运行：.venv/bin/python services/music_service.py   （端口用 EMBER_PORT 覆盖，默认 5174）
"""
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT_DIR)

from ember_music import generate_music, healthcheck, EMOTIONS  # noqa: E402

PORT = int(os.environ.get("EMBER_PORT", "5174"))
OUTPUT_DIR = os.path.join(ROOT_DIR, "data", "audio")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, **healthcheck()})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/generate":
            self._json(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")

            emotion = body.get("emotion", "平静")
            if emotion not in EMOTIONS:
                emotion = "平静"
            try:
                intensity = max(0, min(100, int(body.get("intensity", 0))))
            except (TypeError, ValueError):
                intensity = 0

            result = generate_music(
                emotion=emotion,
                intensity=intensity,
                ai_summary=str(body.get("aiSummary", ""))[:2000],
                text_input=str(body.get("textInput", ""))[:2000],
                output_dir=OUTPUT_DIR,
                use_llm=body.get("useLlm", True),
                session_id=body.get("sessionId"),
            )
            d = result.to_dict()
            # 返回相对 web 路径，前端直接 <audio src> 播放
            d["url"] = "/data/audio/" + os.path.basename(d["path"])
            self._json(200, {"ok": True, "result": d})
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt, *args):
        print(f"[music_service] {fmt % args}")


if __name__ == "__main__":
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    h = healthcheck()
    print(f"[music_service] healthcheck: fallback_pool_ok={h['fallback_pool_ok']} "
          f"llm_config_ok={h['llm_config_ok']} model={h['llm_model']}")
    if not h["fallback_pool_ok"]:
        print(f"[music_service] FATAL 兜底 wav 缺失: {h['fallback_missing']}")
        sys.exit(1)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[music_service] listening on http://127.0.0.1:{PORT}")
    server.serve_forever()
