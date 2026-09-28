"""呼叫 Gateway 內部服務埠的共用用戶端（階段 6，EIR1／EIR2 模擬服務共用）。

對應 gateway/src/server.ts 新增的內部服務埠：純 HTTP、僅限 loopback，不套用
Kyber-only 的 X25519MLKEM768 限制。這是刻意的範圍界線，不是疏漏——BFR4／IIR1
要求的 Kyber TLS 邊界鎖定在「瀏覽器／客戶端 ↔ Gateway」，且本機 WSL2 環境的
系統 OpenSSL（3.0.2）尚不支援 X25519MLKEM768，Python 用戶端無法完成該握手，
細節見 gateway/src/server.ts 的註解與 docs/stage6-integration.md。
"""

from __future__ import annotations

import os

import requests

DEFAULT_BASE_URL = "http://127.0.0.1:8080"


class GatewayError(RuntimeError):
    """Gateway 回傳非 2xx 狀態碼時拋出；訊息取自 Gateway 的錯誤回應內容。"""


def base_url() -> str:
    return os.environ.get("GATEWAY_INTERNAL_URL", DEFAULT_BASE_URL)


def post_json(path: str, body: dict, timeout: float = 10.0) -> dict:
    """對 Gateway 送出 POST 請求並回傳解析後的 JSON；非 2xx 狀態碼一律轉為 GatewayError，
    讓呼叫端（app.py 的 route handler）不需要重複處理 HTTP 細節。
    """
    url = base_url() + path
    response = requests.post(url, json=body, timeout=timeout)
    if not response.ok:
        try:
            message = response.json().get("error", response.text)
        except ValueError:
            message = response.text or response.reason
        raise GatewayError(f"Gateway 呼叫失敗（HTTP {response.status_code}）：{message}")
    return response.json() if response.content else {}
