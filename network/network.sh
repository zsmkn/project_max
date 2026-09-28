#!/usr/bin/env bash
#
# 五組織 Fabric 聯盟鏈（REG/OEM/SVC/INS/APP + OrdererOrg）主控腳本。
# 用法：
#   ./network.sh up              啟動 CA，產生憑證，啟動排序節點與 peer/CouchDB
#   ./network.sh createChannel   建立 channel 並讓所有節點加入（需先 up）
#   ./network.sh down            關閉並清除所有容器、volume 與產生的憑證/artifacts
#
# 需求：WSL2 內已安裝 Fabric 2.5.9 二進位檔（見 docs/stage0-validation.md）。
# FABRIC_BIN 預設指向 ~/fabric/fabric-samples/bin，可用環境變數覆寫。
# FABRIC_CFG_PATH 使用 fabric-samples/config 提供的 core.yaml / orderer.yaml 預設樣板。

set -euo pipefail

NETWORK_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "${NETWORK_HOME}"

FABRIC_SAMPLES_HOME=${FABRIC_SAMPLES_HOME:-"${HOME}/fabric/fabric-samples"}
export PATH="${FABRIC_SAMPLES_HOME}/bin:${PATH}"
export FABRIC_CFG_PATH="${FABRIC_SAMPLES_HOME}/config"

. "${NETWORK_HOME}/scripts/utils.sh"
. "${NETWORK_HOME}/scripts/orgs.sh"
. "${NETWORK_HOME}/organizations/fabric-ca/registerEnroll.sh"

CHANNEL_NAME=${CHANNEL_NAME:-vehiclechannel}

checkPrereqs() {
  for bin in docker jq configtxgen configtxlator osnadmin peer fabric-ca-client; do
    command -v "$bin" >/dev/null 2>&1 || fatalln "找不到指令：${bin}（請確認 FABRIC_SAMPLES_HOME 或 PATH 設定正確）"
  done
}

composeUp() {
  local files=(-f compose/compose-ca.yaml -f compose/compose-couch.yaml -f compose/compose-net.yaml)
  docker compose -p vehiclenet "${files[@]}" up -d
}

waitForCAs() {
  infoln "等待 6 個 Fabric CA 就緒"
  for port in "${ORG_CA_PORT[reg]}" "${ORG_CA_PORT[oem]}" "${ORG_CA_PORT[svc]}" "${ORG_CA_PORT[ins]}" "${ORG_CA_PORT[app]}" "${ORDERER_CA_PORT}"; do
    for _ in $(seq 1 30); do
      curl -sk "https://localhost:${port}/cainfo" >/dev/null 2>&1 && break
      sleep 2
    done
  done
}

createOrgs() {
  if [ -d "${NETWORK_HOME}/organizations/peerOrganizations" ]; then
    infoln "organizations/ 已存在憑證，略過重新產生（如需重建請先執行 down）"
    return
  fi
  for org in "${PEER_ORG_CODES[@]}"; do
    enrollPeerOrg "$org" "${ORG_CA_PORT[$org]}"
  done
  enrollOrdererOrg
}

networkUp() {
  checkPrereqs
  infoln "啟動 CA 容器"
  docker compose -p vehiclenet -f compose/compose-ca.yaml up -d
  waitForCAs
  createOrgs
  infoln "啟動排序節點、peer 與 CouchDB"
  composeUp
  docker ps -a --filter "label=service=hyperledger-fabric"
  successln "網路已啟動：3 個排序節點、5 組織各 1 個 peer + CouchDB"
}

networkDown() {
  docker compose -p vehiclenet \
    -f compose/compose-ca.yaml -f compose/compose-couch.yaml -f compose/compose-net.yaml \
    down -v --remove-orphans
  rm -rf "${NETWORK_HOME}/organizations/peerOrganizations" \
         "${NETWORK_HOME}/organizations/ordererOrganizations" \
         "${NETWORK_HOME}/organizations/fabric-ca/reg" "${NETWORK_HOME}/organizations/fabric-ca/oem" \
         "${NETWORK_HOME}/organizations/fabric-ca/svc" "${NETWORK_HOME}/organizations/fabric-ca/ins" \
         "${NETWORK_HOME}/organizations/fabric-ca/app" "${NETWORK_HOME}/organizations/fabric-ca/orderer" \
         "${NETWORK_HOME}/channel-artifacts"
  successln "網路已關閉並清除憑證／channel artifacts"
}

MODE=${1:-}
case "$MODE" in
  up)
    networkUp
    ;;
  createChannel)
    checkPrereqs
    "${NETWORK_HOME}/scripts/createChannel.sh" "${CHANNEL_NAME}"
    ;;
  down)
    networkDown
    ;;
  *)
    println "用法：./network.sh {up|createChannel|down}"
    exit 1
    ;;
esac
