#!/usr/bin/env node
// plan_dApp.md D1 驗收（真實五組織網路）：自持金鑰錢包。
//   - 車主金鑰在「瀏覽器端」（本腳本以 web/walletCrypto.js 模擬，與網頁同一份程式）產生，
//     Gateway 只收到公鑰與簽章；保養授權在本機簽章後由 SVC 送出上鏈。
//   - 竄改訊息後簽章被鏈碼拒絕。
//   - 匯出加密備份檔、在「另一個瀏覽器」匯入後可正常簽章上鏈。
// 若設定 EXPECT_EMPTY_WALLET_DIR（Gateway 啟動時的 PQC_WALLET_DIR），另外確認整個流程
// 沒有在 Gateway 錢包目錄留下任何檔案——即「關掉 Gateway 錢包後仍能完成」的驗收條件。
import * as fs from 'node:fs/promises';

import { maintenanceAuthorizationMessage } from '../../web/shared/authMessages.js';
import {
  buildRegistrationProof,
  decryptBackup,
  encryptBackup,
  generateKeyPair,
  signMessage,
} from '../../web/walletCrypto.js';
import { assert, expectOk, request, uniqueVin } from './lib/gatewayClient.mjs';

export async function run() {
  const vin = uniqueVin('D1');
  const ownerIdentity = `owner-${vin}`;

  await expectOk('POST', '/api/vehicles', {
    vin,
    engineSerial: `ENG-${vin}`,
    transmissionSerial: `TRX-${vin}`,
    manufactureYear: 2022,
    msrpAmount: 720000,
    ownerHash: ownerIdentity,
  });

  // 瀏覽器 A：產生金鑰並以持有證明登記。
  const browserA = { identity: ownerIdentity, ...generateKeyPair() };
  await expectOk('POST', `/api/pqc-keys/${ownerIdentity}/register`, {
    publicKeyHex: browserA.publicKeyHex,
    proofSignatureHex: buildRegistrationProof(ownerIdentity, browserA, null, null),
  });

  // 瀏覽器 A 簽署保養授權 → SVC 送出上鏈。
  const maintenance = { serviceType: 'OIL_CHANGE', mileage: 12000, description: 'D1 自持金鑰保養' };
  const signatureA = signMessage(
    browserA.secretKeyHex,
    maintenanceAuthorizationMessage(vin, maintenance.serviceType, maintenance.mileage, maintenance.description),
  );
  await expectOk('POST', `/api/vehicles/${vin}/maintenance`, { ...maintenance, ownerSignatureHex: signatureA });

  // 竄改：用同一個簽章送出不同里程 → 鏈碼拒絕。
  const tampered = await request('POST', `/api/vehicles/${vin}/maintenance`, {
    ...maintenance,
    mileage: 99999,
    ownerSignatureHex: signatureA,
  });
  assert(tampered.statusCode >= 400, `竄改後的保養授權應被拒絕，實際 ${tampered.statusCode}`);
  assert(JSON.stringify(tampered.body).includes('授權驗證失敗'), `拒絕原因應為簽章驗證失敗：${JSON.stringify(tampered.body)}`);

  // 匯出加密備份 → 瀏覽器 B 匯入後簽章上鏈。
  const backupText = await encryptBackup(browserA, 'd1-backup-password');
  assert(!backupText.includes(browserA.secretKeyHex), '備份檔不可含明文私鑰');
  const browserB = await decryptBackup(backupText, 'd1-backup-password');
  const second = { serviceType: 'TIRE_ROTATION', mileage: 18000, description: 'D1 換瀏覽器後簽章' };
  await expectOk('POST', `/api/vehicles/${vin}/maintenance`, {
    ...second,
    ownerSignatureHex: signMessage(
      browserB.secretKeyHex,
      maintenanceAuthorizationMessage(vin, second.serviceType, second.mileage, second.description),
    ),
  });

  const history = await expectOk('GET', `/api/vehicles/${vin}/history`);
  const maintenanceEvents = history.filter((e) => e.type === 'MAINTENANCE');
  assert(maintenanceEvents.length === 2, `應有 2 筆保養紀錄（竄改的那筆不應上鏈），實際 ${maintenanceEvents.length}`);

  const walletDir = process.env.EXPECT_EMPTY_WALLET_DIR;
  if (walletDir) {
    const files = await fs.readdir(walletDir).catch(() => []);
    assert(files.length === 0, `Gateway 錢包目錄 ${walletDir} 應維持空白，實際有 ${files.length} 個檔案`);
  }

  return { vin, maintenanceCount: maintenanceEvents.length, walletDirChecked: Boolean(walletDir) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then((result) => console.log('✅ D1 自持金鑰錢包', result))
    .catch((err) => {
      console.error('❌ D1 自持金鑰錢包');
      console.error(err);
      process.exit(1);
    });
}
