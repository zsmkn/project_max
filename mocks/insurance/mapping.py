"""保險公司（INS，EIR2）外部系統的資料格式 ↔ Gateway 請求內容轉換（純函式，方便單元測試）。

模擬保險公司自己既有的理賠系統格式與本系統 Gateway（chaincode RecordClaim，見
gateway/src/routes.ts）的欄位不完全相同，示範一個典型的外部系統整合轉接層——只做
欄位對應與必填檢查，不含業務邏輯（理賠強制存證的規則已在鏈碼內，見
chaincode/vehicle/contract/contract.go 的 RecordClaim）。
"""

from __future__ import annotations


def claim_settlement_to_gateway_payload(settlement: dict) -> dict:
    """保險公司理賠結案通知（模擬格式："vin"、"policyClaimNo"、"accidentType"、
    "settlementAmount"、"damagedComponent"，皆為必填）
    → Gateway RecordClaim 請求內容（"claimId"、"incidentType"、"incidentAmount"、
    "incidentPart"）。
    """
    required = ["vin", "policyClaimNo", "accidentType", "settlementAmount", "damagedComponent"]
    missing = [key for key in required if settlement.get(key) in (None, "")]
    if missing:
        raise ValueError(f"理賠結案通知缺少必填欄位：{'、'.join(missing)}")

    amount = settlement["settlementAmount"]
    if not isinstance(amount, (int, float)) or isinstance(amount, bool):
        raise ValueError("settlementAmount 必須是數字")

    return {
        "vin": settlement["vin"],
        "claimId": settlement["policyClaimNo"],
        "incidentType": settlement["accidentType"],
        "incidentAmount": amount,
        "incidentPart": settlement["damagedComponent"],
    }
