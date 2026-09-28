# 階段 0：環境與技術驗證結論

驗證日期：2026-09-22
驗證環境：Windows 11 + WSL2 Ubuntu 22.04.5 LTS，16 vCPU，WSL2 預設配置 15 GiB RAM（實體機 31 GB），~950 GB 可用磁碟。

本文件記錄 plan.md §2、§5（階段 0）列出的技術風險驗證結果，作為後續階段（尤其階段 1 網路擴充、階段 2 chaincode、階段 3 PQC 整合）的依據。**其中一項發現（Docker 版本相容性）推翻了原先的假設，屬於 plan.md 未預期的新風險，已於下方「新發現」說明。**

## 已安裝元件

| 元件 | 版本 | 備註 |
| --- | --- | --- |
| Docker Engine | **25.0.5**（已從 29.8.1 降級並 `apt-mark hold`） | 見下方「新發現：Docker 版本相容性」 |
| containerd.io | 1.6.28 | 與 Docker 25.0.5 配套 |
| Hyperledger Fabric | 2.5.9（peer/orderer/ca 皆為此版本） | 用官方 `install-fabric.sh -f 2.5.9 -c 1.5.9` 安裝 |
| Fabric CA | 1.5.9 | |
| fabric-samples | 對應 2.5.9 版本 | 位於 `~/fabric/fabric-samples`（WSL 內，未納入本 repo） |
| Go | 1.27.1 | 供本機開發、gateway、pqc 工具使用 |
| Node.js | 22.23.2（bundled OpenSSL 3.5.7） | 供 Gateway（TypeScript）使用 |
| liboqs | 0.13.0（build from source, tag `0.13.0`） | 安裝於 `/opt/liboqs`，含 ML-KEM／Kyber、ML-DSA／Dilithium 全套演算法 |
| CIRCL (cloudflare) | **需求鎖定於 v1.6.0–v1.6.3**（不可用 v1.6.4 以後） | 見下方「新發現：CIRCL 與 ccenv Go 版本」 |

## §2 風險驗證結果

### 風險 #4：Chaincode 容器內驗證 Dilithium（結論：可行，方案如 plan.md 所述）

- 使用 Cloudflare CIRCL 的 `sign/mldsa/mldsa65` 套件（純 Go，無 cgo/liboqs 依賴）產生金鑰、簽章、驗證，正確簽章驗證通過、竄改內容驗證正確失敗。
- **關鍵驗證**：不只在本機 Go 1.27 執行，還**直接在 `hyperledger/fabric-ccenv:2.5.9` 容器內**（`docker run ... hyperledger/fabric-ccenv:2.5.9 go build && go run`）完成編譯與執行，證實 chaincode 打包／安裝流程實際使用的建置環境可以編譯並執行 ML-DSA 驗證邏輯。
- 結論：chaincode 端不簽章、只驗證，使用 CIRCL 的做法（plan.md §2 #4、§3.1 `RegisterPQCKey`）技術上可行。

### 風險 #1／NFR1：Dilithium 取代 ECDSA 的範圍（結論：維持 plan.md 雙層簽章決定）

- Fabric MSP／交易簽章仍為 ECDSA，未修改 Fabric 原始碼；業務資料另附 Dilithium(ML-DSA) 簽章由 chaincode 驗證，此決定維持不變。
- liboqs 0.13.0 的 `example_sig`、`dump_alg_info` 確認 Dilithium2/3/5 與其 FIPS 204 標準化名稱 ML-DSA-44/65/87 皆可用，可作為金鑰產生與 CLI 工具端（pqc/ 目錄）的實作依據。

### 風險 #2／BFR4：Kyber TLS 邊界（結論：比原計畫更簡單——原生支援已足夠，不一定需要 oqs-provider）

這是本階段最大的意外發現，**建議修改 plan.md §2 #2 的建議做法**：

- Go 1.27 標準庫 `crypto/mlkem`、`crypto/tls` 已內建 `tls.X25519MLKEM768`（ML-KEM 與 X25519 的混合金鑰交換群組），可直接用於 `tls.Config.CurvePreferences`，無需 liboqs／oqs-provider。
- **實際握手驗證**：起一個 Node.js 22（OpenSSL 3.5.7）TLS 伺服器，設定 `ecdhCurve: 'X25519MLKEM768'`；用另一個裝有 OpenSSL 3.5.8 的容器當 client（`openssl s_client -groups X25519MLKEM768 -tls1_3`），交握結果明確顯示：

  ```
  Negotiated TLS1.3 group: X25519MLKEM768
  New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
  ```

  以「先用明顯不存在的群組名稱測試會被拒絕」作為對照組，排除了「OpenSSL/Node 忽略未知群組、實際退回傳統 ECDHE」的可能性，確認這是真正的後量子混合金鑰交換，不是誤判。
- 結論：**Gateway（Node.js）與瀏覽器之間的 Kyber TLS 邊界，可優先嘗試「Node.js 原生 TLS + 近期版本瀏覽器（Chrome/Firefox 已預設支援 X25519MLKEM768）」的路線**，比原計畫的「liboqs + oqs-provider + nginx」更輕量。liboqs／oqs-provider 仍保留作為備案（例如需要純 Kyber-768 而非與 X25519 混合、或瀏覽器端不支援時）。此修改待階段 3 實作時再最終定案，屆時一併驗證憑證鏈與瀏覽器相容性。

## 新發現（plan.md 未列出的風險）

### Docker Engine 版本相容性（影響階段 1、2：五組織網路與 chaincode 部署）

- 系統原先安裝的 Docker Engine 29.8.1（2026 年最新版）會導致 Fabric 2.5.9 peer 的 chaincode 安裝失敗：
  ```
  Error: chaincode install failed with status: 500 - failed to invoke backing implementation of
  'InstallChaincode': could not build chaincode: docker build failed: docker image build failed:
  write unix @->/run/docker.sock: write: broken pipe
  ```
- 根因：Fabric peer 內建的 Docker Go client 呼叫的是 Docker Engine 的 legacy（非 BuildKit）`/build` API；用純 `docker build` CLI（走 BuildKit）測試完全正常，證實問題出在 peer 直接呼叫的舊版 API 路徑上，而非一般性的 Docker 故障。
- **已修復**：將 `docker-ce`／`docker-ce-cli`／`docker-ce-rootless-extras` 降級到 **25.0.5**、`containerd.io` 降級到 **1.6.28**（Fabric 2.5.x 官方文件測試過的年代），並以 `apt-mark hold` 鎖定版本避免自動升級再次壞掉。降級後，官方 `asset-transfer-basic` chaincode 完整部署、`InitLedger`／`GetAllAssets` 呼叫皆成功。
- **影響與待辦**：往後在此 WSL 環境執行 `sudo apt-get upgrade` 前，需注意 Docker 套件已被 hold；若未來需要解除（例如要用新版功能），需重新驗證 chaincode 部署流程。此限制與行動需寫入 README／環境建置說明，避免組員或未來重建環境時卡在同樣的問題。

### CIRCL 函式庫版本需鎖定（影響階段 3：PQC chaincode 整合）

- `fabric-ccenv:2.5.9` 內建 **Go 1.22.4**，為固定版本，chaincode 的 `go.mod` 宣告的 Go 版本不可高於此。
- Cloudflare CIRCL 最新版 v1.6.5 的 `go.mod` 要求 `go 1.25.0`，超過 ccenv 能提供的版本，**無法在 ccenv 內建置**。
- v1.6.0～v1.6.3 的 `go.mod` 要求 `go 1.22.0`，與 ccenv 相容；已實測 v1.6.3 在 ccenv 容器內建置並執行 ML-DSA-65 簽章驗證成功。
- **決議**：chaincode 端（`chaincode/vehicle/go.mod`）鎖定 `github.com/cloudflare/circl v1.6.3`，之後若要升級需同步確認 ccenv 版本或改用外部建置（見下方待辦）。
- 另一個規避方案是改用 Fabric 的 External Builder／CCaaS（Chaincode as a Service）模式自行掌控建置環境，即可不受 ccenv Go 版本限制；因目前 pin 版本已可運作，暫不採用，但列為階段 2 若遇到相依套件版本卡關時的備案，一併記錄於 plan.md 待辦。

## §5 階段 0 驗收標準逐項確認

| 驗收標準 | 結果 |
| --- | --- |
| 官方範例 chaincode 部署成功 | ✅ `asset-transfer-basic`（Go）在 5.9 的 2 組織 test-network（含 CA）上完整安裝／核准／commit，`InitLedger`、`GetAllAssets` 呼叫成功（降級 Docker 後）|
| 一段 Dilithium 簽章能由 Go 驗證通過 | ✅ CIRCL `mldsa65` 產生金鑰、簽章、驗證成功；竄改內容驗證正確失敗；並在真實 `fabric-ccenv:2.5.9` 容器（Go 1.22.4）內建置執行成功 |
| 產出「PQC 範圍」結論記錄於 docs/ | ✅ 本文件；範圍維持 plan.md §2 #1 雙層簽章決定，#2 Kyber TLS 邊界建議改為優先嘗試原生 `X25519MLKEM768`（Go/Node 皆原生支援），liboqs 保留為備案 |
| 確認機器資源 | ✅ 16 vCPU／WSL2 15 GiB RAM／~950 GB 磁碟；階段 1 擴充到五組織＋3 Raft 節點（20+ 容器）前，需將 `.wslconfig` 的記憶體上限由預設調高（目前未調整，見下方待辦）|

## 待辦（帶入階段 1）

1. 建立／調整 `%USERPROFILE%\.wslconfig`，將 WSL2 記憶體上限從預設 15 GiB 調高（例如 20–24 GB），為五組織＋3 Raft 排序節點＋CouchDB 的容器數量（20+）預留餘裕；套用需要 `wsl --shutdown` 重啟，屬於會中斷目前所有 WSL work 的操作，待正式開始階段 1 前再與使用者確認時機執行。
2. 在 README 或 network/ 目錄下的建置說明中記錄 Docker Engine 需固定在 25.0.x（已 `apt-mark hold`），避免未來 `apt upgrade` 造成 chaincode 部署再次失敗。
3. chaincode 的 `go.mod` 建立時即鎖定 `github.com/cloudflare/circl v1.6.3`；若後續需要更新版本，先確認 `fabric-ccenv` 的 Go 版本是否也隨 Fabric 版本更新。
