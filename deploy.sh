#!/usr/bin/env bash
#
# 一鍵部署腳本：依 quick_start.md／src/SETUP.md §9 的順序，啟動五組織 Fabric 網路、
# 部署鏈碼、Gateway 與 mocks 模擬服務，並可選擇執行端到端測試。
#
# 用法（在 WSL2 Ubuntu 22.04 內、repo 根目錄執行）：
#   ./deploy.sh up [--e2e] [--no-mocks]   啟動整套系統（預設子指令；重跑安全，已完成的步驟會略過）
#   ./deploy.sh stop                      只停止 Gateway 與 mocks，保留 Fabric 網路與帳本
#   ./deploy.sh down                      停止 Gateway 與 mocks，並關閉、清除整個 Fabric 網路
#   ./deploy.sh status                    顯示各元件目前狀態
#
# 前提：環境已依 src/SETUP.md §0 安裝完成。本腳本只做自檢，不會安裝或升級任何系統套件
# （Docker Engine 必須維持鎖定在 25.0.5，見 CLAUDE.md 環境注意事項）。
#
# 可覆寫的環境變數：
#   FABRIC_SAMPLES_HOME   Fabric 二進位檔位置（預設 ~/fabric/fabric-samples）
#   CC_VERSION            全新網路首次部署鏈碼時使用的版本標籤（預設 1.5）
#
# Gateway、mocks 以背景程序執行，PID 與日誌寫在 .run/（已列入 .gitignore）。

set -euo pipefail

PROJECT_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NETWORK_HOME="${PROJECT_HOME}/network"
GATEWAY_HOME="${PROJECT_HOME}/gateway"
RUN_DIR="${PROJECT_HOME}/.run"

CHANNEL_NAME=vehiclechannel
CC_NAME=vehicle
REQUIRED_DOCKER_VERSION=25.0.5
GATEWAY_HTTPS_PORT=8443
GATEWAY_INTERNAL_PORT=8080
MONITORING_STATION_PORT=9001
INSURANCE_PORT=9002

export FABRIC_SAMPLES_HOME=${FABRIC_SAMPLES_HOME:-"${HOME}/fabric/fabric-samples"}

. "${NETWORK_HOME}/scripts/utils.sh"

# ---------------------------------------------------------------------------
# 共用工具
# ---------------------------------------------------------------------------

stepln() { println "\n${C_BLUE}==> ${1}${C_RESET}"; }

# 以 bash 內建 /dev/tcp 檢查埠是否在監聽：8443 只接受 X25519MLKEM768，
# 用系統 curl 測試會握手失敗，因此只檢查 TCP 連線而不送 HTTP 請求。
isPortOpen() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# waitForPort <port> <名稱> <逾時秒數> <日誌檔>
waitForPort() {
  local port=$1 name=$2 timeoutSeconds=$3 logFile=$4
  for _ in $(seq 1 "$timeoutSeconds"); do
    isPortOpen "$port" && return 0
    sleep 1
  done
  errorln "${name} 在 ${timeoutSeconds} 秒內未開始監聽 ${port} 埠，最後幾行日誌："
  tail -n 20 "$logFile" >&2 || true
  fatalln "請依上方日誌排除問題（完整日誌：${logFile}）"
}

isProcessAlive() {
  local pidFile="${RUN_DIR}/$1.pid"
  [ -f "$pidFile" ] && kill -0 "$(cat "$pidFile")" 2>/dev/null
}

# startBackground <名稱> <工作目錄> <指令...>
startBackground() {
  local name=$1 workDir=$2
  shift 2
  mkdir -p "$RUN_DIR"
  # 只把指令本身放到背景，$! 才會是服務本身的 PID（若連同 cd 一起放到背景，
  # 記到的會是子 shell 的 PID）；setsid 讓服務脫離目前的 session，關掉終端機後仍繼續執行。
  cd "$workDir"
  setsid nohup "$@" >"${RUN_DIR}/${name}.log" 2>&1 </dev/null &
  echo $! >"${RUN_DIR}/${name}.pid"
  cd "$PROJECT_HOME"
}

stopBackground() {
  local name=$1
  local pidFile="${RUN_DIR}/${name}.pid"
  if ! isProcessAlive "$name"; then
    rm -f "$pidFile"
    return
  fi
  local pid
  pid=$(cat "$pidFile")
  infoln "停止 ${name}（PID ${pid}）"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  rm -f "$pidFile"
}

# 「主版本.次版本」比較：versionAtLeast <實際> <最低要求>
versionAtLeast() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

# 在子 shell 載入 network/scripts/envVar.sh，以 REG 管理員身分執行 peer 指令，
# 避免 envVar.sh 設定的 CORE_PEER_* 環境變數影響本腳本其他步驟。
peerAsReg() {
  (
    NETWORK_HOME="$NETWORK_HOME"
    . "${NETWORK_HOME}/scripts/envVar.sh"
    setGlobals reg 2>/dev/null
    "$@"
  )
}

# ---------------------------------------------------------------------------
# 0. 環境自檢（quick_start.md §0）
# ---------------------------------------------------------------------------

checkPrereqs() {
  stepln "環境自檢"
  local missing=()
  for bin in docker node npm python3 jq openssl; do
    command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
  done
  [ ${#missing[@]} -eq 0 ] || fatalln "找不到指令：${missing[*]}（安裝方式見 src/SETUP.md §0）"

  [ -x "${FABRIC_SAMPLES_HOME}/bin/peer" ] \
    || fatalln "找不到 ${FABRIC_SAMPLES_HOME}/bin/peer（見 src/SETUP.md §0.4，或設定 FABRIC_SAMPLES_HOME）"

  local dockerVersion
  dockerVersion=$(docker version --format '{{.Server.Version}}' 2>/dev/null) \
    || fatalln "無法連線 Docker daemon（確認 Docker 已啟動、目前使用者在 docker 群組內）"
  [ "$dockerVersion" = "$REQUIRED_DOCKER_VERSION" ] \
    || fatalln "Docker Engine 版本為 ${dockerVersion}，必須是 ${REQUIRED_DOCKER_VERSION}（26+ 會讓 chaincode 安裝失敗，見 src/SETUP.md §0.3）"

  local nodeVersion opensslVersion
  nodeVersion=$(node -p 'process.versions.node')
  opensslVersion=$(node -p 'process.versions.openssl')
  versionAtLeast "$nodeVersion" 22.0.0 || fatalln "Node.js 版本為 ${nodeVersion}，需要 22 以上"
  versionAtLeast "${opensslVersion%%[!0-9.]*}" 3.5.0 \
    || fatalln "Node.js 內建 OpenSSL 為 ${opensslVersion}，Kyber TLS 需要 3.5 以上"

  for image in fabric-peer:2.5.9 fabric-orderer:2.5.9 fabric-ccenv:2.5.9 fabric-baseos:2.5.9 fabric-ca:1.5.9; do
    docker image inspect "hyperledger/${image}" >/dev/null 2>&1 \
      || fatalln "找不到映像檔 hyperledger/${image}（見 src/SETUP.md §0.4；不可用 latest 標籤代替）"
  done

  # peer lifecycle chaincode package 封裝 Go 鏈碼時會在本機執行 go 判斷 module 根目錄
  # （編譯仍在 fabric-ccenv:2.5.9 容器內），沒有 go 會在部署鏈碼時才失敗。
  # 剛用 setup-env.sh 裝好、還沒重開終端機時 PATH 尚未包含 /usr/local/go/bin，先補上。
  if ! command -v go >/dev/null 2>&1 && [ -x /usr/local/go/bin/go ]; then
    export PATH="${PATH}:/usr/local/go/bin"
  fi
  command -v go >/dev/null 2>&1 \
    || fatalln "找不到 go：封裝鏈碼需要本機 Go（執行 ./setup-env.sh 安裝，見 src/SETUP.md §0.5）"

  successln "Docker ${dockerVersion}、Node.js ${nodeVersion}（OpenSSL ${opensslVersion}）、Fabric 映像檔皆符合"
}

# ---------------------------------------------------------------------------
# 1. Fabric 網路與鏈碼（quick_start.md §1）
# ---------------------------------------------------------------------------

isChannelJoined() {
  peerAsReg peer channel list 2>/dev/null | grep -qx "$CHANNEL_NAME"
}

isChaincodeCommitted() {
  peerAsReg peer lifecycle chaincode querycommitted \
    --channelID "$CHANNEL_NAME" --name "$CC_NAME" >/dev/null 2>&1
}

startNetwork() {
  stepln "啟動五組織 Fabric 網路"
  (cd "$NETWORK_HOME" && ./network.sh up)

  stepln "建立 channel ${CHANNEL_NAME}"
  # network.sh createChannel 不是冪等的（重複加入會失敗），已加入就略過。
  if isChannelJoined; then
    infoln "REG peer 已加入 ${CHANNEL_NAME}，略過"
  else
    (cd "$NETWORK_HOME" && ./network.sh createChannel)
  fi

  stepln "部署鏈碼 ${CC_NAME}"
  # 已提交的鏈碼再以相同 sequence 執行 deployCC.sh 會在核准階段失敗；
  # 鏈碼程式碼有改動時請照 src/SETUP.md §1 手動升級 CC_VERSION／CC_SEQUENCE。
  if isChaincodeCommitted; then
    infoln "鏈碼已提交過，略過（改過鏈碼需手動升級，見 src/SETUP.md §1）"
  else
    (cd "$NETWORK_HOME" && CC_VERSION="${CC_VERSION:-1.5}" CC_SEQUENCE=1 bash scripts/deployCC.sh)
  fi
}

# ---------------------------------------------------------------------------
# 2. Gateway（quick_start.md §2）
# ---------------------------------------------------------------------------

prepareGateway() {
  if [ ! -d "${GATEWAY_HOME}/node_modules" ]; then
    infoln "安裝 Gateway 相依套件"
    (cd "$GATEWAY_HOME" && npm install)
  fi
  if [ ! -f "${GATEWAY_HOME}/.env" ]; then
    cp "${GATEWAY_HOME}/.env.example" "${GATEWAY_HOME}/.env"
  fi
  if [ ! -f "${GATEWAY_HOME}/certs/gateway-cert.pem" ] || [ ! -f "${GATEWAY_HOME}/certs/gateway-key.pem" ]; then
    infoln "產生 Gateway 自簽 TLS 憑證（certs/ 已被 .gitignore 排除）"
    mkdir -p "${GATEWAY_HOME}/certs"
    openssl req -x509 -newkey rsa:2048 \
      -keyout "${GATEWAY_HOME}/certs/gateway-key.pem" -out "${GATEWAY_HOME}/certs/gateway-cert.pem" \
      -days 365 -nodes -subj "/CN=localhost" \
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
  fi
  infoln "建置 Gateway（tsc）"
  (cd "$GATEWAY_HOME" && npm run build --silent)
}

startGateway() {
  stepln "啟動 Gateway"
  if isProcessAlive gateway; then
    infoln "Gateway 已在執行（PID $(cat "${RUN_DIR}/gateway.pid")），略過"
    return
  fi
  for port in "$GATEWAY_HTTPS_PORT" "$GATEWAY_INTERNAL_PORT"; do
    isPortOpen "$port" && fatalln "${port} 埠已被其他程序佔用（是否另外開著 npm run dev？用 ss -ltnp | grep ${port} 查出是哪個程序）"
  done
  prepareGateway
  # Gateway 本身不會讀取 .env，交給 Node.js 的 --env-file 載入。
  startBackground gateway "$GATEWAY_HOME" node --env-file=.env dist/index.js
  waitForPort "$GATEWAY_INTERNAL_PORT" Gateway 60 "${RUN_DIR}/gateway.log"
  waitForPort "$GATEWAY_HTTPS_PORT" Gateway 10 "${RUN_DIR}/gateway.log"
  successln "Gateway 已啟動（日誌：.run/gateway.log）"
}

# ---------------------------------------------------------------------------
# 3. 外部系統模擬服務（quick_start.md §3）
# ---------------------------------------------------------------------------

# startMock <名稱> <python 模組> <埠>
startMock() {
  local name=$1 module=$2 port=$3
  if isProcessAlive "$name"; then
    infoln "${name} 已在執行（PID $(cat "${RUN_DIR}/${name}.pid")），略過"
    return
  fi
  isPortOpen "$port" && fatalln "${port} 埠已被其他程序佔用，無法啟動 ${name}（用 ss -ltnp | grep ${port} 查出是哪個程序）"
  startBackground "$name" "$PROJECT_HOME" python3 -m "$module"
  waitForPort "$port" "$name" 15 "${RUN_DIR}/${name}.log"
  successln "${name} 已啟動：http://127.0.0.1:${port}（日誌：.run/${name}.log）"
}

startMocks() {
  stepln "啟動監理站（EIR1）／保險公司（EIR2）模擬服務"
  if ! python3 -c 'import requests' 2>/dev/null; then
    infoln "安裝 mocks 相依套件"
    python3 -m pip install --user -r "${PROJECT_HOME}/mocks/requirements.txt"
  fi
  startMock monitoring-station mocks.monitoring_station.app "$MONITORING_STATION_PORT"
  startMock insurance mocks.insurance.app "$INSURANCE_PORT"
}

# ---------------------------------------------------------------------------
# 子指令
# ---------------------------------------------------------------------------

printSummary() {
  stepln "部署完成"
  cat >&2 <<EOF
  車主介面    https://localhost:${GATEWAY_HTTPS_PORT}/owner.html
  買家介面    https://localhost:${GATEWAY_HTTPS_PORT}/buyer.html
  鑑定師介面  https://localhost:${GATEWAY_HTTPS_PORT}/appraiser.html
  （首次開啟需手動接受自簽憑證警告；瀏覽器需支援 X25519MLKEM768：Chrome／Edge 131+、Firefox 132+）

  Gateway 內部服務埠  http://127.0.0.1:${GATEWAY_INTERNAL_PORT}
  日誌目錄            ${RUN_DIR}
  停止服務            ./deploy.sh stop   （保留網路與帳本）
  完全清除            ./deploy.sh down
EOF
}

cmdUp() {
  local shouldRunE2e=false shouldStartMocks=true
  for arg in "$@"; do
    case "$arg" in
      --e2e) shouldRunE2e=true ;;
      --no-mocks) shouldStartMocks=false ;;
      *) fatalln "未知的選項：${arg}（可用：--e2e、--no-mocks）" ;;
    esac
  done
  if $shouldRunE2e && ! $shouldStartMocks; then
    fatalln "--e2e 需要 mocks 模擬服務（UC-03、EIR1 情境），不能與 --no-mocks 同時使用"
  fi

  checkPrereqs
  startNetwork
  startGateway
  $shouldStartMocks && startMocks

  if $shouldRunE2e; then
    stepln "執行端到端測試（UC-01/02/03＋EIR1＋dApp D0–D3）"
    (cd "$PROJECT_HOME" && node tests/e2e/runAll.mjs)
  fi
  printSummary
}

cmdStop() {
  stepln "停止 Gateway 與 mocks"
  stopBackground insurance
  stopBackground monitoring-station
  stopBackground gateway
  successln "已停止（Fabric 網路仍在執行）"
}

cmdDown() {
  cmdStop
  stepln "關閉並清除 Fabric 網路"
  (cd "$NETWORK_HOME" && ./network.sh down)
}

cmdStatus() {
  local name
  for name in gateway monitoring-station insurance; do
    if isProcessAlive "$name"; then
      successln "${name}：執行中（PID $(cat "${RUN_DIR}/${name}.pid")）"
    else
      warnln "${name}：未執行"
    fi
  done
  local containerCount
  containerCount=$(docker ps --filter "label=service=hyperledger-fabric" -q 2>/dev/null | wc -l)
  infoln "Fabric 容器（排序節點＋peer）執行中：${containerCount} 個"
  if isChaincodeCommitted; then
    peerAsReg peer lifecycle chaincode querycommitted --channelID "$CHANNEL_NAME" --name "$CC_NAME" >&2 2>/dev/null
  else
    warnln "鏈碼 ${CC_NAME} 尚未提交至 ${CHANNEL_NAME}（或網路未啟動）"
  fi
}

MODE=${1:-up}
[ $# -gt 0 ] && shift
case "$MODE" in
  up) cmdUp "$@" ;;
  stop) cmdStop ;;
  down) cmdDown ;;
  status) cmdStatus ;;
  *)
    println "用法：./deploy.sh {up [--e2e] [--no-mocks]|stop|down|status}"
    exit 1
    ;;
esac
