#!/usr/bin/env bash
#
# 一次性環境安裝腳本：在全新的 WSL2 Ubuntu 22.04 內，依 src/SETUP.md §0 安裝本專案
# 需要的所有工具。裝完後執行 ./deploy.sh up --e2e 即可部署整套系統。
#
# 用法（在 WSL2 Ubuntu 22.04 內、repo 根目錄執行）：
#   ./setup-env.sh             安裝必要元件（含 Go；舊的 --with-go 選項仍可用，效果相同）
#
# 重跑安全：已裝好且版本正確的元件會略過。會用 sudo 安裝系統套件（過程中可能要求輸入
# 一次密碼）；不會修改 sudoers，也不會動 Windows 端的 %USERPROFILE%\.wslconfig。
#
# 版本鎖定原因（詳見 src/SETUP.md §0、CLAUDE.md 環境注意事項）：
#   Docker Engine 25.0.5   26 以上會讓 Fabric 2.5.9 peer 的 chaincode 安裝失敗
#   Fabric 2.5.9／CA 1.5.9  需求書指定；映像檔一律用明確版號，不用 latest
#   Node.js 22+            內建 OpenSSL 3.5+ 才支援 Kyber TLS（X25519MLKEM768）
#   Go 1.27.1              peer 封裝 Go 鏈碼時會在本機執行 go 判斷 module 根目錄（必要）；
#                          實際編譯仍在 fabric-ccenv:2.5.9（Go 1.22.4）容器內

set -euo pipefail

PROJECT_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

DOCKER_VERSION=5:25.0.5-1~ubuntu.22.04~jammy
CONTAINERD_VERSION=1.6.28-1
FABRIC_VERSION=2.5.9
FABRIC_CA_VERSION=1.5.9
NODE_MAJOR=22
GO_VERSION=1.27.1
export FABRIC_SAMPLES_HOME=${FABRIC_SAMPLES_HOME:-"${HOME}/fabric/fabric-samples"}

. "${PROJECT_HOME}/network/scripts/utils.sh"

stepln() { println "\n${C_BLUE}==> ${1}${C_RESET}"; }

versionAtLeast() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

# docker 群組要重新登入才生效；本次執行期間若目前 shell 還沒有權限，就改用 sg 以
# docker 群組身分執行（使用者已被加入群組，不需要群組密碼）。
runWithDocker() {
  if docker info >/dev/null 2>&1; then
    "$@"
  else
    sg docker -c "$(printf '%q ' "$@")"
  fi
}

# ---------------------------------------------------------------------------

checkPlatform() {
  stepln "確認執行環境"
  [ "$(id -u)" -ne 0 ] || fatalln "請用一般使用者執行（腳本會在需要時自行呼叫 sudo），不要用 sudo ./setup-env.sh"
  grep -qi microsoft /proc/version || warnln "看起來不是在 WSL2 內執行；本專案只在 WSL2 Ubuntu 22.04 驗證過"
  local release
  release=$(. /etc/os-release && echo "${VERSION_ID:-unknown}")
  [ "$release" = "22.04" ] \
    || fatalln "目前是 Ubuntu ${release}，本專案需要 Ubuntu 22.04（Docker 25.0.5 的套件只針對 22.04 jammy 發行）"
  # 用 sudo true 而非 sudo -v：sudoers 同時有 NOPASSWD 與預設 %sudo 規則時，-v 仍會要求密碼。
  sudo true
  successln "Ubuntu 22.04，sudo 可用"
}

installBasePackages() {
  stepln "安裝基本套件"
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl gnupg lsb-release jq unzip openssl git \
    python3 python3-pip python3-venv
}

isDockerDesktop() {
  local dockerPath
  dockerPath=$(command -v docker 2>/dev/null || true)
  [[ "$dockerPath" == /mnt/* ]] && return 0
  docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop'
}

installDocker() {
  stepln "安裝 Docker Engine 25.0.5（鎖定版本）"
  if isDockerDesktop; then
    fatalln "偵測到 Docker Desktop 的 WSL 整合。請在 Docker Desktop › Settings › Resources › WSL integration 關閉 Ubuntu-22.04 的整合後重跑（Docker Desktop 的版本無法鎖定在 25.0.5）"
  fi

  local installed
  installed=$(dpkg-query -W -f='${Version}' docker-ce 2>/dev/null || true)
  if [ "$installed" = "$DOCKER_VERSION" ]; then
    infoln "docker-ce ${installed} 已安裝，略過"
  else
    [ -z "$installed" ] || warnln "目前 docker-ce 為 ${installed}，將降級至 25.0.5"
    sudo install -m 0755 -d /etc/apt/keyrings
    if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    fi
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
    sudo apt-get update -y
    sudo apt-mark unhold docker-ce docker-ce-cli docker-ce-rootless-extras containerd.io >/dev/null 2>&1 || true
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades \
      "docker-ce=${DOCKER_VERSION}" \
      "docker-ce-cli=${DOCKER_VERSION}" \
      "docker-ce-rootless-extras=${DOCKER_VERSION}" \
      "containerd.io=${CONTAINERD_VERSION}" \
      docker-compose-plugin docker-buildx-plugin
  fi
  # 防止日後 apt upgrade 把 Docker 升到不相容的版本。
  sudo apt-mark hold docker-ce docker-ce-cli docker-ce-rootless-extras containerd.io >/dev/null

  if ! id -nG "$USER" | grep -qw docker; then
    sudo usermod -aG docker "$USER"
    warnln "已將 ${USER} 加入 docker 群組；需重新開啟 WSL 終端機才會生效"
  fi

  if ! sudo docker info >/dev/null 2>&1; then
    infoln "啟動 Docker 服務"
    sudo systemctl start docker 2>/dev/null || sudo service docker start
  fi
  successln "Docker Engine $(sudo docker version --format '{{.Server.Version}}')"
}

hasFabricImages() {
  local image
  for image in fabric-peer:${FABRIC_VERSION} fabric-orderer:${FABRIC_VERSION} \
               fabric-ccenv:${FABRIC_VERSION} fabric-baseos:${FABRIC_VERSION} fabric-ca:${FABRIC_CA_VERSION}; do
    sudo docker image inspect "hyperledger/${image}" >/dev/null 2>&1 || return 1
  done
}

installFabric() {
  stepln "安裝 Hyperledger Fabric ${FABRIC_VERSION}／Fabric CA ${FABRIC_CA_VERSION}"
  if [ -x "${FABRIC_SAMPLES_HOME}/bin/peer" ] && hasFabricImages; then
    infoln "Fabric 執行檔與映像檔皆已存在，略過"
    return
  fi
  local fabricParent
  fabricParent=$(dirname "$FABRIC_SAMPLES_HOME")
  mkdir -p "$fabricParent"
  curl -fsSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh \
    -o "${fabricParent}/install-fabric.sh"
  chmod +x "${fabricParent}/install-fabric.sh"
  (cd "$fabricParent" && runWithDocker ./install-fabric.sh -f "$FABRIC_VERSION" -c "$FABRIC_CA_VERSION" docker samples binary)

  hasFabricImages || fatalln "Fabric 映像檔安裝不完整（需要 peer/orderer/ccenv/baseos:${FABRIC_VERSION} 與 ca:${FABRIC_CA_VERSION}）"
  local ccenvGo
  ccenvGo=$(sudo docker run --rm "hyperledger/fabric-ccenv:${FABRIC_VERSION}" go version)
  successln "Fabric 已安裝於 ${FABRIC_SAMPLES_HOME}（ccenv：${ccenvGo}）"
}

installNode() {
  stepln "安裝 Node.js ${NODE_MAJOR}"
  if command -v node >/dev/null 2>&1; then
    local nodeVersion
    nodeVersion=$(node -p 'process.versions.node')
    if versionAtLeast "$nodeVersion" "${NODE_MAJOR}.0.0"; then
      infoln "Node.js ${nodeVersion} 已安裝，略過"
      checkNodeOpenssl
      return
    fi
  fi
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  checkNodeOpenssl
}

checkNodeOpenssl() {
  local opensslVersion
  opensslVersion=$(node -p 'process.versions.openssl')
  if versionAtLeast "${opensslVersion%%[!0-9.]*}" 3.5.0; then
    successln "Node.js $(node --version)（OpenSSL ${opensslVersion}）"
  else
    fatalln "Node.js 內建 OpenSSL 為 ${opensslVersion}，Kyber TLS 需要 3.5 以上；請升級到最新的 Node.js ${NODE_MAJOR}.x（sudo apt-get install -y nodejs）"
  fi
}

installGo() {
  stepln "安裝 Go ${GO_VERSION}"
  if [ -x /usr/local/go/bin/go ]; then
    infoln "已安裝 $(/usr/local/go/bin/go version | awk '{print $3}')，略過"
  else
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tar.gz
    sudo rm -rf /usr/local/go
    sudo tar -C /usr/local -xzf /tmp/go.tar.gz
    rm -f /tmp/go.tar.gz
  fi
  grep -q '/usr/local/go/bin' "${HOME}/.bashrc" || echo 'export PATH=$PATH:/usr/local/go/bin' >>"${HOME}/.bashrc"
  successln "Go 已安裝（新開的終端機才會讀到 PATH）"
}

installPythonPackages() {
  stepln "安裝 mocks 模擬服務的 Python 套件"
  if python3 -c 'import requests' 2>/dev/null; then
    infoln "requests 已安裝，略過"
    return
  fi
  python3 -m pip install --user -r "${PROJECT_HOME}/mocks/requirements.txt"
}

printNextSteps() {
  stepln "環境安裝完成"
  cat >&2 <<EOF
  接下來：
  1. 關掉這個終端機、重新開啟 WSL（讓 docker 群組權限生效）
  2. 建議在 Windows 端設定 %USERPROFILE%\\.wslconfig 停用 WSL 閒置逾時（見 src/SETUP.md §0.7），
     否則長時間沒操作時，WSL 可能連同所有容器一起被關閉
  3. 回到專案目錄執行：./deploy.sh up --e2e
EOF
}

# ---------------------------------------------------------------------------

for arg in "$@"; do
  case "$arg" in
    --with-go) ;; # 舊選項：Go 現在一律安裝（封裝鏈碼需要），保留以相容舊文件
    *) fatalln "未知的選項：${arg}" ;;
  esac
done

checkPlatform
installBasePackages
installDocker
installFabric
installNode
installGo
installPythonPackages
printNextSteps
