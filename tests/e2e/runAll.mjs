#!/usr/bin/env node
// 一鍵執行 UC-01／UC-02／UC-03 端到端腳本＋EIR1 監理站整合測試（階段 6 驗收標準：
// 「UC-01/02/03 端到端腳本一鍵通過」），以及 plan_dApp.md D0–D3 的驗收腳本。
//
// 前提（見 tests/e2e/README.md）：
//   1. network/ 已啟動並部署 chaincode（./network.sh up && createChannel && deployCC.sh）
//   2. gateway/ 已啟動（npm run dev 或 npm start）
//   3. mocks/ 的兩個模擬服務已啟動（uc03、eir1 兩支腳本需要）：
//        python3 -m mocks.insurance.app
//        python3 -m mocks.monitoring_station.app
//
// 用法：node tests/e2e/runAll.mjs
import * as uc01 from './uc01AppraiserScoring.mjs';
import * as uc02 from './uc02BuyerPqcQuery.mjs';
import * as uc03 from './uc03OemSvcInsLifecycle.mjs';
import * as eir1 from './eir1MonitoringStation.mjs';
import * as dappD0 from './dappD0KeyRules.mjs';
import * as dappD1 from './dappD1SelfCustody.mjs';
import * as dappD2 from './dappD2BrowserVerify.mjs';
import * as dappD3 from './dappD3LiveEvents.mjs';

const scenarios = [
  { name: 'UC-01 鑑定師複檢與動態扣分', run: uc01.run },
  { name: 'UC-02 買家查詢與 PQC 連線', run: uc02.run },
  { name: 'UC-03 車廠初始化與理賠存證', run: uc03.run },
  { name: 'EIR1 監理站整合測試', run: eir1.run },
  // plan_dApp.md D0–D3 驗收。
  { name: 'D0 金鑰登記規則（持有證明／換鑰／強制重綁）', run: dappD0.run },
  { name: 'D1 自持金鑰錢包（瀏覽器簽章、備份匯入）', run: dappD1.run },
  { name: 'D2 買家瀏覽器端驗證 QR 授權', run: dappD2.run },
  { name: 'D3 鏈上事件即時推播（UC-01 扣分通知）', run: dappD3.run },
];

async function main() {
  let failures = 0;
  for (const scenario of scenarios) {
    const startedAt = Date.now();
    try {
      const result = await scenario.run();
      const elapsedMs = Date.now() - startedAt;
      console.log(`✅ ${scenario.name}（${elapsedMs}ms）`, result);
    } catch (err) {
      failures += 1;
      console.error(`❌ ${scenario.name}`);
      console.error(err instanceof Error ? err.stack ?? err.message : err);
    }
  }

  console.log('---');
  if (failures > 0) {
    console.error(`${failures}/${scenarios.length} 個情境失敗。`);
    process.exitCode = 1;
  } else {
    console.log(`全部 ${scenarios.length} 個情境通過。`);
  }
}

main();
