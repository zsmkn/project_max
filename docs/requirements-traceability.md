# 需求追蹤矩陣（完整版）

對應 plan.md §5 階段 6 驗收標準「需求追蹤矩陣補全」。plan.md §6 已列出每項需求對應
的階段與驗證*方式*；本文件補上每項需求對應的*具體*實作位置與測試（檔案／函式／
腳本名稱），並記錄目前狀態，供畢業專題報告直接引用。

圖例：✅ 已有可執行測試且通過｜⚠️ 部分驗證或已知限制｜📄 依文件／架構特性佐證，非
可獨立執行的測試。

## 功能性需求（FFR）

| 需求 | 說明 | 實作 | 測試 | 狀態 |
| --- | --- | --- | --- | --- |
| FFR1 | 履歷查詢 | `gateway/src/routes.ts`（GET summary／history）、`web/buyer.html` | `tests/e2e/uc02BuyerPqcQuery.mjs`；鏈碼 `TestGetVehicleHistory_FiltersByTimeRange_IIR2` | ✅ |
| FFR2 | 身分授權（車主 Dilithium 簽章） | `web/wallet.js`、`web/walletCrypto.js`（瀏覽器自持金鑰，plan_dApp.md D1）、`gateway/src/routes.ts`（託管模式 `/maintenance/authorize`）、`chaincode/vehicle/contract/pqc.go` | 鏈碼 `TestAddMaintenance_TamperedSignature_Rejected_BFR5`／`_WrongSignerKey_Rejected_BFR5`／`_OwnerKeyNotRegistered_Rejected_BFR5`；`tests/e2e/uc01AppraiserScoring.mjs`、`uc03OemSvcInsLifecycle.mjs`（主流程）；`tests/e2e/dappD1SelfCustody.mjs`、`tests/e2e/browserSmoke.ps1`（瀏覽器簽章） | ✅ |
| FFR3 | 複檢發布（鑑定師） | `chaincode/vehicle/contract/contract.go`（`SubmitInspection`） | 鏈碼 `TestSubmitInspection_Success_BFR3_FFR3`；`tests/e2e/uc01AppraiserScoring.mjs` | ✅ |
| FFR4 | 防呆警示（里程倒退紅字鎖定，雙層攔截） | 前端：`web/appraiser.html`；鏈碼：`SubmitInspection`＋`scoring.go`（照常記錄不拒絕） | 鏈碼層：同 FFR3／BFR3 測試（驗證「記錄而非拒絕」）。前端層：**未測試** | ⚠️ 鏈碼層已驗證；前端互動未經瀏覽器自動化測試（延續 docs/stage5-gateway-web.md 的已知限制，本機無瀏覽器自動化工具） |

## 業務功能需求（BFR）

| 需求 | 說明 | 實作 | 測試 | 狀態 |
| --- | --- | --- | --- | --- |
| BFR1 | 資產初始化（VIN＋零件雜湊綁定） | `contract.go`（`InitVehicle`） | 鏈碼 `TestInitVehicle_Success_BFR1`／`_WrongOrg_Rejected_BFR1`／`_DuplicateVIN_Rejected_BFR1`／`_DuplicatePartHash_Rejected_BFR1`；`tests/e2e/uc01/uc02/uc03/eir1` 皆以 InitVehicle 起始 | ✅ |
| BFR2 | 生命週期（保養／理賠／過戶／報廢） | `contract.go`（`AddMaintenance`／`RecordClaim`／`TransferOwnership`／`ScrapVehicle`） | 鏈碼 `TestAddMaintenance_*`／`TestRecordClaim_*`／`TestTransferOwnership_Success_BFR2`／`TestScrapVehicle_*`；`tests/e2e/uc01`（保養）、`uc03`（保養＋理賠）、`eir1MonitoringStation.mjs`（過戶＋報廢，含重複報廢例外流程） | ✅ |
| BFR3 | 動態誠信評分與折舊引擎 | `chaincode/vehicle/contract/scoring.go`、`scoring_config.json` | 鏈碼 `scoring_test.go`（39 項，涵蓋三種扣分規則與殘值公式）；`tests/e2e/uc01AppraiserScoring.mjs`（真實網路：100→60、ANOMALY 上鏈） | ✅（零件重複規則的純函式已測試，但鏈碼呼叫端因 `bindPart` 直接拒絕重複零件雜湊而未接上，見 docs/stage4-scoring.md 已知限制，非本階段範圍） |
| BFR4 | Kyber TLS 邊界 | `gateway/src/server.ts` | `tests/e2e/uc02BuyerPqcQuery.mjs`（握手成功／`prime256v1` 握手失敗） | ✅（API 層）；瀏覽器相容性未測試，見 IIR1 |
| BFR5 | Dilithium（ML-DSA-65）簽章驗證 | `chaincode/vehicle/contract/pqc.go`、`gateway/src/pqcWallet.ts` | 鏈碼 `TestRegisterPQCKey_*`（含 D0 持有證明、覆寫被拒、換鑰防重放）、`TestForceRebindPQCKey_*`、`TestAddMaintenance_TamperedSignature_Rejected_BFR5` 等；`gateway/src/pqcWallet.test.ts`；`tests/e2e/dappD0KeyRules.mjs`；`tests/e2e` 各腳本皆走過註冊＋簽章主流程 | ✅ |

## 非功能性需求（NFR）

| 需求 | 說明 | 實作／證據 | 測試 | 狀態 |
| --- | --- | --- | --- | --- |
| NFR1 | 抗量子（長期安全性） | PQC 範圍見 plan.md §2 #1、#2（雙層簽章＋邊界 Kyber TLS） | 依範圍說明佐證（BFR4、BFR5 已驗證的部分即 NFR1 的可執行範圍） | 📄 |
| NFR2 | 效能（查詢延遲、TPS） | `gateway/` REST API；`chaincode/vehicle`（Caliper 直接量測交易層） | `tests/e2e/uc02BuyerPqcQuery.mjs` 斷言 GetSummary 延遲 < 1000ms（實測約 10ms）；`tests/perf/`（Hyperledger Caliper，8 回合、1650 筆交易，見 docs/stage7-performance.md §2） | ✅ 寫入 TPS 約 12～17（低於 §7 #7 的 50 TPS 參考目標，如實記錄）；查詢 TPS 269～404，延遲 < 50ms |
| NFR3 | 容錯（節點斷線仍可寫入） | `network/` Raft／多 peer | `network/scripts/faultToleranceTest.sh`（stage 1，channel 設定交易初驗）；`network/scripts/faultToleranceTestFull.sh`（階段 7，真實 `RecordClaim` 交易，多重故障＋容錯邊界外預期失敗＋復原，見 docs/stage7-performance.md §3） | ✅ 6 項情境全數符合預期，含「超出容錯邊界應失敗」的邊界驗證 |
| NFR4 | 不可竄改 | Fabric 帳本本身的機制（非鏈碼邏輯） | 帳本歷史可完整查驗：`TestGetVehicleHistory_FiltersByTimeRange_IIR2`、`tests/e2e` 各腳本的 GetVehicleHistory 斷言 | 📄 由 Fabric 帳本架構保證，非額外可測試的業務邏輯 |

## 外部介面需求（EIR）

| 需求 | 說明 | 實作 | 測試 | 狀態 |
| --- | --- | --- | --- | --- |
| EIR1 | 監理站外部介面模擬 | `mocks/monitoring_station/`（`mapping.py`、`app.py`） | `mocks/monitoring_station/test_mapping.py`（欄位轉換純函式）；`tests/e2e/eir1MonitoringStation.mjs`（真實網路：過戶＋報廢＋重複報廢例外流程） | ✅ |
| EIR2 | 保險公司外部介面模擬 | `mocks/insurance/`（`mapping.py`、`app.py`） | `mocks/insurance/test_mapping.py`；`tests/e2e/uc03OemSvcInsLifecycle.mjs`（真實網路，經模擬服務轉送理賠） | ✅ |
| EIR3 | Root CA（Fabric CA 核發身分） | `network/organizations/fabric-ca/registerEnroll.sh`、`network/network.sh up` | 隱含驗證：五組織＋排序組織身分皆由 Fabric CA 簽發且可正常連線／背書（docs/stage1-network.md；本階段重新啟動網路時再次確認 `peer channel list`／`querycommitted` 正常） | ✅ |

## 內部介面需求（IIR）

| 需求 | 說明 | 實作 | 測試 | 狀態 |
| --- | --- | --- | --- | --- |
| IIR1 | Gateway ↔ 用戶端的 Kyber TLS | `gateway/src/server.ts` | 同 BFR4：`tests/e2e/uc02BuyerPqcQuery.mjs` | ✅（API 層）；真實瀏覽器未測試，見已知限制 |
| IIR2 | 履歷區間查詢 | `contract.go`（`GetVehicleHistory` 的 from／to 篩選） | 鏈碼 `TestGetVehicleHistory_FiltersByTimeRange_IIR2`；`gateway/src/routes.ts` 的 `?from=&to=` | ✅ |
| IIR3 | 評分／折舊內部觸發（寫入函式觸發重算） | `scoring.go`（`recalcAndApply`，由 `AddMaintenance`／`RecordClaim`／`SubmitInspection`／`TransferOwnership`／`ScrapVehicle` 呼叫） | 鏈碼 `TestRecalculate_*`；`tests/e2e/uc01AppraiserScoring.mjs`（複檢自動觸發重算） | ✅ |

## 使用案例（UC）

| 使用案例 | 涵蓋需求 | 端到端腳本 | 狀態 |
| --- | --- | --- | --- |
| UC-01 鑑定師複檢與動態扣分 | BFR3、FFR3、FFR4（鏈碼層） | `tests/e2e/uc01AppraiserScoring.mjs`；扣分即時通知車主：`tests/e2e/dappD3LiveEvents.mjs`（plan_dApp.md D3） | ✅ 真實五組織網路驗證通過 |
| UC-02 買家查詢與 PQC 連線 | FFR1、BFR4、IIR1、plan.md §7 #10 | `tests/e2e/uc02BuyerPqcQuery.mjs`；買家瀏覽器端驗章：`tests/e2e/dappD2BrowserVerify.mjs`（plan_dApp.md D2） | ✅ 真實五組織網路驗證通過 |
| UC-03 車廠初始化與理賠存證 | BFR1、BFR2、FFR2、EIR2 | `tests/e2e/uc03OemSvcInsLifecycle.mjs` | ✅ 真實五組織網路驗證通過 |

`node tests/e2e/runAll.mjs`（或 `make e2e`）一鍵執行 UC-01／02／03＋EIR1，四個情境
於 2026-09-23 在真實五組織網路（`vehicle@1.4`，sequence 5）上全數通過，詳見
[stage6-integration.md](stage6-integration.md)。

## 未涵蓋／延後項目彙總

- **FFR4 前端互動**：鑑定師頁的紅字警示與鎖定送出尚未以真實瀏覽器自動化驗證。
  UC-01（扣分通知）／UC-02（買家驗章）的瀏覽器操作流程已於 2026/09/24 以 headless Edge 153
  實測通過（`tests/e2e/browserSmoke.ps1`，見 docs/dapp.md §6）；Firefox／Safari 未測。
- **NFR1**：屬範圍聲明性質（plan.md §2），其可執行部分已由 BFR4／BFR5 覆蓋，
  沒有獨立於兩者之外的「抗量子」測試項目。
- **NFR2／NFR3 已於階段 7 完成**（見上表與 docs/stage7-performance.md）；未涵蓋
  部分（不同併發程度的 TPS 曲線、2 個 Raft 節點同時故障等更極端情境）記錄於該
  文件 §6 已知限制。
