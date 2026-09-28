# tests/perf/ — Hyperledger Caliper 效能測試（階段 7，NFR2）

對應 plan.md §5 階段 7「用 Hyperledger Caliper 量測 TPS 與查詢延遲」。與
`tests/e2e/`（驗證 Gateway REST API 行為是否正確）不同，這裡刻意繞過 Gateway，
Caliper 透過 `@hyperledger/fabric-gateway` SDK **直接**對五組織網路送出交易，
量測的是鏈本身（含 chaincode 執行、背書、排序、提交）的 TPS 與延遲，不含
Gateway REST 層的額外開銷（該開銷已由 `tests/e2e/uc02BuyerPqcQuery.mjs` 另外
量測，約 10ms）。

## 為什麼獨立一個 npm 工作區

Caliper 本身依賴龐大（`@hyperledger/caliper-cli`／`caliper-core`／`caliper-fabric`
及其綁定的 `@hyperledger/fabric-gateway`），且與 `gateway/`／`tests/e2e/` 的用途
不同，因此獨立一個 `package.json`（比照 `gateway/`、`mocks/` 各自管理相依套件的
既有慣例），不污染其餘工作區。

## 前提

1. `network/` 已啟動並部署 chaincode：
   ```bash
   cd network
   ./network.sh up
   ./network.sh createChannel
   bash scripts/deployCC.sh
   ```
2. `gateway/` 已啟動（僅供步驟 4 的種子資料建立呼叫其內部服務埠 8080，
   見 `../../gateway/README.md`）：
   ```bash
   cd gateway
   npm run dev
   ```
3. 安裝相依套件並綁定 Fabric SDK（`@hyperledger/fabric-gateway@1.7.1`，
   相容 Fabric 2.5.9）：
   ```bash
   cd tests/perf
   npm install
   npm run bind
   ```
4. 建立種子資料（登記測試車主 PQC 金鑰、建立 300 台種子車輛，供多數回合重複
   讀寫；不計入 Caliper 量測時間）：
   ```bash
   npm run seed
   ```
5. 產生 Caliper 的網路連線設定（依目前 `network/organizations/` 的憑證動態產生，
   每次 `network.sh down && up` 重新產生憑證後都要重跑這步）：
   ```bash
   npm run config
   ```

## 執行

```bash
npm run benchmark
```

實際等同：

```bash
npx caliper launch manager \
  --caliper-workspace . \
  --caliper-networkconfig networkConfig.yaml \
  --caliper-benchconfig benchmarkConfig.yaml \
  --caliper-flow-only-test
```

執行完成後，Caliper 會在 `tests/perf/` 下產生 `report.html`（預設檔名），內含
每個回合的 TPS、延遲（最小／最大／平均）、成功率。本專案將該報告的關鍵數據
整理進 [../../docs/stage7-performance.md](../../docs/stage7-performance.md)，
供畢業專題成果發表引用；原始報告與種子資料本身不進版控（見 `.gitignore`，
`report.html`、`setup/seedVehicles.json`、`setup/perfOwnerKey.local.json`、
`networkConfig.yaml` 皆為機器相依或含測試用私鑰的產生物）。

## 回合涵蓋範圍

| 回合 | 鏈碼函式 | 呼叫組織 | 說明 |
| --- | --- | --- | --- |
| `initVehicle` | InitVehicle | OEM | 全新 VIN，不依賴種子資料，無 PQC 驗證，寫入基準對照組 |
| `addMaintenance` | AddMaintenance | SVC | 含 ML-DSA-65 Dilithium 簽章驗證（BFR5），預期是最重的一筆 |
| `recordClaim` | RecordClaim | INS | 無 PQC 驗證，與 addMaintenance 對照「簽章驗證的成本」 |
| `submitInspection` | SubmitInspection | APP | 觸發 BFR3 評分引擎重算（讀取完整事件歷史） |
| `transferOwnership` | TransferOwnership | REG | 觸發 BFR3 評分引擎重算 |
| `getSummary` | GetSummary | 查詢 | 單鍵讀取，NFR2 查詢延遲 |
| `getVehicleHistory` | GetVehicleHistory | 查詢 | 區間查詢，NFR2 查詢延遲 |
| `scrapVehicle` | ScrapVehicle | REG | 每台種子車輛僅報廢一次，**必須是最後一個回合**（見 `benchmarkConfig.yaml` 開頭註解） |

## 已知限制

- 速率控制採 `fixed-load`（維持固定的未完成交易數，見 `benchmarkConfig.yaml`
  註解），量測的是「系統在此併發程度下的實際吞吐量」，不是刻意調校去湊
  plan.md §7 #7 的 50 TPS 參考目標；如實記錄實際測得數值。
- 未納入 Docker 容器資源監控（CPU／記憶體），僅量測交易層級的 TPS 與延遲；
  範圍外項目，見 docs/stage7-performance.md 的已知限制章節。
- `AddMaintenance` 的車主簽章在 workload 模組內就地產生（重用種子資料階段
  複製的測試私鑰，見 `setup/seedData.mjs`），不透過 Gateway 的
  `/maintenance/authorize` 端點，避免額外 HTTP 往返污染量測到的鏈上交易延遲。
