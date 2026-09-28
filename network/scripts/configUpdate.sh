#!/usr/bin/env bash
#
# Channel 設定更新的共用工具函式，改編自 fabric-samples/test-network/scripts/configUpdate.sh。
# 需要 jq 與 configtxlator。

NETWORK_HOME=${NETWORK_HOME:-${PWD}}
. "${NETWORK_HOME}/scripts/envVar.sh"

# fetchChannelConfig <org代號> <channel> <輸出json路徑>
fetchChannelConfig() {
  local org=$1
  local channel=$2
  local output=$3

  setGlobals "$org"

  infoln "抓取 channel 最新設定區塊"
  peer channel fetch config "${NETWORK_HOME}/channel-artifacts/config_block.pb" \
    -o localhost:7050 --ordererTLSHostnameOverride orderer1.${DOMAIN} \
    -c "$channel" --tls --cafile "$ORDERER_CA"

  configtxlator proto_decode --input "${NETWORK_HOME}/channel-artifacts/config_block.pb" \
    --type common.Block --output "${NETWORK_HOME}/channel-artifacts/config_block.json"
  jq .data.data[0].payload.data.config "${NETWORK_HOME}/channel-artifacts/config_block.json" > "${output}"
}

# createConfigUpdate <channel> <原始json> <修改後json> <輸出envelope.pb>
createConfigUpdate() {
  local channel=$1
  local original=$2
  local modified=$3
  local output=$4

  configtxlator proto_encode --input "${original}" --type common.Config \
    --output "${NETWORK_HOME}/channel-artifacts/original_config.pb"
  configtxlator proto_encode --input "${modified}" --type common.Config \
    --output "${NETWORK_HOME}/channel-artifacts/modified_config.pb"
  configtxlator compute_update --channel_id "${channel}" \
    --original "${NETWORK_HOME}/channel-artifacts/original_config.pb" \
    --updated "${NETWORK_HOME}/channel-artifacts/modified_config.pb" \
    --output "${NETWORK_HOME}/channel-artifacts/config_update.pb"
  configtxlator proto_decode --input "${NETWORK_HOME}/channel-artifacts/config_update.pb" \
    --type common.ConfigUpdate --output "${NETWORK_HOME}/channel-artifacts/config_update.json"
  echo '{"payload":{"header":{"channel_header":{"channel_id":"'"${channel}"'", "type":2}},"data":{"config_update":'"$(cat "${NETWORK_HOME}/channel-artifacts/config_update.json")"'}}}' \
    | jq . > "${NETWORK_HOME}/channel-artifacts/config_update_in_envelope.json"
  configtxlator proto_encode --input "${NETWORK_HOME}/channel-artifacts/config_update_in_envelope.json" \
    --type common.Envelope --output "${output}"
}
