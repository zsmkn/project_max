"""極簡 JSON REST 服務基底，只用 Python 標準函式庫（不引入 Flask 等框架）。

mocks/ 底下的兩個外部系統模擬服務（監理站、保險公司）需求都一樣單純：收 JSON、
轉換格式、呼叫 Gateway、回 JSON，共用這層薄薄的 HTTP 處理邏輯即可
（CLAUDE.md「小而專注」、「不過度設計」）；本機環境未安裝 Flask，而需求本身也
不需要完整的 web 框架。
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

RouteHandler = Callable[[dict], dict]
Routes = dict[tuple[str, str], RouteHandler]


def make_handler_class(routes: Routes) -> type[BaseHTTPRequestHandler]:
    """依 routes（(method, path) -> handler(body) -> response_body）組出對應的
    BaseHTTPRequestHandler 子類別。handler 拋出 ValueError 視為請求格式錯誤（400，
    對應輸入驗證失敗，CLAUDE.md「只在系統邊界做輸入驗證」）；呼叫 Gateway 失敗
    （gateway_client.GatewayError 或其他例外）一律視為 502（下游服務錯誤），錯誤
    訊息直接取自例外內容（已是可讀說明，不含內部堆疊，CLAUDE.md「面向使用者的
    錯誤訊息不洩漏內部路徑」）。
    """

    class Handler(BaseHTTPRequestHandler):
        def _dispatch(self, method: str) -> None:
            handler = routes.get((method, self.path))
            if handler is None:
                self._respond(404, {"error": f"找不到路徑：{method} {self.path}"})
                return

            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length > 0 else b""
                body = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                self._respond(400, {"error": "請求內容不是合法的 JSON"})
                return

            try:
                result = handler(body)
            except ValueError as err:
                self._respond(400, {"error": str(err)})
                return
            except Exception as err:  # noqa: BLE001 — 統一轉換成對外的錯誤回應格式
                self._respond(502, {"error": str(err)})
                return

            self._respond(201, result)

        def _respond(self, status: int, payload: dict) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self) -> None:
            self._dispatch("POST")

        def log_message(self, log_format: str, *args: object) -> None:
            print(f"[{self.address_string()}] {log_format % args}")

    return Handler


def run(routes: Routes, host: str, port: int) -> None:
    handler_cls = make_handler_class(routes)
    server = ThreadingHTTPServer((host, port), handler_cls)
    print(f"監聽 http://{host}:{port}（Ctrl+C 結束）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
