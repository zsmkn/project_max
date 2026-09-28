#!/usr/bin/env bash
#
# 階段 4 驗收：以 peer CLI 在真實五組織網路上重現 UC-01「鑑定師複檢與動態扣分」
# 例外流程——SVC 正常回報里程後，APP 複檢回報的里程低於歷史最高值（里程倒退），
# 合約不得拒絕交易，須照常寫入複檢事件、額外記錄 ANOMALY 事件並扣 40 分
# （plan.md §3.4、CLAUDE.md「異常要記錄而不是拒絕」）。
#
# 用法：bash scripts/demoStage4.sh [channel名稱]
# 前提：network.sh up、createChannel、deployCC.sh（CC_VERSION=1.3 CC_SEQUENCE=4 以上，
# 含 SubmitInspection／評分引擎）皆已執行完成；PATH 需含 go（產生 PQC 測試金鑰）。

set -uo pipefail

NETWORK_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
. "${NETWORK_HOME}/scripts/envVar.sh"

CHANNEL_NAME=${1:-vehiclechannel}
CC_NAME=vehicle
ORDERER_ADDR="localhost:7050"
ORDERER_HOSTNAME_OVERRIDE="orderer1.${DOMAIN}"
SIGN_TOOL_DIR="${NETWORK_HOME}/../chaincode/vehicle"

invoke() {
  local submitterOrg=$1; shift
  local fcn=$1; shift
  local argsJSON=$1; shift
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

RUN_ID=$(date +%s)
VIN1="VIN${RUN_ID}UC01"
OWNER_HASH="owner-hash-uc01-${RUN_ID}"

infoln "產生車主 PQC 測試金鑰（ML-DSA-65，用後即刪，見 cmd/signdemo）"
KEYOUT=$(cd "${SIGN_TOOL_DIR}" && go run -mod=vendor ./cmd/signdemo genkey)
OWNER_PUB=$(echo "${KEYOUT}" | awk '/^PUB/{print $2}')
OWNER_PRIV=$(echo "${KEYOUT}" | awk '/^PRIV/{print $2}')
[ -n "${OWNER_PUB}" ] && [ -n "${OWNER_PRIV}" ] || { errorln "金鑰產生失敗"; exit 1; }

echo "=============================================================="
infoln "① InitVehicle（OEM，背書 OEM+REG）"
invoke oem InitVehicle "[\"${VIN1}\",\"ENGINE-UC01-${RUN_ID}\",\"TRANS-UC01-${RUN_ID}\",\"2024\",\"800000\",\"${OWNER_HASH}\"]" oem reg
r1=$?
[ $r1 -eq 0 ] && successln "① 成功" || errorln "① 失敗"

echo "=============================================================="
infoln "② RegisterPQCKey（登記車主 Dilithium 公鑰，任何身分可登記；PQC 鍵無專屬 SBE，"
infoln "   須符合鏈碼層級預設政策 OutOf(2, 五組織)，因此背書至少需 2 個組織）"
invoke reg RegisterPQCKey "[\"${OWNER_HASH}\",\"${OWNER_PUB}\"]" reg oem
r2=$?
[ $r2 -eq 0 ] && successln "② 成功" || errorln "② 失敗"

echo "=============================================================="
infoln "③ AddMaintenance（SVC，里程 50000，正常遞增）"
SIG1=$(cd "${SIGN_TOOL_DIR}" && go run -mod=vendor ./cmd/signdemo signmaint "${OWNER_PRIV}" "${VIN1}" "OIL_CHANGE" "50000" "更換機油（UC-01 demo）" | awk '/^SIG/{print $2}')
invoke svc AddMaintenance "[\"${VIN1}\",\"OIL_CHANGE\",\"50000\",\"更換機油（UC-01 demo）\",\"${SIG1}\"]" svc reg
r3=$?
[ $r3 -eq 0 ] && successln "③ 成功" || errorln "③ 失敗"

echo "=============================================================="
infoln "④ GetSummary（複檢前，預期誠信分數仍為 100）"
setGlobals app
query GetSummary "[\"${VIN1}\"]"

echo "=============================================================="
infoln "⑤ SubmitInspection（APP，複檢回報里程 30000，低於歷史最高 50000 → 里程倒退）"
infoln "   UC-01 例外流程：預期交易仍『成功』（不得拒絕），並自動扣 40 分、記錄異常上鏈"
invoke app SubmitInspection "[\"${VIN1}\",\"30000\",\"儀表里程與外觀有明顯落差（UC-01 demo）\"]" app reg
r5=$?
[ $r5 -eq 0 ] && successln "⑤ 成功（符合預期：里程倒退不拒絕交易）" || errorln "⑤ 失敗（不符預期，應成功並記錄異常）"

echo "=============================================================="
infoln "⑥ GetSummary（複檢後，預期誠信分數為 60 = 100 - 40，里程如實記錄為 30000）"
setGlobals reg
SUMMARY=$(query GetSummary "[\"${VIN1}\"]")
echo "${SUMMARY}"
SCORE=$(echo "${SUMMARY}" | jq -r '.integrityScore')
MILEAGE=$(echo "${SUMMARY}" | jq -r '.mileage')
r6=0
[ "${SCORE}" = "60" ] || { errorln "誠信分數應為 60，實際為 ${SCORE}"; r6=1; }
[ "${MILEAGE}" = "30000" ] || { errorln "里程應為 30000，實際為 ${MILEAGE}"; r6=1; }
[ $r6 -eq 0 ] && successln "⑥ 分數與里程皆符合預期"

echo "=============================================================="
infoln "⑦ GetVehicleHistory（預期含 INIT／MAINTENANCE／INSPECTION／ANOMALY 四種事件）"
HISTORY=$(query GetVehicleHistory "[\"${VIN1}\",\"\",\"\"]")
echo "${HISTORY}"
r7=0
ANOMALY_COUNT=$(echo "${HISTORY}" | jq '[.[] | select(.type=="ANOMALY")] | length')
ANOMALY_TYPE=$(echo "${HISTORY}" | jq -r '[.[] | select(.type=="ANOMALY")][0].anomalyType // empty')
ANOMALY_DELTA=$(echo "${HISTORY}" | jq -r '[.[] | select(.type=="ANOMALY")][0].scoreDelta // empty')
[ "${ANOMALY_COUNT}" = "1" ] || { errorln "應恰好有 1 筆 ANOMALY 事件，實際為 ${ANOMALY_COUNT}"; r7=1; }
[ "${ANOMALY_TYPE}" = "MILEAGE_ROLLBACK" ] || { errorln "異常類型應為 MILEAGE_ROLLBACK，實際為 ${ANOMALY_TYPE}"; r7=1; }
[ "${ANOMALY_DELTA}" = "-40" ] || { errorln "異常扣分應為 -40，實際為 ${ANOMALY_DELTA}"; r7=1; }
[ $r7 -eq 0 ] && successln "⑦ ANOMALY 事件內容符合預期"

echo "=============================================================="
if [ $r1 -eq 0 ] && [ $r2 -eq 0 ] && [ $r3 -eq 0 ] && [ $r5 -eq 0 ] && [ $r6 -eq 0 ] && [ $r7 -eq 0 ]; then
  successln "階段 4 CLI 展示（UC-01 例外流程）全部符合預期：里程倒退不拒絕交易、扣 40 分、異常上鏈"
  exit 0
else
  errorln "有步驟結果不符預期，請檢視上方輸出"
  exit 1
fi
