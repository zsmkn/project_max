# mocks/ — 監理站／保險公司外部系統模擬（階段 6，EIR1／EIR2）

對應 plan.md §3.5：「EIR1 監理站、EIR2 保險公司：用 Python 寫模擬服務，透過
Gateway 呼叫合約；只做介面示範」。**不對接真實監理站／保險公司系統**（CLAUDE.md
「非目標」）——這裡示範的是「若真的要對接，介面長什麼樣子」，而非真實整合。

## 設計

每個模擬服務代表一個外部系統自己既有的業務 API（欄位名稱、資料格式與本系統不同），
收到請求後：

1. 驗證必填欄位（純函式，見各自的 `mapping.py`，有對應單元測試）。
2. 轉換成 Gateway REST API 期望的請求格式。
3. 呼叫 Gateway 的**內部服務埠**（`http://127.0.0.1:8080`，見
   `../gateway/src/server.ts`）送出交易。

```
mocks/
├── common/
│   ├── gateway_client.py   # 呼叫 Gateway 內部服務埠的共用用戶端
│   └── json_service.py     # 極簡 JSON REST 服務基底（標準函式庫，無框架相依）
├── monitoring_station/     # EIR1：監理站
│   ├── mapping.py          # 報廢通知／過戶登記通知 → Gateway 請求格式
│   ├── app.py               # 對外暴露 /scrap-notices、/transfer-notices
│   └── test_mapping.py
└── insurance/               # EIR2：保險公司
    ├── mapping.py          # 理賠結案通知 → Gateway 請求格式
    ├── app.py               # 對外暴露 /claim-settlements
    └── test_mapping.py
```

### 為什麼呼叫 Gateway 的內部服務埠（非公開的 8443 埠）

Gateway 公開的 HTTPS 埠（8443）只接受 `X25519MLKEM768` 混合金鑰交換
（BFR4，見 `../gateway/src/server.ts`）。本機 WSL2 Ubuntu 22.04 的系統 OpenSSL
（3.0.2）尚不支援這個群組，Python 的 `ssl`／`requests` 因此無法完成該握手
（`openssl version` 可自行確認）。BFR4／IIR1 的 Kyber TLS 要求原本就鎖定在
「瀏覽器／客戶端 ↔ Gateway」這個面向使用者的公開邊界（plan.md §2 #2），監理站／
保險公司的後端整合不在此範圍內，因此 Gateway 另外開了一個僅限 loopback 的純
HTTP 內部埠（8080）供這類系統對系統整合使用，業務路由與公開埠相同（另外多一個僅限監理站
使用的 PQC 金鑰強制重綁端點，見 gateway/README.md）。

## 執行

```bash
# 前提：network/ 已啟動並部署 chaincode，gateway/ 已啟動（npm run dev）
cd project_max
python3 -m venv .venv && source .venv/bin/activate   # 可選，不想污染系統 Python 時使用
pip install -r mocks/requirements.txt

python3 -m mocks.monitoring_station.app   # 監聽 http://127.0.0.1:9001
python3 -m mocks.insurance.app            # 監聽 http://127.0.0.1:9002
```

## API

### 監理站模擬服務（EIR1，預設埠 9001）

| 方法 | 路徑 | body（模擬監理站原始格式） | 轉送至 Gateway |
| --- | --- | --- | --- |
| POST | `/scrap-notices` | `{vin, deregistrationReasonCode, deregistrationReasonText, officerId?}` | `POST /api/vehicles/:vin/scrap`（REG，`ScrapVehicle`，BFR2、EIR1） |
| POST | `/transfer-notices` | `{vin, newOwnerIdentityHash, officerId?}` | `POST /api/vehicles/:vin/transfer`（REG，`TransferOwnership`，BFR2） |

### 保險公司模擬服務（EIR2，預設埠 9002）

| 方法 | 路徑 | body（模擬保險公司原始格式） | 轉送至 Gateway |
| --- | --- | --- | --- |
| POST | `/claim-settlements` | `{vin, policyClaimNo, accidentType, settlementAmount, damagedComponent}` | `POST /api/vehicles/:vin/claims`（INS，`RecordClaim`，BFR2、EIR2） |

## 測試

```bash
cd project_max
python3 -m unittest discover -s mocks -p "test_*.py"
```

`mapping.py` 的欄位轉換／必填驗證邏輯為純函式，測試不需要啟動 Gateway 或
Fabric 網路；`app.py` 的 HTTP 轉送邏輯已在真實五組織網路上以
`tests/e2e/uc03OemSvcInsLifecycle.mjs` 間接驗證過對應鏈碼函式的行為（見
`../docs/stage6-integration.md`）。
