# project_max

> 基於 Hyperledger Fabric 聯盟鏈與後量子密碼學（PQC）的汽車履歷系統，讓二手車的里程、保養、理賠紀錄不可竄改、可溯源。

## 功能

- 車輛全生命週期履歷上鏈：出廠、保養、理賠、過戶、報廢
- 五方聯盟鏈共同背書：監理站、車廠、維修廠、保險公司、第三方鑑定中心
- 動態誠信評分與殘值估算，自動偵測里程倒退等異常
- 車輛與核心零件序號雜湊綁定
- Dilithium 數位簽章與 Kyber 加密通道
- 車主、買家、鑑定師 Web 介面

## 快速開始

```bash
./setup-env.sh         # 新機器先執行一次：安裝 Docker 25.0.5、Fabric 2.5.9、Node.js 22 等（WSL2 Ubuntu 22.04 內）
./deploy.sh up --e2e   # 一鍵部署網路、鏈碼、Gateway、模擬服務並跑端到端測試（./deploy.sh down 清除）
```

或手動逐步執行：

```bash
cd network && ./network.sh up && ./network.sh createChannel && bash scripts/deployCC.sh
cd ../gateway && npm install && npm run dev      # 首次需另外產生自簽憑證
make e2e                                          # 四個使用案例情境全過即部署成功
```

名詞說明、完整步驟、前置需求與常見問題見下列文件：

| 文件 | 適合什麼時候看 |
| --- | --- |
| [describe.md](describe.md) | 看不懂專有名詞時：白話說明各項核心技術、系統架構與名詞速查表 |
| [quick_start.md](quick_start.md) | 環境已備妥，想在 10 分鐘內把整套系統跑起來 |
| [src/SETUP.md](src/SETUP.md) | 新機器從零安裝、各模組的完整指令、lint 與效能測試、環境陷阱速查表 |

所有指令都在 **WSL2 Ubuntu 22.04** 內執行；Docker Engine 需鎖定 25.0.5、Fabric 2.5.9、
Node.js 22+、Go 1.22+，版本對不上會踩到已知的相容性問題（原因見
[docs/stage0-validation.md](docs/stage0-validation.md)）。

## 專案結構

```
project_max/
├── network/               # Fabric 網路：configtx、docker-compose、啟動與測試腳本
├── chaincode/vehicle/     # 智慧合約（Go）：資產生命週期、評分引擎、Dilithium 驗證
├── gateway/               # Fabric Gateway REST API（Node.js / TypeScript）
├── web/                   # 車主／買家／鑑定師 HTML5 介面
├── mocks/                 # 監理站、保險公司外部系統模擬（Python）
├── tests/e2e/             # UC-01/02/03＋EIR1 端到端腳本
├── tests/perf/            # Hyperledger Caliper 效能測試（NFR2）
└── docs/                  # 各階段設計文件與需求追蹤矩陣
```

## 開發

請參考 [CLAUDE.md](CLAUDE.md) 了解編程風格、Git 規範與常用指令。

## 授權

TODO：選定授權後在此註明（並新增 `LICENSE` 檔案）。
