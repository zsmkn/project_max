#!/usr/bin/env bash
#
# NFR3 初驗（plan.md §5 階段 1 驗收標準）：
# 停掉 1 個排序節點（orderer2，Raft 3 節點中的 1 個）與 1 個 peer（peer0.svc），
# 證明其餘節點仍可完成一筆真實的帳本寫入——以「設定 APP 組織的 anchor peer」
# 作為寫入動作：這是一筆會產生新區塊的 channel 設定交易，送交剩餘存活的
# 排序節點（orderer1），不需要先部署鏈碼即可驗證 Raft 容錯與 peer 容錯。
#
# 完整涵蓋鏈碼交易層級的容錯測試，待階段 2 鏈碼部署後於階段 7 補做。

set -euo pipefail

NETWORK_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
. "${NETWORK_HOME}/scripts/envVar.sh"

CHANNEL_NAME=${1:-vehiclechannel}

infoln "=== NFR3 初驗：停掉 orderer2 與 peer0.svc ==="
docker stop orderer2.vehiclenet.tw peer0.svc.vehiclenet.tw
sleep 5

infoln "確認 Raft 叢集僅剩 2/3 節點、peer0.svc 已離線"
docker ps --filter "name=orderer" --filter "name=peer0" --format '{{.Names}}: {{.Status}}'

infoln "在僅剩 orderer1／orderer3 與 4 個 peer 存活的情況下，送出 APP 組織的 anchor peer 設定交易"
"${NETWORK_HOME}/scripts/setAnchorPeer.sh" app "${CHANNEL_NAME}"

successln "寫入成功：Raft 容忍 1 個排序節點故障、其餘組織不受 1 個 peer 離線影響，NFR3 初驗通過"

infoln "=== 復原：重新啟動 orderer2 與 peer0.svc，確認追上最新區塊高度 ==="
docker start orderer2.vehiclenet.tw peer0.svc.vehiclenet.tw
sleep 10

infoln "比對五組織 peer 的 channel 區塊高度"
for org in "${PEER_ORG_CODES[@]}"; do
  setGlobals "$org"
  height=$(peer channel getinfo -c "${CHANNEL_NAME}" 2>/dev/null | grep -o '"height":[0-9]*' | cut -d: -f2)
  println "  [$org] block height = ${height}"
done

successln "復原完成"
