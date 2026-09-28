# 快速開始

從一台**已裝好環境**的機器啟動整套系統、確認能跑，約 10 分鐘。
環境還沒裝好（Docker／Fabric／Go／Node／Python）請先做 [src/SETUP.md](src/SETUP.md) §0，
那份也收錄了完整的指令、版本鎖定原因與環境陷阱速查表。

所有指令都在 **WSL2 Ubuntu 22.04** 內執行。專案放在 Windows 檔案系統（`/mnt/c/...`）沒問題，
但 Docker、Fabric 二進位檔、Go、Node.js 必須裝在 WSL 內。

## 0. 三十秒環境自檢

```bash
docker version --format '{{.Server.Version}}'   # 必須是 25.0.5（26+ 會讓 chaincode 安裝失敗）
node --version                                   # v22+
node -p 'process.versions.openssl'               # >= 3.5（Kyber TLS 需要）
go version                                       # 1.22+
ls ~/fabric/fabric-samples/bin                   # peer / orderer / configtxgen / fabric-ca-client …
```

有任何一項對不上，先回 [src/SETUP.md](src/SETUP.md) §0，不要硬跑下去。

## 1. 啟動聯盟鏈並部署合約

```bash
cd network
./network.sh up             # 6 個 CA、簽發憑證、3 個 Raft 排序節點 + 5 peer + 5 CouchDB
./network.sh createChannel  # 建立 vehiclechannel，五組織加入並設定 anchor peer
bash scripts/deployCC.sh    # 封裝／安裝／核准／提交 chaincode/vehicle（首次約數分鐘）
```

三個指令都是冪等的，重跑安全；要完全重來先 `./network.sh down`。

## 2. 啟動 Gateway（另開一個終端機）

```bash
cd gateway
npm install
cp .env.example .env    # 預設值即對應本機五組織網路，通常不必改

mkdir -p certs          # 自簽 TLS 憑證，只需產生一次
openssl req -x509 -newkey rsa:2048 -keyout certs/gateway-key.pem \
  -out certs/gateway-cert.pem -days 365 -nodes -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

npm run dev
```

啟動後有兩個埠：`https://localhost:8443`（公開，只接受 Kyber 混合金鑰交換）、
`http://127.0.0.1:8080`（僅限本機，供模擬服務與效能測試呼叫）。

## 3. 啟動外部系統模擬服務（各開一個終端機）

```bash
cd project_max
pip install -r mocks/requirements.txt
python3 -m mocks.monitoring_station.app   # 監理站（EIR1），http://127.0.0.1:9001
python3 -m mocks.insurance.app            # 保險公司（EIR2），http://127.0.0.1:9002
```

## 4. 啟動網頁介面

```bash
cd web
python3 -m http.server 8000   # 不要用 8080，會與 Gateway 內部服務埠衝突
```

開 `http://localhost:8000/owner.html`（車主）／`buyer.html`（買家）／`appraiser.html`（鑑定師）。

**首次使用前**先在瀏覽器分頁直接開 `https://localhost:8443/api/vehicles/x/summary`，
手動接受一次自簽憑證警告，否則頁面的請求會被瀏覽器擋掉。

## 5. 驗證整套系統可用

```bash
cd project_max
make e2e
```

UC-01／UC-02／UC-03＋EIR1 四個情境全數通過，就代表部署成功。

## 收拾

先在各終端機 `Ctrl+C` 停掉 web／mocks／gateway，最後關閉網路：

```bash
cd network && ./network.sh down   # 清除所有容器、volume、憑證與 channel artifacts
```

## 卡住了？

| 症狀 | 對策 |
| --- | --- |
| chaincode 安裝失敗，`broken pipe` | Docker Engine 版本太新，降回 25.0.5（[src/SETUP.md](src/SETUP.md) §0.3） |
| 容器突然全部消失 | WSL2 閒置逾時關掉整個發行版，見 [src/SETUP.md](src/SETUP.md) §0.7 |
| `curl`／Python 連 8443 握手失敗 | 設計行為：公開埠只收 `X25519MLKEM768`，系統對系統請改用 `127.0.0.1:8080` |
| `python3 -m http.server 8080` 說埠被佔用 | 改用 8000，8080 是 Gateway 內部服務埠 |

其餘症狀見 [src/SETUP.md](src/SETUP.md) §10 的完整速查表。

## 想再深入

| 想了解什麼 | 看哪裡 |
| --- | --- |
| 完整安裝、各模組指令、lint、效能測試 | [src/SETUP.md](src/SETUP.md) |
| 需求理解、架構決策、階段規劃 | [plan.md](plan.md) |
| 各階段實作紀錄與踩過的坑 | [docs/](docs/) |
| 成果發表的建議展示順序 | [docs/stage7-performance.md](docs/stage7-performance.md) §5 |
