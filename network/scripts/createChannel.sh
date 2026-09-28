#!/usr/bin/env bash
#
# 建立 channel genesis block、讓 3 個排序節點加入、5 個 peer 加入並設定 anchor peer。
# 改編自 fabric-samples/test-network/scripts/createChannel.sh 的 channel participation
# API（osnadmin）流程，擴充為 3 個 Raft 節點與 5 個業務組織。

set -euo pipefail

NETWORK_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
. "${NETWORK_HOME}/scripts/envVar.sh"

CHANNEL_NAME=${1:-vehiclechannel}
DELAY=${2:-3}
MAX_RETRY=${3:-5}

mkdir -p "${NETWORK_HOME}/channel-artifacts"

infoln "產生 channel genesis block（profile: VehicleNetChannel）"
GENESIS_FABRIC_CFG_PATH="${FABRIC_CFG_PATH}"
export FABRIC_CFG_PATH="${NETWORK_HOME}/configtx"
configtxgen -profile VehicleNetChannel -outputBlock "${NETWORK_HOME}/channel-artifacts/${CHANNEL_NAME}.block" -channelID "${CHANNEL_NAME}"
# peer / osnadmin 需要 core.yaml 的預設樣板，切回原本的 FABRIC_CFG_PATH（fabric-samples/config）
export FABRIC_CFG_PATH="${GENESIS_FABRIC_CFG_PATH}"

joinOrderer() {
  local node=$1
  local adminPort=${ORDERER_ADMIN_PORT[$node]}
  local nodeDir="${NETWORK_HOME}/organizations/ordererOrganizations/${DOMAIN}/orderers/${node}.${DOMAIN}"

  infoln "[$node] 加入 channel（osnadmin, port ${adminPort}）"
  osnadmin channel join --channelID "${CHANNEL_NAME}" \
    --config-block "${NETWORK_HOME}/channel-artifacts/${CHANNEL_NAME}.block" \
    -o "localhost:${adminPort}" \
    --ca-file "$(ordererCACertPath)" \
    --client-cert "${nodeDir}/tls/server.crt" \
    --client-key "${nodeDir}/tls/server.key"
}

for node in "${ORDERER_NODES[@]}"; do
  rc=1
  attempt=1
  while [ $rc -ne 0 ] && [ $attempt -le "$MAX_RETRY" ]; do
    sleep "$DELAY"
    joinOrderer "$node" && rc=0 || rc=1
    attempt=$((attempt + 1))
  done
  verifyResult $rc "${node} 加入 channel 失敗"
done
successln "3 個排序節點皆已加入 channel '${CHANNEL_NAME}'"

joinPeer() {
  local org=$1
  setGlobals "$org"
  peer channel join -b "${NETWORK_HOME}/channel-artifacts/${CHANNEL_NAME}.block"
}

for org in "${PEER_ORG_CODES[@]}"; do
  rc=1
  attempt=1
  while [ $rc -ne 0 ] && [ $attempt -le "$MAX_RETRY" ]; do
    sleep "$DELAY"
    joinPeer "$org" && rc=0 || rc=1
    attempt=$((attempt + 1))
  done
  verifyResult $rc "[$org] peer0 加入 channel 失敗"
  successln "[$org] peer0 已加入 channel '${CHANNEL_NAME}'"
done

# APP 組織的 anchor peer 刻意留到 scripts/faultToleranceTest.sh（NFR3 初驗）再設定，
# 用來證明「停掉 1 個 orderer + 1 個 peer 後仍可寫入」——設定 anchor peer 本身就是一筆
# 真實的 channel 設定交易（會產生新區塊），不需要額外部署鏈碼即可驗證容錯能力。
for org in reg oem svc ins; do
  "${NETWORK_HOME}/scripts/setAnchorPeer.sh" "$org" "${CHANNEL_NAME}"
done

successln "Channel '${CHANNEL_NAME}' 建立完成，五組織 peer 皆已加入（REG/OEM/SVC/INS 已設定 anchor peer；APP 留給容錯測試）"
