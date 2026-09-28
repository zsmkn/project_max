# 階段 1：五組織網路 — 完成記錄

完成日期：2026-09-22
對應 plan.md §5 階段 1：「擴充為 REG/OEM/SVC/INS/APP；Fabric CA；3 個 Raft 排序節點；
每組織 1 個 peer + CouchDB；建立 channel」。實作內容見 [network/](../network/)，
使用說明見 [network/README.md](../network/README.md)。

## 驗收標準逐項確認

| 驗收標準 | 結果 |
| --- | --- |
| 五組織 peer 皆加入 channel | ✅ `network.sh up` → `network.sh createChannel` 後，REG/OEM/SVC/INS/APP 五個 peer 皆成功加入 `vehiclechannel`（3 個排序節點以 channel participation API／`osnadmin` 加入，5 個 peer 以 `peer channel join` 加入，REG/OEM/SVC/INS 並設定 anchor peer） |
| 停掉 1 個 orderer 與 1 個 peer 後仍可寫入（NFR3 初驗） | ✅ `scripts/faultToleranceTest.sh`：停掉 `orderer2`（3 個 Raft 節點之一）與 `peer0.svc`，在僅剩 2/3 排序節點與 4/5 peer 存活時，送出 APP 組織的 anchor peer 設定交易（一筆真實的 channel 設定交易），成功提交；復原後五個 peer 的 channel 區塊高度一致（皆為 6），證實離線的 peer 重新加入後可追上進度 |

## 新發現：本機 Docker 映像檔 `latest` 標籤實際指向 Fabric 3.1.5

沿用 docs/stage0-validation.md 驗證過的環境時發現：本機 `hyperledger/fabric-peer:latest`、
`fabric-orderer:latest`、`fabric-ca:latest`、`fabric-ccenv:3.1` 等標籤，實際上是 **Fabric v3.1.5**
（`go1.26.4`），而非階段 0 驗證的 2.5.9／CIRCL v1.6.3 組合。`docker images` 當時**沒有**任何
`2.5.9` 或 `1.5.9` 標籤的本機映像檔，代表階段 0 的驗證是以顯式版本標籤暫時拉取，之後被某次
未帶版本號的 `docker pull` 覆蓋了 `latest` 參照。

**已修正**：明確重新拉取並鎖定 `hyperledger/fabric-peer:2.5.9`、`fabric-orderer:2.5.9`、
`fabric-ca:1.5.9`、`fabric-ccenv:2.5.9`、`fabric-baseos:2.5.9`；`network/compose/*.yaml`
全部使用明確版本號，不使用 `latest`。**教訓**：往後在此環境中操作 Docker 映像檔，
一律明確指定版本標籤，不依賴 `latest`。

## 架構決策記錄

- **排序組織獨立於五個業務組織**：`OrdererOrg`（MSP `OrdererMSP`）擁有 3 個 Raft 節點
  （orderer1/2/3），不隸屬於 REG/OEM/SVC/INS/APP 任何一方，維持排序服務中立，
  符合 Fabric 標準作法（fabric-samples test-network 亦如此）。
- **憑證簽發改用 Fabric CA（非 cryptogen）**：對應 plan.md §3.5 EIR3「使用 Fabric CA
  核發各組織身分」；`organizations/fabric-ca/registerEnroll.sh` 將 fabric-samples
  原本 org1/org2/orderer 三份重複函式，改寫為可套用到任意組織代號的通用函式
  （`enrollPeerOrg`、`enrollOrdererOrg`），5 個業務組織共用同一份邏輯。
- **NFR3 初驗不依賴鏈碼**：階段 1 尚未實作業務鏈碼（階段 2 才開始），容錯測試改以
  「設定 APP 組織的 anchor peer」作為寫入動作——這是一筆會產生新區塊、經過 Raft
  排序與多個 peer 驗證/提交的真實 channel 設定交易，足以驗證排序節點與 peer 的
  容錯能力。待階段 2 鏈碼部署後，階段 7 應以實際鏈碼交易重做一次完整測試
  （見 network/README.md「已知限制」）。
- **WSL2 記憶體上限維持預設，未建立 `.wslconfig`**：階段 0 待辦原先建議調高
  WSL2 記憶體上限以容納 20+ 容器。實測目前環境（無 `.wslconfig`，WSL2 預設
  分配 21 GiB）在 6 個 CA + 3 個排序節點 + 5 個 peer + 5 個 CouchDB（共 19 個
  容器）全部啟動後，`docker stats` 顯示總記憶體用量僅約 900 MB，遠低於上限，
  故未建立 `.wslconfig`（可省去 `wsl --shutdown` 中斷工作階段的成本）。若後續
  階段（如階段 2 起同時建置多個 chaincode 容器、階段 7 效能測試）觀察到記憶體
  壓力，再依 stage0 的建議調整。

## 已知限制／待辦

1. 容錯測試使用 channel 設定交易而非鏈碼交易，完整驗證留待階段 2 之後（見上）。
2. 背書策略（plan.md §3.3 的 `AND(OEM, REG)` 等）尚未設定，因為要在階段 2
   提交鏈碼定義時以 `--signature-policy` 指定；`configtx.yaml` 的 Application
   預設策略維持 Fabric 範本的 `ImplicitMeta` 通用規則。
3. 測試過程中觀察到 WSL2 虛擬機曾自行重啟一次（`uptime` 顯示僅 3 分鐘，
   所有容器變成 `Exited (0)`），研判是主機睡眠或系統層面事件所致，非本專案
   操作造成；由於憑證與 channel 狀態皆為 bind mount 於 Windows 檔案系統上，
   重新 `docker compose up -d` 後容器直接沿用既有帳本資料復原，未遺失任何
   資料。往後若重開機或 WSL 重啟，執行 `docker compose -p vehiclenet -f
   compose/compose-ca.yaml -f compose/compose-couch.yaml -f compose/compose-net.yaml
   up -d` 即可恢復（不需重新 `network.sh up`，因為憑證已存在）。
4. `network/organizations/fabric-ca/{reg,oem,svc,ins,app,orderer}/`（CA 伺服器狀態，
   含私鑰）與 `network/organizations/peerOrganizations|ordererOrganizations/`
   （MSP／TLS 憑證，含私鑰）皆已排除於 git 之外，僅
   `organizations/fabric-ca/registerEnroll.sh` 原始碼會被追蹤，見 `.gitignore`。

下一步：進入**階段 2（資產合約）**——實作 `InitVehicle`、`AddMaintenance`、
`RecordClaim`、`TransferOwnership`、`ScrapVehicle` 等鏈碼函式與零件雜湊綁定，
並設定 plan.md §3.3 的背書策略。
