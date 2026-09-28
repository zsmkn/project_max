# 搭建與測試指令彙總

給組員在自己機器上從零搭建本專案、依序啟動各模組、執行所有測試用的參考。
環境已經裝好、只想把系統跑起來的話，看 [quick_start.md](../quick_start.md) 就夠了。
只彙整「指令」；設計理由、除錯過程與已知限制請見對應連結，不在此重複：
根目錄 [CLAUDE.md](../CLAUDE.md)（工作方式、編程風格、環境注意事項）、
[plan.md](../plan.md)（需求理解、階段規劃、已定案決策）、
`docs/stage0-validation.md` ～ `docs/stage7-performance.md`（各階段做了什麼、踩過
什麼坑），以及各子目錄自己的 README（`network/`、`gateway/`、`mocks/`、`web/`、
`tests/e2e/`、`tests/perf/`）。

> 所有指令皆在 **WSL2（Ubuntu 22.04）** 內執行。專案檔案可以放在 Windows 檔案系統
> （`/mnt/c/...`），從 WSL 用該路徑操作即可，不需要把 repo 複製進 WSL 原生檔案系統；
> 但 Docker、Fabric 二進位檔、Go、Node.js 都必須裝在 WSL 內，不是 Windows 側。

## 0. 一次性環境安裝（新機器只需做一次）

版本務必照抄，差一個版號就可能撞上 `docs/stage0-validation.md` 記錄過的相容性問題。

| 元件 | 版本 | 為什麼卡在這個版本 |
| --- | --- | --- |
| WSL2 | Ubuntu 22.04 LTS | 需求書指定 |
| Docker Engine | **鎖定 25.0.5**（`apt-mark hold`） | 26 以上會讓 Fabric 2.5.9 peer 的 chaincode 安裝失敗（legacy docker build API 不相容） |
| Hyperledger Fabric / Fabric CA | **2.5.9 / 1.5.9** | 官方 `install-fabric.sh -f 2.5.9 -c 1.5.9`；Docker 映像檔務必用明確版號，不可用 `latest`（本機曾發生 `latest` 實際解析成 Fabric 3.1.5） |
| Go | 1.22+（chaincode 開發機建議與 CI 一致用 1.22.x／1.27.x 皆可） | `chaincode/vehicle/go.mod` 鎖定 `go 1.22.0`：依賴 `github.com/cloudflare/circl v1.6.3` 要求 1.22.0，且 `fabric-ccenv:2.5.9` 容器內建的正是 Go 1.22.4，更新版 CIRCL 要求 Go 1.25+ 會建置失敗 |
| Node.js | 22+ | `gateway/`、`tests/e2e/`、`tests/perf/` 皆要求；內建 OpenSSL 3.5+ 支援 Kyber TLS（`X25519MLKEM768`），系統其他工具（WSL 內建 `curl`、系統 Python 的 `requests`）的舊版 OpenSSL 連不上 Gateway 公開埠是**設計行為**，不是 bug |
| Python | 3.10+ | `mocks/`、`web/` 的簡易伺服器 |
| jq、curl、openssl | 任意新版 | network 腳本與產生自簽憑證用 |

### 0.1 WSL2 + 免密碼 sudo

Windows PowerShell（系統管理員）：

```powershell
wsl --install -d Ubuntu-22.04
```

進入 WSL 後，先讓非互動安裝指令不會卡在密碼提示：

```bash
echo "$USER ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/90-$USER
```

### 0.2 編譯工具與基本套件

```bash
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  build-essential cmake ninja-build libssl-dev pkg-config jq unzip \
  python3-pip python3-venv
```

### 0.3 Docker Engine — 必須鎖定 25.0.5，不可用最新版

> **地雷**：Docker Engine 26 以上（含目前官方預設安裝的版本）會讓 Fabric 2.5.9
> peer 內建的 chaincode 安裝失敗（`docker build failed: ... write: broken pipe`），
> 因為 peer 呼叫的是 Docker 的 legacy（非 BuildKit）`/build` API，新版 Docker 對此
> 路徑不相容。純 `docker build` CLI（走 BuildKit）不受影響，只有 Fabric peer 內部
> 呼叫會壞掉，容易誤判成「Fabric 有問題」。詳見 `docs/stage0-validation.md`。

全新機器：

```bash
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update

sudo apt-get install -y \
  docker-ce=5:25.0.5-1~ubuntu.22.04~jammy \
  docker-ce-cli=5:25.0.5-1~ubuntu.22.04~jammy \
  docker-ce-rootless-extras=5:25.0.5-1~ubuntu.22.04~jammy \
  containerd.io=1.6.28-1

sudo apt-mark hold docker-ce docker-ce-cli docker-ce-rootless-extras containerd.io
sudo usermod -aG docker "$USER"   # 需要重新登入 WSL 才生效
docker version   # Server: Docker Engine - Community, Version: 25.0.5
```

已裝過新版 Docker 的機器，改用 `--allow-downgrades` 降級到同一組版本再 `apt-mark hold`。

### 0.4 Hyperledger Fabric 2.5.9 / Fabric CA 1.5.9

```bash
mkdir -p ~/fabric && cd ~/fabric
curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
chmod +x install-fabric.sh
./install-fabric.sh -f 2.5.9 -c 1.5.9 docker samples binary
```

`~/fabric/fabric-samples/bin` 會有 `peer`/`orderer`/`cryptogen`/`configtxgen`/
`fabric-ca-client` 等工具；`network/` 底下的腳本預設會去這個路徑找，安裝到別處
需設定環境變數 `FABRIC_SAMPLES_HOME` 覆寫。確認映像檔版本正確（不可只看 `latest`）：

```bash
docker images | grep fabric   # 應看到 peer/orderer/ccenv/baseos:2.5.9、ca:1.5.9 明確版號
docker run --rm hyperledger/fabric-ccenv:2.5.9 go version
# go version go1.22.4 linux/amd64
```

### 0.5 Go、Node.js

```bash
# Go（官方 tarball；只要落在 1.22.x 以上皆可，本機用 1.27.1 開發）
curl -fsSL https://go.dev/dl/go1.27.1.linux-amd64.tar.gz -o /tmp/go.tar.gz
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf /tmp/go.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
source ~/.bashrc
go version

# Node.js 22（NodeSource 或 nvm 皆可）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version                        # v22.x
node -p 'process.versions.openssl'    # 需 >= 3.5（Kyber TLS 混合金鑰交換）
```

### 0.6（選用）liboqs 0.13.0

只有要重現 stage 0 的 Kyber TLS／Dilithium CLI 底層實驗才需要。**最終的 chaincode／
Gateway 分別用 Cloudflare CIRCL（Go）與 `@noble/post-quantum`（TypeScript）**，不依賴
liboqs 執行期函式庫，一般開發／展示不需要裝這一步：

```bash
git clone --branch 0.13.0 --depth 1 https://github.com/open-quantum-safe/liboqs.git /tmp/liboqs
cmake -S /tmp/liboqs -B /tmp/liboqs/build -GNinja -DCMAKE_INSTALL_PREFIX=/opt/liboqs -DOQS_DIST_BUILD=ON
ninja -C /tmp/liboqs/build
sudo ninja -C /tmp/liboqs/build install
```

### 0.7 WSL2 記憶體與閒置逾時（`%USERPROFILE%\.wslconfig`，Windows 端）

實測 19 個容器（6 CA＋3 Raft＋5 peer＋5 CouchDB）只需約 900 MB，記憶體不必特別調高；
但 WSL2 預設閒置逾時（約 60 秒無活動）會整個關閉發行版、連帶砍掉所有容器，長時間
開發務必嘗試停用（**注意**：`docs/stage2-chaincode.md` 記錄過此設定在 WSL 2.7.14.0
下實測仍可能約 20–50 秒後失效——容器突然全部 `Exited` 時，先懷疑是不是 WSL 被關閉，
不要急著懷疑鏈碼或網路設定；跑長時間操作時，把整個流程放進同一個 shell 指令連續
執行完，減少「閒置等待下一步」的空檔）：

```ini
[wsl2]
memory=22GB
processors=16
swap=4GB
localhostForwarding=true
vmIdleTimeout=-1
```

改完存檔後套用（**會中斷當下所有 WSL 工作**，先確認沒有其他重要工作階段）：

```powershell
wsl --shutdown
```

筆電**建議接上電源**——Windows 預設閒置睡眠是與 WSL2 `vmIdleTimeout` 獨立的另一個
機制，同樣會中斷所有容器；必要時暫時關閉（事後用同一指令搭配原始值還原）：

```powershell
powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0
```

---

## 1. 啟動五組織 Fabric 聯盟鏈並部署合約

```bash
cd network
./network.sh up             # 6 個 CA、簽發五組織＋排序組織憑證、3 個 Raft 排序節點 + 5 peer + 5 CouchDB
./network.sh createChannel  # 建立 vehiclechannel，五組織加入並設定 anchor peer
bash scripts/deployCC.sh    # 封裝／安裝／核准／提交 chaincode/vehicle（首次約數分鐘）
```

- `up` 只在憑證尚未產生時才重新簽發，重複執行是安全的；完全重來先 `./network.sh down`
  （會清除所有容器、volume、憑證與 channel-artifacts）。
- `deployCC.sh` 全程冪等，重跑會跳過已安裝的組織；`chaincode/vehicle/` 程式碼有改動
  時，用環境變數升級版本再重跑一次（實際版號以程式碼目前狀態為準，可對照
  `docs/stage4-scoring.md`／`docs/stage6-integration.md` 等文件紀錄的最新版本）：

  ```bash
  CC_VERSION=1.5 CC_SEQUENCE=6 bash scripts/deployCC.sh   # 目前最新：plan_dApp.md D0／D3（docs/dapp.md）
  ```

- 關閉並清除：`./network.sh down`。
- 組織／連接埠對照表見 [network/README.md](../network/README.md)。

### NFR3 容錯測試

```bash
bash scripts/faultToleranceTest.sh       # 階段 1 初驗：channel 設定交易（尚無鏈碼時）
bash scripts/faultToleranceTestFull.sh   # 階段 7 完整版：真實鏈碼交易，含容錯邊界驗證
```

### CLI 展示腳本（驗收用，非日常開發必需）

```bash
bash scripts/demoStage2.sh   # UC-03 前半段：InitVehicle/AddMaintenance/RecordClaim + 背書政策
bash scripts/demoStage4.sh   # UC-01：里程倒退不拒絕交易、扣 40 分、ANOMALY 事件上鏈
```

---

## 2. Chaincode（`chaincode/vehicle/`，Go）

```bash
cd chaincode/vehicle
go test ./...
go vet ./...
gofmt -l contract/*.go main.go   # 不要用 gofmt -l .——會把 vendor/ 第三方套件也列出來
```

在真實 chaincode 建置環境（`fabric-ccenv:2.5.9`，內建 Go 1.22.4）內驗證能建置
（本機 Go 版本較新時，這一步才是唯一準確的相容性驗證）：

```bash
docker run --rm -v "$(pwd)":/cc -w /cc hyperledger/fabric-ccenv:2.5.9 \
  bash -lc 'go vet -mod=vendor ./... && go build -mod=vendor -o /tmp/out .'
```

`go.mod` 修改依賴後要重新產生 vendor（ccenv 容器內建置不連網路）：

```bash
go mod vendor
```

修改鏈碼後需重新部署（見上方 §1 `deployCC.sh`，記得升級 `CC_VERSION`/`CC_SEQUENCE`）
才會反映到已啟動的網路上。

---

## 3. Gateway（`gateway/`，Node.js 22 + TypeScript）

前提：network 已 `up` ＋ `createChannel` ＋ 部署 chaincode。

```bash
cd gateway
npm install
cp .env.example .env    # 視需要覆寫預設值（預設值已對應本機五組織開發環境）

# 產生本機開發用的自簽 TLS 憑證（Kyber TLS 邊界，僅需一次）
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -keyout certs/gateway-key.pem \
  -out certs/gateway-cert.pem -days 365 -nodes -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

npm run dev   # 開發模式（tsx watch）
```

啟動後有**兩個埠**：

- `https://localhost:8443` —— 對外公開，只接受 `X25519MLKEM768` 混合金鑰交換
  （Kyber TLS 邊界，BFR4）；瀏覽器與新版 Node.js 可連，`curl`／舊版 OpenSSL 會直接
  handshake failure（設計行為）。
- `http://127.0.0.1:8080` —— 僅限本機（loopback）的內部服務埠，供 `mocks/` 這類
  系統對系統整合、`tests/perf/` 建立種子資料時呼叫，不套用 Kyber TLS 限制。

```bash
npm test           # 等同 npx vitest run
npx tsc --noEmit    # 型別檢查
npm run build       # 建置正式版（tsc 輸出到 dist/）
npm start            # node dist/index.js
```

驗證 Kyber TLS（一般 `curl`／舊版 OpenSSL 會直接握手失敗，這是設計行為，不是 bug）：

```js
import https from 'node:https';
https.request(
  { hostname: 'localhost', port: 8443, path: '/api/vehicles/<vin>/summary',
    rejectUnauthorized: false, ecdhCurve: 'X25519MLKEM768', minVersion: 'TLSv1.3' },
  (res) => res.on('data', (c) => process.stdout.write(c)),
).end();
```

API 端點清單見 [gateway/README.md](../gateway/README.md)。

---

## 4. Web（`web/`，三種角色 HTML5 介面）

前提：Gateway 已啟動。網頁由 Gateway 同源提供（plan_dApp.md D0），不需另開靜態伺服器：

```
https://localhost:8443/owner.html      # 車主（瀏覽器自持 PQC 金鑰、即時通知）
https://localhost:8443/buyer.html      # 買家（瀏覽器端驗章）
https://localhost:8443/appraiser.html  # 鑑定師
```

第一次開啟時手動接受 Gateway 自簽憑證警告一次即可。瀏覽器需支援 `X25519MLKEM768`
（Chrome／Edge 131+、Firefox 132+）。

網頁錢包單元測試與真實瀏覽器冒煙測試：

```bash
node --test web/tests/*.test.mjs                                        # WSL 內
powershell -NoProfile -ExecutionPolicy Bypass -File tests\e2e\browserSmoke.ps1  # Windows 端，headless Edge
```

---

## 5. 外部系統模擬服務（`mocks/`，Python，EIR1／EIR2）

前提：Gateway 已啟動（呼叫其內部服務埠 8080）。

```bash
cd project_max   # repo 根目錄
python3 -m venv .venv && source .venv/bin/activate   # 可選
pip install -r mocks/requirements.txt

python3 -m mocks.monitoring_station.app   # EIR1，監聽 http://127.0.0.1:9001
python3 -m mocks.insurance.app            # EIR2，監聽 http://127.0.0.1:9002
```

單元測試（`mapping.py` 欄位轉換純函式，不需啟動 network／Gateway）：

```bash
python3 -m unittest discover -s mocks -p "test_*.py"
# 或：make mocks-test
```

---

## 6. 端到端測試（`tests/e2e/`，UC-01/02/03 ＋ EIR1，階段 6）

對應驗收標準「UC-01/02/03 端到端腳本一鍵通過」。前提（依序啟動，各自保留在前景
執行或另開終端機）：

```bash
# 1) network（含部署 chaincode，見 §1）
# 2) gateway（npm run dev，見 §3）
# 3) mocks（uc03、eir1 腳本需要，見 §5）
```

執行：

```bash
node tests/e2e/runAll.mjs        # 一鍵執行全部八個情境（UC-01/02/03、EIR1、dApp D0–D3）
# 或：make e2e

# 只執行單一情境
node tests/e2e/uc01AppraiserScoring.mjs
node tests/e2e/uc02BuyerPqcQuery.mjs
node tests/e2e/uc03OemSvcInsLifecycle.mjs
node tests/e2e/eir1MonitoringStation.mjs
```

每次執行都會在鏈上留下新的測試車輛與事件（帳本不可竄改／刪除，這是預期行為，非
殘留清理疏漏）。涵蓋範圍對照表見 [tests/e2e/README.md](../tests/e2e/README.md)。

---

## 7. 效能測試（`tests/perf/`，Hyperledger Caliper，階段 7，NFR2）

獨立的 npm 工作區，繞過 Gateway REST 層，直接透過 `@hyperledger/fabric-gateway` SDK
對鏈量測交易層級的 TPS 與查詢延遲。前提：network（含部署 chaincode）、gateway（僅供
`seed` 步驟呼叫其內部埠 8080）皆已啟動。

```bash
cd tests/perf
npm install
npm run bind      # caliper bind --caliper-bind-sut fabric:2.5
npm run seed       # 建立 300 台種子車輛 + 測試車主 PQC 金鑰
npm run config     # 依目前 network/organizations/ 的憑證產生 networkConfig.yaml
npm run benchmark
```

`network.sh down && up` 重新產生憑證後，需重跑 `npm run config`。完成後於
`tests/perf/report.html` 產生報告（TPS、延遲、成功率，機器相依產生物，不進版控）；
關鍵數據已整理進 [docs/stage7-performance.md](../docs/stage7-performance.md)。

---

## 8. Lint / 格式化速查

| 語言 | 指令 | 備註 |
| --- | --- | --- |
| Go | `gofmt -l contract/*.go main.go`、`go vet ./...` | 不要對整個目錄跑 `gofmt -l .`，會列出 `vendor/` 底下的第三方套件 |
| Python | `ruff check mocks/` | 尚未加入 `pyproject.toml`／ruff 設定檔，供未來啟用 |
| TypeScript | `npx tsc --noEmit` | `eslint`／`prettier` 設定檔尚未加入 |

---

## 9. 完整啟動順序（從零開始，單一終端機示範）

```bash
cd network && ./network.sh up && ./network.sh createChannel && bash scripts/deployCC.sh && cd ..

cd gateway && npm install && cp .env.example .env
mkdir -p certs && openssl req -x509 -newkey rsa:2048 -keyout certs/gateway-key.pem \
  -out certs/gateway-cert.pem -days 365 -nodes -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
npm run dev &   # 背景執行；正式操作建議另開終端機視窗跑 npm run dev
cd ..

pip install -r mocks/requirements.txt
python3 -m mocks.monitoring_station.app &
python3 -m mocks.insurance.app &

make e2e   # 四個情境全數通過即代表整個系統搭建成功
```

收尾（反向操作：先停 mocks／web／gateway 的 `Ctrl+C` 或對應 `kill`，最後關閉網路）：

```bash
cd network && ./network.sh down   # 關閉並清除所有容器、volume、憑證與 channel artifacts
```

---

## 10. 常見環境陷阱（動手前先看）

| 症狀 | 原因 | 對策 |
| --- | --- | --- |
| `sudo` 指令卡住不動 | 非互動 shell 等密碼輸入 | §0.1，設定 `NOPASSWD` |
| chaincode install 失敗，`write unix @->/run/docker.sock: broken pipe` | Docker Engine 版本太新（26+），legacy build API 不相容 | §0.3，降級並 `apt-mark hold` 在 25.0.5 |
| chaincode 在 ccenv 容器內建置失敗，Go 版本錯誤 | CIRCL 版本 > v1.6.3 要求 Go 1.25+，但 ccenv 只有 Go 1.22.4 | `go.mod` 鎖定 `circl v1.6.3` 與 `go 1.22.0`，勿任意升級 CIRCL |
| Docker 映像檔行為與預期不符 | 用了 `latest` 標籤，實際解析到 Fabric 3.x | 一律用明確版本號 `2.5.9`／`1.5.9` |
| 長時間沒操作，容器全部消失（`docker ps` 變空） | WSL2 閒置逾時關閉整個發行版（`vmIdleTimeout=-1` 不保證生效） | §0.7；需要 Docker 存活的多步驟操作，盡量放進同一段 shell 連續執行完，減少閒置空檔 |
| Python／curl 呼叫 Gateway 8443 埠 TLS 握手失敗 | 公開埠只接受 `X25519MLKEM768`，系統 OpenSSL 版本不支援 | 改呼叫 Gateway 內部服務埠 `127.0.0.1:8080`（見 §3、`mocks/README.md`） |
| `web/` 與 Gateway 內部服務埠衝突（`Address already in use`） | 兩者都想用 8080 | `web/` 一律用 `python3 -m http.server 8000`（見 §4） |
| `peer chaincode invoke` 回報「chaincode definition exists, but chaincode is not installed」 | shell script 的 log 輸出印到 stdout，污染了 `$(...)` 擷取的 package ID | 已知根因並已修正（`network/scripts/utils.sh` 的 log 函式改印到 stderr）；若重新遇到「變數裡混入不該有的文字」，優先檢查有沒有指令替換擷取到夾雜 log 訊息的輸出 |
| `tests/perf` 種子資料或 `networkConfig.yaml` 過期 | `network.sh down && up` 後憑證重新產生 | 重跑 `npm run seed`／`npm run config` |

---

## 11. 深入閱讀

| 想了解什麼 | 看哪裡 |
| --- | --- |
| 環境已備妥時的最短啟動路徑 | [quick_start.md](../quick_start.md) |
| 成果發表的建議展示順序與時間分配 | [docs/stage7-performance.md](../docs/stage7-performance.md) §5 |
| 整體需求、架構決策、各階段驗收標準 | [plan.md](../plan.md) |
| 工作慣例、編程風格、環境注意事項 | [CLAUDE.md](../CLAUDE.md) |
| 各階段實際做了什麼、遇到什麼問題、怎麼解的 | `docs/stage0-validation.md` ～ `docs/stage7-performance.md` |
| 需求編號（FFR/BFR/NFR/EIR/IIR）對應到哪些程式與測試 | [docs/requirements-traceability.md](../docs/requirements-traceability.md) |
| 各子系統的詳細設計與已知限制 | `network/README.md`、`gateway/README.md`、`mocks/README.md`、`web/README.md`、`tests/e2e/README.md`、`tests/perf/README.md` |
