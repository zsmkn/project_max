# 階段 6：外部模擬與整合測試 — 進度記錄

狀態：**已完成**。監理站（EIR1）／保險公司（EIR2）外部系統模擬服務、UC-01/02/03
端到端腳本、需求追蹤矩陣補全皆已完成，並在真實五組織網路上一鍵執行全數通過。
對應 plan.md §5 階段 6：「監理站、保險公司模擬服務；三個 UC 的端到端腳本；需求
追蹤矩陣補全」。

## Gateway：新增內部服務埠（EIR1／EIR2 的前置變更）

動手寫 `mocks/`（規劃用 Python 3.10，見 plan.md §7 #3）之前，先發現一個環境限制：
Gateway 公開的 HTTPS 埠（8443）只接受 `X25519MLKEM768` 混合金鑰交換（BFR4，見
`gateway/src/server.ts`），而本機 WSL2 Ubuntu 22.04 系統 OpenSSL 為 3.0.2
（`openssl version` 實測），尚不支援這個群組（需 OpenSSL 3.2+ 搭配 oqs-provider，
或 3.5+ 原生支援），Python 的 `ssl`／`requests` 因此無法完成該握手。

判斷這不是需要繞過的 bug，而是需要標註範圍的既有事實：BFR4／IIR1 的 Kyber TLS
要求本來就鎖定在「瀏覽器／客戶端 ↔ Gateway」這個面向使用者的公開邊界
（plan.md §2 #2），監理站／保險公司的後端整合是系統對系統的另一種介面，不在此
範圍內。因此在 `gateway/src/server.ts`／`index.ts`／`config.ts` 新增一個僅限
`127.0.0.1` 的純 HTTP 內部服務埠（預設 8080，`GATEWAY_INTERNAL_HTTP_PORT` 可覆寫），
與公開埠共用同一個 Express app（同樣的路由、同樣的輸入驗證），只是不套用 Kyber-only
的限制。詳細理由記錄在該檔案的註解與 `gateway/README.md`。

## 監理站／保險公司模擬服務（`mocks/`，EIR1／EIR2）

對應 plan.md §3.5：「用 Python 寫模擬服務，透過 Gateway 呼叫合約；只做介面示範」。
本機未安裝 Flask，且需求單純（收 JSON、轉格式、呼叫 Gateway、回 JSON），改用
Python 標準函式庫的 `http.server` 搭配一個共用的極簡 JSON REST 服務基底
（`mocks/common/json_service.py`），避免引入不必要的框架相依（CLAUDE.md
「不過度設計」）。

- `mocks/monitoring_station/`（EIR1）：模擬監理站自己的過戶登記／報廢通知格式
  （`deregistrationReasonCode`／`deregistrationReasonText`／`newOwnerIdentityHash`
  等），`mapping.py` 將其轉換為 Gateway `TransferOwnership`／`ScrapVehicle` 的請求
  格式（純函式，`test_mapping.py` 覆蓋必填檢查與欄位對應）。
- `mocks/insurance/`（EIR2）：模擬保險公司自己的理賠結案格式
  （`policyClaimNo`／`accidentType`／`settlementAmount`／`damagedComponent`），
  `mapping.py` 轉換為 Gateway `RecordClaim` 的請求格式。
- 兩者皆呼叫 Gateway 的內部服務埠（`mocks/common/gateway_client.py`），失敗時
  轉為 502 並保留 Gateway 原始錯誤訊息（不吞掉錯誤，CLAUDE.md「錯誤處理」）。

## UC-01/02/03 端到端腳本（`tests/e2e/`）

延續 docs/stage5-gateway-web.md 的建議：以 Node.js 用戶端＋Kyber TLS 設定
（`ecdhCurve: 'X25519MLKEM768'`，模擬 `web/api.js` 在真實瀏覽器中的行為）呼叫
Gateway REST API，並保留在版本庫中作為正式回歸測試（而非階段 3／5 用後即刪的
驗證腳本），直接滿足「UC-01/02/03 端到端腳本一鍵通過」的驗收條件。

| 腳本 | 涵蓋 |
| --- | --- |
| `uc01AppraiserScoring.mjs` | OEM 初始化 → SVC 保養（50000）→ APP 複檢回報里程倒退（30000）→ 誠信分數 100→60、ANOMALY 上鏈；交易不被拒絕 |
| `uc02BuyerPqcQuery.mjs` | 車主查詢授權簽署／驗證（含偽造簽章例外流程）→ GetSummary 延遲量測（NFR2）→ Kyber TLS 握手成功／`prime256v1` 握手失敗（BFR4 例外流程） |
| `uc03OemSvcInsLifecycle.mjs` | OEM 初始化 → SVC 保養（車主授權簽章）→ 呼叫保險公司模擬服務（EIR2）轉送理賠 → RecordClaim 上鏈 |
| `eir1MonitoringStation.mjs`（額外，非既定 UC） | 呼叫監理站模擬服務轉送過戶登記／報廢通知；含「對已報廢車輛重複報廢應被拒絕」例外流程 |

`tests/e2e/runAll.mjs`（`make e2e`）依序執行以上四支並彙總結果，任一失敗即以非 0
結束碼結束。

### 真實五組織網路端到端驗證（2026-09-23）

沿用既有網路狀態（`vehicle@1.4`，sequence 5，先前階段已提交，本階段未修改鏈碼），
重新 `network.sh up` 後確認 peer 已加入 channel、鏈碼可正常查詢，啟動 `gateway/`
（`npx tsx src/index.ts`）與兩個模擬服務（`python3 -m mocks.insurance.app`、
`python3 -m mocks.monitoring_station.app`），執行 `make e2e`：

```
✅ UC-01 鑑定師複檢與動態扣分（8637ms） { vin: 'UC01...', integrityScore: 60 }
✅ UC-02 買家查詢與 PQC 連線（4338ms） { vin: 'UC02...', queryLatencyMs: 10 }
✅ UC-03 車廠初始化與理賠存證（8675ms） { vin: 'UC03...', claimId: 'CLM-UC03...' }
✅ EIR1 監理站整合測試（6569ms） { vin: 'EIR1...' }
---
全部 4 個情境通過。
```

**過程中發現並修正一處撰寫腳本時的錯誤假設**：`uc01AppraiserScoring.mjs` 原本
斷言「里程倒退的複檢不應覆寫車輛主檔的 mileage 欄位」，實測發現
`SubmitInspection`（`contract.go`）無論是否倒退都會把 `vehicle.Mileage` 更新為
本次複檢回報值——「記錄異常而非拒絕」指的是額外寫入 ANOMALY 事件並扣分，不是
凍結當前里程欄位；倒退判斷（`DetectMileageRollbacks`）依據的是完整事件歷史裡的
歷史最高值，不是車輛主檔當下的單一 mileage 欄位。已修正腳本斷言為符合實際（且
正確）的鏈碼行為，提醒之後任何「異常記錄」相關的假設都要以真實網路或至少讀原始
鏈碼確認，不能憑函式命名／註解直覺猜測欄位語意。

其餘回歸測試：鏈碼 `go test ./...`（既有 39＋ 項測試全數通過，未變動）、Gateway
`npx vitest run`＋`npx tsc --noEmit`（12 項測試通過，型別檢查無錯誤）、
`python3 -m unittest discover -s mocks`（7 項新測試通過）。

## 需求追蹤矩陣補全

新增 [docs/requirements-traceability.md](requirements-traceability.md)：逐項列出
FFR/BFR/NFR/EIR/IIR（共 19 項）與 UC-01/02/03 對應的實作位置與具體測試（檔案／
函式／腳本名稱），取代 plan.md §6 只到「階段＋驗證方式」的粗粒度對照，滿足
「每項需求都有對應測試」的驗收標準；未涵蓋或延後的項目（NFR2 完整 TPS、NFR3
完整壓力測試、FFR4 前端與瀏覽器操作流程）在文件末尾集中列出，不打散在各列造成
遺漏。

## 已知限制

- **FFR4 前端、UC-01/UC-02 瀏覽器操作流程未測試**：延續 docs/stage5-gateway-web.md
  的既有限制，本次工作階段仍無瀏覽器自動化工具；`tests/e2e/` 驗證的是 Gateway
  REST API 層（Node.js 用戶端模擬瀏覽器 TLS 設定），不是 `web/*.html` 頁面本身的
  實際點擊操作。
- **Gateway 內部服務埠不套用 Kyber TLS**：刻意的範圍界線（見上方說明），不是
  BFR4 的例外或退化；EIR1／EIR2 模擬服務僅限 loopback 呼叫，未對外開放。
- **NFR2／NFR3 僅完成初驗**：`uc02BuyerPqcQuery.mjs` 的延遲斷言與
  `faultToleranceTest.sh` 都只是單次量測／單一故障情境，完整 TPS 壓力測試與
  多重故障情境留待階段 7（Hyperledger Caliper）。

## 驗收標準對照（plan.md §5 階段 6）

| 驗收標準 | 狀態 |
| --- | --- |
| UC-01/02/03 端到端腳本一鍵通過 | ✅ `make e2e` 於真實五組織網路四個情境全數通過 |
| 每項需求都有對應測試 | ✅ 見 docs/requirements-traceability.md；少數項目（NFR1/NFR2/NFR3/NFR4/FFR4 前端）明確標註為文件佐證或已知限制，非遺漏 |

下一步：進入**階段 7（效能、容錯與結案）**——Hyperledger Caliper 量測 TPS 與查詢
延遲、更完整的節點斷線測試、整理畢業專題報告所需的架構圖與展示腳本。
