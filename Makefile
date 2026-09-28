# 常用指令捷徑（CLAUDE.md「常用指令」表）。前提請見各自的 README：
#   network/README.md、gateway/README.md、mocks/README.md、tests/e2e/README.md

.PHONY: e2e mocks-test web-test

# UC-01/02/03 端到端腳本＋EIR1 整合測試＋dApp D0–D3 驗收一鍵執行（階段 6 驗收標準）。
# 前提：network/ 已啟動並部署 chaincode、gateway/ 已啟動、mocks/ 的兩個模擬服務已啟動。
e2e:
	node tests/e2e/runAll.mjs

# mocks/ 的欄位轉換純函式單元測試（不需要啟動 network/gateway）。
mocks-test:
	python3 -m unittest discover -s mocks -p "test_*.py"

# web/walletCrypto.js（瀏覽器自持金鑰錢包，plan_dApp.md D1／D2）單元測試，不需要啟動 network/gateway。
web-test:
	node --test web/tests/*.test.mjs
