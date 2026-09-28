#!/usr/bin/env bash
#
# 共用輸出函式，改編自 fabric-samples/test-network/scripts/utils.sh。

C_RESET='\033[0m'
C_RED='\033[0;31m'
C_GREEN='\033[0;32m'
C_BLUE='\033[0;34m'
C_YELLOW='\033[1;33m'

# 輸出到 stderr（而非 stdout）：deployCC.sh 的 queryPackageID() 等函式會呼叫
# setGlobals（內部呼叫 infoln）後，再用 $(...) 只擷取「回傳值」那一行；若 log
# 混在 stdout，擷取到的變數會被污染（曾導致 package ID 混入 ANSI 色碼與提示文字，
# 使核准的鏈碼永遠與本地已安裝套件的雜湊對不上，peer 一律回報 chaincode not installed）。
println() { echo -e "$1" >&2; }
errorln() { println "${C_RED}${1}${C_RESET}"; }
successln() { println "${C_GREEN}${1}${C_RESET}"; }
infoln() { println "${C_BLUE}${1}${C_RESET}"; }
warnln() { println "${C_YELLOW}${1}${C_RESET}"; }
fatalln() {
  errorln "$1"
  exit 1
}

verifyResult() {
  if [ "$1" -ne 0 ]; then
    fatalln "$2"
  fi
}

export -f println errorln successln infoln warnln fatalln verifyResult
