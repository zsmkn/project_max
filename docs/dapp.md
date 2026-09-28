# dApp 化（plan_dApp.md D0–D3）— 設計與驗證紀錄

狀態：**D0–D3 已完成，並在真實五組織網路（`vehicle@1.5`，sequence 6）與真實瀏覽器
（Microsoft Edge 153 headless）驗證通過**（2026/09/24）。D4（公有鏈錨定）為選做，本次未實作。

開始前確認的三項決策（plan_dApp.md §6）：

1. 課程的 dApp 定義：做到 D3 即可（不需要 MetaMask／公有鏈）。
2. D0 的漏洞修正一併回推到畢業專題，並記錄於畢業專題報告（docx）。
3. 私鑰遺失處理：採「監理站線下核對身分後強制重綁」。

## 1. 目標：把「中心化」的地方換掉

| 原本 | dApp 化後 |
| --- | --- |
| 車主私鑰放在 Gateway 伺服器（託管式錢包，plan.md §7 #5 的 PoC 簡化） | 私鑰在瀏覽器產生、存於 IndexedDB，Gateway 只看得到公鑰與簽章（D1） |
| 買家只能相信 Gateway 回報「簽章有效」 | 買家瀏覽器自己向鏈上取公鑰驗章（D2） |
| 車主要自己重新整理才知道車況變化 | 鏈碼發出事件，Gateway 以 SSE 即時推播（D3） |

Fabric 層交易仍由各組織的 X.509 身分送出，背書政策不變；車主以 PQC 簽章「授權」，
由組織「代送」。

## 2. D0 前置修正

### 2.1 修正的安全漏洞：任何人都能覆寫他人 PQC 公鑰

修正前的 `RegisterPQCKey(identity, publicKeyHex)` 不檢查呼叫者、允許直接覆寫。任何能送交易的
組織都能把車主的公鑰換成自己的，再偽造 `AddMaintenance` 的車主授權，FFR2／BFR5 形同失效。
私鑰由 Gateway 託管時風險被掩蓋；改成使用者自持金鑰後就必須先補上。

修正後的規則（`chaincode/vehicle/contract/pqc.go`）：

| 情境 | 函式 | 規則 |
| --- | --- | --- |
| 第一次登記 | `RegisterPQCKey(identity, publicKeyHex, proofSignatureHex)` | `proof` 須為**新私鑰**對 `RegisterPQCKey\|{identity}\|{publicKeyHex}` 的簽章（持有證明） |
| 換鑰 | 同上 | `proof` 須為**目前登記的舊私鑰**對 `RotatePQCKey\|{identity}\|{目前版本}\|{新公鑰}` 的簽章；含版本號，舊的換鑰簽章無法重放（A→B→A 後重放 A→B 會被拒） |
| 私鑰遺失 | `ForceRebindPQCKey(identity, publicKeyHex, proofSignatureHex, reason)` | **僅限 REG**；仍需新私鑰的持有證明與原因；寫入稽核紀錄並發出事件 |
| 查詢 | `GetPQCKey(identity)` | 任何組織皆可，供 D2 買家驗章 |

資料模型：

- `PQCKey`（`PQC:{identity}`）新增 `version`（從 1 起算，每次換鑰或強制重綁 +1）。
- 新增 `PQCKeyLog`（`PQCLOG:{identity}:{時間}:{txId}`）：每次登記、換鑰、強制重綁都記一筆
  `{action, version, publicKeyHash, submittingOrg, reason, txId, timestamp}`，只存公鑰的 SHA-256。
- **升級相容**：修正前登記的公鑰沒有 `version` 欄位，讀取時視為第 1 版，舊私鑰仍可正常換鑰。
  已在真實網路以 2026/09/22 於 `vehicle@1.4` 登記的身分 `owner-hash-gateway-test` 驗證：
  升級後讀到 `version: 1`，以舊私鑰換鑰後成為 `version: 2`。

Gateway 端：強制重綁端點 `POST /api/pqc-keys/:identity/force-rebind` **只掛在 loopback 內部埠**
（8080），對外的 Kyber TLS 埠回傳 404，外部瀏覽器無法借用 Gateway 的 REG 身分觸發。
託管錢包模式改為「上鏈成功後才寫入錢包」，避免錢包與鏈上不一致。

### 2.2 網頁與 Gateway 同源（plan-aws.md §4 #2 共用修正）

先前網頁用 `python3 -m http.server 8000` 另開來源呼叫 `https://localhost:8443`，Gateway 沒有
CORS 標頭，真實瀏覽器會擋下（階段 5 已記錄「真實瀏覽器測試未執行」）。改為 Gateway 以
`express.static` 同源提供 `web/`，`api.js` 預設呼叫同源 API。

### 2.3 順帶發現並修正的既有缺陷

實作與真實瀏覽器驗證時發現以下四項既有缺陷，一併修正：

| 缺陷 | 影響 | 修正 |
| --- | --- | --- |
| `owner.html` 引用的 `qrcode@1.5.3/build/qrcode.min.js` CDN 網址為 404 | 車主頁的 QR Code 在真實瀏覽器中從未能顯示 | 改為本地固定版本 `web/vendor/qrcode-1.5.3.js`（同時符合「不從 CDN 載入」原則） |
| ML-DSA-65 簽章約 3,309 bytes（十六進位 6,618 字元），超過單一 QR Code 上限 2,953 bytes | 即使函式庫載入成功，QR Code 也放不下授權內容 | QR 只放內容定址 ID（授權的 SHA-256），完整授權由 Gateway 暫存轉交；買家重算 ID 比對，Gateway 無法竄改（見 §4） |
| Gateway 只回傳 `err.message`（`10 ABORTED: failed to endorse transaction`） | 寫入交易被鏈碼拒絕時，使用者看不到真正原因（例如「授權簽章驗證失敗」） | `gateway/src/gatewayErrors.ts` 從錯誤 `details` 取出鏈碼的中文訊息（去重、去除節點資訊） |
| 查詢授權驗證只檢查簽章，不檢查簽署者是否為這台車的車主 | 任何人都能用自己登記的金鑰替別人的車簽出「有效」授權 | 瀏覽器端與 Gateway verify 端點都加上 `GetSummary().ownerHash === ownerIdentity` 檢查 |

## 3. D1 自持金鑰錢包

| 元件 | 說明 |
| --- | --- |
| `web/shared/authMessages.js` | 簽章訊息格式的**唯一定義**，瀏覽器直接載入，Gateway 的 `authorizationMessages.ts` re-export 同一份；須與 `pqc.go` 逐位元組一致 |
| `web/walletCrypto.js` | 純密碼學：ML-DSA-65 金鑰產生／簽章／驗章、換鑰證明、買家驗證、備份加解密。不碰 DOM，Node.js 也能載入測試 |
| `web/wallet.js` | IndexedDB 儲存層 |
| `web/vendor/` | 固定版本函式庫（`@noble/post-quantum@0.7.1` 與 Gateway 同版本，已驗證與鏈碼 CIRCL 互通），附 SHA-256 |

- 備份檔：密碼經 PBKDF2-SHA256（600,000 次，OWASP 2023 建議值）導出 AES-256-GCM 金鑰；
  `identity` 同時作為 GCM 附加驗證資料，改動檔案中的身分欄位會使解密失敗。
- 私鑰相關腳本一律同源載入，不使用 CDN。

**兩種模式的差異（報告說明用）：**

| | 託管錢包（原 PoC） | 自持金鑰（dApp） |
| --- | --- | --- |
| 私鑰位置 | Gateway 伺服器 `gateway/wallet/`（明文 JSON） | 使用者瀏覽器 IndexedDB |
| Gateway 看得到私鑰？ | 是 | 否，只看得到公鑰與簽章 |
| Gateway 被入侵的後果 | 可冒用所有車主簽章 | 無法冒用車主簽章 |
| 換裝置 | 無需處理 | 匯出／匯入加密備份檔 |
| 私鑰遺失 | 不會發生（伺服器保管） | 監理站臨櫃核對後強制重綁，全程留下鏈上紀錄 |
| 用途 | e2e 測試、展示備援 | 網頁預設 |

## 4. D2 瀏覽器端自行驗證

流程（`web/buyer.html`，與 `tests/e2e/dappD2BrowserVerify.mjs` 相同）：

1. 車主瀏覽器簽署 `QueryAuthorization|{vin}|{expiresAt}`，把 `{vin, ownerIdentity, expiresAt, signatureHex}`
   交給 `POST /api/query-authorizations` 暫存，取得內容定址 ID（固定欄位順序 JSON 的 SHA-256）。
2. QR Code 內容為 `https://<gateway>/buyer.html#auth=<ID>`，手機相機掃描即開啟買家頁。
3. 買家瀏覽器取回授權並**重算 ID**，不符即拒絕（Gateway 不可能竄改內容而不被發現）。
4. 向 Gateway 取「鏈上原始資料」：`GetPQCKey(ownerIdentity)` 公鑰、`GetSummary(vin).ownerHash`。
5. 在瀏覽器內檢查：期限未過、簽署者是目前車主、ML-DSA-65 簽章有效。**不呼叫** Gateway 的 verify 端點。
6. 履歷每筆事件顯示交易編號（`txId`），可向任一組織的 peer 交叉查證。

暫存區（`gateway/src/authorizationStore.ts`）只存在記憶體、到期即刪、有效期限上限 24 小時、
總筆數上限 10,000，避免被塞爆。

## 5. D3 鏈上事件即時推播

- 鏈碼（`chaincode/vehicle/contract/events.go`）：每個寫入函式成功後 `SetEvent`。Fabric 每筆交易
  只能有一個事件，因此異常以欄位帶出：
  - `VehicleEvent`：`{vin, eventType, txId, timestamp, submittingOrg, integrityScore, residualValue, anomalies[]}`，
    `anomalies[]` 為本交易新偵測到的 `{anomalyType, scoreDelta, description}`。由 `InitVehicle` 與
    `recalcAndApply`（其餘五個寫入函式共用）發出。
  - `PQCKeyEvent`：內容即 `PQCKeyLog`，公鑰登記、換鑰、強制重綁時發出。
- Gateway（`gateway/src/events.ts`）：`network.getChaincodeEvents()` 訂閱，依 VIN／身分分流；
  訂閱中斷時每 3 秒重試。只有已提交且有效的交易會產生事件。
- SSE 端點：`GET /api/vehicles/:vin/events`、`GET /api/pqc-keys/:identity/events`，每 15 秒送心跳。
- 車主頁以瀏覽器原生 `EventSource` 接收（斷線自動重連），異常扣分以紅色通知顯示。

## 6. 驗證結果（2026/09/24，真實五組織網路 `vehicle@1.5`／sequence 6）

| 項目 | 指令 | 結果 |
| --- | --- | --- |
| 鏈碼單元測試 | `cd chaincode/vehicle && go test ./...`、`go vet ./...`、`gofmt -l` | 54 個測試全數通過（新增 D0 11 個、D3 4 個）；vet／gofmt 乾淨 |
| Gateway 單元測試／型別檢查 | `cd gateway && npx vitest run && npx tsc --noEmit` | 26 個測試全數通過（新增事件分流、授權暫存、錯誤訊息、錢包拆分） |
| 網頁錢包單元測試 | `node --test web/tests/*.test.mjs` | 14 個測試全數通過 |
| 端到端（既有＋D0–D3） | `make e2e` | 8 個情境全數通過：UC-01、UC-02、UC-03、EIR1、D0、D1、D2、D3 |
| D1「關掉 Gateway 錢包」 | 以空的 `PQC_WALLET_DIR` 啟動 Gateway，執行 D0–D3 並設 `EXPECT_EMPTY_WALLET_DIR` | 全數通過，錢包目錄維持 0 個檔案 |
| 升級相容 | 對 `vehicle@1.4` 時期登記的身分換鑰 | 成功，`version` 1 → 2 |
| 真實瀏覽器 | `tests/e2e/browserSmoke.ps1`（Edge 153 headless，經 Kyber TLS） | 9 個步驟全數通過（見下） |

真實瀏覽器冒煙測試（`web/tests/browser-smoke.html` 以同源 iframe 操作真正的 owner／buyer 頁）：

```
PASS D0 同源呼叫 Gateway 建立測試車
PASS D1 瀏覽器產生金鑰並登記上鏈
PASS D1 IndexedDB 私鑰與鏈上公鑰一致
PASS D1 瀏覽器簽章的保養授權上鏈        （2,221 ms）
PASS D3 車主頁即時收到扣 40 分通知       （2,450 ms）
PASS D2 QR Code 可解碼為買家網址（內容定址 ID）
PASS D2 買家瀏覽器以鏈上公鑰驗章通過
PASS D2 履歷顯示交易編號
PASS D2 竄改後瀏覽器端驗證失敗
```

**plan_dApp.md §5 驗收標準對照：**

| 階段 | 驗收標準 | 結果 |
| --- | --- | --- |
| D0 | 未附持有證明被拒、他人覆寫被拒、舊鑰可換鑰、REG 可強制重綁；既有 `go test`、`make e2e` 仍通過 | ✅ 單元測試＋`dappD0KeyRules.mjs`；既有測試全數通過 |
| D1 | 關掉 Gateway 錢包後仍能從瀏覽器完成保養授權並上鏈；竄改訊息被鏈碼拒絕；匯出檔換瀏覽器匯入後可正常簽章 | ✅ `dappD1SelfCustody.mjs`（空錢包目錄）＋真實瀏覽器冒煙測試 |
| D2 | 竄改 QR 內容或過期時，瀏覽器端直接顯示驗證失敗（不經 verify 端點） | ✅ `dappD2BrowserVerify.mjs`（竄改期限、竄改簽章、過期、冒名）＋真實瀏覽器 |
| D3 | 鑑定師提交里程倒退複檢後，車主頁數秒內跳出扣 40 分通知 | ✅ 送出複檢到車主收到通知約 2.2–2.5 秒（含背書、排序、提交） |

## 7. 已知限制與未驗證項目

- **備份匯入的檔案選擇 UI** 未在真實瀏覽器中自動化（headless 無法操作檔案選擇器）；匯出／匯入的
  加解密邏輯與網頁共用同一份 `walletCrypto.js`，已由單元測試與 `dappD1SelfCustody.mjs` 在真實網路驗證。
- 真實瀏覽器只測了 Edge（Chromium）；Firefox／Safari 未測。
- ML-DSA 尚未納入 WebCrypto，瀏覽器私鑰無法設為 non-extractable，同源腳本都讀得到。
- 第一次登記採「先登記者得」：若有人搶先替某車主化名登記公鑰，需由監理站強制重綁處理。
- 未實作登入：Gateway 對外埠的寫入端點仍可被任何人呼叫（PoC 範圍，與階段 5 相同）；強制重綁
  已限縮到 loopback 內部埠。
- 查詢授權暫存只在 Gateway 記憶體，Gateway 重啟後需車主重新產生 QR Code。
- D4（以太坊 Sepolia 錨定）未實作。
