# 階段 3：PQC 整合 — 進度記錄

> **2026/09/24 後續修正**：本文件記錄的 `RegisterPQCKey(identity, publicKeyHex)` 允許任何組織
> 直接覆寫他人公鑰，是一個安全漏洞。`vehicle@1.5` 起改為 `RegisterPQCKey(identity, publicKeyHex,
> proofSignatureHex)`（第一次登記需持有證明、換鑰需舊私鑰簽章），並新增 `ForceRebindPQCKey`
> （僅限 REG）與 `GetPQCKey`。詳見 [dapp.md](dapp.md) §2。

狀態：**進行中。chaincode 端 PQC（BFR5 鏈碼部分）與 Gateway 骨架（金鑰錢包、查詢端點、Kyber TLS 邊界 BFR4）皆已完成並驗證通過。尚未實作：依角色切換組織身分、AddMaintenance／RecordClaim 等寫入交易走 Gateway、瀏覽器端整合**。
對應 plan.md §5 階段 3：「Dilithium 公鑰登記與 chaincode 驗證（BFR5）；金鑰錢包；Kyber TLS 邊界代理（BFR4）」。

## 已完成：chaincode 端 PQC（BFR5 鏈碼部分）

### 1. 依賴：`github.com/cloudflare/circl v1.6.3`

延續 docs/stage0-validation.md 的驗證結論：CIRCL 鎖定在 v1.6.0–v1.6.3
（更新版本要求 go 1.25+，`fabric-ccenv:2.5.9` 只內建 Go 1.22.4，會建置失敗）。
`go.mod` 的 `go` 版本宣告因此從 1.19 提升到 `circl` 要求的 1.22.0（仍在 ccenv
的 1.22.4 範圍內，見 `go.mod` 內註解）。使用的簽章方案是 ML-DSA-65
（`sign/mldsa/mldsa65`），即 FIPS 204 標準化後的 CRYSTALS-Dilithium 第三
安全等級。鏈碼只做「驗證」，不簽章、不產生金鑰（CLAUDE.md「密碼學與安全」：
不自行實作密碼學演算法、使用經審查的函式庫）。

### 2. 資料模型與狀態鍵（`contract/model.go`、`contract/keys.go`）

- `PQCKey`（`PQC:{identity}`）：`{docType, identity, algorithm, publicKeyHex,
  registeredAt}`。`identity` 是任意身分字串——組織成員或車主化名雜湊皆可
  （車主不是 Fabric MSP 身分，因此 `RegisterPQCKey` 不限制呼叫者組織）。

### 3. `contract/pqc.go`（新檔案）

- `RegisterPQCKey(ctx, identity, publicKeyHex) error`：解析並驗證公鑰格式
  （長度需等於 `mldsa65.PublicKeySize`、可成功 `UnmarshalBinary`）後寫入
  `PQC:{identity}`。允許覆蓋（金鑰輪替）。
- `verifyDilithiumAuthorization(ctx, identity, message, signatureHex) error`：
  查詢 `identity` 登記的公鑰，驗證 `message` 的簽章；任何一步失敗（未登記、
  格式錯誤、驗證不通過）一律回傳錯誤拒絕交易，不寫入狀態。
- `maintenanceAuthorizationMessage(vin, serviceType, mileage, description)
  []byte`：組出 `AddMaintenance` 車主授權訊息的固定格式
  （`AddMaintenance|{vin}|{serviceType}|{mileage}|{description}`），確保
  簽章與實際寫入內容一一綁定，竄改任何欄位都會讓驗證失敗。

### 4. 接上 `AddMaintenance`（FFR2、BFR5）

`contract.go` 的 `AddMaintenance` 新增第六個參數 `ownerSignatureHex`：在
「車輛已報廢」檢查之後、寫入任何狀態之前，查詢該車輛 `OwnerHash` 登記的
PQC 公鑰並驗證簽章，失敗則整筆交易拒絕（不進入 Fabric 背書／排序流程外的
任何寫入）。plan.md §3.1 只在 `AddMaintenance` 標註 FFR2（需車主簽章授權），
其餘寫入函式（`RecordClaim`、`TransferOwnership`、`ScrapVehicle`）暫不要求
車主簽章，維持原設計範圍。

### 5. 單元測試（`contract_test.go`，新增 7 個，全數通過）

```
TestRegisterPQCKey_Success_BFR5
TestRegisterPQCKey_InvalidPublicKey_Rejected_BFR5
TestAddMaintenance_TamperedSignature_Rejected_BFR5   （簽章與交易內容不符）
TestAddMaintenance_WrongSignerKey_Rejected_BFR5      （用未登記的金鑰簽章）
TestAddMaintenance_OwnerKeyNotRegistered_Rejected_BFR5
```

測試用真實 `mldsa65.GenerateKey`／`SignTo` 產生金鑰與簽章（而非假資料），
`initTestVehicle` 測試輔助函式同步登記車主 PQC 公鑰並回傳私鑰，供各測試
簽署對應的 `AddMaintenance` 訊息。`go test ./...`、`go vet ./...`、
`gofmt -l`（僅檢查專案自身檔案，不含 vendor）皆乾淨通過。

### 6. 已驗證：真實 `fabric-ccenv:2.5.9` 容器內建置成功

延續階段 2 的驗證模式：

```
docker run --rm -v "$(pwd)":/cc -w /cc hyperledger/fabric-ccenv:2.5.9 \
  bash -lc 'go vet -mod=vendor ./... && go build -mod=vendor -o /tmp/out .'
```

確認 CIRCL 依賴（連同其對 `golang.org/x/sys` 的間接依賴）在 ccenv 的
Go 1.22.4 環境下可正常 vet／build，延續階段 0／2 對此風控點的持續驗證。

### 7. 已驗證：真實五組織網路端到端測試

以 `vehicle@1.2`（sequence 3）部署至既有 `vehiclechannel`，用一組真實產生的
mldsa65 金鑰對／簽章（測試工具腳本，用後即刪，不在專案內），透過 peer CLI
驗證：

1. `RegisterPQCKey` 登記車主公鑰成功。
2. `AddMaintenance` 附上對「里程 12000」正確內容的簽章 → 成功，
   `GetSummary` 確認里程正確更新為 12000。
3. `AddMaintenance` 用同一組簽章但把里程改成 99999（模擬竄改）→ 交易被拒，
   錯誤訊息「車主保養授權驗證失敗：授權簽章驗證失敗」，且 `GetSummary`
   確認里程仍是 12000（竄改交易確實未寫入任何狀態）。

## 已完成：Gateway 骨架（`gateway/`，Node.js 22 + TypeScript）

### 1. 專案設定：ESM（非 CommonJS）

`@noble/post-quantum`（PQC 金鑰錢包用的簽章函式庫，見下）只發佈 ESM 版本
（`package.json` 的 `"type": "module"`），靜態 `import` 編譯成 CommonJS
`require()` 會在執行時丟出 `ERR_REQUIRE_ESM`。因此 `gateway/package.json`
設定 `"type": "module"`、`tsconfig.json` 設定 `"module": "NodeNext"`，
本機相對路徑的 import 需帶 `.js` 副檔名（NodeNext 的規則，即使原始檔是
`.ts`）；`__dirname` 改用 `path.dirname(fileURLToPath(import.meta.url))`
換算（ESM 沒有 `__dirname`）。`@hyperledger/fabric-gateway`、
`@grpc/grpc-js`、`express` 皆為 CommonJS 套件，在 ESM 環境下可直接
具名 import，無相容性問題。

### 2. Fabric 連線（`src/fabricClient.ts`、`src/config.ts`）

直接連線 `peer0.app.vehiclenet.tw:11051`（Fabric 2.4+ peer 內建 Gateway
服務，不需要另外的 Gateway 節點），身分為
`network/organizations/peerOrganizations/app.vehiclenet.tw/users/User1@app...`
（APP 組織，對應「鑑定師」角色）。peer TLS 憑證的 SAN 已包含
`localhost`（見憑證內容），本機開發不需另外設定 SNI／hostname override。

### 3. PQC 金鑰錢包（`src/pqcWallet.ts`）：`@noble/post-quantum` v0.7.1

鏈碼端用 CIRCL（Go）「驗證」簽章；Gateway 端需要「產生金鑰＋簽章」，
選用 `@noble/post-quantum` 的 `ml_dsa65`——純 TypeScript／JavaScript 實作
FIPS 204（ML-DSA），經審查、無原生相依（符合 CLAUDE.md「不自行實作密碼學
演算法」）。

**關鍵風控點：跨語言相容性已手動驗證**——用 `@noble/post-quantum` 產生金鑰、
簽署一段訊息，寫出公鑰／簽章的十六進位編碼，再用 CIRCL（與 chaincode 內
完全相同的函式庫與呼叫方式）驗證，結果為 `true`。公鑰／簽章長度也與 CIRCL
的 `mldsa65.PublicKeySize`（1952 bytes）／`SignatureSize`（3309 bytes）
逐位元組相符。這證實兩個獨立函式庫（Go 的 CIRCL、TypeScript 的
noble-post-quantum）對 ML-DSA-65 的實作互通，車主用 Gateway／瀏覽器端
簽出的授權簽章可以被鏈上 chaincode 正確驗證。

**安全性警示（PoC 簡化，已寫入程式註解與 gateway/README.md）**：私鑰以
明文 JSON 存放於 `gateway/wallet/`（`.gitignore` 的 `**/wallet/` 規則已
排除，不會被提交）。畢業專題報告需明確標註此為 PoC 簡化，正式產品應改為
加密靜態儲存或使用者裝置端保管私鑰。

### 4. Kyber TLS 邊界（`src/server.ts`，BFR4）

延續 docs/stage0-validation.md 的建議：HTTPS 伺服器的 `ecdhCurve` 設定**只**
包含 `X25519MLKEM768`（不含傳統群組作為備援），刻意讓不支援後量子混合金鑰
交換的用戶端連線失敗，直接對應 UC-02 例外流程「握手失敗時拒絕連線」。

**已驗證**（用真實 HTTPS 請求，非模擬）：

- 用 WSL2 Ubuntu 22.04 系統內建 `curl`（連結舊版 OpenSSL，不支援
  `X25519MLKEM768`）連線 → TLS handshake failure（`SSL routines::sslv3
  alert handshake failure`），**符合預期的拒絕行為**。
- 用 Node.js 22 內建 `https` 用戶端（同樣設定 `ecdhCurve:
  'X25519MLKEM768'`）連線 → 成功，TLS 1.3／`TLS_AES_256_GCM_SHA384`，
  正確取得 API 回應。由於伺服器端 `ecdhCurve` 只列出這一個群組（沒有
  備援群組可退回），握手成功即代表協商到的必定是
  `X25519MLKEM768`，不需額外的群組名稱內省即可確認。

### 5. REST API 端到端驗證（對照既有五組織網路，`vehicle@1.2`）

以 Node.js 用戶端（符合 Kyber TLS 要求）依序呼叫，全部成功：

1. `GET /api/vehicles/:vin/summary`、`GET /api/vehicles/:vin/history`：
   正確回傳先前用 peer CLI 建立的 `VIN-PQC-DEMO-1` 資料（含 INIT、
   MAINTENANCE 事件）。
2. `POST /api/pqc-keys/:identity`：金鑰錢包產生新金鑰，成功送出
   `RegisterPQCKey` 交易並提交上鏈。
3. `GET /api/pqc-keys/:identity`：回傳剛才登記的公鑰。
4. `POST /api/vehicles/:vin/maintenance/authorize`：車主錢包對保養內容
   簽章，回傳 `signatureHex`（與 chaincode 端訊息格式一致，供之後 SVC
   端提交 `AddMaintenance` 時附帶；本階段未實作跨組織身分送出交易，
   見下方「尚未完成」）。

## 尚未完成

- **依角色切換組織身分**：目前 Gateway 只設定單一 APP 組織身分。
  `AddMaintenance`（需 SVC）、`RecordClaim`（需 INS）等寫入交易若要
  透過本 Gateway 送出，需要依請求切換身分（例如同一服務內管理多組
  identity/signer，或改為每組織各自一個 Gateway 服務實例）；目前
  `maintenance/authorize` 端點只做「車主簽章」，不送出鏈上交易，是刻意的
  範圍界線而非疏漏。**2026-09-23 已定案（見 plan.md §7 第 11 項）**：採
  「單一 Gateway 服務，內部管理多組身分」，階段 5 實作。
- 前端瀏覽器與 `X25519MLKEM768` 的相容性（docs/stage0-validation.md
  提及近期 Chrome／Firefox 已預設支援，但尚未實際用瀏覽器測試）。
- 其餘寫入函式是否也需要類似的組織端 Dilithium 雙層簽章（plan.md §2
  #1「雙層簽章」原意涵蓋所有業務資料，不只車主授權）：目前僅實作了
  plan.md §3.1 明確標註 FFR2 的 `AddMaintenance` 車主授權一項。

## 驗收標準對照（plan.md §5 階段 3）

| 驗收標準 | 狀態 |
| --- | --- |
| 簽章被竄改時交易被拒 | ✅ chaincode 端已驗證（單元測試＋真實網路） |
| Kyber 握手成功、失敗時拒絕連線（UC-02 例外流程） | ✅ 已驗證（見上「Kyber TLS 邊界」） |

下一步：階段 4（評分引擎，BFR3）或補強階段 3 剩餘項目（多組織身分切換、
瀏覽器相容性測試），依使用者優先順序決定。
