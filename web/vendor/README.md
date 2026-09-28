# web/vendor/ — 固定版本的前端函式庫

plan_dApp.md D1：車主私鑰存在瀏覽器（IndexedDB），**同源頁面上的任何腳本都讀得到它**。
因此網頁不從 CDN 載入任何腳本（CDN 被竄改時可能偷走私鑰），改為把固定版本打包成單一
ESM 檔放在這裡，由 Gateway 同源提供。更新版本時請重新打包並更新下表的 SHA-256。

| 檔案 | 來源套件 | 用途 | SHA-256 |
| --- | --- | --- | --- |
| `noble-post-quantum-0.7.1-ml-dsa.js` | `@noble/post-quantum@0.7.1`（匯出 `ml_dsa65`，含相依的 `@noble/hashes`） | ML-DSA-65（Dilithium）金鑰產生、簽章、驗章；與 Gateway 同一版本 | `5f95c3a666ff3d3ad305880af8b70e2e8f26ddd72178fdc40f81984189dc3d2f` |
| `qrcode-1.5.3.js` | `qrcode@1.5.3`（匯出 `toCanvas`） | 車主頁繪製 QR Code | `57ef8c1aa9d2aebab6e6b8fa86b386252c780848e6a3696fc77abdac7064e7e8` |
| `jsqr-1.4.0.js` | `jsqr@1.4.0`（匯出 `jsQR`） | 買家頁解析 QR Code 圖片 | `7a90dfe645b50ce6046ebc7e8b58c3f83710c02bf6dcf449662175bc60ff68e4` |

原本 `owner.html` 引用的 `https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js`
實際上是 404（該版本套件沒有 `build/` 目錄），車主頁的 QR Code 在真實瀏覽器中從未能顯示；
改為本地打包後一併修正（見 docs/dapp.md）。

## 重新打包

在 WSL 內執行（esbuild 取自 `gateway/node_modules`，產物為 minify 後的 ESM，授權聲明保留在檔尾）：

```bash
# ML-DSA：直接使用 gateway/ 已安裝的同版本套件
cd gateway
echo 'export { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";' > .vendor-entry.mjs
npx esbuild .vendor-entry.mjs --bundle --format=esm --minify --legal-comments=eof \
  --outfile=../web/vendor/noble-post-quantum-0.7.1-ml-dsa.js
rm .vendor-entry.mjs

# QR Code 兩個套件：在暫存目錄安裝固定版本後打包
mkdir -p /tmp/vendorbuild && cd /tmp/vendorbuild && npm init -y >/dev/null
npm install qrcode@1.5.3 jsqr@1.4.0
echo 'export { toCanvas } from "qrcode";' > qr.mjs
echo 'export { default as jsQR } from "jsqr";' > jsqr.mjs
E=<專案路徑>/gateway/node_modules/.bin/esbuild
$E qr.mjs --bundle --format=esm --minify --legal-comments=eof --outfile=<專案路徑>/web/vendor/qrcode-1.5.3.js
$E jsqr.mjs --bundle --format=esm --minify --legal-comments=eof --outfile=<專案路徑>/web/vendor/jsqr-1.4.0.js

cd <專案路徑>/web/vendor && sha256sum *.js
```
