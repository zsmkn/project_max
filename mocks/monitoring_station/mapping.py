"""監理站（REG，EIR1）外部系統的資料格式 ↔ Gateway 請求內容轉換（純函式，方便單元測試）。

模擬監理站自己既有的業務系統格式（報廢通知、過戶登記通知）與本系統 Gateway
（chaincode ScrapVehicle／TransferOwnership，見 gateway/src/routes.ts）的欄位不完全
相同，這裡示範一個典型的外部系統整合轉接層——只做欄位對應與必填檢查，不含業務邏輯
（業務規則已在鏈碼內，見 chaincode/vehicle/contract/contract.go）。
"""

from __future__ import annotations


def scrap_notice_to_gateway_payload(notice: dict) -> dict:
    """監理站報廢通知（模擬格式："vin"、"deregistrationReasonCode"、
    "deregistrationReasonText"，皆為必填；"officerId" 選填僅供稽核）
    → Gateway ScrapVehicle 請求內容（"reason"）。
    """
    required = ["vin", "deregistrationReasonCode", "deregistrationReasonText"]
    missing = [key for key in required if not notice.get(key)]
    if missing:
        raise ValueError(f"報廢通知缺少必填欄位：{'、'.join(missing)}")

    reason = f"[{notice['deregistrationReasonCode']}] {notice['deregistrationReasonText']}"
    return {"vin": notice["vin"], "reason": reason}


def transfer_notice_to_gateway_payload(notice: dict) -> dict:
    """監理站過戶登記通知（模擬格式："vin"、"newOwnerIdentityHash"，皆為必填；
    "officerId" 選填僅供稽核）→ Gateway TransferOwnership 請求內容（"newOwnerHash"）。

    newOwnerIdentityHash 沿用監理站端已完成的雜湊化身分（NFR1：車主身分不上鏈明文個資，
    見 CLAUDE.md「智慧合約規則」），本轉接層不做額外處理，只做欄位改名。
    """
    required = ["vin", "newOwnerIdentityHash"]
    missing = [key for key in required if not notice.get(key)]
    if missing:
        raise ValueError(f"過戶登記通知缺少必填欄位：{'、'.join(missing)}")

    return {"vin": notice["vin"], "newOwnerHash": notice["newOwnerIdentityHash"]}
