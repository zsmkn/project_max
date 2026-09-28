# GitHub × VS Code 使用指南

給 project_max 團隊：如何把專案放上 GitHub、限制誰能編寫，以及日常協作流程。
所有操作都以 VS Code 介面為主，附上等效的指令供參考。

## 目錄

1. [開始前的一次性設定](#1-開始前的一次性設定)
2. [第一次上傳到 GitHub](#2-第一次上傳到-github)
3. [限制誰可以編寫](#3-限制誰可以編寫)
4. [哪些檔案會被上傳](#4-哪些檔案會被上傳)
5. [日常協作流程](#5-日常協作流程)
6. [在 WSL 中開發的注意事項](#6-在-wsl-中開發的注意事項)
7. [常見問題](#7-常見問題)

---

## 1. 開始前的一次性設定

### 1.1 註冊 GitHub 帳號並開啟兩步驟驗證

到 <https://github.com> 註冊，並在 Settings → Password and authentication 開啟 2FA。

### 1.2 設定 Git 身分

Git 需要知道你是誰，才能在 commit 上署名。在 VS Code 開啟終端機（`` Ctrl+` ``）執行：

```bash
git config --global user.name "你的名字"
git config --global user.email "你的 email"
```

email 必須與 GitHub 帳號綁定的 email 一致，commit 才會顯示為你的頭像。
若不想公開 email，可到 GitHub Settings → Emails 勾選「Keep my email addresses private」，
並改用 GitHub 提供的 `<數字>+<帳號>@users.noreply.github.com`。

### 1.3 VS Code 建議安裝的擴充功能

| 擴充功能 | ID | 用途 |
| --- | --- | --- |
| GitHub Pull Requests | `GitHub.vscode-pull-request-github` | 在 VS Code 內建立、檢視、審查 PR 與 issue |
| GitLens | `eamodio.gitlens` | 顯示每一行是誰改的、查看歷史（選用） |
| WSL | `ms-vscode-remote.remote-wsl` | 在 WSL 內開發（本專案需要，見第 6 節） |

Git 本身已內建於 VS Code，登入 GitHub 的功能也是內建的，不需要另外安裝。

---

## 2. 第一次上傳到 GitHub

只需要由**一個人**（建議組長）做一次。其他組員之後用 clone 即可（見 5.1）。

### 2.1 先決定要公開還是私人

建議先建立為 **Private（私人）**。原因：專案內含需求書（有組員姓名與指導教授），
而且開發過程中難免出現測試用的設定。畢業專題提交前若需要公開，隨時可以改（Settings → General → Danger Zone → Change visibility）。

### 2.2 方法 A：直接用 VS Code 發佈（最簡單，不需另外安裝工具）

1. 用 VS Code 開啟專案資料夾。
2. 點左側「原始檔控制」圖示（`Ctrl+Shift+G`）。專案已初始化 git，會看到一列待提交的檔案。
3. **確認要提交哪些檔案**：檔案清單就是即將被上傳的內容，被 `.gitignore` 排除的檔案不會出現在這裡。詳見第 4 節。
4. 在上方訊息欄輸入 commit 訊息，例如 `chore: initial project scaffold`。
5. 點「Commit」。若跳出「沒有暫存的變更，要全部暫存嗎？」，選「Always」或「Yes」。
6. commit 後按鈕會變成「**Publish Branch**」（發佈分支），點下去。
7. 上方選單會請你登入 GitHub，選「Allow」並在瀏覽器完成授權。
8. 選擇 **`project_max` (private)**，VS Code 會自動在你的帳號下建立倉庫並推送。

完成後，右下角會跳出通知並提供「Open on GitHub」。

### 2.3 方法 B：先在網站建立倉庫，再用指令推送

1. 到 <https://github.com/new>，Repository name 填 `project_max`，選 **Private**。
2. **不要**勾選「Add a README」「.gitignore」「license」，因為本機已經有了，勾選會造成衝突。
3. 建立後，在 VS Code 終端機執行（把 `<帳號>` 換成你的 GitHub 帳號）：

```bash
git add .
git commit -m "chore: initial project scaffold"
git remote add origin https://github.com/<帳號>/project_max.git
git push -u origin main
```

第一次 push 時會跳出瀏覽器要求登入，完成後 Git for Windows 內建的認證管理員會記住憑證。

### 2.4 方法 C：用 GitHub CLI（選用）

先安裝 `winget install GitHub.cli`，重開終端機後：

```bash
gh auth login
gh repo create project_max --private --source=. --push
```

---

## 3. 限制誰可以編寫

GitHub 的權限有兩個獨立的問題：**誰能看到**、**誰能修改**。

### 3.1 誰能看、誰能寫

| 設定 | 誰能看 | 誰能直接寫 |
| --- | --- | --- |
| Private 倉庫 | 只有你與被邀請的人 | 被邀請的人（Write 權限） |
| Public 倉庫 | 所有人 | 只有你與被邀請的協作者；其他人只能 fork 後發 PR，需要你同意才會合併 |

**預設狀態下，沒被邀請的人不論倉庫公開或私人，都無法直接修改你的倉庫。**

### 3.2 邀請指定的組員

1. 在倉庫頁面點 **Settings** → 左側 **Collaborators**（可能需要輸入密碼確認）。
2. 點 **Add people**，輸入組員的 GitHub 帳號或 email。
3. 對方會收到邀請信，接受後才會生效。

個人帳號底下的倉庫，被邀請的協作者一律擁有讀寫權限（Write）。
如果需要更細的角色（例如指導教授只能唯讀），可以建立 GitHub Organization，
在 Organization 中才能指派 Read / Triage / Write / Maintain / Admin。

移除某人：Settings → Collaborators → 該人旁邊的垃圾桶。

### 3.3 保護 main 分支（建議）

避免有人（包括自己）不小心直接推壞 `main`：

1. Settings → **Branches**（或 **Rules → Rulesets**）→ Add rule。
2. 分支名稱填 `main`。
3. 勾選 **Require a pull request before merging**，並設定至少 1 位審查者核准。
4. 勾選 **Block force pushes**。

注意：私人倉庫的分支保護功能依 GitHub 方案而定。若在 Settings 中找不到或顯示需要升級，
可以先申請 [GitHub Student Developer Pack](https://education.github.com/pack)（學生免費，內含 Pro），
或改用團隊約定：「不直接推 main，一律開分支再發 PR」。

### 3.4 指定特定檔案必須由特定人審查（進階，選用）

建立 `.github/CODEOWNERS`，例如：

```
# 智慧合約的變更必須由 @帳號A 審查
/chaincode/ @帳號A
```

需搭配 3.3 的「Require review from Code Owners」才會強制執行。

---

## 4. 哪些檔案會被上傳

**不是所有檔案都會被上傳。** 判斷原則：

> 只有被 git **追蹤（tracked）** 並且被 **commit** 且 **push** 的檔案才會到 GitHub。

檔案有三種狀態：

| 狀態 | 意義 | 會上傳嗎 |
| --- | --- | --- |
| 被忽略（ignored） | 符合 `.gitignore` 規則，git 完全不看 | 不會 |
| 未追蹤（untracked） | 新檔案，還沒 `git add` | 不會，直到你 add + commit + push |
| 已追蹤（tracked） | 已 add 並 commit | push 後會 |

### 4.1 本專案目前的規則

規則寫在專案根目錄的 [.gitignore](../.gitignore)，主要排除：

- **機密**：`.env`、`.env.*`、`*.pem`、`*.key`（唯獨 `.env.example` 會上傳，它只是範本）
- **Fabric 憑證與私鑰**：`network/organizations/`、`network/channel-artifacts/`、`**/wallet/`、`pqc/keys/`、`*_sk`
- **依賴與建置輸出**：`node_modules/`、`dist/`、`build/`、`__pycache__/`、`.venv/`
- **個人環境**：`.vscode/`（僅保留 `settings.json`、`extensions.json`）、`.idea/`、`.claude/settings.local.json`、作業系統暫存檔
- **日誌與暫存**：`*.log`、`tmp/`

會被上傳的包括原始碼、`CLAUDE.md`、`plan.md`、`README.md`、`docs/`、`.github/`、
`系統需求書3.docx`，以及各個 `.gitkeep`（空檔案，只是為了讓空資料夾能被追蹤）。

### 4.2 如何確認「這個檔案會不會上傳」

**方法 1：看 VS Code 介面**
- 「原始檔控制」面板列出的檔案，就是有變更、即將被納入 commit 的檔案。
- 檔案總管中，被忽略的檔案會顯示為**灰色**。

**方法 2：指令查詢**（在專案根目錄的終端機）

```bash
# 列出所有「已被追蹤」的檔案，也就是 GitHub 上會看到的檔案
git ls-files

# 列出所有被忽略的檔案
git status --ignored

# 詢問某個檔案是否被忽略，以及是哪條規則造成的
git check-ignore -v .env
git check-ignore -v network/organizations/peerOrganizations/org1/users/Admin/msp/keystore/priv_sk
# 有輸出 = 被忽略；沒有輸出 = 不會被忽略，將會上傳

# 預演：看 git add 會加入哪些檔案，但不真的加
git add -n .
```

**方法 3：commit 前最後檢查**

```bash
git status                 # 目前狀態
git diff --cached --stat   # 已暫存、即將 commit 的檔案清單與變更量
```

養成習慣：**每次 push 前，快速掃一眼暫存清單**，看到 `.env`、`*.key`、`*_sk`、`wallet` 之類的檔案就停下來。

### 4.3 重要：`.gitignore` 只對「還沒被追蹤」的檔案有效

如果某個檔案**已經被 commit 過**才加進 `.gitignore`，它仍會被繼續追蹤與上傳。
要讓 git 停止追蹤（但保留本機檔案）：

```bash
git rm --cached 檔案路徑
git commit -m "chore: 停止追蹤 檔案路徑"
```

### 4.4 萬一機密不小心被 push 了

**只刪除檔案是不夠的**，因為 git 歷史裡仍然找得到。正確做法：

1. **立刻讓該金鑰／密碼／憑證失效並重新產生**（最重要的一步）。
2. 再視情況用 `git filter-repo` 或 BFG 清除歷史，並 force push。
3. 若倉庫曾經公開，一律視為已外洩。

---

## 5. 日常協作流程

### 5.1 組員第一次取得專案

被邀請並接受後：

- **VS Code**：`Ctrl+Shift+P` → 輸入「Git: Clone」→ 選「Clone from GitHub」→ 選 `project_max`。
- **指令**：`git clone https://github.com/<擁有者帳號>/project_max.git`

### 5.2 標準流程：開分支 → 修改 → commit → push → PR → 合併

**① 更新本機（每次開工前）**

原始檔控制面板右上「⋯」→ Pull；或狀態列底部點擊同步圖示。指令：`git pull`。

**② 建立新分支**

點 VS Code 左下角的分支名稱（`main`）→「Create new branch...」→ 輸入名稱。

分支命名（與 [CLAUDE.md](../CLAUDE.md) 一致）：`feat/…`、`fix/…`、`docs/…`、`chore/…`，例如 `feat/init-vehicle`。

指令：`git switch -c feat/init-vehicle`

**③ 修改程式並 commit**

在原始檔控制面板：
1. 點檔案旁的 `+` 暫存變更（或上方的 `+` 全部暫存）。
2. 在訊息欄輸入 commit 訊息。
3. 點「Commit」。

Commit 訊息格式採 Conventional Commits：`feat(chaincode): 新增里程倒退扣分`、`fix(network): 修正 SVC 背書設定`。
一個 commit 只做一件事。

**④ 推送分支**

第一次推送新分支時，按鈕會顯示「Publish Branch」；之後是「Sync Changes」。指令：`git push -u origin feat/init-vehicle`。

**⑤ 建立 Pull Request**

- 推送後 GitHub 網頁會出現「Compare & pull request」按鈕。
- 或在 VS Code 安裝 GitHub Pull Requests 擴充功能後，左側會出現 GitHub 圖示，可直接「Create Pull Request」。
- PR 範本會自動帶入 [.github/pull_request_template.md](../.github/pull_request_template.md) 的檢查清單。

**⑥ 審查與合併**

其他組員在 PR 頁面的「Files changed」逐行留言，通過後 **Approve**，由作者按 **Merge**（建議選 Squash and merge，保持 `main` 歷史整潔）。

**⑦ 合併後清理**

```bash
git switch main
git pull
git branch -d feat/init-vehicle
```

### 5.3 解決合併衝突

兩人改到同一處時，pull 或 merge 會出現衝突。VS Code 會標出衝突檔案：

1. 在原始檔控制面板的「Merge Changes」下點該檔案。
2. 點檔案內的「Resolve in Merge Editor」，畫面左邊是別人的、右邊是你的、下方是結果。
3. 逐一選擇「Accept Current / Incoming / Both」，或手動編輯。
4. 全部解決後按「Complete Merge」，再暫存並 commit。

減少衝突的習慣：**分支存活時間短、頻繁 pull、不同人負責不同目錄**。

### 5.4 常用指令速查

| 目的 | 指令 |
| --- | --- |
| 查看目前狀態 | `git status` |
| 查看歷史 | `git log --oneline --graph -20` |
| 查看尚未暫存的變更 | `git diff` |
| 放棄某檔案的未提交變更 | `git restore 檔案路徑` |
| 取消暫存 | `git restore --staged 檔案路徑` |
| 暫時收起未完成的修改 | `git stash` / `git stash pop` |
| 修改上一次 commit 訊息（尚未 push） | `git commit --amend` |
| 切換分支 | `git switch 分支名` |

---

## 6. 在 WSL 中開發的注意事項

本專案的 Fabric 網路在 WSL2 + Docker 上執行。有兩個實務重點：

1. **把專案 clone 到 WSL 的家目錄（如 `~/project_max`），不要放在 `/mnt/c/...`**。
   跨檔案系統存取很慢，也容易出現檔案權限問題，會讓 Docker 掛載與 Fabric 腳本出錯。
2. **用 VS Code 的 WSL 擴充功能開啟**：在 WSL 終端機進入專案目錄後執行 `code .`，
   VS Code 會以「WSL: Ubuntu」模式開啟，介面與 Git 操作完全相同。

WSL 內的 git 設定與 Windows **是分開的**，第一次使用要再做一次 1.2 的 `git config`。
認證通常會自動沿用 Windows 的 Git Credential Manager；若推送時被要求輸入帳號密碼，
請改用 Personal Access Token 或 `gh auth login`。

---

## 7. 常見問題

**Q：`git push` 被拒絕，顯示 `rejected ... fetch first`？**
遠端有你本機沒有的更新。先 `git pull`（若有衝突先解決），再 push。

**Q：出現 `warning: LF will be replaced by CRLF`？**
換行字元轉換的提示，可忽略。專案已用 [.gitattributes](../.gitattributes) 與 [.editorconfig](../.editorconfig) 統一為 LF。

**Q：commit 時顯示「Please tell me who you are」？**
尚未設定身分，回到 1.2。

**Q：推送時要求我登入，但找不到認證視窗？**
確認瀏覽器沒有擋掉彈出視窗；或在終端機執行 `gh auth login` 改用 CLI 登入。

**Q：某個檔案我不想上傳，但它不在 `.gitignore`？**
在 `.gitignore` 加一行規則。若該檔已被追蹤過，另需 `git rm --cached`（見 4.3）。

**Q：能不能直接把倉庫變成公開給指導教授看？**
可以，但公開等於所有人可讀。若只想讓教授看又不想給修改權限：個人帳號倉庫沒有「唯讀協作者」，邀請進來就有寫入權限（見 3.2），
所以要嘛建立 GitHub Organization 並給教授 Read 角色，要嘛把倉庫設為公開（外人只能讀，不能直接寫）。
