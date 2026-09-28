'use strict';
// 各 workload 模組共用：讀取 setup/seedData.mjs 產生的種子車輛清單與測試車主 PQC 金鑰。
// CommonJS（非 .mjs）是刻意的：Caliper 以 require() 載入 workload 模組（見
// caliper-core CaliperUtils.loadModuleFunction 的 requireFunction 預設值為 require），
// package.json 若宣告 "type":"module" 會讓 .js 檔變成 ESM 而載入失敗。

const fs = require('fs');
const path = require('path');

function loadSeedVehicles() {
  const filePath = path.join(__dirname, '../setup/seedVehicles.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`找不到 ${filePath}，請先執行 npm run seed（見 tests/perf/README.md）`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadPerfOwnerKey() {
  const filePath = path.join(__dirname, '../setup/perfOwnerKey.local.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`找不到 ${filePath}，請先執行 npm run seed（見 tests/perf/README.md）`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// 依 workerIndex 與遞增計數器，從種子車輛池中挑出一個不重複交錯（round-robin）的索引，
// 讓多個 worker 平均分攤整個池子，避免同一瞬間集中打同一台車輛造成不必要的 MVCC 衝突。
function makeVinPicker(vins, workerIndex, totalWorkers) {
  let counter = 0;
  return () => {
    const index = (workerIndex + counter * totalWorkers) % vins.length;
    counter += 1;
    return vins[index];
  };
}

module.exports = { loadSeedVehicles, loadPerfOwnerKey, makeVinPicker };
