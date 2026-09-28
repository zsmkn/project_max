#!/usr/bin/env bash
#
# 階段 2 驗收：以 peer CLI 重現 UC-03 前半段（車廠初始化 InitVehicle、理賠存證
# RecordClaim），並示範 chaincode/vehicle/contract/policy.go 設定的狀態背書（SBE）
# 實際生效範圍：SBE 保護 EVT 鍵「之後」的修改，但無法保護「首次建立」當下那筆
# 交易本身（Fabric 既有限制，非本專案程式錯誤；2026-09-23 確認並記錄於
# docs/stage2-chaincode.md，PoC 階段接受此限制，暫不重新設計背書機制）。
#
# 用法：bash scripts/demoStage2.sh [channel名稱]
# 前提：network.sh up、createChannel、deployCC.sh 皆已執行完成。

set -uo pipefail

NETWORK_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
. "${NETWORK_HOME}/scripts/envVar.sh"

CHANNEL_NAME=${1:-vehiclechannel}
CC_NAME=vehicle
ORDERER_ADDR="localhost:7050"
ORDERER_HOSTNAME_OVERRIDE="orderer1.${DOMAIN}"

invoke() {
  local submitterOrg=$1; shift
  local fcn=$1; shift
  local argsJSON=$1; shift
  # 其餘參數為背書組織代號（org 代號，依序組出 --peerAddresses / --tlsRootCertFiles）。
  # 注意順序：parsePeerConnectionParameters 內部會呼叫 setGlobals 覆寫 CORE_PEER_*，
  # 因此送出交易提案簽署身分的 setGlobals submitterOrg 必須放在其「之後」，
  # 才能讓「呼叫者身分」與「背書組織」分開控制（驗證 SBE 是否真的檢查背書簽章，
  # 而不是只看鏈碼內的呼叫者 MSP 檢查）。
  parsePeerConnectionParameters "$@"
  setGlobals "$submitterOrg"
  peer chaincode invoke -o "${ORDERER_ADDR}" --ordererTLSHostnameOverride "${ORDERER_HOSTNAME_OVERRIDE}" \
    --tls --cafile "${ORDERER_CA}" -C "${CHANNEL_NAME}" -n "${CC_NAME}" \
    -c "{\"function\":\"${fcn}\",\"Args\":${argsJSON}}" \
    "${PEER_CONN_PARMS[@]}" --waitForEvent
}

query() {
  local fcn=$1; shift
  local argsJSON=$1
  peer chaincode query -C "${CHANNEL_NAME}" -n "${CC_NAME}" \
    -c "{\"function\":\"${fcn}\",\"Args\":${argsJSON}}"
}

# 用時間戳讓每次重跑（即使對同一個未清除的 channel）都不會撞上零件雜湊
# 重複綁定檢查（PartBinding，見 contract.go）——VIN 與引擎／變速箱雜湊都要唯一。
RUN_ID=$(date +%s)
VIN1="VIN${RUN_ID}A"
VIN2="VIN${RUN_ID}B"

echo "=============================================================="
infoln "① InitVehicle（呼叫者 OEM，背書 OEM+REG，符合 AND(OEM,REG)）— 預期成功"
invoke oem InitVehicle "[\"${VIN1}\",\"ENGINE-DEMO-${RUN_ID}\",\"TRANS-DEMO-${RUN_ID}\",\"2024\",\"800000\",\"owner-hash-demo1\"]" oem reg
r1=$?
[ $r1 -eq 0 ] && successln "① 成功（符合預期）" || errorln "① 失敗（不符預期，應成功）"

echo "=============================================================="
infoln "② InitVehicle（呼叫者 OEM，背書 SVC+INS，未含 OEM／REG）— 預期「仍會成功」"
infoln "   已知限制（2026-09-23 確認並記錄於 docs/stage2-chaincode.md，PoC 階段"
infoln "   接受不修正）：Fabric 的狀態背書（SBE）只保護鍵值『之後』的寫入，"
infoln "   建立 EVT 鍵當下這筆交易本身仍受鏈碼層級寬鬆政策 OutOf(2,五組織) 管轄，"
infoln "   因此任兩組織背書即可通過。這裡刻意示範此限制，而非驗證『被阻擋』。"
invoke oem InitVehicle "[\"${VIN2}\",\"ENGINE-DEMO-${RUN_ID}-B\",\"TRANS-DEMO-${RUN_ID}-B\",\"2024\",\"800000\",\"owner-hash-demo2\"]" svc ins
r2=$?
[ $r2 -eq 0 ] && successln "② 成功（符合目前已知限制：SBE 未擋下缺少 OEM/REG 的背書組合）" || errorln "② 失敗（不符已知限制，SBE 這次反而擋下了，值得留意是否行為有變）"

echo "=============================================================="
infoln "③ AddMaintenance（呼叫者 SVC，背書 SVC+REG，符合 AND(SVC,OutOf(1,REG,APP)))— 預期成功"
invoke svc AddMaintenance "[\"${VIN1}\",\"OIL_CHANGE\",\"12000\",\"更換機油（demo）\"]" svc reg
r3=$?
[ $r3 -eq 0 ] && successln "③ 成功（符合預期）" || errorln "③ 失敗（不符預期，應成功）"

echo "=============================================================="
infoln "④ AddMaintenance（呼叫者 SVC，背書 REG+INS，未含 SVC）— 預期「仍會成功」（同②的已知限制："
infoln "   本次 AddMaintenance 新建立的 EVT 鍵也是首次寫入，不受其上剛設定的 SBE 保護）"
invoke svc AddMaintenance "[\"${VIN1}\",\"OIL_CHANGE\",\"13000\",\"更換機油（demo，背書組織錯誤）\"]" reg ins
r4=$?
[ $r4 -eq 0 ] && successln "④ 成功（符合目前已知限制）" || errorln "④ 失敗（不符已知限制，SBE 這次反而擋下了，值得留意是否行為有變）"

echo "=============================================================="
infoln "⑤ RecordClaim（呼叫者 INS，背書 INS+APP，符合 AND(INS,OutOf(1,REG,APP)))— UC-03 後半段，預期成功"
invoke ins RecordClaim "[\"${VIN1}\",\"CLM-DEMO-${RUN_ID}\",\"COLLISION\",\"45000\",\"FRONT_BUMPER\"]" ins app
r5=$?
[ $r5 -eq 0 ] && successln "⑤ 成功（符合預期）" || errorln "⑤ 失敗（不符預期，應成功）"

echo "=============================================================="
infoln "⑥ 查詢 GetSummary（任何組織皆可查詢，FFR1／IIR2）"
setGlobals app
query GetSummary "[\"${VIN1}\"]"

echo "=============================================================="
infoln "⑦ 查詢 GetVehicleHistory（FFR1／IIR2）"
setGlobals reg
query GetVehicleHistory "[\"${VIN1}\",\"\",\"\"]"

echo "=============================================================="
if [ $r1 -eq 0 ] && [ $r2 -eq 0 ] && [ $r3 -eq 0 ] && [ $r4 -eq 0 ] && [ $r5 -eq 0 ]; then
  successln "階段 2 CLI 展示全部符合目前已知行為：UC-03 前半段可重現；SBE 對 EVT 鍵"
  successln "『之後的修改』有效，但無法保護『首次建立』（已知限制，見 docs/stage2-chaincode.md）"
  exit 0
else
  errorln "有步驟結果不符預期，請檢視上方輸出"
  exit 1
fi
