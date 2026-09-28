#!/usr/bin/env bash
#
# 設定單一組織在 channel 上的 anchor peer，改編自
# fabric-samples/test-network/scripts/setAnchorPeer.sh。
# 用法：setAnchorPeer.sh <org代號> <channel名稱>

set -euo pipefail

NETWORK_HOME=${NETWORK_HOME:-${PWD}}
. "${NETWORK_HOME}/scripts/configUpdate.sh"

ORG=$1
CHANNEL_NAME=$2

setGlobals "$ORG"

infoln "[$ORG] 抓取 channel 設定"
fetchChannelConfig "$ORG" "$CHANNEL_NAME" "${NETWORK_HOME}/channel-artifacts/${CORE_PEER_LOCALMSPID}config.json"

HOST="peer0.${ORG}.${DOMAIN}"
PORT=${ORG_PEER_PORT[$ORG]}

infoln "[$ORG] 產生 anchor peer 更新交易"
jq '.channel_group.groups.Application.groups.'"${CORE_PEER_LOCALMSPID}"'.values += {"AnchorPeers":{"mod_policy": "Admins","value":{"anchor_peers": [{"host": "'"${HOST}"'","port": '"${PORT}"'}]},"version": "0"}}' \
  "${NETWORK_HOME}/channel-artifacts/${CORE_PEER_LOCALMSPID}config.json" \
  > "${NETWORK_HOME}/channel-artifacts/${CORE_PEER_LOCALMSPID}modified_config.json"

createConfigUpdate "$CHANNEL_NAME" \
  "${NETWORK_HOME}/channel-artifacts/${CORE_PEER_LOCALMSPID}config.json" \
  "${NETWORK_HOME}/channel-artifacts/${CORE_PEER_LOCALMSPID}modified_config.json" \
  "${NETWORK_HOME}/channel-artifacts/${CORE_PEER_LOCALMSPID}anchors.tx"

infoln "[$ORG] 送出 anchor peer 更新交易"
peer channel update -o localhost:7050 --ordererTLSHostnameOverride orderer1.${DOMAIN} \
  -c "$CHANNEL_NAME" -f "${NETWORK_HOME}/channel-artifacts/${CORE_PEER_LOCALMSPID}anchors.tx" \
  --tls --cafile "$ORDERER_CA"

successln "[$ORG] anchor peer 已設定為 ${HOST}:${PORT}"
