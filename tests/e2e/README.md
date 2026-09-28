# tests/e2e/ — UC-01/02/03 端到端腳本（階段 6）

對應 plan.md §5 階段 6 驗收標準：「UC-01/02/03 端到端腳本一鍵通過」。延續
docs/stage5-gateway-web.md 的建議，以 Node.js 用戶端＋Kyber TLS 設定（比照
`web/api.js` 在真實瀏覽器中的行為）驗證 Gateway REST API，並保留在版本庫中作為
正式回歸測試（而非階段 3／5 用後即刪的驗證腳本）。

## 前提

1. `network/` 已啟動並部署 chaincode：
   ```bash
   cd network
   ./network.sh up
   ./network.sh createChannel
   bash scripts/deployCC.sh
   ```
2. `gateway/` 已啟動（見 `../../gateway/README.md`）：
   ```bash
   cd gateway
   npm run dev
   ```
3. `uc03OemSvcInsLifecycle.mjs`、`eir1MonitoringStation.mjs` 兩支腳本額外需要
   `mocks/` 的模擬服務（見 `../../mocks/README.md`）：
   ```bash
   python3 -m mocks.insurance.app
   python3 -m mocks.monitoring_station.app
   ```

## 執行

```bash
# 一鍵執行全部四個情境（UC-01/02/03 + EIR1）
node tests/e2e/runAll.mjs
# 或：make e2e

# plan_dApp.md D0–D3 驗收腳本（已包含在 runAll.mjs 內，也可單獨執行）
node tests/e2e/dappD0KeyRules.mjs      # 持有證明、覆寫被拒、換鑰、REG 強制重綁
node tests/e2e/dappD1SelfCustody.mjs   # 瀏覽器端簽章上鏈、竄改被拒、備份匯入後簽章
node tests/e2e/dappD2BrowserVerify.mjs # QR 內容定址、瀏覽器端驗章（竄改／過期／冒名皆失敗）
node tests/e2e/dappD3LiveEvents.mjs    # SSE 即時推播里程倒退扣 40 分、強制重綁通知

# D1「關掉 Gateway 錢包仍可運作」：以空的錢包目錄啟動 Gateway 後執行 D0–D3，並檢查目錄仍為空
#   (cd gateway && PQC_WALLET_DIR=/tmp/empty-wallet npx tsx src/index.ts)
EXPECT_EMPTY_WALLET_DIR=/tmp/empty-wallet node tests/e2e/dappD1SelfCustody.mjs

# 真實瀏覽器冒煙測試（Windows PowerShell，headless Edge 操作真正的 owner／buyer 頁）
powershell -NoProfile -ExecutionPolicy Bypass -File tests\e2e\browserSmoke.ps1

# 只執行單一情境
node tests/e2e/uc01AppraiserScoring.mjs
node tests/e2e/uc02BuyerPqcQuery.mjs
node tests/e2e/uc03OemSvcInsLifecycle.mjs
node tests/e2e/eir1MonitoringStation.mjs
```

每支腳本會產生自己專用的測試 VIN（`uniqueVin()`，見 `lib/gatewayClient.mjs`），
重複執行不會互相撞名；但每次執行都會在鏈上留下新的測試車輛與事件，不會自動清除
（Fabric 帳本本就不可竄改／刪除，這是預期行為，非殘留清理疏漏）。

## 涵蓋範圍

| 腳本 | 使用案例／需求 | 涵蓋內容 |
| --- | --- | --- |
| `uc01AppraiserScoring.mjs` | UC-01，BFR3、FFR3 | OEM 初始化 → SVC 保養（里程 50000）→ APP 複檢回報里程倒退（30000）→ 誠信分數 100→60、ANOMALY 事件上鏈；驗證交易不被拒絕（記錄而非拒絕） |
| `uc02BuyerPqcQuery.mjs` | UC-02，FFR1、BFR4、IIR1 | 車主簽署查詢授權 → 買家驗證（合法／偽造簽章）→ GetSummary 延遲量測（NFR2）→ Kyber TLS 握手成功／失敗（BFR4 例外流程） |
| `uc03OemSvcInsLifecycle.mjs` | UC-03，BFR1、BFR2、FFR2、EIR2 | OEM 初始化 → SVC 保養（車主授權簽章）→ 保險公司模擬服務（EIR2）受理理賠並轉送 → RecordClaim 上鏈 |
| `eir1MonitoringStation.mjs` | EIR1（不屬於既定 UC，獨立涵蓋需求追蹤） | 監理站模擬服務受理過戶登記／報廢通知並轉送 → TransferOwnership／ScrapVehicle 上鏈；含「重複報廢應被拒絕」例外流程 |

需求追蹤總覽見 [../../docs/requirements-traceability.md](../../docs/requirements-traceability.md)。

## 已知限制

- 腳本驗證的是 Gateway REST API 層（Node.js 用戶端模擬瀏覽器 TLS 設定），不是
  `web/*.html` 頁面本身在真實瀏覽器中的操作流程——延續 docs/stage5-gateway-web.md
  記錄的既有限制（本工作階段無瀏覽器自動化工具）。
- 不會自動啟動 `network/`／`gateway/`／`mocks/`（PoC 階段刻意保持腳本單純，見
  CLAUDE.md「不過度設計」），需依「前提」章節手動啟動後再執行。
