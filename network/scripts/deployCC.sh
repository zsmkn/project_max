#!/usr/bin/env bash
#
# 封裝、安裝、核准並提交車輛履歷鏈碼（chaincode/vehicle）至五組織皆已加入的
# vehiclechannel。對應 plan.md §5 階段 2「資產合約」。
#
# 鏈碼層級（channel 提交時）的預設背書政策設為 OutOf(2, REG,OEM,SVC,INS,APP)：
# 任兩個組織即可背書 VEH 主檔等一般鍵值的寫入。plan.md §3.3 要求的「每種交易類型
# 專屬背書組織」（如 InitVehicle 需要 OEM+REG）由鏈碼在寫入 EVT 事件鍵時以
# 狀態背書（state-based endorsement, SetStateValidationParameter）逐筆設定，
# 見 chaincode/vehicle/contract/policy.go 與 network/README.md「背書策略與鏈碼」。

set -euo pipefail

NETWORK_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
. "${NETWORK_HOME}/scripts/envVar.sh"

CHANNEL_NAME=${1:-vehiclechannel}
CC_NAME=${CC_NAME:-vehicle}
CC_VERSION=${CC_VERSION:-1.0}
CC_SEQUENCE=${CC_SEQUENCE:-1}
CC_SRC_PATH=${CC_SRC_PATH:-"$(cd "${NETWORK_HOME}/../chaincode/vehicle" && pwd)"}
CC_LABEL="${CC_NAME}_${CC_VERSION}"
CC_ENDORSEMENT_POLICY="OutOf(2, 'REGMSP.member','OEMMSP.member','SVCMSP.member','INSMSP.member','APPMSP.member')"
PACKAGE_FILE="${NETWORK_HOME}/channel-artifacts/${CC_NAME}.tar.gz"

packageChaincode() {
  # --lang golang 會在本機執行 go 判斷 module 根目錄，缺 go 時錯誤訊息只有難懂的
  # "failed to normalize chaincode path"，先檢查並給出解法。實際編譯仍在 ccenv 容器內。
  if ! command -v go >/dev/null 2>&1 && [ -x /usr/local/go/bin/go ]; then
    export PATH="${PATH}:/usr/local/go/bin"
  fi
  command -v go >/dev/null 2>&1 \
    || fatalln "找不到 go：封裝 Go 鏈碼需要本機 Go（執行 ./setup-env.sh 安裝，見 src/SETUP.md §0.5）"
  infoln "封裝鏈碼（來源：${CC_SRC_PATH}）"
  peer lifecycle chaincode package "${PACKAGE_FILE}" \
    --path "${CC_SRC_PATH}" --lang golang --label "${CC_LABEL}"
  successln "已封裝為 ${PACKAGE_FILE}"
}

installChaincode() {
  local org=$1
  setGlobals "$org"
  if peer lifecycle chaincode queryinstalled --output json \
      | jq -e --arg ccLabel "${CC_LABEL}" '.installed_chaincodes[] | select(.label == $ccLabel)' >/dev/null 2>&1; then
    infoln "[$org] 鏈碼已安裝過，略過（重跑本腳本安全冪等）"
    return
  fi
  infoln "[$org] 安裝鏈碼（會在 fabric-ccenv:2.5.9 容器內建置，需數十秒）"
  peer lifecycle chaincode install "${PACKAGE_FILE}"
}

queryPackageID() {
  # 五組織安裝同一份鏈碼套件，package ID（雜湊）在各 peer 上皆相同，取第一個組織查詢即可。
  setGlobals reg
  peer lifecycle chaincode queryinstalled --output json \
    | jq -r --arg ccLabel "${CC_LABEL}" '.installed_chaincodes[] | select(.label == $ccLabel) | .package_id'
}

approveChaincode() {
  local org=$1
  local packageID=$2
  setGlobals "$org"
  infoln "[$org] 核准鏈碼定義"
  peer lifecycle chaincode approveformyorg -o localhost:7050 \
    --ordererTLSHostnameOverride orderer1.${DOMAIN} --tls --cafile "${ORDERER_CA}" \
    --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" --version "${CC_VERSION}" \
    --package-id "${packageID}" --sequence "${CC_SEQUENCE}" \
    --signature-policy "${CC_ENDORSEMENT_POLICY}"
}

checkCommitReadiness() {
  setGlobals reg
  infoln "檢查提交就緒狀態（五組織皆須已核准）"
  peer lifecycle chaincode checkcommitreadiness \
    --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" --version "${CC_VERSION}" \
    --sequence "${CC_SEQUENCE}" --signature-policy "${CC_ENDORSEMENT_POLICY}" --output json
}

commitChaincode() {
  parsePeerConnectionParameters "${PEER_ORG_CODES[@]}"
  setGlobals reg
  infoln "提交鏈碼定義至 channel '${CHANNEL_NAME}'"
  peer lifecycle chaincode commit -o localhost:7050 \
    --ordererTLSHostnameOverride orderer1.${DOMAIN} --tls --cafile "${ORDERER_CA}" \
    --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" --version "${CC_VERSION}" \
    --sequence "${CC_SEQUENCE}" --signature-policy "${CC_ENDORSEMENT_POLICY}" \
    "${PEER_CONN_PARMS[@]}"
}

queryCommitted() {
  setGlobals reg
  peer lifecycle chaincode querycommitted --channelID "${CHANNEL_NAME}" --name "${CC_NAME}"
}

packageChaincode
for org in "${PEER_ORG_CODES[@]}"; do
  installChaincode "$org"
done

PACKAGE_ID=$(queryPackageID)
[ -n "${PACKAGE_ID}" ] || fatalln "查無已安裝鏈碼的 package ID（label=${CC_LABEL}）"
infoln "Package ID: ${PACKAGE_ID}"

for org in "${PEER_ORG_CODES[@]}"; do
  approveChaincode "$org" "${PACKAGE_ID}"
done

checkCommitReadiness
commitChaincode
queryCommitted

successln "鏈碼 ${CC_NAME}@${CC_VERSION}（sequence ${CC_SEQUENCE}）已提交至 '${CHANNEL_NAME}'，五組織皆已安裝／核准"
