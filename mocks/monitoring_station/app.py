"""監理站（REG，EIR1）外部系統模擬服務。

模擬監理站自己對外的業務系統（報廢通知、過戶登記通知），本服務收到通知後轉換
格式並呼叫 Gateway 內部服務埠，正式將資料寫入鏈上（ScrapVehicle／
TransferOwnership，皆為 REG 組織身分，見 gateway/src/routes.ts）。只做介面示範，
不對接真實監理站系統（plan.md §3.5「EIR1 監理站：用 Python 寫模擬服務，透過
Gateway 呼叫合約；只做介面示範」、CLAUDE.md「非目標」）。

用法：
    python3 -m mocks.monitoring_station.app [port]   # 預設埠 9001

環境變數：
    GATEWAY_INTERNAL_URL   Gateway 內部服務埠位址（預設 http://127.0.0.1:8080）
"""

from __future__ import annotations

import sys

from mocks.common import json_service
from mocks.common.gateway_client import post_json
from mocks.monitoring_station.mapping import (
    scrap_notice_to_gateway_payload,
    transfer_notice_to_gateway_payload,
)

DEFAULT_PORT = 9001


def handle_scrap_notice(notice: dict) -> dict:
    vin = notice.get("vin")
    payload = scrap_notice_to_gateway_payload(notice)
    post_json(f"/api/vehicles/{vin}/scrap", payload)
    return {"vin": vin, "status": "已通知 Gateway 辦理報廢註銷"}


def handle_transfer_notice(notice: dict) -> dict:
    vin = notice.get("vin")
    payload = transfer_notice_to_gateway_payload(notice)
    post_json(f"/api/vehicles/{vin}/transfer", payload)
    return {"vin": vin, "status": "已通知 Gateway 辦理過戶登記"}


ROUTES = {
    ("POST", "/scrap-notices"): handle_scrap_notice,
    ("POST", "/transfer-notices"): handle_transfer_notice,
}


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    json_service.run(ROUTES, "127.0.0.1", port)


if __name__ == "__main__":
    main()
