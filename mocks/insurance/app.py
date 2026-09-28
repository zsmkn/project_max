"""保險公司（INS，EIR2）外部系統模擬服務。

模擬保險公司自己對外的理賠系統（理賠結案通知），本服務收到通知後轉換格式並呼叫
Gateway 內部服務埠，正式將理賠事件強制存證上鏈（RecordClaim，INS 組織身分，見
gateway/src/routes.ts）。只做介面示範，不對接真實保險公司系統（plan.md §3.5
「EIR2 保險公司：用 Python 寫模擬服務，透過 Gateway 呼叫合約；只做介面示範」、
CLAUDE.md「非目標」）。

用法：
    python3 -m mocks.insurance.app [port]   # 預設埠 9002

環境變數：
    GATEWAY_INTERNAL_URL   Gateway 內部服務埠位址（預設 http://127.0.0.1:8080）
"""

from __future__ import annotations

import sys

from mocks.common import json_service
from mocks.common.gateway_client import post_json
from mocks.insurance.mapping import claim_settlement_to_gateway_payload

DEFAULT_PORT = 9002


def handle_claim_settlement(settlement: dict) -> dict:
    vin = settlement.get("vin")
    payload = claim_settlement_to_gateway_payload(settlement)
    post_json(f"/api/vehicles/{vin}/claims", payload)
    return {"vin": vin, "claimId": payload["claimId"], "status": "已通知 Gateway 存證理賠事件"}


ROUTES = {
    ("POST", "/claim-settlements"): handle_claim_settlement,
}


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    json_service.run(ROUTES, "127.0.0.1", port)


if __name__ == "__main__":
    main()
