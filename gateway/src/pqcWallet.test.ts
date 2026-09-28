import * as fs from 'node:fs/promises';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { afterEach, describe, expect, it } from 'vitest';

import { config } from './config.js';
import * as pqcWallet from './pqcWallet.js';

// 用固定的測試身分字串，測試結束後清掉錢包檔案，避免污染真實 wallet/ 目錄
// （見 pqcWallet.ts 的檔名編碼規則：identity 的 utf8 十六進位編碼 + .json）。
const testIdentity = 'vitest-pqc-wallet-test-identity';

function testKeyFilePath(): string {
  const fileName = Buffer.from(testIdentity, 'utf8').toString('hex') + '.json';
  return `${config.wallet.dir}/${fileName}`;
}

afterEach(async () => {
  await fs.rm(testKeyFilePath(), { force: true });
});

describe('pqcWallet', () => {
  it('generates a key whose signatures verify with the same ML-DSA-65 implementation used by chaincode (CIRCL, verified separately, see docs/stage3-pqc.md)', async () => {
    const { publicKeyHex } = await pqcWallet.generateKey(testIdentity);
    const message = new TextEncoder().encode('hello vehiclenet');
    const signatureHex = await pqcWallet.sign(testIdentity, message);

    const publicKey = Uint8Array.from(Buffer.from(publicKeyHex, 'hex'));
    const signature = Uint8Array.from(Buffer.from(signatureHex, 'hex'));
    expect(ml_dsa65.verify(signature, message, publicKey)).toBe(true);
  });

  it('rejects a signature for content that was not what was signed', async () => {
    const { publicKeyHex } = await pqcWallet.generateKey(testIdentity);
    const signedMessage = new TextEncoder().encode('original content');
    const tamperedMessage = new TextEncoder().encode('tampered content');
    const signatureHex = await pqcWallet.sign(testIdentity, signedMessage);

    const publicKey = Uint8Array.from(Buffer.from(publicKeyHex, 'hex'));
    const signature = Uint8Array.from(Buffer.from(signatureHex, 'hex'));
    expect(ml_dsa65.verify(signature, tamperedMessage, publicKey)).toBe(false);
  });

  it('returns null from getPublicKey for an identity with no generated key', async () => {
    expect(await pqcWallet.getPublicKey('identity-with-no-key-ever-generated')).toBeNull();
  });

  it('throws when asked to sign for an identity with no generated key', async () => {
    await expect(pqcWallet.sign('identity-with-no-key-ever-generated', new Uint8Array())).rejects.toThrow(
      '尚未在金鑰錢包中產生',
    );
  });

  it('verifyWithPublicKey accepts a genuine signature', async () => {
    const { publicKeyHex } = await pqcWallet.generateKey(testIdentity);
    const message = new TextEncoder().encode('query-authorization payload');
    const signatureHex = await pqcWallet.sign(testIdentity, message);
    expect(pqcWallet.verifyWithPublicKey(publicKeyHex, message, signatureHex)).toBe(true);
  });

  it('verifyWithPublicKey rejects a signature for content that was not what was signed', async () => {
    const { publicKeyHex } = await pqcWallet.generateKey(testIdentity);
    const signatureHex = await pqcWallet.sign(testIdentity, new TextEncoder().encode('original'));
    const tampered = new TextEncoder().encode('tampered');
    expect(pqcWallet.verifyWithPublicKey(publicKeyHex, tampered, signatureHex)).toBe(false);
  });

  it('verifyWithPublicKey returns false (not throw) for malformed hex input', () => {
    const message = new TextEncoder().encode('anything');
    const { publicKeyHex } = pqcWallet.newKeyPair();
    expect(pqcWallet.verifyWithPublicKey(publicKeyHex, message, 'not-valid-hex')).toBe(false);
    expect(pqcWallet.verifyWithPublicKey('zz', message, 'deadbeef')).toBe(false);
  });

  it('newKeyPair does not write to the wallet until saveKey is called (D0: save only after on-chain registration)', async () => {
    const pair = pqcWallet.newKeyPair();
    expect(await pqcWallet.getPublicKey(testIdentity)).toBeNull();
    await pqcWallet.saveKey(testIdentity, pair);
    expect(await pqcWallet.getPublicKey(testIdentity)).toBe(pair.publicKeyHex);
  });

  it('signWithSecretKey produces a proof of possession verifiable with the new public key', () => {
    const pair = pqcWallet.newKeyPair();
    const message = new TextEncoder().encode('RegisterPQCKey|owner|' + pair.publicKeyHex);
    const signatureHex = pqcWallet.signWithSecretKey(pair.secretKeyHex, message);
    expect(pqcWallet.verifyWithPublicKey(pair.publicKeyHex, message, signatureHex)).toBe(true);
  });
});
