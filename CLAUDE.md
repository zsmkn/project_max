# CLAUDE.md

本檔案提供 Claude Code 在此專案中工作時的指引。開始任務前請先閱讀，任務目標或風格有變動時請同步更新。
實作規劃與階段進度請見 [plan.md](plan.md)。

## 專案概述

**基於區塊鏈技術的汽車履歷系統**，為畢業專題作品。指導教授：陳興忠；組長：陳建中；組員：藍家鎧、張泰傑。

台灣二手車市場存在調錶、事故車／泡水車隱瞞、套牌與零件拼裝、中心化履歷庫被竄改等問題。本系統以 **Hyperledger Fabric 聯盟鏈** 讓監理站、車廠、維修廠、保險公司、第三方鑑定中心共同背書履歷資料，並導入 **後量子密碼學（PQC）** 使履歷具備十年以上的長期安全性。

四項創新技術：

1. **Fabric 聯盟鏈**：多方共識、分散式寫入、不可竄改。
2. **PQC**：CRYSTALS-Kyber（TLS 金鑰封裝）＋ CRYSTALS-Dilithium（數位簽章），基於 liboqs。
3. **動態誠信評分與折舊引擎**：智慧合約自動交叉比對「保險理賠」與「維修紀錄」，發現里程倒退或有理賠無維修時自動扣分。
4. **核心零件數位孿生綁定**：VIN 與引擎、變速箱序號以密碼學雜湊綁定，防止贓車與零件拼裝。

需求原始文件：專案根目錄的 `系統需求書3.docx` 是**本專案的權威需求來源**（需求編號 FFR / BFR / NFR / EIR / IIR 皆出自此文件）。

## 任務目標

### 核心目標

1. 建立可運作的五組織 Fabric 聯盟鏈網路（REG、OEM、SVC、INS、APP），Raft 排序、CouchDB 狀態庫。
2. 實作車輛資產全生命週期智慧合約：出廠初始化 → 保養／理賠上鏈 → 過戶 → 報廢（BFR1、BFR2）。
3. 實作動態誠信與折舊評分引擎（BFR3）。
4. 整合 PQC：Dilithium 簽章驗證（BFR5）、Kyber TLS 通道（BFR4）。
5. 提供車主、買家、鑑定師三種 Web 介面（FFR1–FFR4）。
6. 完成三個使用案例的端到端展示：UC-01 鑑定師複檢與動態扣分、UC-02 買家查詢與 PQC 連線、UC-03 車廠初始化與理賠存證。

### 非目標

- 不做真實對接監理站／保險公司系統，只提供 API 介面與模擬服務（EIR1、EIR2）。
- 不做行動 App 與生產等級部署；目標是可完整展示、可寫進畢業專題報告的 PoC。
- 不修改 Fabric 原始碼（節點間原生 TLS 與 MSP 身分維持 Fabric 預設，PQC 加在應用層與邊界，細節見 plan.md）。

### 目前進度

- [x] 需求書完成（v5.0，2026/08/03）
- [x] plan.md 經使用者確認，待決策事項已全部定案
- [x] 階段 0：環境與技術驗證（2026/09/22 完成；結論見 [docs/stage0-validation.md](docs/stage0-validation.md)，plan.md §9 已同步摘要）
- [x] 階段 1：五組織網路（2026/09/23 完成；結論見 [docs/stage1-network.md](docs/stage1-network.md)，操作說明見 [network/README.md](network/README.md)）
- [x] 階段 2：資產合約（2026/09/23 完成；結論見 [docs/stage2-chaincode.md](docs/stage2-chaincode.md)）
- [x] 階段 3：PQC 整合（chaincode 端 Dilithium 簽章驗證、Gateway 骨架（金鑰錢包、查詢端點、Kyber TLS 邊界）皆已完成並在真實網路驗證通過；依角色切換組織身分與瀏覽器相容性測試留待階段 5，見 [docs/stage3-pqc.md](docs/stage3-pqc.md)）
- [x] 階段 4：評分引擎（誠信分數／殘值純函式、參數化設定檔、由寫入函式觸發重算、UC-01 里程倒退扣 40 分並上鏈，皆已在真實五組織網路驗證通過；見 [docs/stage4-scoring.md](docs/stage4-scoring.md)）
- [x] 階段 5：Gateway 與網頁（Gateway 依角色切換組織身分、三種角色 HTML5 介面、QR Code、FFR4 里程倒退紅字警示並鎖定送出，皆已在真實五組織網路驗證通過；真實瀏覽器相容性測試待補，見 [docs/stage5-gateway-web.md](docs/stage5-gateway-web.md)）
- [x] 階段 6：外部模擬與整合測試（監理站／保險公司模擬服務、Gateway 內部服務埠、UC-01/02/03＋EIR1 端到端腳本、需求追蹤矩陣補全，皆已在真實五組織網路驗證通過；見 [docs/stage6-integration.md](docs/stage6-integration.md)、[docs/requirements-traceability.md](docs/requirements-traceability.md)）
- [x] 階段 7：效能、容錯與結案（Hyperledger Caliper 效能測試、延伸版 NFR3 容錯測試、架構圖與展示腳本，皆已在真實五組織網路驗證通過；見 [docs/stage7-performance.md](docs/stage7-performance.md)）。**畢業專題全部階段已完成**
- [x] 延伸：dApp 化 D0–D3（[plan_dApp.md](plan_dApp.md)，2026/09/24 完成）：修正 `RegisterPQCKey` 可覆寫他人公鑰的漏洞（持有證明、舊鑰換鑰、REG 強制重綁）、網頁改由 Gateway 同源提供、瀏覽器自持金鑰錢包、買家瀏覽器端驗章、鏈上事件 SSE 即時推播；鏈碼 `vehicle@1.5`（sequence 6），真實五組織網路與真實瀏覽器（Edge）皆驗證通過，見 [docs/dapp.md](docs/dapp.md)。D4 公有鏈錨定為選做，未實作

**環境注意事項（階段 0／1 發現，動手前必看）：**
- WSL2（Ubuntu 22.04）內的 `docker-ce`/`docker-ce-cli`/`docker-ce-rootless-extras`/`containerd.io` 已鎖定在 25.0.5/1.6.28（`apt-mark hold`），因為更新版 Docker Engine 會讓 Fabric 2.5.9 peer 的 chaincode 安裝失敗（legacy docker build API 不相容）。不要執行會升級這些套件的操作。
- chaincode 若要用 Cloudflare CIRCL 做 PQC 驗證，鎖定 `v1.6.3`；更新版本要求 Go 1.25+，但 `fabric-ccenv:2.5.9` 只內建 Go 1.22.4，會建置失敗。
- **Docker 映像檔務必明確指定版本標籤，不可用 `latest`**：階段 1 發現本機 `latest` 標籤實際指向 Fabric 3.1.5，而非驗證過的 2.5.9（詳見 docs/stage1-network.md）。一律使用 `hyperledger/fabric-peer:2.5.9`、`fabric-orderer:2.5.9`、`fabric-ca:1.5.9`、`fabric-ccenv:2.5.9` 等明確版本號。
- WSL2 記憶體上限維持系統預設（未建立 `.wslconfig`）即可：階段 1 實測 19 個容器（6 CA＋3 Raft 排序節點＋5 peer＋5 CouchDB）同時運作，總記憶體用量僅約 900 MB，遠低於預設的 21 GiB 上限。若之後階段觀察到記憶體壓力再調整。
- **`%USERPROFILE%\.wslconfig` 已於階段 2 加入 `vmIdleTimeout=-1`**：WSL2 預設約 60 秒無活動就會關閉整個發行版（連同所有 Docker 容器），長時間跑 Fabric 網路測試時會被頻繁中斷；已停用此逾時（原始檔案備份於 `.wslconfig.bak`）。修改 `.wslconfig` 後需要 `wsl --shutdown` 才會生效，會中斷當下所有 WSL 工作，執行前先確認沒有其他重要工作階段。
- **長時間 WSL／Docker 工作階段建議接上電源**：筆電電池供電時，Windows 預設 180 秒閒置就會睡眠（與上述 WSL 閒置逾時是兩個獨立機制），同樣會中斷所有容器。必要時可用 `powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0` 暫時關閉（單位為秒；`powercfg /change` 系列指令的單位是分鐘，容易混淆，還原時要注意），事後用同一指令還原原始值。

不再參加競賽，沒有外部截止日；各階段依 plan.md 順序完成即可。

## 領域名詞

| 名詞 | 說明 |
| --- | --- |
| VIN | 車輛識別碼，車輛資產的主鍵 |
| REG / OEM / SVC / INS / APP | 監理站／原車廠／維修廠／保險公司／第三方鑑定中心，五個聯盟組織 |
| 誠信分數 | 由評分引擎計算的車況可信度，發現異常即扣分 |
| 殘值 | 依折舊演算法與誠信分數估算的二手車價值 |
| 數位孿生 | 車輛與核心零件序號的雜湊綁定紀錄 |
| World State | Fabric 目前狀態資料庫（本專案使用 CouchDB） |

## 專案結構

規劃結構如下，目錄於各階段開始時才建立，實際狀態以檔案系統為準：

```
project_max/
├── network/               # Fabric 網路：configtx、docker-compose、啟動腳本
├── chaincode/vehicle/     # 智慧合約（Go）
├── pqc/                   # liboqs 金鑰產生、簽章、驗證工具；Kyber TLS 代理設定
├── gateway/               # Fabric Gateway REST API（Node.js / TypeScript）
├── web/                   # 車主／買家／鑑定師 HTML5 介面（由 Gateway 同源提供；vendor/ 固定版本函式庫、shared/ 共用簽章訊息格式）
├── mocks/                 # 監理站、保險公司外部系統模擬（Python）
├── docs/                  # 設計文件、需求追蹤矩陣
├── tests/                 # 端到端與效能測試
├── src/SETUP.md           # 全專案搭建與測試指令彙總（給新組員的環境搭建參考）
├── CLAUDE.md
├── plan.md
└── README.md
```

## 技術棧

| 項目 | 選擇 | 備註 |
| --- | --- | --- |
| 作業系統 | Windows 11 + WSL2 Ubuntu 22.04 LTS | 需求書指定 |
| 區塊鏈 | Hyperledger Fabric **v2.5.9**，Docker 容器化 | 需求書指定 |
| 狀態庫 / 共識 | CouchDB / Raft | 需求書指定 |
| PQC | liboqs（Kyber、Dilithium） | 需求書指定 |
| 網頁與模擬服務 | Python 3.10 + HTML5 | 需求書指定 |
| Chaincode 語言 | Go | 已定案；若階段 0 驗證發現無法在 chaincode 內驗證 Dilithium 再檢討 |
| Gateway 語言 | Node.js / TypeScript（`@hyperledger/fabric-gateway`） | 已定案；Fabric 無維護中的 Python SDK |
| PQC 範圍 | 應用層雙層簽章 + 邊界 Kyber TLS | 已定案，見 plan.md §2 |

## 常用指令

| 用途 | 指令 |
| --- | --- |
| 啟動 Fabric 網路（五組織） | `cd network && ./network.sh up` |
| 建立 channel 並加入五組織 | `cd network && ./network.sh createChannel` |
| 關閉並清除網路 | `cd network && ./network.sh down` |
| NFR3 容錯初驗（channel 設定交易，階段 1） | `cd network && bash scripts/faultToleranceTest.sh` |
| NFR3 完整容錯測試（真實鏈碼交易，階段 7） | `cd network && bash scripts/faultToleranceTestFull.sh` |
| 部署 chaincode | `cd network && bash scripts/deployCC.sh`（可用 `CC_VERSION=`／`CC_SEQUENCE=` 環境變數升級版本） |
| Chaincode 單元測試 | `cd chaincode/vehicle && go test ./...` |
| 啟動 Gateway（開發模式） | `cd gateway && npm run dev`（需先啟動 network/ 並部署 chaincode，見 [gateway/README.md](gateway/README.md)） |
| Gateway 單元測試／型別檢查 | `cd gateway && npx vitest run && npx tsc --noEmit` |
| 啟動監理站／保險公司模擬服務（EIR1／EIR2） | `python3 -m mocks.monitoring_station.app`／`python3 -m mocks.insurance.app`（需先啟動 Gateway，見 [mocks/README.md](mocks/README.md)） |
| mocks 單元測試 | `make mocks-test`（等同 `python3 -m unittest discover -s mocks -p "test_*.py"`） |
| 網頁錢包單元測試（dApp D1／D2） | `make web-test`（等同 `node --test web/tests/*.test.mjs`） |
| 真實瀏覽器冒煙測試（dApp D0–D3） | Windows 端：`powershell -NoProfile -ExecutionPolicy Bypass -File tests\e2e\browserSmoke.ps1`（前提：network／gateway 已啟動） |
| 端到端測試（UC-01/02/03＋EIR1＋dApp D0–D3） | `make e2e`（前提見 [tests/e2e/README.md](tests/e2e/README.md)：network／gateway／mocks 皆須先啟動） |
| 效能測試（NFR2，Hyperledger Caliper） | `cd tests/perf && npm run seed && npm run config && npm run benchmark`（前提見 [tests/perf/README.md](tests/perf/README.md)：network／gateway 皆須先啟動且已 bind） |
| 格式化 / Lint | Go：`gofmt`、`go vet`；Python：`ruff`；TypeScript：`eslint`、`prettier` |

## 編程風格

### 通則

- **可讀性優先**：程式碼是寫給人看的。清楚的命名勝過註解，簡單的寫法勝過聰明的寫法。
- **小而專注**：一個函式只做一件事；一個檔案只負責一個主題。函式過長或巢狀過深時先拆分。
- **符合既有風格**：修改現有檔案時，沿用該檔案的命名、縮排、註解密度與慣用寫法，不順手重構無關的程式碼。
- **不過度設計**：只實作目前需要的功能，不為假想的未來需求預留抽象層。
- **早期返回**：優先用 guard clause 處理錯誤與邊界條件，減少巢狀。

### 命名

- 名稱要能表達意圖，避免 `data`、`tmp`、`foo` 這類無意義名稱。
- 布林值使用 `is` / `has` / `should` 開頭。
- 縮寫僅限通用者（如 `id`、`url`、`vin`），避免自創縮寫。
- 各語言慣例：
  - **Go**：匯出識別字 `PascalCase`，其餘 `camelCase`；用 `gofmt` 格式化。
  - **Python**：`snake_case`，類別 `PascalCase`，常數 `UPPER_SNAKE_CASE`；遵循 PEP 8。
  - **JavaScript / TypeScript**：`camelCase`，型別與類別 `PascalCase`。
  - **Chaincode 鏈上資料欄位**：`camelCase` JSON 鍵，Key 前綴大寫，例如 `VEH:{vin}`。

### 需求可追溯

- 實作某項需求時，在函式註解或測試名稱中標註需求編號（如 `FFR4`、`BFR3`、`UC-01`），讓程式、測試與 `系統需求書3.docx` 能互相對照。
- 測試名稱範例：`TestSubmitInspection_MileageRollback_DeductsScore_BFR3`。

### 註解與文件

- 註解說明「為什麼」，而不是「做了什麼」——後者應由程式碼本身表達。
- 公開的函式 / 模組需有簡短說明（用途、參數、回傳值、可能的錯誤）。
- 不留下被註解掉的舊程式碼，版本歷史交給 git。
- 註解與文件使用**繁體中文**；程式碼中的識別字使用**英文**。

### 智慧合約（Chaincode）規則

- **必須具決定性**：不得使用 `time.Now()`、隨機數、外部網路呼叫或迭代順序不定的 map；時間一律取用 `stub.GetTxTimestamp()`。
- **異常要「記錄」而不是「拒絕」**：Fabric 交易一旦回傳錯誤就不會寫入狀態。像 UC-01 的里程倒退，需要扣分並將異常標記上鏈，合約應成功提交並寫入異常紀錄，而不是回傳錯誤。
- 所有寫入函式先驗證呼叫者組織（MSP ID）與輸入格式，再改動狀態。
- 鏈上不存明文個資；車主身分以雜湊或化名表示。
- 狀態鍵設計集中定義於單一檔案，避免各處拼字串。

### 密碼學與安全

- **絕不將私鑰、憑證私鑰、`.env` 或任何機密提交到 git**；測試用金鑰放在被 `.gitignore` 排除的目錄，並提供 `.env.example`。
- 不自行實作密碼學演算法，使用 liboqs 或經審查的函式庫。
- 簽章驗證失敗一律視為拒絕，不可降級為忽略。
- 面向使用者的錯誤訊息不洩漏內部路徑、金鑰資訊或堆疊。
- 只在系統邊界（使用者輸入、外部 API、Gateway 請求）做輸入驗證，內部程式信任已驗證的資料。

### 錯誤處理

- 不吞掉例外；捕捉後要不是處理，就是帶著上下文重新拋出。
- 錯誤訊息要能指出問題與可能的解法。

### 測試

- 新功能與 bug 修正都應附上測試；修 bug 時先寫出能重現問題的測試。
- 測試以行為為單位命名，彼此獨立，不依賴執行順序。
- Chaincode 邏輯（尤其評分引擎）以單元測試覆蓋；跨組織流程以端到端測試覆蓋。

## Git 與協作規範

- **分支**：`main` 保持可運作；新工作使用 `feat/…`、`fix/…`、`docs/…`、`chore/…` 分支。
- **Commit 訊息**採用 [Conventional Commits](https://www.conventionalcommits.org/)：
  `feat(chaincode): 新增里程倒退扣分`、`fix(network): 修正 SVC 節點背書設定`。
- 每個 commit 只做一件事，訊息說明「為什麼」而非只列出改了什麼。
- 提交前確認測試與 lint 皆通過。
- 未經使用者要求，不要自行 commit、push 或建立 PR。

## 給 Claude 的工作方式

- 動手前先讀相關檔案與 plan.md，理解現有做法再修改。
- 需求書沒寫清楚的數值（扣分、殘值公式、TPS 目標等），使用者已表示不需討論：採用 plan.md 已定案的預設值，做成可調整的設定檔，不要寫死在邏輯裡。牽涉架構方向的事仍要先詢問。
- 修改完成後執行測試 / lint 驗證，並如實回報結果（包含失敗與未驗證的部分）。
- 新增指令、目錄或重要慣例後，同步更新本檔案；階段完成時更新「目前進度」。
