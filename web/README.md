# web/ — 三種角色 HTML5 介面

車主／買家／鑑定師三個靜態頁面（FFR1–FFR4，對應 plan.md §5 階段 5；plan_dApp.md D0–D3
改為 dApp 形式）。純 HTML5 + vanilla JavaScript（ES modules），不使用前端框架或建置工具。
所有頁面透過 `api.js` 呼叫 `gateway/` 的 REST API。

## 啟動

Gateway 需先啟動（見 `gateway/README.md`）。**網頁由 Gateway 同源提供**（plan_dApp.md D0），
直接開啟：

```
https://localhost:8443/            # 首頁
https://localhost:8443/owner.html  # 車主
https://localhost:8443/buyer.html  # 買家
https://localhost:8443/appraiser.html
```

同源後瀏覽器呼叫 API 不再跨來源（先前用 `python3 -m http.server 8000` 另開來源時，Gateway
沒有 CORS 標頭，真實瀏覽器會擋下請求），也只需要在第一次開啟時接受一次 Gateway 自簽憑證警告。
另開靜態伺服器仍可運作，但需自行處理 CORS；`api.js` 在非 https 來源時會退回
`https://localhost:8443`，也可在主控台執行
`localStorage.setItem('gatewayBaseUrl', 'https://your-host:port')` 覆寫。

瀏覽器須支援 TLS 1.3 的 `X25519MLKEM768` 混合金鑰交換（Chrome／Edge 131+、Firefox 132+；
已以 Edge 153 實測，見 `docs/dapp.md`）。

## 頁面

| 頁面 | 角色 | 對應需求 |
| --- | --- | --- |
| `owner.html` | 車主 | 自持 PQC 錢包（瀏覽器產生金鑰、IndexedDB、加密備份匯出匯入、換鑰）、在瀏覽器簽署保養授權與 QR 查詢授權（FFR2、D1）、即時通知（D3、UC-01） |
| `buyer.html` | 買家 | 掃 QR（`buyer.html#auth=<ID>`）或貼上授權，**在瀏覽器內**以鏈上公鑰驗章、檢查期限與簽署者是否為目前車主（D2、UC-02）；履歷顯示交易編號 |
| `appraiser.html` | 鑑定師 | FFR3、FFR4、UC-01（提交複檢、里程倒退紅字警示並鎖定送出） |

## 檔案

| 檔案 | 說明 |
| --- | --- |
| `api.js` | Gateway API 呼叫封裝、履歷表格（一般 script，定義全域 `api`） |
| `shared/authMessages.js` | 簽章訊息格式的唯一定義，Gateway 直接 re-export；須與鏈碼 `pqc.go` 逐位元組一致 |
| `walletCrypto.js` | 錢包的純密碼學部分：ML-DSA-65 金鑰／簽章／驗章、換鑰證明、買家驗證、PBKDF2＋AES-GCM 備份加密（不碰 DOM，Node.js 也能載入測試） |
| `wallet.js` | 錢包儲存層：IndexedDB 存取私鑰 |
| `vendor/` | 固定版本的前端函式庫（不從 CDN 載入，見 `vendor/README.md`） |
| `tests/walletCrypto.test.mjs` | `walletCrypto.js` 單元測試（`node --test web/tests/*.test.mjs`） |
| `tests/browser-smoke.html` | 真實瀏覽器冒煙測試頁，以同源 iframe 操作 owner／buyer 頁（`tests/e2e/browserSmoke.ps1` 驅動） |

## 自持金鑰錢包（plan_dApp.md D1）

- 金鑰在瀏覽器內產生，私鑰存於 IndexedDB（`vehiclenet-wallet` 資料庫），Gateway 只收到公鑰
  與簽章。第一次登記附「新私鑰的持有證明」、換鑰附「舊私鑰對新公鑰的簽章」，規則見
  `chaincode/vehicle/contract/pqc.go`；上鏈成功後才寫入本機，避免本機與鏈上不一致。
- **加密備份**：以密碼經 PBKDF2-SHA256（600,000 次）導出 AES-256-GCM 金鑰加密後下載；
  換電腦時用同一密碼匯入。
- **私鑰遺失**：瀏覽器端無法自行補救，需至監理站臨櫃核對身分後，由監理站強制重綁
  （Gateway 內部埠，見 `gateway/README.md`），車主頁會即時收到「已被強制重綁」通知。

## FFR4：里程倒退紅字警示並鎖定送出

鑑定師頁面在送出複檢前，先查詢車輛目前紀錄里程，若使用者輸入的里程低於目前紀錄，
立即顯示紅字警示並停用送出按鈕，需勾選「我已核實現場狀況」才能解鎖送出——這是**前端
UI 層的防呆**，與鏈碼端「不拒絕交易，改為記錄異常並扣分」（BFR3、UC-01 例外流程，見
`chaincode/vehicle/contract/scoring.go`）是兩層獨立機制（CLAUDE.md 編程風格「需求可
追溯」的雙層攔截設計，plan.md §6 對 FFR4 的驗證方式：「前端測試＋合約測試（雙層攔截）」）：
即使使用者略過或繞過前端警示直接呼叫 API，鏈碼仍會如實記錄並扣分，不會讓資料變得不
可信。送出後頁面會重新查詢事件歷史，若出現新的 `ANOMALY` 事件同樣以紅字呈現。

## 已知限制（PoC 範圍）

- QR Code 解析支援手機相機直接開啟 `buyer.html#auth=…` 網址，或在買家頁上傳圖片（`jsQR`）、
  手動貼上授權 JSON；未在網頁內整合相機即時掃描。
- 查詢授權驗證的是「車主同意查詢」這個意圖，不是資料存取的硬性關卡——履歷資料本身透過
  `GetSummary`／`GetVehicleHistory` 一律可查（區塊鏈透明性設計使然）。
- ML-DSA 尚未納入 WebCrypto，瀏覽器私鑰只能以原始位元組存在 IndexedDB，無法設為
  non-extractable；同源的任何腳本都讀得到，因此所有腳本皆從同源載入（`vendor/`）。
- 未實作登入／權限系統：任何人皆可在任一頁面輸入任意識別碼操作，PoC 階段以
  「操作介面對應角色」示範流程，不做身分驗證（畢業專題報告需標註此簡化）。車主頁的
  「展示用：模擬維修廠送出上鏈」按鈕即為單人展示而設，真實情境由維修廠以 SVC 身分送出。
