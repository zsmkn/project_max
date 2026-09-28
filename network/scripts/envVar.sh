#!/usr/bin/env bash
#
# 設定各組織 CLI 操作所需環境變數，改編自 fabric-samples/test-network/scripts/envVar.sh。

NETWORK_HOME=${NETWORK_HOME:-${PWD}}
. "${NETWORK_HOME}/scripts/utils.sh"
. "${NETWORK_HOME}/scripts/orgs.sh"

# 讓本檔案在被直接呼叫的腳本（非透過 network.sh）中也能找到 Fabric 二進位檔
FABRIC_SAMPLES_HOME=${FABRIC_SAMPLES_HOME:-"${HOME}/fabric/fabric-samples"}
case ":${PATH}:" in
  *":${FABRIC_SAMPLES_HOME}/bin:"*) ;;
  *) export PATH="${FABRIC_SAMPLES_HOME}/bin:${PATH}" ;;
esac
export FABRIC_CFG_PATH="${FABRIC_CFG_PATH:-${FABRIC_SAMPLES_HOME}/config}"

export CORE_PEER_TLS_ENABLED=true
export ORDERER_CA="${NETWORK_HOME}/organizations/ordererOrganizations/${DOMAIN}/tlsca/tlsca.${DOMAIN}-cert.pem"

# setGlobals <org代號 reg|oem|svc|ins|app>
setGlobals() {
  local org=$1
  if [ -z "${ORG_MSP[$org]:-}" ]; then
    errorln "未知的組織代號：${org}"
    return 1
  fi
  infoln "Using organization ${org}"
  export CORE_PEER_LOCALMSPID="${ORG_MSP[$org]}"
  export CORE_PEER_TLS_ROOTCERT_FILE=$(peerCACertPath "$org")
  export CORE_PEER_MSPCONFIGPATH="${NETWORK_HOME}/organizations/peerOrganizations/${org}.${DOMAIN}/users/Admin@${org}.${DOMAIN}/msp"
  export CORE_PEER_ADDRESS=$(peerLocalhostAddress "$org")

  if [ "${VERBOSE:-false}" = "true" ]; then
    env | grep CORE_PEER
  fi
}

# parsePeerConnectionParameters <org代號...>
# 組出多組織背書所需的 --peerAddresses / --tlsRootCertFiles 參數陣列
parsePeerConnectionParameters() {
  PEER_CONN_PARMS=()
  for org in "$@"; do
    setGlobals "$org"
    PEER_CONN_PARMS+=(--peerAddresses "$CORE_PEER_ADDRESS" --tlsRootCertFiles "$CORE_PEER_TLS_ROOTCERT_FILE")
  done
}
