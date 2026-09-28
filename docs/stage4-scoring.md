# 階段 4：評分引擎 — 進度記錄

狀態：**已完成**。誠信評分與折舊純函式、參數化設定檔、由寫入函式觸發重算、
里程倒退異常記錄（BFR3、IIR3、UC-01）皆已實作、單元測試通過，並在真實五組織網路上
以 `vehicle@1.4`（sequence 5）驗證通過。
對應 plan.md §5 階段 4：「評分與殘值純函式、參數表、由寫入函式觸發（BFR3、IIR3）；
里程倒退異常紀錄」。

## 新增：`SubmitInspection`（第三方鑑定中心複檢）

stage 2／3 尚未實作 plan.md §3.1 列出的 `SubmitInspection` 函式（APP 組織提交複檢結果）。
UC-01「鑑定師複檢與動態扣分」的例外流程明確以此函式為觸發點（plan.md §5 階段 4 驗收：
「UC-01 例外流程扣 40 分並上鏈」），且 plan.md §6 需求追蹤將 FFR3 對應到階段 5、但本階段
的驗收標準直接點名 UC-01，因此判斷 `SubmitInspection` 屬於階段 4 範圍，一併實作：

- 呼叫者須為 APP（`requireOrg`）。
- 回報里程若低於鏈上已知最高里程，**不拒絕交易**（CLAUDE.md「異常要記錄而不是拒絕」）：
  照常寫入 `INSPECTION` 事件、如實更新車輛主檔里程，並觸發評分引擎重算。
- 背書政策：`AND(APP, OutOf(1, REG, INS))`，對應 plan.md §3.3。

## 評分引擎（`chaincode/vehicle/contract/scoring.go`）

### 參數化設定檔

`scoring_config.json` 以 `go:embed` 內嵌進鏈碼二進位檔（`ScoringConfig`／
`ResidualValueConfig` 結構對應 plan.md §3.4 的全部數值）。選擇 `go:embed` 而非執行期讀取
外部檔案路徑，是因為鏈碼打包成單一 Go 二進位檔、所有背書節點執行同一份映像檔，
內嵌設定檔在所有 peer 上必定一致，不會破壞鏈碼決定性；調整參數只需改 JSON 檔並以新版本
（`CC_VERSION`／`CC_SEQUENCE`）重新部署，數值不散落在業務邏輯各處（CLAUDE.md「給 Claude
的工作方式」：數值放設定檔）。

### 三種扣分規則（純函式，`ScoringConfig` 可注入，方便單元測試）

| 函式 | 規則 | 觸發資料 |
| --- | --- | --- |
| `DetectMileageRollbacks` | 里程倒退，扣 40 分 | 掃描 INIT／MAINTENANCE／INSPECTION 事件，找出回報里程低於歷史最高值的事件 |
| `DetectClaimsWithoutMaintenance` | 有理賠卻無維修證明，扣 20 分 | 理賠事件滿 30 天觀察期後，該期間內查無 MAINTENANCE 事件 |
| `DetectDuplicatePartUsage` | 零件序號重複出現，扣 30 分 | 零件雜湊 → 綁定 VIN 清單的索引 |

以及 `ComputeResidualValue`（plan.md §3.4 殘值公式：原廠售價 × 車齡係數 × 里程係數 ×
誠信係數，三係數皆有下限）與 `Recalculate`（彙整三種規則、依 `alreadyRecorded` 去重、
計算最終分數與殘值）。

**已知限制**：`DetectDuplicatePartUsage` 未接上鏈碼呼叫端。原因：stage 2 的 `bindPart`
（`contract.go`）對零件雜湊重複綁定採取「直接拒絕交易」，是本專案防止贓車與零件拼裝的核心
機制，交易在寫入當下就被擋下，不會產生「兩輛車共用同一零件」的鏈上狀態供評分引擎事後偵測。
函式本身與其單元測試皆已備妥（`TestDetectDuplicatePartUsage_*`），若日後調整 `bindPart`
政策可直接沿用。此限制屬於 stage 2 已定案的設計取捨（見 docs/stage2-chaincode.md），
本階段不重新設計背書／綁定機制。

### 重算觸發（`recalcAndApply`）

`AddMaintenance`、`RecordClaim`、`SubmitInspection`、`TransferOwnership`、`ScrapVehicle`
五個寫入函式在寫入各自業務事件後皆呼叫 `recalcAndApply`：重新計算誠信分數與殘值、寫回
車輛主檔，並將新偵測到、尚未記錄過的異常寫成 `EVT:{vin}:...:A{n}`（`EventTypeAnomaly`）
事件，`anomalyDedupeKey`（異常類型＋觸發交易 ID）確保同一異常不會因為之後其他交易觸發重算
而被重複寫入。

**真實網路除錯發現、推翻原始假設**：實作之初假設 Fabric chaincode 交易內「讀自己剛寫入」
的行為（`GetState` 具備此特性、stage 2 的 `bindPart` 已依賴）對 `GetStateByRange`
同樣成立，因此原本讓 `recalcAndApply` 直接呼叫 `getEventHistory`（`GetStateByRange`）
取得含「本次交易剛寫入的業務事件」的完整歷史。以此邏輯首次部署至真實五組織網路
（`vehicle@1.3`）測試 UC-01 時，`SubmitInspection` 的 `INSPECTION` 事件成功寫入、但
`GetVehicleHistory` 只看到 3 筆事件（無 `ANOMALY`）、`GetSummary` 的 `integrityScore`
仍是 100——實測證實 `GetStateByRange` **不會**合併同一筆交易內尚未提交的 `PutState`
寫入，與單鍵 `GetState` 的行為不同。修正：`recalcAndApply` 改為接收呼叫端剛建立的
`newBusinessEvent` 參數，讀回歷史後手動將其併入清單（並以 TxID 去重，防止不同執行環境
下重複計入），不再單靠重新查詢取得完整歷史。以 `vehicle@1.4`（sequence 5）重新部署後，
真實網路端到端驗證通過（見下方「驗收」）。若沒有在真實網路（而非只在記憶體 mock 測試）
驗證，這個問題不會被發現——mock 測試環境（`testLedger`，見 `contract_test.go`）以扁平
map 模擬世界狀態，天生就有「讀自己剛寫入」的效果，掩蓋了這個落差，這也是本次除錯後補回
`TestSubmitInspection_RollbackRecalcIsIdempotent_BFR3` 等測試時同步發現並修正 mock 與
真實行為落差的原因（見下方測試小節）。

## 單元測試

`chaincode/vehicle/contract/scoring_test.go`（純函式，21 個測試）與
`contract_test.go` 新增的整合測試（透過 `testLedger` 走完整合約流程）：

```
TestDetectMileageRollbacks_NoRollback_NoAnomaly_BFR3
TestDetectMileageRollbacks_Rollback_DeductsScore_BFR3
TestDetectMileageRollbacks_MultipleRollbacks_EachDeductsSeparately_BFR3
TestDetectClaimsWithoutMaintenance_HasMaintenanceWithinWindow_NoAnomaly_BFR3
TestDetectClaimsWithoutMaintenance_NoMaintenanceAfterWindow_DeductsScore_BFR3
TestDetectClaimsWithoutMaintenance_WithinWindow_NotYetJudged_BFR3
TestDetectClaimsWithoutMaintenance_MaintenanceBeforeClaim_StillDeducts_BFR3
TestDetectDuplicatePartUsage_SharedHash_DeductsScore_BFR3
TestDetectDuplicatePartUsage_NotInvolved_NoAnomaly_BFR3
TestComputeResidualValue_Formula_BFR3
TestComputeResidualValue_CoefficientsFloorAtMinimum_BFR3
TestRecalculate_DeductsForEachDistinctAnomaly_BFR3
TestRecalculate_AlreadyRecordedAnomaly_NotDuplicated_BFR3
TestRecalculate_ScoreFloorsAtMinScore_BFR3
TestSubmitInspection_Success_BFR3_FFR3
TestSubmitInspection_WrongOrg_Rejected_BFR3
TestSubmitInspection_MileageRollback_DeductsScore_BFR3   （UC-01 例外流程）
TestSubmitInspection_RollbackRecalcIsIdempotent_BFR3
TestRecordClaim_NoMaintenanceAfterWindow_DeductsScore_BFR3
TestRecordClaim_MaintenanceWithinWindow_NoDeduction_BFR3
```

`go test ./...`、`go vet ./...`、`gofmt -l`（不含 vendor）全數通過（39 個測試）；
真實 `fabric-ccenv:2.5.9` 容器內建置成功（延續 stage 0／2／3 的驗證模式）。

## 真實五組織網路端到端驗證（UC-01）

以 `network/scripts/demoStage4.sh`（比照 `demoStage2.sh` 的 CLI 展示模式）在既有五組織
網路上部署 `vehicle@1.4`（sequence 5）並執行：

1. `InitVehicle`（OEM+REG 背書）→ 成功。
2. `RegisterPQCKey`（車主公鑰；此鍵無專屬 SBE，需符合鏈碼層級預設政策
   `OutOf(2, 五組織)`，示範腳本首次撰寫時背書組織數不足導致
   `ENDORSEMENT_POLICY_FAILURE`，修正為兩個組織背書後成功——記錄於此，
   提醒日後呼叫未設定 SBE 的鍵值時背書組織數量需求）。
3. `AddMaintenance`（SVC，里程 50000，車主 ML-DSA-65 簽章授權）→ 成功。
4. `GetSummary` 確認複檢前 `integrityScore: 100`。
5. `SubmitInspection`（APP，複檢里程 30000，低於歷史最高 50000）→ **交易成功**（不拒絕）。
6. `GetSummary` 確認複檢後 `integrityScore: 60`、`mileage: 30000`、`residualValue` 隨新
   里程與分數重新計算。
7. `GetVehicleHistory` 確認事件序列為 INIT／MAINTENANCE／INSPECTION／**ANOMALY**
   （`anomalyType: MILEAGE_ROLLBACK`、`scoreDelta: -40`、`relatedTxId` 等於觸發它的
   `SubmitInspection` 交易 ID）。

腳本以 `jq` 斷言分數、里程、異常事件內容，非僅檢查交易是否成功；`demoStage4.sh` 執行後
`exit 0`。此腳本用後保留在 `network/scripts/`（非用後即刪的臨時工具），供之後階段
（例如階段 7 效能／容錯測試）重複使用。過程中另外寫了一個一次性的 PQC 金鑰產生／簽章
CLI 工具（`chaincode/vehicle/cmd/signdemo`，比照 stage 3 驗證模式），驗證完成後已刪除，
不留在版本庫中。

## 驗收標準對照（plan.md §5 階段 4）

| 驗收標準 | 狀態 |
| --- | --- |
| 三種扣分情境的單元測試通過 | ✅ 里程倒退、理賠未維修：單元測試＋真實網路皆驗證；零件重複：純函式與單元測試已覆蓋，鏈碼呼叫端因 stage 2 的 `bindPart` 拒絕機制而未接上（見上方「已知限制」） |
| UC-01 例外流程（里程倒退）扣 40 分並上鏈 | ✅ 真實五組織網路驗證：交易成功、`integrityScore` 100→60、`ANOMALY` 事件正確上鏈 |

下一步：階段 5（Gateway 與網頁），含階段 3 遺留的「依角色切換組織身分」設計決策。
