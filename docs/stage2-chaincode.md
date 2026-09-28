# 階段 2：資產合約 — 進度記錄

狀態：**鏈碼實作、單元測試、即時網路 CLI 展示（InitVehicle／AddMaintenance／RecordClaim／查詢）皆已跑通；「chaincode is not installed」根因已找到並修正。發現一項需要決策的架構落差（SBE 無法保護鍵值的第一次寫入）與一個獨立的查詢函式回傳格式錯誤，詳見文末「新發現」**。
對應 plan.md §5 階段 2：「`InitVehicle`、`AddMaintenance`、`RecordClaim`、
`TransferOwnership`、`ScrapVehicle`、查詢；零件雜湊綁定；背書策略」。

## 已完成

### 1. 鏈碼實作（`chaincode/vehicle/`）

Go module（`vehiclenet.tw/chaincode/vehicle`），依 CLAUDE.md 的檔案結構慣例：

```
chaincode/vehicle/
├── go.mod / go.sum         鎖定 go 1.19 與 fabric-contract-api-go v1.2.2（非 /v2）
├── main.go                 進入點
├── vendor/                 go mod vendor 產生，讓 fabric-ccenv:2.5.9 內建置不需網路
└── contract/
    ├── contract.go          VehicleContract：InitVehicle、AddMaintenance、
    │                        RecordClaim、TransferOwnership、ScrapVehicle、
    │                        GetSummary、GetVehicleHistory
    ├── model.go              Vehicle／Event／PartBinding 結構
    ├── keys.go                VEH:/EVT:/PART:/CLAIM: 狀態鍵集中定義
    ├── policy.go               狀態背書（SBE）政策位元組建構（見下）
    ├── contract_test.go        14 個單元測試（白箱，package contract）
    └── mocks/                  counterfeiter 產生的 ChaincodeStub／
                                 ClientIdentity／TransactionContext 假物件
```

**依賴版本鎖定的原因**：`fabric-contract-api-go` 目前的 `/v2` 需要 go 1.26+，
`fabric-chaincode-go/v2` 也需要新版 Go，兩者都超出 `fabric-ccenv:2.5.9` 內建的
Go 1.22.4，會導致 chaincode 安裝時建置失敗（延續 docs/stage0-validation.md
「CIRCL 與 ccenv Go 版本」的同一類限制）。改用舊版（無 `/v2` 後綴）
`fabric-contract-api-go@v1.2.2` ＋ `fabric-chaincode-go@v0.0.0-20230731094759`
＋ `fabric-protos-go@v0.3.0`，宣告 `go 1.19`，與 ccenv 相容。
**已實測**：在 `docker run hyperledger/fabric-ccenv:2.5.9 go build -mod=vendor`
中建置成功（見下方「已驗證」）。

### 2. 資料模型（對應 plan.md §3.2）

- `VEH:{vin}`：車輛主檔（引擎/變速箱雜湊、出廠年份、原廠建議售價、車主雜湊、
  狀態、里程、誠信分數、殘值）。誠信分數與殘值僅在 `InitVehicle` 寫入初始值
  （100 分、殘值＝MSRP）；動態重算屬於階段 4（BFR3），本階段不實作。
- `EVT:{vin}:{奈秒時間戳}:{txId}`：生命週期事件，鍵以 `stub.GetTxTimestamp()`
  的奈秒數零填補確保字典序＝時間序（維持鏈碼決定性）。
- `PART:{零件雜湊}`：核心零件數位孿生綁定索引。`InitVehicle` 綁定引擎／變速箱
  雜湊；若雜湊已綁定在另一輛「未報廢」車輛則拒絕（防套牌／零件拼裝）；
  `ScrapVehicle` 將綁定標記為 `released`，允許報廢車輛的零件合法回收後
  綁定至其他車輛（零件轉生，EIR1）。
- `CLAIM:{claimId}`：理賠編號索引，防止同一理賠編號被重複存證。

### 3. 背書政策：狀態背書（SBE）取代單一 channel 政策

plan.md §3.3 要求「每種交易類型有專屬背書組織」（如 `InitVehicle` 需要
`AND(OEM, REG)`），但 Fabric 的鏈碼層級政策（`peer lifecycle chaincode commit
--signature-policy`）**全鏈碼只能設定一種**，無法依函式區分。

**解法**：鏈碼層級政策設為 `OutOf(2, REG,OEM,SVC,INS,APP)`（任兩組織的寬鬆基準值，
守住 VEH 等一般鍵）；每個寫入函式在該次交易新建立的 `EVT:...` 事件鍵上，
呼叫 `SetStateValidationParameter` 設定 plan.md §3.3 指定的精確政策
（`chaincode/vehicle/contract/policy.go`）：

| 函式 | EVT 鍵的 SBE 政策 |
| --- | --- |
| `InitVehicle` | `AND(OEM, REG)` |
| `AddMaintenance` | `AND(SVC, OutOf(1, REG, APP))` |
| `RecordClaim` | `AND(INS, OutOf(1, REG, APP))` |
| `TransferOwnership` / `ScrapVehicle` | `AND(REG, OutOf(1, OEM, APP))` |

因為每個 EVT 鍵僅由建立它的那筆交易寫入一次，不會有後續交易在同一把鍵上
要求不同背書組織而互相衝突。VEH 鍵本身不設定 SBE，沿用鏈碼層級的寬鬆基準，
兩者疊加後仍與 plan.md §3.3 的精確要求一致（見程式內註解推導）。

`fabric-chaincode-go/pkg/statebased` 的 `NewStateEP`/`AddOrgs` 便利 API
只支援「所有列出組織皆須背書」（AND-of-orgs），無法表達 `OutOf(1, ...)`
子句，因此 `policy.go` 改為直接組出對應的 `common.SignaturePolicyEnvelope`
protobuf（與 `--signature-policy` 底層使用的是同一份結構），使用
`github.com/golang/protobuf/proto`（`fabric-protos-go@v0.3.0` 是舊版 APIv1
產生碼，需搭配此相容殼層，不能用 `google.golang.org/protobuf/proto`）。

### 4. 單元測試（`contract_test.go`，14 個，全數通過）

白箱測試（`package contract`），以 counterfeiter 產生的假物件模擬 Fabric shim，
並用一個記憶體 `map[string][]byte` 模擬世界狀態（`GetState`/`PutState`/
`GetStateByRange`/`SetStateValidationParameter` 皆連到同一份假帳本），
讓測試貼近真實 peer 行為又不需要啟動網路：

```
TestInitVehicle_Success_BFR1
TestInitVehicle_WrongOrg_Rejected_BFR1
TestInitVehicle_DuplicateVIN_Rejected_BFR1
TestInitVehicle_DuplicatePartHash_Rejected_BFR1        （套牌／零件拼裝防護）
TestAddMaintenance_Success_BFR2
TestAddMaintenance_ScrappedVehicle_Rejected_BFR2
TestRecordClaim_Success_BFR2
TestRecordClaim_DuplicateClaimID_Rejected_BFR2
TestTransferOwnership_Success_BFR2
TestScrapVehicle_ReleasesParts_BFR2_EIR1
TestScrapVehicle_PartReleaseAllowsRebinding_EIR1       （零件轉生）
TestScrapVehicle_AlreadyScrapped_Rejected_BFR2
TestGetSummary_NotFound_ReturnsError
TestGetVehicleHistory_FiltersByTimeRange_IIR2
```

每個成功案例都額外驗證：寫入該交易 EVT 鍵時設定的 SBE 政策位元組，
與獨立呼叫 `andPolicy`/`requiredWithWitness` 算出的期望值完全相同
（`require.Equal` 逐位元組比對），確保背書政策設定邏輯本身有被測試覆蓋，
不只是「有呼叫 SetStateValidationParameter」。

`go test ./...`、`go vet ./...`、`gofmt -l .` 皆乾淨通過。

### 5. 已驗證：於真實 `fabric-ccenv:2.5.9` 容器內建置成功

```
docker run --rm -v "$(pwd)":/cc -w /cc hyperledger/fabric-ccenv:2.5.9 \
  bash -lc 'go vet -mod=vendor ./... && go build -mod=vendor -o /tmp/out .'
```

`go version` 於該容器內回報 `go1.22.4`；`vet`／`build` 皆成功（產出 18MB 執行檔）。
這是階段 0／1 強調過的關鍵風控點（Docker 版本、Go 版本相容性），確認過關。

### 6. 部署腳本（`network/scripts/deployCC.sh`）

封裝→五組織皆安裝→查詢 package ID→五組織皆核准→檢查提交就緒→提交→查詢已提交，
全程冪等（重跑會跳過已安裝的組織、不會重複建置）。**已在真實五組織網路上執行成功
兩次**（分別以 `vehicle@1.0#1` 與全新重建網路後的 `vehicle@1.0#1`），
`peer lifecycle chaincode querycommitted` 皆回報五組織 `Approvals` 全數為 `true`，
`checkcommitreadiness`／`commit` 皆成功，`ClientWait` 顯示每個組織的
`approveformyorg`／`commit` 交易在該組織自己的 peer 上都被確認為 `VALID`。

### 7. CLI 展示腳本（`network/scripts/demoStage2.sh`，已寫好，待下次排查後重跑）

以 peer CLI 重現 UC-03 前半段並驗證跨組織背書：

1. `InitVehicle`（呼叫者 OEM，背書 OEM+REG）— 預期成功
2. `InitVehicle`（呼叫者 OEM，但背書改成 SVC+INS）— 預期失敗，用來證明 EVT 鍵的
   SBE（`AND(OEM,REG)`）真的被 peer 強制執行，而不只是滿足鏈碼層級寬鬆政策
   `OutOf(2, 五組織)`「任兩組織」即可
3. `AddMaintenance`（呼叫者 SVC，背書 SVC+REG）— 預期成功
4. `AddMaintenance`（呼叫者 SVC，但背書改成 REG+INS，缺 SVC）— 預期失敗
5. `RecordClaim`（呼叫者 INS，背書 INS+APP）— UC-03 後半段，預期成功
6. `GetSummary`／`GetVehicleHistory` 查詢

腳本設計重點：`invoke()` 函式刻意把「送交易提案簽署身分」（`submitterOrg`）
與「背書組織清單」（`parsePeerConnectionParameters` 的參數）分開控制，
讓②④能單獨測試「背書簽章組合錯誤」而不與「呼叫者 MSP 檢查」互相混淆。

## 已解決：「chaincode is not installed」根因與修正（2026-09-23）

**現象**（原記錄）：`peer lifecycle chaincode package/install/approveformyorg/
checkcommitreadiness/commit/querycommitted` 全部成功，五組織 peer 也都各自把
`approveformyorg`／`commit` 交易確認為 `VALID`；但之後任何一次
`peer chaincode invoke` 或 `peer chaincode query` 呼叫 `vehicle` 鏈碼，
一律在數毫秒內失敗：

```
Error: endorsement failure during invoke. response: status:500
message:"make sure the chaincode vehicle has been successfully defined on
channel vehiclechannel and try again: chaincode definition for 'vehicle'
exists, but chaincode is not installed"
```

### 根因

`network/scripts/utils.sh` 的 `println()`（供 `infoln`/`successln`/`errorln`
等呼叫）原本把訊息印到 **stdout**。`deployCC.sh` 的 `queryPackageID()`：

```bash
queryPackageID() {
  setGlobals reg   # 內部呼叫 infoln "Using organization reg"（印到 stdout）
  peer lifecycle chaincode queryinstalled --output json \
    | jq -r ... '.package_id'
}
...
PACKAGE_ID=$(queryPackageID)   # 用 $(...) 擷取整個函式的 stdout
```

`setGlobals` 內的 `infoln` 橫幅（含 ANSI 色碼）與 `queryinstalled | jq -r`
的真正輸出**混在同一個 stdout 串流**被 `$(...)` 一起擷取，導致
`PACKAGE_ID` 實際內容是兩行混在一起的字串（色碼＋"Using organization reg"
＋換行＋真正的 package ID）。這個被污染的字串接著整個被傳入
`approveformyorg --package-id "${PACKAGE_ID}"`，使五個組織核准時，
各自私有集合裡記錄的「本組織核准所參照的 package ID」都是這串垃圾值，
永遠對不上任何一個 peer 本地實際安裝的 package ID（用
`peer lifecycle chaincode queryapproved` 直接查證，`source.Type.LocalPackage
.package_id` 欄位裡真的印出了 `\u001b[0;34mUsing organization reg\u001b[0m\n`
前綴，坐實此推論）。Fabric 的 `_lifecycle` cache 在處理 commit 區塊時
（`core/chaincode/lifecycle` 的 `update()`）比對「本組織核准參照的
package ID」與「本地已安裝的 package ID」，比對不上就回報
`"approved, but not installed"`——即使該 package 確實已正確安裝在磁碟上
（`docker exec <peer> ls /var/hyperledger/production/lifecycle/chaincodes/`
可見對應檔案），peer 重啟重新掃描也不會修正，因為問題不在磁碟或快取時序，
而在鏈上私有資料本身記錄的值就是錯的。

**已排除的可能性**（過程中逐一驗證，記錄供參考）：核准/提交/委任皆成功；
`core.yaml` 與 `fabric-samples` 範本逐位元組相同；`dev-peer0.<org>...`
映像檔確實建置成功；`queryinstalled`／`querycommitted` 單獨查詢皆正常；
peer 重啟後 `InitializeLocalChaincodes` 也正確回報「1 already installed
chaincodes」，證明本地安裝本身完全正常，問題確實出在核准時傳入的
package ID 字串被污染。

### 修正

`network/scripts/utils.sh`：`println()` 改為輸出到 **stderr**（`>&2`），
這是一般 shell 腳本慣例——「記錄／提示訊息」與「函式回傳值」必須分屬不同
串流，才能安全地用 `$(functionThatLogs)` 擷取回傳值。修正後以全新
channel／全新 `deployCC.sh` 重新部署，`peer chaincode invoke`／`query`
皆正常運作（見下）。

### 過程中確認、但非本錯誤根因的環境問題（維持記錄）

- **WSL2 的 `vmIdleTimeout=-1` 在本次除錯過程中實測並未生效**：`.wslconfig`
  雖已設定，但兩次獨立的 `wsl -d ... -- ...` 呼叫之間，WSL 發行版仍在約
  20–50 秒無 interop 連線後整個關閉（`docker.service` 隨之被 systemd
  反覆 stop/start，所有容器跟著整批中斷，狀態碼與先前誤判為「Windows
  睡眠」的現象完全相同）。確認方式：`wsl -l -v` 在兩次指令間顯示
  `Stopped`；`journalctl -u docker` 顯示 dockerd 在同一分鐘內反覆
  「Starting up」→「Processing signal 'terminated'」。**因此指令仍
  correct，但 `-1` 這個值本身可能未被目前 WSL 版本（2.7.14.0）正確解讀
  為「停用逾時」**；待之後有時間再確認正確寫法或改用其他機制（例如本次
  除錯採用的暫時性作法：`wsl -d Ubuntu-22.04 -- sleep <秒數>` 保持一個
  背景 interop 連線，讓發行版在整段除錯過程中不被關閉）。
- Windows 電池供電閒置睡眠（180 秒）在**第一次**中斷中被誤判為根因
  （事件檢視器 Event 506/507 時間點與初次中斷相近），但後續證實與
  「chaincode not installed」本身無關，且第二次中斷發生時系統本已插電、
  也已用 `powercfg /setdcvalueindex` 暫時關閉睡眠，中斷仍然發生——
  證實真正原因是上一點的 WSL 閒時關閉，而非睡眠。**除錯階段暫時關閉的
  睡眠設定尚未還原**，之後正式收工時需用
  `powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 180`
  還原（或視需要保留關閉，长時間 Fabric 工作階段建議直接插電）。

## 新發現：`demoStage2.sh` 跑通後浮現的兩個獨立問題（2026-09-23）

修正上述根因、以全新 channel 重新部署後，`demoStage2.sh` 七個步驟中
①③⑤⑥成功、②④⑦不符預期，暴露兩個與「chaincode not installed」無關的
獨立問題：

### 1. SBE（狀態背書）無法保護鍵值的「第一次寫入」——需要架構決策

步驟②（`InitVehicle` 背書改成 SVC+INS，應被 `AND(OEM,REG)` 擋下）與
步驟④（`AddMaintenance` 背書缺 SVC，應被 `AND(SVC,OutOf(1,REG,APP))` 擋下）
**都非預期地成功了**。

原因：Fabric 的 `SetStateValidationParameter` 設定的 SBE，只保護
**該鍵之後的寫入**；建立該鍵的**當下這筆交易**，其背書要求仍沿用
「呼叫 `SetStateValidationParameter` 之前」該鍵原本的政策——對一個全新的
`EVT:...` 鍵而言，寫入前並無既有 SBE，因此退回鏈碼層級的寬鬆基準
`OutOf(2, 五組織)`。`policy.go`／`docs/stage2-chaincode.md`
原先「每個 EVT 鍵僅寫入一次，不會衝突」的推導沒有錯，但遺漏了
「第一次寫入本身不受新設定的 SBE 保護」這個 Fabric 既有限制，導致
plan.md §3.3 要求的「InitVehicle 需要 OEM+REG 背書」實際上**沒有被強制
執行**——任兩個組織背書即可偽造 `InitVehicle`／`AddMaintenance`。

**決策（2026-09-23，已與使用者確認）**：先接受此限制，作為 PoC 已知限制
記錄，不重新設計背書機制；報告中需誠實標註「SBE 僅保護鍵值建立後的修改，
建立當下的交易由鏈碼層級寬鬆政策 `OutOf(2, 五組織)` 把關，plan.md §3.3
的 per-function 背書要求僅對『修改』生效、對『首次建立』不生效」。
若之後仍想做到真正的 per-function 背書，可考慮改用「多鏈碼＋各自鏈碼
層級 `--signature-policy`」（鏈碼層級政策在 commit 時就固定，不受
「第一次寫入」限制），但需要拆分鏈碼、處理跨鏈碼呼叫，架構改動較大，
暫不列入排程。

### 2. `GetVehicleHistory` 查詢回傳格式錯誤（獨立小問題）

步驟⑦查詢失敗：

```
Error handling success response. Value did not match schema:
1. return.0: claimId is required
2. return.0: incidentAmount is required
...
```

`fabric-contract-api-go` 依回傳型別自動產生 JSON Schema；`GetVehicleHistory`
回傳的 `Event` 陣列疑似把「維修／理賠／過戶／檢驗」共用同一個結構，
但欄位未正確標記為選填（例如缺少 `metadata:",optional"` tag 或型別設計
本身沒有用「哪些欄位一定有、哪些依事件類型才有」區分），造成產生的
schema 要求所有子類型欄位在每筆事件都必須存在。屬於獨立的實作缺陷，
不影響 InitVehicle／AddMaintenance／RecordClaim／GetSummary，待修正
`contract/model.go` 的 `Event` 結構或改用 `interface{}` + 手動
schema 標記解決。

### `GetVehicleHistory` 回傳格式修正

`chaincode/vehicle/contract/model.go` 的 `Event` 結構補上
`metadata:",optional"` tag（`fabric-contract-api-go` 產生查詢函式回傳型別的
JSON Schema 時只看這個 tag，`json:"...,omitempty"` 不影響 schema）。
以 `vehicle@1.1`（sequence 2）重新部署後，`GetVehicleHistory` 查詢正常回傳
完整事件陣列，不再有 schema 驗證錯誤。

### `demoStage2.sh` 同步調整

- VIN、引擎／變速箱雜湊、理賠編號皆改用執行時的時間戳（`RUN_ID`）組出，
  避免對同一個未清除的 channel 重跑腳本時，撞上 `PartBinding`／`CLAIM:`
  的重複綁定檢查而誤報失敗（純屬測試資料衝突，非鏈碼缺陷）。
- 步驟②④的預期結果與判斷式，改為對應「已知限制：SBE 不保護首次建立」
  的實際行為（背書組織不足但仍成功），不再誤判為失敗。

### 最終驗證：`demoStage2.sh` 全數通過（2026-09-23）

以全新 channel 部署 `vehicle@1.0`（sequence 1），修正 `GetVehicleHistory`
後以 `vehicle@1.1`（sequence 2）在同一 channel 上完成鏈碼升級並重新驗證，
七個步驟全數符合目前已知行為：①③⑤ 皆成功寫入並經 `ClientWait` 確認
`VALID`；⑥ `GetSummary`、⑦ `GetVehicleHistory` 皆正確回傳完整 JSON
（`GetVehicleHistory` 可見 INIT／MAINTENANCE×2／CLAIM 四筆事件，欄位依
類型正確增減，不再觸發 schema 錯誤）；②④ 依「已知限制」預期成功。

## 驗收標準對照（plan.md §5 階段 2）

| 驗收標準 | 狀態 |
| --- | --- |
| BFR1、BFR2 單元測試通過 | ✅ 14/14 通過 |
| 跨組織背書測試通過 | ✅ CLI 可正常 invoke／query；SBE 對「修改」有效，對「首次建立」的限制已記錄為 PoC 已知限制（使用者確認接受，不重新設計） |
| UC-03 前半段可在 CLI 重現 | ✅ InitVehicle／AddMaintenance／RecordClaim／GetSummary／GetVehicleHistory 皆驗證成功 |

**階段 2 完成。** 下一步：進入**階段 3（PQC 整合）**。
