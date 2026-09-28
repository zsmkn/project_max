// web/walletCrypto.js 的單元測試（plan_dApp.md D1／D2），以 Node.js 22 內建 node:test 執行：
//   node --test web/tests/
// walletCrypto.js 不依賴 DOM／IndexedDB，因此與瀏覽器載入的是同一份程式。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  pqcKeyRegistrationMessage,
  pqcKeyRotationMessage,
  queryAuthorizationMessage,
} from '../shared/authMessages.js';
import {
  buildRegistrationProof,
  decryptBackup,
  encryptBackup,
  generateKeyPair,
  signMessage,
  verifyQueryAuthorization,
  verifySignature,
} from '../walletCrypto.js';

const identity = 'owner-hash-web-test';

describe('encryptBackup / decryptBackup（D1 匯出匯入）', () => {
  it('round-trips a key with the right password', async () => {
    const record = { identity, ...generateKeyPair(), createdAt: '2026-09-24T00:00:00.000Z' };
    const backup = await encryptBackup(record, 'correct horse battery');
    assert.ok(!backup.includes(record.secretKeyHex), '備份檔不可含明文私鑰');
    assert.deepEqual(await decryptBackup(backup, 'correct horse battery'), record);
  });

  it('rejects a wrong password', async () => {
    const backup = await encryptBackup({ identity, ...generateKeyPair() }, 'correct horse battery');
    await assert.rejects(decryptBackup(backup, 'wrong password!!'), /密碼錯誤/);
  });

  it('rejects a backup whose identity field was edited', async () => {
    const backup = JSON.parse(await encryptBackup({ identity, ...generateKeyPair() }, 'correct horse battery'));
    backup.identity = 'someone-else';
    await assert.rejects(decryptBackup(JSON.stringify(backup), 'correct horse battery'), /密碼錯誤或備份檔已損毀/);
  });

  it('refuses short passwords', async () => {
    await assert.rejects(encryptBackup({ identity, ...generateKeyPair() }, 'short'), /至少需要 8 個字元/);
  });
});

describe('buildRegistrationProof（D0 規則的瀏覽器端）', () => {
  it('signs a proof of possession with the new key on first registration', () => {
    const next = generateKeyPair();
    const proof = buildRegistrationProof(identity, next, null, null);
    assert.ok(verifySignature(next.publicKeyHex, pqcKeyRegistrationMessage(identity, next.publicKeyHex), proof));
  });

  it('signs the rotation with the current key and the on-chain version', () => {
    const current = generateKeyPair();
    const next = generateKeyPair();
    const onChain = { publicKeyHex: current.publicKeyHex, version: 3 };
    const proof = buildRegistrationProof(identity, next, onChain, current);
    assert.ok(verifySignature(current.publicKeyHex, pqcKeyRotationMessage(identity, 3, next.publicKeyHex), proof));
  });

  it('refuses to rotate when the local key does not match the on-chain key', () => {
    const onChain = { publicKeyHex: generateKeyPair().publicKeyHex, version: 1 };
    assert.throws(() => buildRegistrationProof(identity, generateKeyPair(), onChain, generateKeyPair()), /強制重綁/);
    assert.throws(() => buildRegistrationProof(identity, generateKeyPair(), onChain, null), /強制重綁/);
  });
});

describe('verifyQueryAuthorization（D2 買家瀏覽器端驗證）', () => {
  const owner = generateKeyPair();
  const onChainKey = { publicKeyHex: owner.publicKeyHex, version: 1 };
  const now = new Date('2026-09-24T00:00:00.000Z');
  const expiresAt = '2026-09-24T00:10:00.000Z';
  const payload = {
    vin: 'VIN-D2',
    ownerIdentity: identity,
    expiresAt,
    signatureHex: signMessage(owner.secretKeyHex, queryAuthorizationMessage('VIN-D2', expiresAt)),
  };
  const verify = (overrides = {}) =>
    verifyQueryAuthorization({ payload, onChainKey, vehicleOwnerHash: identity, now, ...overrides });

  it('accepts a genuine, unexpired authorization from the current owner', () => {
    assert.deepEqual(verify(), { valid: true });
  });

  it('rejects a tampered VIN', () => {
    assert.match(verify({ payload: { ...payload, vin: 'VIN-OTHER' } }).reason, /簽章驗證失敗/);
  });

  it('rejects an extended expiry (signature covers expiresAt)', () => {
    assert.match(verify({ payload: { ...payload, expiresAt: '2026-09-25T00:00:00.000Z' } }).reason, /簽章驗證失敗/);
  });

  it('rejects an expired authorization before checking the signature', () => {
    assert.match(verify({ now: new Date('2026-09-24T00:10:00.001Z') }).reason, /已過期/);
  });

  it('rejects a signer who is not the vehicle\'s current owner', () => {
    assert.match(verify({ vehicleOwnerHash: 'owner-hash-real' }).reason, /不是鏈上登記的目前車主/);
  });

  it('rejects when the owner has no on-chain key', () => {
    assert.match(verify({ onChainKey: null }).reason, /尚未在鏈上登記/);
  });

  it('rejects malformed signature hex without throwing', () => {
    assert.match(verify({ payload: { ...payload, signatureHex: 'zz' } }).reason, /簽章驗證失敗/);
  });
});
