#!/usr/bin/env node
// plan_dApp.md D2 驗收（真實五組織網路）：買家瀏覽器端自行驗證 QR 授權。
// 流程與 web/buyer.html 相同：QR 只含內容定址 ID → 取回授權並重算 ID → 向 Gateway 取「鏈上
// 原始資料」（GetPQCKey 公鑰、GetSummary 車主雜湊）→ 以 web/walletCrypto.js 在本機驗章。
// 全程不呼叫 Gateway 的 .../query-authorization/verify 端點。
import { queryAuthorizationId, queryAuthorizationMessage } from '../../web/shared/authMessages.js';
import {
  buildRegistrationProof,
  generateKeyPair,
  signMessage,
  verifyQueryAuthorization,
} from '../../web/walletCrypto.js';
import { assert, expectOk, request, uniqueVin } from './lib/gatewayClient.mjs';

// buyerVerify 模擬買家頁收到 QR 內容 ID 之後的全部步驟，回傳瀏覽器端驗證結果。
async function buyerVerify(authorizationId, { now } = {}) {
  const fetched = await expectOk('GET', `/api/query-authorizations/${authorizationId}`);
  if ((await queryAuthorizationId(fetched)) !== authorizationId) {
    return { valid: false, reason: '取回的授權內容與 QR Code 不符' };
  }
  return verifyWithChainData(fetched, { now });
}

async function verifyWithChainData(payload, { now } = {}) {
  const onChainKey = await expectOk('GET', `/api/pqc-keys/${payload.ownerIdentity}`);
  const summary = await expectOk('GET', `/api/vehicles/${payload.vin}/summary`);
  return verifyQueryAuthorization({ payload, onChainKey, vehicleOwnerHash: summary.ownerHash, now });
}

export async function run() {
  const vin = uniqueVin('D2');
  const ownerIdentity = `owner-${vin}`;
  await expectOk('POST', '/api/vehicles', {
    vin,
    engineSerial: `ENG-${vin}`,
    transmissionSerial: `TRX-${vin}`,
    manufactureYear: 2020,
    msrpAmount: 600000,
    ownerHash: ownerIdentity,
  });
  const owner = generateKeyPair();
  await expectOk('POST', `/api/pqc-keys/${ownerIdentity}/register`, {
    publicKeyHex: owner.publicKeyHex,
    proofSignatureHex: buildRegistrationProof(ownerIdentity, owner, null, null),
  });

  // 車主瀏覽器：簽署查詢授權，交給 Gateway 暫存，QR 只放 ID。
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const authorization = {
    vin,
    ownerIdentity,
    expiresAt,
    signatureHex: signMessage(owner.secretKeyHex, queryAuthorizationMessage(vin, expiresAt)),
  };
  const { id } = await expectOk('POST', '/api/query-authorizations', authorization);
  assert(id === (await queryAuthorizationId(authorization)), 'Gateway 回傳的 ID 應等於授權內容的 SHA-256');

  // 主流程：買家瀏覽器驗證通過。
  const valid = await buyerVerify(id);
  assert(valid.valid === true, `合法授權應在瀏覽器端驗證通過，實際：${JSON.stringify(valid)}`);

  // 竄改 QR 內容（延長期限、改簽章）→ 以鏈上公鑰在瀏覽器端直接判定失敗。
  const extended = await verifyWithChainData({
    ...authorization,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  assert(extended.valid === false && extended.reason.includes('簽章驗證失敗'), `延長期限應驗證失敗：${JSON.stringify(extended)}`);
  const flipped = authorization.signatureHex.at(-1) === '0' ? '1' : '0';
  const forgedSignature = await verifyWithChainData({
    ...authorization,
    signatureHex: authorization.signatureHex.slice(0, -1) + flipped,
  });
  assert(
    forgedSignature.valid === false && forgedSignature.reason.includes('簽章驗證失敗'),
    `竄改簽章應驗證失敗：${JSON.stringify(forgedSignature)}`,
  );

  // 竄改的內容換算出的 ID 不同，Gateway 上查不到。
  const forgedId = await queryAuthorizationId({ ...authorization, vin: uniqueVin('D2X') });
  const forgedFetch = await request('GET', `/api/query-authorizations/${forgedId}`);
  assert(forgedFetch.statusCode === 404, `竄改後的內容定址 ID 不應存在，實際 ${forgedFetch.statusCode}`);

  // 過期：以「11 分鐘後」的時間驗證同一份授權。
  const expired = await buyerVerify(id, { now: new Date(Date.now() + 11 * 60_000) });
  assert(expired.valid === false && expired.reason.includes('已過期'), `過期授權應驗證失敗：${JSON.stringify(expired)}`);

  // 冒名：別人用自己的鏈上金鑰替這台車簽授權 → 簽署者不是目前車主。
  const impostorIdentity = `impostor-${vin}`;
  const impostor = generateKeyPair();
  await expectOk('POST', `/api/pqc-keys/${impostorIdentity}/register`, {
    publicKeyHex: impostor.publicKeyHex,
    proofSignatureHex: buildRegistrationProof(impostorIdentity, impostor, null, null),
  });
  const impostorAuth = {
    vin,
    ownerIdentity: impostorIdentity,
    expiresAt,
    signatureHex: signMessage(impostor.secretKeyHex, queryAuthorizationMessage(vin, expiresAt)),
  };
  const { id: impostorId } = await expectOk('POST', '/api/query-authorizations', impostorAuth);
  const impostorResult = await buyerVerify(impostorId);
  assert(
    impostorResult.valid === false && impostorResult.reason.includes('不是鏈上登記的目前車主'),
    `冒名授權應驗證失敗：${JSON.stringify(impostorResult)}`,
  );

  // 履歷每筆事件都附交易編號，可向任一組織 peer 交叉查證。
  const history = await expectOk('GET', `/api/vehicles/${vin}/history`);
  assert(history.length > 0 && history.every((e) => /^[0-9a-f]{64}$/.test(e.txId)), '履歷事件應附 64 位十六進位交易編號');

  return { vin, authorizationId: id.slice(0, 16) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then((result) => console.log('✅ D2 瀏覽器端驗證', result))
    .catch((err) => {
      console.error('❌ D2 瀏覽器端驗證');
      console.error(err);
      process.exit(1);
    });
}
