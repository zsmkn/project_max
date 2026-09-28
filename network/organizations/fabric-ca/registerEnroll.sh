#!/usr/bin/env bash
#
# 透過各組織的 Fabric CA 註冊／簽發身分，產生 MSP 與 TLS 憑證。
# 改編自 fabric-samples/test-network/organizations/fabric-ca/registerEnroll.sh，
# 將 org1/org2/orderer 三份重複函式，改寫成可套用於任意組織代號的通用函式。

# enrollPeerOrg <org代號> <CA埠>
# 例：enrollPeerOrg reg 7054
function enrollPeerOrg() {
  local org=$1
  local caPort=$2
  local mspId=${ORG_MSP[$org]}
  local orgDomain="${org}.${DOMAIN}"
  local caName="ca-${org}"
  local orgDir="${NETWORK_HOME}/organizations/peerOrganizations/${orgDomain}"
  local caCert="${NETWORK_HOME}/organizations/fabric-ca/${org}/ca-cert.pem"

  infoln "[$org] 註冊 CA 管理員"
  mkdir -p "${orgDir}"
  export FABRIC_CA_CLIENT_HOME="${orgDir}"

  fabric-ca-client enroll -u https://admin:adminpw@localhost:${caPort} --caname "${caName}" --tls.certfiles "${caCert}"

  echo "NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/localhost-${caPort}-${caName}.pem
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/localhost-${caPort}-${caName}.pem
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/localhost-${caPort}-${caName}.pem
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/localhost-${caPort}-${caName}.pem
    OrganizationalUnitIdentifier: orderer" > "${orgDir}/msp/config.yaml"

  mkdir -p "${orgDir}/msp/tlscacerts" "${orgDir}/tlsca" "${orgDir}/ca"
  cp "${caCert}" "${orgDir}/msp/tlscacerts/ca.crt"
  cp "${caCert}" "${orgDir}/tlsca/tlsca.${orgDomain}-cert.pem"
  cp "${caCert}" "${orgDir}/ca/ca.${orgDomain}-cert.pem"

  infoln "[$org] 註冊 peer0／使用者／管理員身分"
  fabric-ca-client register --caname "${caName}" --id.name peer0 --id.secret peer0pw --id.type peer --tls.certfiles "${caCert}"
  fabric-ca-client register --caname "${caName}" --id.name user1 --id.secret user1pw --id.type client --tls.certfiles "${caCert}"
  fabric-ca-client register --caname "${caName}" --id.name ${org}admin --id.secret ${org}adminpw --id.type admin --tls.certfiles "${caCert}"

  infoln "[$org] 產生 peer0 MSP"
  fabric-ca-client enroll -u https://peer0:peer0pw@localhost:${caPort} --caname "${caName}" \
    -M "${orgDir}/peers/peer0.${orgDomain}/msp" --tls.certfiles "${caCert}"
  cp "${orgDir}/msp/config.yaml" "${orgDir}/peers/peer0.${orgDomain}/msp/config.yaml"

  infoln "[$org] 產生 peer0 TLS 憑證"
  fabric-ca-client enroll -u https://peer0:peer0pw@localhost:${caPort} --caname "${caName}" \
    -M "${orgDir}/peers/peer0.${orgDomain}/tls" --enrollment.profile tls \
    --csr.hosts "peer0.${orgDomain}" --csr.hosts localhost --tls.certfiles "${caCert}"
  cp "${orgDir}/peers/peer0.${orgDomain}/tls/tlscacerts/"* "${orgDir}/peers/peer0.${orgDomain}/tls/ca.crt"
  cp "${orgDir}/peers/peer0.${orgDomain}/tls/signcerts/"* "${orgDir}/peers/peer0.${orgDomain}/tls/server.crt"
  cp "${orgDir}/peers/peer0.${orgDomain}/tls/keystore/"* "${orgDir}/peers/peer0.${orgDomain}/tls/server.key"

  infoln "[$org] 產生一般使用者 MSP（user1）"
  fabric-ca-client enroll -u https://user1:user1pw@localhost:${caPort} --caname "${caName}" \
    -M "${orgDir}/users/User1@${orgDomain}/msp" --tls.certfiles "${caCert}"
  cp "${orgDir}/msp/config.yaml" "${orgDir}/users/User1@${orgDomain}/msp/config.yaml"

  infoln "[$org] 產生組織管理員 MSP（Admin）"
  fabric-ca-client enroll -u https://${org}admin:${org}adminpw@localhost:${caPort} --caname "${caName}" \
    -M "${orgDir}/users/Admin@${orgDomain}/msp" --tls.certfiles "${caCert}"
  cp "${orgDir}/msp/config.yaml" "${orgDir}/users/Admin@${orgDomain}/msp/config.yaml"
}

# enrollOrdererOrg：註冊排序組織（3 個 Raft 節點 + 管理員）
function enrollOrdererOrg() {
  local caPort=${ORDERER_CA_PORT}
  local caName="ca-orderer"
  local orgDir="${NETWORK_HOME}/organizations/ordererOrganizations/${DOMAIN}"
  local caCert="${NETWORK_HOME}/organizations/fabric-ca/orderer/ca-cert.pem"

  infoln "[orderer] 註冊 CA 管理員"
  mkdir -p "${orgDir}"
  export FABRIC_CA_CLIENT_HOME="${orgDir}"

  fabric-ca-client enroll -u https://admin:adminpw@localhost:${caPort} --caname "${caName}" --tls.certfiles "${caCert}"

  echo "NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/localhost-${caPort}-${caName}.pem
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/localhost-${caPort}-${caName}.pem
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/localhost-${caPort}-${caName}.pem
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/localhost-${caPort}-${caName}.pem
    OrganizationalUnitIdentifier: orderer" > "${orgDir}/msp/config.yaml"

  mkdir -p "${orgDir}/msp/tlscacerts" "${orgDir}/tlsca"
  cp "${caCert}" "${orgDir}/msp/tlscacerts/tlsca.${DOMAIN}-cert.pem"
  cp "${caCert}" "${orgDir}/tlsca/tlsca.${DOMAIN}-cert.pem"

  for node in "${ORDERER_NODES[@]}"; do
    local nodeDomain="${node}.${DOMAIN}"
    infoln "[orderer] 註冊與簽發 ${node}"
    fabric-ca-client register --caname "${caName}" --id.name "${node}" --id.secret "${node}pw" --id.type orderer --tls.certfiles "${caCert}"

    fabric-ca-client enroll -u https://${node}:${node}pw@localhost:${caPort} --caname "${caName}" \
      -M "${orgDir}/orderers/${nodeDomain}/msp" --tls.certfiles "${caCert}"
    cp "${orgDir}/msp/config.yaml" "${orgDir}/orderers/${nodeDomain}/msp/config.yaml"
    mv "${orgDir}/orderers/${nodeDomain}/msp/signcerts/cert.pem" "${orgDir}/orderers/${nodeDomain}/msp/signcerts/${nodeDomain}-cert.pem"

    fabric-ca-client enroll -u https://${node}:${node}pw@localhost:${caPort} --caname "${caName}" \
      -M "${orgDir}/orderers/${nodeDomain}/tls" --enrollment.profile tls \
      --csr.hosts "${nodeDomain}" --csr.hosts localhost --tls.certfiles "${caCert}"
    cp "${orgDir}/orderers/${nodeDomain}/tls/tlscacerts/"* "${orgDir}/orderers/${nodeDomain}/tls/ca.crt"
    cp "${orgDir}/orderers/${nodeDomain}/tls/signcerts/"* "${orgDir}/orderers/${nodeDomain}/tls/server.crt"
    cp "${orgDir}/orderers/${nodeDomain}/tls/keystore/"* "${orgDir}/orderers/${nodeDomain}/tls/server.key"

    mkdir -p "${orgDir}/orderers/${nodeDomain}/msp/tlscacerts"
    cp "${orgDir}/orderers/${nodeDomain}/tls/tlscacerts/"* "${orgDir}/orderers/${nodeDomain}/msp/tlscacerts/tlsca.${DOMAIN}-cert.pem"
  done

  infoln "[orderer] 註冊與產生排序組織管理員 MSP"
  fabric-ca-client register --caname "${caName}" --id.name ordererAdmin --id.secret ordererAdminpw --id.type admin --tls.certfiles "${caCert}"
  fabric-ca-client enroll -u https://ordererAdmin:ordererAdminpw@localhost:${caPort} --caname "${caName}" \
    -M "${orgDir}/users/Admin@${DOMAIN}/msp" --tls.certfiles "${caCert}"
  cp "${orgDir}/msp/config.yaml" "${orgDir}/users/Admin@${DOMAIN}/msp/config.yaml"
}
