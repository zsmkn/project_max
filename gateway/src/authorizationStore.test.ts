import { describe, expect, it } from 'vitest';

import { queryAuthorizationId } from './authorizationMessages.js';
import { QueryAuthorizationStore } from './authorizationStore.js';

// plan_dApp.md D2：QR Code 只放內容定址 ID，完整授權由 Gateway 暫存轉交。

const NOW = Date.parse('2026-09-24T00:00:00.000Z');

function authorization(expiresAt = '2026-09-24T00:10:00.000Z') {
  return { vin: 'VIN1', ownerIdentity: 'owner-1', expiresAt, signatureHex: 'ab'.repeat(3309) };
}

describe('QueryAuthorizationStore', () => {
  it('returns the SHA-256 content address, so the buyer can detect any tampering by the Gateway', async () => {
    const store = new QueryAuthorizationStore(() => NOW);
    const id = await store.put(authorization());
    expect(id).toBe(await queryAuthorizationId(authorization()));
    expect(store.get(id)).toEqual(authorization());
  });

  it('changes the ID when any field changes', async () => {
    const a = await queryAuthorizationId(authorization());
    const b = await queryAuthorizationId({ ...authorization(), vin: 'VIN2' });
    expect(a).not.toBe(b);
  });

  it('drops authorizations after they expire', async () => {
    let now = NOW;
    const store = new QueryAuthorizationStore(() => now);
    const id = await store.put(authorization());
    now = Date.parse('2026-09-24T00:10:00.001Z');
    expect(store.get(id)).toBeNull();
  });

  it('rejects already-expired or overly long-lived authorizations', async () => {
    const store = new QueryAuthorizationStore(() => NOW);
    await expect(store.put(authorization('2026-09-23T23:59:59.000Z'))).rejects.toThrow('已過期');
    await expect(store.put(authorization('2026-09-26T00:00:00.000Z'))).rejects.toThrow('24 小時');
    await expect(store.put(authorization('not-a-date'))).rejects.toThrow('格式錯誤');
  });
});
