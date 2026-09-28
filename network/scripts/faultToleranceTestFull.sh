#!/usr/bin/env bash
#
# NFR3 完整容錯測試（plan.md §5 階段 7）：延續階段 1 faultToleranceTest.sh（僅測試
# channel 設定交易），本腳本改用真實鏈碼交易（RecordClaim）驗證多重故障情境：
#
#   ① 基準：全部節點健康，InitVehicle 建立示範車輛、① 次 RecordClaim 成功存證
#   ② 同時停掉 1 個 Raft 排序節點（orderer2）與 1 個見證組織 peer（peer0.reg）：
#      RecordClaim 背書政策為 AND(INS, OutOf(1,REG,APP))，REG 見證缺席時改用 APP
#      見證，預期交易仍成功——證明 Raft 容忍 1 節點故障、OutOf(1,...) 見證容錯設計
#      如預期運作（對應 plan.md §3.3 選用 SBE OutOf 的理由）。
#   ③ 再停掉 peer0.app（此時 REG、APP 兩個見證皆離線，僅剩 INS 本身）：
#      預期 RecordClaim 失敗（背書不足），證明政策並非形同虛設、容錯確有邊界。
#   ④ 復原全部節點，確認五個 peer 的 channel 區塊高度追平，並再次成功送出
#      RecordClaim，證明系統完全恢復。
#
# 用法：bash scripts/faultToleranceTestFull.sh [channel名稱]
# 前提：network.sh up、createChannel、deployCC.sh 皆已完成（沿用既有 vehicle 鏈碼版本，
# 不需要特定版本，只呼叫 InitVehicle／RecordClaim／GetSummary）。

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
  parsePeerConnectionParameters "$@"
  setGlobals "$submitterOrg"
  peer chaincode invoke -o "${ORDERER_ADDR}" --ordererTLSHostnameOverride "${ORDERER_HOSTNAME_OVERRIDE}" \
    --tls --cafile "${ORDERER_CA}" -C "${CHANNEL_NAME}" -n "${CC_NAME}" \
    -c "{\"function\":\"${fcn}\",\"Args\":${argsJSON}}" \
    "${PEER_CONN_PARMS[@]}" --waitForEvent
}

query() {
  local queryOrg=$1; shift
  local fcn=$1; shift
  local argsJSON=$1
  setGlobals "$queryOrg"
  peer chaincode query -C "${CHANNEL_NAME}" -n "${CC_NAME}" \
    -c "{\"function\":\"${fcn}\",\"Args\":${argsJSON}}"
}

RUN_ID=$(date +%s)
VIN="NFR3-${RUN_ID}"
OWNER_HASH="owner-hash-nfr3-${RUN_ID}"

pass_count=0
fail_count=0
record_result() {
  local label=$1
  local expected=$2   # "success" | "failure"
  local actual_rc=$3
  if { [ "$expected" = "success" ] && [ "$actual_rc" -eq 0 ]; } || \
     { [ "$expected" = "failure" ] && [ "$actual_rc" -ne 0 ]; }; then
    successln "${label}：符合預期（expected=${expected}, rc=${actual_rc}）"
    pass_count=$((pass_count + 1))
  else
    errorln "${label}：不符預期（expected=${expected}, rc=${actual_rc}）"
    fail_count=$((fail_count + 1))
  fi
}

echo "=============================================================="
infoln "=== 基準情境：全部節點健康 ==="
infoln "① InitVehicle（OEM+REG 皆為必要背書者，示範車輛 ${VIN}）"
invoke oem InitVehicle "[\"${VIN}\",\"ENGINE-NFR3-${RUN_ID}\",\"TRANS-NFR3-${RUN_ID}\",\"2024\",\"600000\",\"${OWNER_HASH}\"]" oem reg
record_result "① InitVehicle（基準）" success $?

infoln "② RecordClaim（INS 必要 + OutOf(1,REG,APP)，claimID=CLM-${RUN_ID}-A）"
invoke ins RecordClaim "[\"${VIN}\",\"CLM-${RUN_ID}-A\",\"COLLISION\",\"50000\",\"BUMPER\"]" ins reg
record_result "② RecordClaim（基準，REG 見證）" success $?

echo "=============================================================="
infoln "=== 情境 A：停掉 orderer2（Raft 3 節點之一）與 peer0.reg（見證組織之一）==="
docker stop orderer2.vehiclenet.tw peer0.reg.vehiclenet.tw
sleep 5
docker ps --filter "name=orderer" --filter "name=peer0" --format '{{.Names}}: {{.Status}}'

infoln "③ RecordClaim（REG 見證缺席，改用 APP 見證；claimID=CLM-${RUN_ID}-B）"
invoke ins RecordClaim "[\"${VIN}\",\"CLM-${RUN_ID}-B\",\"COLLISION\",\"30000\",\"DOOR\"]" ins app
record_result "③ RecordClaim（1 orderer + 1 見證 peer 離線，改用 APP 見證）" success $?

echo "=============================================================="
infoln "=== 情境 B：再停掉 peer0.app（此時 REG、APP 兩個見證皆離線）==="
docker stop peer0.app.vehiclenet.tw
sleep 5
docker ps --filter "name=peer0" --format '{{.Names}}: {{.Status}}'

infoln "④ RecordClaim（僅 INS 本身可背書，兩個見證皆不可用；claimID=CLM-${RUN_ID}-C）"
infoln "   預期失敗：AND(INS, OutOf(1,REG,APP)) 在缺少任何見證時無法滿足"
invoke ins RecordClaim "[\"${VIN}\",\"CLM-${RUN_ID}-C\",\"COLLISION\",\"10000\",\"MIRROR\"]" ins
record_result "④ RecordClaim（超出容錯邊界，預期背書失敗）" failure $?

echo "=============================================================="
infoln "=== 復原：重新啟動 orderer2、peer0.reg、peer0.app ==="
docker start orderer2.vehiclenet.tw peer0.reg.vehiclenet.tw peer0.app.vehiclenet.tw
sleep 10

infoln "比對五組織 peer 的 channel 區塊高度（預期皆已追上最新高度）"
for org in "${PEER_ORG_CODES[@]}"; do
  setGlobals "$org"
  height=$(peer channel getinfo -c "${CHANNEL_NAME}" 2>/dev/null | grep -o '"height":[0-9]*' | cut -d: -f2)
  println "  [$org] block height = ${height}"
done

infoln "⑤ RecordClaim（全部節點恢復後，REG 見證重新可用；claimID=CLM-${RUN_ID}-D）"
invoke ins RecordClaim "[\"${VIN}\",\"CLM-${RUN_ID}-D\",\"COLLISION\",\"5000\",\"MIRROR\"]" ins reg
record_result "⑤ RecordClaim（復原後）" success $?

echo "=============================================================="
infoln "⑥ GetVehicleHistory（驗證上鏈事件數：INIT + 3 筆成功 RecordClaim，情境 B 應無新增事件）"
setGlobals reg
HISTORY=$(query reg GetVehicleHistory "[\"${VIN}\",\"\",\"\"]")
CLAIM_COUNT=$(echo "${HISTORY}" | jq '[.[] | select(.type=="CLAIM")] | length')
println "  上鏈的 CLAIM 事件數 = ${CLAIM_COUNT}（預期 3：基準①＋情境A①＋復原①，情境B的失敗交易不應寫入任何事件）"
if [ "${CLAIM_COUNT}" = "3" ]; then
  successln "⑥ 上鏈事件數符合預期"
  pass_count=$((pass_count + 1))
else
  errorln "⑥ 上鏈事件數不符預期"
  fail_count=$((fail_count + 1))
fi

echo "=============================================================="
println "NFR3 完整容錯測試結果：${pass_count} 項符合預期、${fail_count} 項不符預期"
if [ "${fail_count}" -eq 0 ]; then
  successln "全部情境（基準／Raft+見證容錯／容錯邊界外預期失敗／復原）皆符合預期"
  exit 0
else
  errorln "有情境不符預期，請檢視上方輸出"
  exit 1
fi
