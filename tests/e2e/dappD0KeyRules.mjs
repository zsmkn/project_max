#!/usr/bin/env node
// plan_dApp.md D0 驗收（真實五組織網路）：RegisterPQCKey 安全修正。
//   - 未附持有證明被拒、他人覆寫公鑰被拒
//   - 舊鑰簽章可換鑰（鏈上版本號 +1）
//   - 監理站（REG，Gateway 內部埠）可強制重綁；對外埠不提供此端點
// 金鑰與簽章全部在本腳本（模擬瀏覽器，與 web/walletCrypto.js 同一份程式）產生。
import { pqcKeyRegistrationMessage } from '../../web/shared/authMessages.js';
import { buildRegistrationProof, generateKeyPair, signMessage } from '../../web/walletCrypto.js';
import { assert, expectOk, internalRequest, request, uniqueVin } from './lib/gatewayClient.mjs';

async function expectRejected(method, urlPath, body, expectedText) {
  const { statusCode, body: responseBody } = await request(method, urlPath, body);
  const text = JSON.stringify(responseBody);
  assert(statusCode >= 400, `${method} ${urlPath} 應被拒絕，實際 ${statusCode}：${text}`);
  assert(text.includes(expectedText), `拒絕原因應包含「${expectedText}」，實際：${text}`);
}

export async function run() {
  const identity = `owner-${uniqueVin('D0')}`;
  const registerPath = `/api/pqc-keys/${identity}/register`;
  const owner = generateKeyPair();

  // 1. 第一次登記未附持有證明（或證明由別把私鑰簽）→ 拒絕。
  const stranger = generateKeyPair();
  await expectRejected('POST', registerPath, { publicKeyHex: owner.publicKeyHex, proofSignatureHex: 'deadbeef' }, '持有證明');
  await expectRejected(
    'POST',
    registerPath,
    {
      publicKeyHex: owner.publicKeyHex,
      proofSignatureHex: signMessage(stranger.secretKeyHex, pqcKeyRegistrationMessage(identity, owner.publicKeyHex)),
    },
    '持有證明',
  );

  // 2. 正常第一次登記。
  await expectOk('POST', registerPath, {
    publicKeyHex: owner.publicKeyHex,
    proofSignatureHex: buildRegistrationProof(identity, owner, null, null),
  });
  const v1 = await expectOk('GET', `/api/pqc-keys/${identity}`);
  assert(v1.version === 1 && v1.publicKeyHex === owner.publicKeyHex, `登記後應為第 1 版，實際：${JSON.stringify(v1)}`);

  // 3. 攻擊者用自己的新金鑰（附自己的持有證明）覆寫車主公鑰 → 拒絕（修正前會成功）。
  const attacker = generateKeyPair();
  await expectRejected(
    'POST',
    registerPath,
    { publicKeyHex: attacker.publicKeyHex, proofSignatureHex: buildRegistrationProof(identity, attacker, null, null) },
    '目前登記的私鑰',
  );

  // 4. 車主以舊私鑰簽署換鑰 → 成功，版本 +1。
  const rotated = generateKeyPair();
  await expectOk('POST', registerPath, {
    publicKeyHex: rotated.publicKeyHex,
    proofSignatureHex: buildRegistrationProof(identity, rotated, v1, owner),
  });
  const v2 = await expectOk('GET', `/api/pqc-keys/${identity}`);
  assert(v2.version === 2 && v2.publicKeyHex === rotated.publicKeyHex, `換鑰後應為第 2 版，實際：${JSON.stringify(v2)}`);

  // 5. 私鑰遺失：監理站線下核對身分後，經 Gateway 內部埠以 REG 身分強制重綁。
  const replacement = generateKeyPair();
  const rebindBody = {
    publicKeyHex: replacement.publicKeyHex,
    proofSignatureHex: buildRegistrationProof(identity, replacement, null, null),
    reason: 'e2e：車主遺失私鑰，監理站臨櫃核對身分證件後重綁',
  };
  const publicAttempt = await request('POST', `/api/pqc-keys/${identity}/force-rebind`, rebindBody);
  assert(publicAttempt.statusCode === 404, `對外埠不應提供強制重綁端點，實際 ${publicAttempt.statusCode}`);
  const rebind = await internalRequest('POST', `/api/pqc-keys/${identity}/force-rebind`, rebindBody);
  assert(rebind.statusCode === 201, `內部埠強制重綁應成功，實際 ${rebind.statusCode}：${JSON.stringify(rebind.body)}`);
  const v3 = await expectOk('GET', `/api/pqc-keys/${identity}`);
  assert(v3.version === 3 && v3.publicKeyHex === replacement.publicKeyHex, `強制重綁後應為第 3 版，實際：${JSON.stringify(v3)}`);

  return { identity, finalVersion: v3.version };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then((result) => console.log('✅ D0 金鑰登記規則', result))
    .catch((err) => {
      console.error('❌ D0 金鑰登記規則');
      console.error(err);
      process.exit(1);
    });
}
