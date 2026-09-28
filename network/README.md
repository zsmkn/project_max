# network/ — 五組織 Fabric 聯盟鏈

REG（監理站）／OEM（原車廠）／SVC（維修廠）／INS（保險公司）／APP（第三方鑑定中心）
五個業務組織 + 獨立的 OrdererOrg（3 個 Raft 排序節點），每個業務組織各 1 個 peer + CouchDB。
詳細設計見 [plan.md](../plan.md) §3.3、§5；驗證結果見 [docs/stage1-network.md](../docs/stage1-network.md)。

## 前置需求

- WSL2（Ubuntu 22.04）內已安裝 Fabric 2.5.9 / Fabric CA 1.5.9 二進位檔於
  `~/fabric/fabric-samples/bin`（可用環境變數 `FABRIC_SAMPLES_HOME` 覆寫路徑）。
- Docker Engine **鎖定在 25.0.5**（`apt-mark hold`，見 docs/stage0-validation.md）。
- **映像檔版本務必明確指定，不可用 `latest`**：本機曾經驗證過，`latest` 標籤實際
  解析為 Fabric 3.1.5，而非本專案驗證過的 2.5.9，兩者的 chaincode 建置機制不同，
  混用會導致難以排查的失敗。compose 檔案皆已鎖定 `2.5.9`（peer/orderer）與
  `1.5.9`（CA），新增服務時比照辦理。

## 指令

```bash
cd network
./network.sh up             # 啟動 6 個 CA、註冊/簽發五組織＋排序組織憑證、啟動 3 排序節點 + 5 peer + 5 CouchDB
./network.sh createChannel  # 建立 vehiclechannel、3 個排序節點加入、5 個 peer 加入並設定 anchor peer
./network.sh down           # 關閉並清除所有容器、volume、憑證與 channel-artifacts

bash scripts/faultToleranceTest.sh   # NFR3 初驗：停掉 1 個 orderer + 1 個 peer 後仍可寫入
```

`network.sh up` 只在 `organizations/peerOrganizations` 不存在時才重新註冊憑證，
重複執行不會重灌；要重新產生請先 `down`。

## 組織與連接埠

| 組織代號 | MSP ID | CA（client / operations） | peer（general / operations） | CouchDB |
| --- | --- | --- | --- | --- |
| REG | REGMSP | 7054 / 17054 | 7051 / 9451 | 5984 |
| OEM | OEMMSP | 8054 / 18054 | 8051 / 9452 | 6984 |
| SVC | SVCMSP | 9054 / 19054 | 9051 / 9453 | 7984 |
| INS | INSMSP | 10054 / 20054 | 10051 / 9454 | 8984 |
| APP | APPMSP | 11054 / 21054 | 11051 / 9455 | 9984 |

| 排序節點 | general | admin | operations |
| --- | --- | --- | --- |
| orderer1 | 7050 | 7053 | 9443 |
| orderer2 | 8050 | 8053 | 9444 |
| orderer3 | 9050 | 9053 | 9445 |

排序組織 CA：6054（client）／16054（operations）。Channel 名稱：`vehiclechannel`。

## 目錄

```
network/
├── organizations/fabric-ca/registerEnroll.sh   # 五組織＋排序組織的 CA 註冊／簽發（通用函式）
├── organizations/                              # 憑證產生物（gitignore，內含私鑰）
├── configtx/configtx.yaml                      # 5 組織 + Raft 3 節點的 channel 設定範本
├── compose/compose-ca.yaml                     # 6 個 Fabric CA
├── compose/compose-net.yaml                    # 3 個排序節點 + 5 個 peer
├── compose/compose-couch.yaml                  # 5 個 CouchDB
├── peercfg/core.yaml                           # peer 容器內 FABRIC_CFG_PATH 所需的預設設定樣板
├── scripts/                                    # orgs.sh（組織中繼資料）、envVar.sh、createChannel.sh、
│                                                # setAnchorPeer.sh、configUpdate.sh、faultToleranceTest.sh
├── channel-artifacts/                          # genesis block 等產生物（gitignore）
└── network.sh                                  # 主控腳本：up / createChannel / down
```

## 背書策略與鏈碼

本階段只建立網路與 channel，尚未部署鏈碼；各交易類型的背書策略
（plan.md §3.3，如 `AND(OEM, REG)`）於階段 2 提交鏈碼定義時以
`--signature-policy` 指定，不寫在 channel 層級的 Application 預設策略中。

## 已知限制

- `faultToleranceTest.sh` 以「設定 APP 組織的 anchor peer」作為容錯情境下的
  寫入驗證，因為此階段尚無業務鏈碼可呼叫。這是一筆真實的 channel 設定交易
  （會產生新區塊、經過 Raft 排序與多個 peer 驗證/提交），足以驗證階段 1
  的 NFR3 初驗範圍；待階段 2 鏈碼部署後，應在階段 7 以實際的鏈碼交易
  （`AddMaintenance`、`RecordClaim` 等）重做一次完整的容錯測試。
