# 階段 5：Gateway 與網頁 — 進度記錄

狀態：**已完成（瀏覽器相容性測試除外，見下方「已知限制」）**。Gateway 依角色切換組織
身分、三種角色 HTML5 介面、QR Code、里程倒退紅字警示並鎖定送出（FFR1–FFR4）皆已實作，
並以模擬瀏覽器 TLS 設定的 Node.js 用戶端在真實五組織網路上完整走過 UC-01／UC-02／UC-03
關鍵步驟驗證通過。
對應 plan.md §5 階段 5：「Gateway REST API；車主、買家、鑑定師介面；QR Code；里程倒退
紅字警示並鎖定送出（FFR1–FFR4）」。

## Gateway：依角色切換組織身分（plan.md §7 #11）

延續 docs/stage3-pqc.md 的「尚未完成」項目。設計決策（已與 plan.md §7 #11 一併定案）：
**單一 Gateway 服務，內部管理多組身分**，而非每組織各自部署一個 Gateway 實例——PoC 階段
操作單純，單一服務較易展示，正式產品應拆成各組織各自部署（已在 `gateway/README.md`
標註此簡化）。

- `src/config.ts`：`orgConfigs` 依 `network/scripts/orgs.sh` 的組織代號／連接埠慣例，
  推導出 REG/OEM/SVC/INS/APP 五個組織各自的 `OrgFabricConfig`（MSP ID、peer 端點、
  TLS 憑證、身分憑證／私鑰目錄），皆以 `User1@{org}.vehiclenet.tw` 身分連線（五個組織
  皆有此身分，見階段 1 的 CA 憑證簽發）。可用 `FABRIC_<ORG>_*` 環境變數分別覆寫。
- `src/fabricClient.ts`：`FabricConnectionPool` 以「首次使用時建立、之後重複使用」
  （lazy + cache）維護每個組織身分各自的 gRPC 連線／Fabric Gateway 連線，
  `getConnection(org)` 回傳（必要時先建立）指定組織的連線。
- `src/routes.ts`：新增 `InitVehicle`（OEM）、`AddMaintenance`（SVC）、`RecordClaim`
  （INS）、`SubmitInspection`（APP）、`TransferOwnership`（REG）、`ScrapVehicle`（REG）
  六個寫入端點，各自呼叫 `pool.getConnection(對應組織)`；查詢端點固定用
  `config.fabric.defaultQueryOrg`（預設 REG）。

## 買家查詢授權／QR Code（plan.md §7 #10，UC-02）

- `src/authorizationMessages.ts` 新增 `queryAuthorizationMessage(vin, expiresAt)`，
  格式為 `QueryAuthorization|{vin}|{expiresAt}`（與 `maintenanceAuthorizationMessage`
  相同的固定分隔符設計，欄位變動會讓簽章失效）。
- `src/pqcWallet.ts` 新增 `verify(identity, message, signatureHex)`：Gateway 端自行
  驗證（不上鏈），用於買家頁面驗證 QR 內容。**此驗證不是資料存取的硬性關卡**——
  本系統的履歷資料設計上即為公開可查（區塊鏈透明性），簽章驗證的是「車主同意查詢」
  這個意圖本身，已在程式註解與 `web/README.md` 明確標註此範圍界線，避免與存取控制
  混淆。
- `POST /api/vehicles/:vin/query-authorization`：車主簽署「VIN + 有效期限」，回傳值
  即為 QR Code 應編碼的 JSON 內容。
- `GET /api/vehicles/:vin/query-authorization/verify`：驗證簽章與有效期限。

## 三種角色 HTML5 介面（`web/`）

不使用前端框架或建置工具，純 HTML5 + vanilla JavaScript，透過 `web/api.js` 呼叫
Gateway REST API（plan.md §7 #3：網頁層 HTML5）；QR Code 產生／解析透過 CDN 載入
`qrcode`／`jsQR`（純前端函式庫）。

| 頁面 | 角色 | 對應需求／使用案例 |
| --- | --- | --- |
| `owner.html` | 車主 | FFR2（PQC 金鑰登記、保養授權簽章）、產生 UC-02 查詢授權 QR Code |
| `buyer.html` | 買家 | FFR1、UC-02（上傳/貼上 QR、驗證授權、查詢履歷並顯示查詢耗時） |
| `appraiser.html` | 鑑定師 | FFR3、FFR4、UC-01（提交複檢、里程倒退紅字警示並鎖定送出） |

### FFR4：里程倒退紅字警示並鎖定送出——雙層攔截

鑑定師頁面在送出複檢前，先查詢車輛目前紀錄里程；若使用者輸入的里程低於目前紀錄，
立即顯示紅字警示並停用送出按鈕，需勾選「我已核實現場狀況」才能解鎖（前端 UI 防呆）。
即使略過前端直接呼叫 API，鏈碼端仍會如實記錄並扣分、不拒絕交易（BFR3，見
`chaincode/vehicle/contract/scoring.go`）——這是 plan.md §6 對 FFR4 要求的
「前端測試＋合約測試（雙層攔截）」：前端負責提醒與人工確認，鏈碼負責確保資料本身
永遠誠實記錄，兩者互不依賴，任一層失效另一層仍能保護資料完整性。

## 真實五組織網路端到端驗證

Gateway 端到端行為以 Node.js `https` 用戶端（設定與瀏覽器相同的
`ecdhCurve: 'X25519MLKEM768'`、`minVersion: 'TLSv1.3'`，模擬 `web/api.js` 的
`fetch()` 呼叫）在既有五組織網路上驗證，涵蓋 UC-01／UC-02／UC-03 的關鍵步驟：

1. `RegisterPQCKey`、`InitVehicle`（OEM 身分）成功。
2. 車主簽署保養授權 → `AddMaintenance`（**SVC 身分**，非 Gateway 預設查詢組織）成功，
   里程正確更新為 50000；`GetSummary` 查詢延遲實測 **12 ms**（NFR2 目標 < 1000 ms）。
3. `RecordClaim`（**INS 身分**）成功。
4. `SubmitInspection`（**APP 身分**，複檢回報里程 30000，低於歷史最高 50000）→
   交易仍成功（不拒絕，UC-01 例外流程）；`GetSummary` 確認誠信分數 100→60；
   `GetVehicleHistory` 確認 `ANOMALY` 事件正確上鏈。
5. `TransferOwnership`（**REG 身分**）成功。
6. 買家查詢授權：產生、驗證（合法簽章）皆成功；偽造簽章正確被判定為無效
   （UC-02 例外流程）。
7. `ScrapVehicle`（**REG 身分**）成功。

五個不同組織身分（OEM／SVC／INS／APP／REG）皆透過同一個 Gateway 服務、依請求呼叫的
函式自動切換正確身分送出交易並成功背書／提交，證實 `FabricConnectionPool` 的多組織
身分切換設計在真實網路上正確運作。驗證用腳本比照 stage 3／4 慣例，用後即刪
（未併入版本庫）；`gateway/README.md`、`web/README.md` 記錄了對應的操作方式，供之後
重新驗證。

Gateway 單元測試（`npm run build`／`npx tsc --noEmit`／`npx vitest run`）：12 個測試
全數通過，涵蓋 `queryAuthorizationMessage`（新增）與 `pqcWallet.verify`（新增，含
未登記身分、偽造簽章、格式錯誤簽章三種情境）。

## 已知限制

- **瀏覽器相容性測試（延續 stage 3 的待辦）未執行**：本階段的端到端驗證使用
  Node.js `https` 用戶端模擬瀏覽器的 TLS 設定（`ecdhCurve: 'X25519MLKEM768'`），
  這能驗證 Kyber TLS 邊界與 API 行為本身正確，但**不等同於**在真實瀏覽器
  （Chrome／Firefox）中開啟 `web/*.html` 操作的實測——本次執行環境（背景／自動化
  工作階段）沒有可用的瀏覽器自動化工具，無法實際驅動瀏覽器點擊操作。
  docs/stage0-validation.md 已記錄「近期 Chrome／Firefox 已預設支援
  X25519MLKEM768」，但這是查文件得到的結論，不是本專案的實測結果；使用者接手時
  建議手動在瀏覽器開啟 `web/index.html` 走一次三個角色頁面，確認：
  (a) 首次連線 Gateway 需手動接受自簽憑證警告（`web/README.md` 已說明）、
  (b) QR Code 圖片上傳解析（`jsQR`）、(c) 表單互動與 FFR4 的鎖定/解鎖行為。
- **買家頁面查詢授權驗證不是存取控制**：見上方「買家查詢授權／QR Code」小節的說明，
  這是刻意的範圍界線，非疏漏。
- **未實作登入／權限系統**：任何人可在任一頁面輸入任意識別碼操作，PoC 階段以
  「操作介面對應角色」示範流程；畢業專題報告需標註此簡化。

## 驗收標準對照（plan.md §5 階段 5）

| 驗收標準 | 狀態 |
| --- | --- |
| UC-01、UC-02 可從網頁完整操作 | ⚠️ API 層（Gateway REST API，模擬瀏覽器 TLS 設定的用戶端）已完整驗證通過；`web/*.html` 頁面本身呼叫的正是這些已驗證的端點，但頁面在真實瀏覽器中的操作流程未實測（見上方已知限制） |
| 查詢延遲小於 1 秒（NFR2 初驗） | ✅ 實測 `GetSummary` 12 ms，遠低於目標 |

下一步：階段 6（外部模擬與整合測試）——監理站／保險公司模擬服務（`mocks/`）、
UC-01/02/03 端到端腳本、需求追蹤矩陣補全。建議下一階段的 e2e 腳本比照本階段驗證
腳本的模式（Node.js 用戶端＋Kyber TLS 設定），並改為保留在版本庫中的正式測試腳本
（而非用後即刪），直接滿足「UC-01/02/03 端到端腳本一鍵通過」的最終驗收條件。
