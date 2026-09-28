# gateway/

車輛履歷系統的 Fabric Gateway REST API（Node.js/TypeScript），對應 plan.md 階段 3／5。

## 目前範圍（階段 3＋5）

- **依角色切換組織身分**（階段 5，plan.md §7 #11 已定案）：`src/fabricClient.ts` 的
  `FabricConnectionPool` 在單一 Gateway 服務內同時管理 REG／OEM／SVC／INS／APP
  五個組織各自的 MSP identity／signer（`src/config.ts` 的 `orgConfigs`），依鏈碼函式
  所需的組織身分（`requireOrg`，見 `chaincode/vehicle/contract/contract.go`）選用對應
  連線送出交易（`InitVehicle`→OEM、`AddMaintenance`→SVC、`RecordClaim`→INS、
  `SubmitInspection`→APP、`TransferOwnership`／`ScrapVehicle`→REG）。查詢類交易固定用
  `defaultQueryOrg`（預設 REG）。**PoC 簡化**：正式產品應拆成各組織各自部署 Gateway，
  畢業專題報告需標註此簡化範圍。
- **PQC 金鑰：兩種模式並存**（plan_dApp.md D1，見 `../docs/dapp.md`）：
  - **自持金鑰（dApp，網頁預設）**：車主在瀏覽器產生金鑰、簽章（`../web/wallet.js`），
    Gateway 只代送 `RegisterPQCKey` 與 `AddMaintenance`，全程看不到私鑰。
  - **託管錢包（保留供 e2e 測試與展示備援）**：伺服器端產生／保管 Dilithium（ML-DSA-65）
    金鑰（`src/pqcWallet.ts`）。**私鑰明文存於 `wallet/` 目錄（已 `.gitignore` 排除）**，
    見檔案內註解的安全性警示。
- **簽章訊息格式**：唯一定義在 `../web/shared/authMessages.js`，`src/authorizationMessages.ts`
  直接 re-export，網頁與 Gateway 共用，須與鏈碼 `pqc.go` 逐位元組一致。
- **網頁同源提供**（plan_dApp.md D0）：HTTPS 埠以 `express.static` 提供 `../web/`
  （`GATEWAY_WEB_DIR` 可覆寫），瀏覽器開 `https://localhost:8443/owner.html` 即同源呼叫 API，
  不需要 CORS。
- **鏈上事件即時推播**（plan_dApp.md D3）：`src/events.ts` 以 `network.getChaincodeEvents()`
  訂閱鏈碼的 `VehicleEvent`／`PQCKeyEvent`，依 VIN／身分分流後以 Server-Sent Events 推給瀏覽器；
  訂閱中斷會自動重試。
- **查詢端點**：`GetSummary`、`GetVehicleHistory`（FFR1／IIR2）。
- **PQC 公鑰登記**：呼叫鏈碼 `RegisterPQCKey`（BFR5）。鏈碼 `vehicle@1.5` 起要求第一次登記
  附新私鑰的持有證明、換鑰附舊私鑰簽章；私鑰遺失由監理站經內部埠 `ForceRebindPQCKey` 強制重綁。
- **買家查詢授權**（plan.md §7 #10，UC-02）：車主簽署「VIN + 有效期限」短期授權。
  ML-DSA-65 簽章約 3.3 KB、放不進 QR Code，因此 QR 只放內容定址 ID（授權的 SHA-256），
  完整授權由 `src/authorizationStore.ts` 暫存轉交（記憶體、到期即刪、最長 24 小時）；買家瀏覽器
  取回後自行重算 ID 並以鏈上公鑰驗章（D2）。舊的驗證端點保留，公鑰改取自鏈上並檢查簽署者是否為目前車主。
- **錯誤訊息**：`src/gatewayErrors.ts` 從 Fabric 背書錯誤的 `details` 取出鏈碼的中文拒絕原因回傳
  （先前只回傳「10 ABORTED: failed to endorse transaction」，使用者看不到真正原因）。
- **Kyber TLS 邊界**（BFR4）：HTTPS 伺服器只接受 `X25519MLKEM768` 混合金鑰
  交換（`src/server.ts`），不支援後量子金鑰交換的用戶端會直接握手失敗
  （對應 UC-02 例外流程）。
- **內部服務埠（階段 6，EIR1／EIR2）**：另外監聽 `http://127.0.0.1:8080`（純
  HTTP，僅限 loopback，可用 `GATEWAY_INTERNAL_HTTP_PORT` 覆寫），供 `../mocks/`
  的監理站／保險公司模擬服務呼叫，業務路由與上面的 HTTPS 埠相同；差異只有兩點：
  內部埠**另外**提供僅限監理站使用的強制重綁端點（plan_dApp.md §2），HTTPS 埠**另外**提供
  `web/` 靜態頁面。不套用 Kyber-only 限制的原因見 `src/server.ts` 的註解：BFR4／IIR1 的範圍是
  「瀏覽器／客戶端 ↔ Gateway」邊界，且 WSL2 系統 OpenSSL 3.0.2 尚不支援
  `X25519MLKEM768`，Python 模擬服務無法完成 Kyber-only 握手。

## 快速開始

```bash
cd gateway
npm install
cp .env.example .env   # 視需要覆寫預設值

# 產生本機開發用的自簽 TLS 憑證（僅需一次）
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -keyout certs/gateway-key.pem \
  -out certs/gateway-cert.pem -days 365 -nodes -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

npm run dev   # 需先啟動 network/（network.sh up && createChannel && deployCC.sh）
```

預設監聽 `https://localhost:8443`。啟動時會連線五個組織各自的 `peer0.{org}`
（皆以 `User1@{org}.vehiclenet.tw` 身分，見 `src/config.ts` 的 `orgConfigs`），
依請求呼叫的鏈碼函式選用對應組織身分送出交易（見上方「依角色切換組織身分」）；
除了預設查詢組織（REG）會在啟動時預先連線，其餘組織的連線在第一次需要時才建立。

可用 `FABRIC_<ORG>_MSP_ID` / `_PEER_ENDPOINT` / `_PEER_HOST_ALIAS` /
`_TLS_CERT_PATH` / `_CERT_DIR` / `_KEY_DIR`（`<ORG>` 為 `REG`／`OEM`／`SVC`／
`INS`／`APP`）分別覆寫各組織的連線設定，見 `.env.example`。

## 測試 Kyber TLS

一般瀏覽器／`curl`／舊版 OpenSSL 若不支援 `X25519MLKEM768`，連線會直接
handshake failure（這是設計行為，不是 bug）。用 Node.js 22（內建支援）驗證：

```js
import https from 'node:https';
https.request(
  { hostname: 'localhost', port: 8443, path: '/api/vehicles/<vin>/summary',
    rejectUnauthorized: false, ecdhCurve: 'X25519MLKEM768', minVersion: 'TLSv1.3' },
  (res) => res.on('data', (c) => process.stdout.write(c)),
).end();
```

## API

| 方法 | 路徑 | 組織身分 | 說明 |
| --- | --- | --- | --- |
| POST | `/api/pqc-keys/:identity` | defaultQueryOrg | 託管模式：Gateway 錢包產生金鑰，附持有證明／換鑰簽章登記上鏈（`RegisterPQCKey`，BFR5） |
| POST | `/api/pqc-keys/:identity/register` | defaultQueryOrg | 自持模式：代送瀏覽器產生的 `{ publicKeyHex, proofSignatureHex }`（D1） |
| GET | `/api/pqc-keys/:identity` | defaultQueryOrg | 鏈上公鑰（`GetPQCKey`，含 `version`；未登記回 404，D2） |
| GET | `/api/pqc-keys/:identity/events` | — | SSE：公鑰登記／換鑰／強制重綁通知（`PQCKeyEvent`，D3） |
| POST | `/api/pqc-keys/:identity/force-rebind` | REG（**僅內部埠**） | 監理站線下核對身分後強制重綁（`ForceRebindPQCKey`），body `{ publicKeyHex, proofSignatureHex, reason }` |
| POST | `/api/vehicles` | OEM | 出廠初始化（`InitVehicle`，BFR1，UC-03） |
| GET | `/api/vehicles/:vin/summary` | defaultQueryOrg | 車輛摘要（誠信分數、殘值，FFR1／IIR2） |
| GET | `/api/vehicles/:vin/history?from=&to=` | defaultQueryOrg | 生命週期事件（FFR1／IIR2），每筆含 `txId` |
| GET | `/api/vehicles/:vin/events` | — | SSE：該車的寫入事件與異常扣分（`VehicleEvent`，D3、UC-01） |
| POST | `/api/vehicles/:vin/maintenance/authorize` | （託管錢包簽章，不送鏈上交易） | 車主簽署保養授權（FFR2；自持模式改在瀏覽器簽） |
| POST | `/api/vehicles/:vin/maintenance` | SVC | 保養／維修紀錄（`AddMaintenance`，BFR2，需車主授權簽章） |
| POST | `/api/vehicles/:vin/claims` | INS | 保險理賠存證（`RecordClaim`，BFR2、EIR2） |
| POST | `/api/vehicles/:vin/inspections` | APP | 實體複檢（`SubmitInspection`，BFR3、FFR3，UC-01） |
| POST | `/api/vehicles/:vin/transfer` | REG | 過戶（`TransferOwnership`，BFR2） |
| POST | `/api/vehicles/:vin/scrap` | REG | 報廢（`ScrapVehicle`，BFR2、EIR1） |
| POST | `/api/vehicles/:vin/query-authorization` | （託管錢包簽章，不送鏈上交易） | 車主簽署買家查詢授權（UC-02；自持模式改在瀏覽器簽） |
| GET | `/api/vehicles/:vin/query-authorization/verify` | defaultQueryOrg（查鏈上公鑰與車主） | 驗證查詢授權簽章、有效期限與簽署者是否為目前車主 |
| POST | `/api/query-authorizations` | （記憶體暫存） | 暫存車主已簽好的查詢授權，回傳內容定址 `{ id }`（D2） |
| GET | `/api/query-authorizations/:id` | （記憶體暫存） | 取回授權；買家須自行重算 ID 比對（D2） |

見 `../web/README.md` 的三種角色介面（`owner.html`／`buyer.html`／
`appraiser.html`）如何呼叫以上端點；`../docs/stage5-gateway-web.md` 記錄了
以此 API 走完 UC-01／UC-02／UC-03 關鍵步驟的真實五組織網路端到端驗證結果。
