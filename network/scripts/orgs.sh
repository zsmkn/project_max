#!/usr/bin/env bash
#
# 五組織網路的組織中繼資料，供 registerEnroll.sh、envVar.sh、createChannel.sh 等腳本共用。
# 修改組織清單或連接埠時，只需改這裡；compose/*.yaml 因為是 docker compose 靜態設定，
# 仍需手動同步（每個組織的區塊彼此獨立，比對本檔案即可核對）。

DOMAIN="vehiclenet.tw"

# 五個聯盟組織：代號（小寫，用於路徑／容器名）與 MSP ID（大寫）
PEER_ORG_CODES=(reg oem svc ins app)
declare -A ORG_MSP=( [reg]=REGMSP [oem]=OEMMSP [svc]=SVCMSP [ins]=INSMSP [app]=APPMSP )
declare -A ORG_CA_PORT=( [reg]=7054 [oem]=8054 [svc]=9054 [ins]=10054 [app]=11054 )
declare -A ORG_CA_OPS_PORT=( [reg]=17054 [oem]=18054 [svc]=19054 [ins]=20054 [app]=21054 )
declare -A ORG_PEER_PORT=( [reg]=7051 [oem]=8051 [svc]=9051 [ins]=10051 [app]=11051 )
declare -A ORG_PEER_OPS_PORT=( [reg]=9451 [oem]=9452 [svc]=9453 [ins]=9454 [app]=9455 )
declare -A ORG_COUCHDB_PORT=( [reg]=5984 [oem]=6984 [svc]=7984 [ins]=8984 [app]=9984 )

# 排序組織（獨立於五個業務組織）：3 個 Raft 節點
ORDERER_MSP="OrdererMSP"
ORDERER_CA_PORT=6054
ORDERER_CA_OPS_PORT=16054
ORDERER_NODES=(orderer1 orderer2 orderer3)
declare -A ORDERER_GENERAL_PORT=( [orderer1]=7050 [orderer2]=8050 [orderer3]=9050 )
declare -A ORDERER_ADMIN_PORT=( [orderer1]=7053 [orderer2]=8053 [orderer3]=9053 )
declare -A ORDERER_OPS_PORT=( [orderer1]=9443 [orderer2]=9444 [orderer3]=9445 )

peerAddress() {
  local org=$1
  echo "peer0.${org}.${DOMAIN}:${ORG_PEER_PORT[$org]}"
}

peerLocalhostAddress() {
  local org=$1
  echo "localhost:${ORG_PEER_PORT[$org]}"
}

peerCACertPath() {
  local org=$1
  echo "${NETWORK_HOME}/organizations/peerOrganizations/${org}.${DOMAIN}/tlsca/tlsca.${org}.${DOMAIN}-cert.pem"
}

ordererCACertPath() {
  echo "${NETWORK_HOME}/organizations/ordererOrganizations/${DOMAIN}/tlsca/tlsca.${DOMAIN}-cert.pem"
}
