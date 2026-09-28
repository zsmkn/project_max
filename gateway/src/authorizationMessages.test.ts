import { describe, expect, it } from 'vitest';
import {
  maintenanceAuthorizationMessage,
  pqcKeyRegistrationMessage,
  pqcKeyRotationMessage,
  queryAuthorizationMessage,
} from './authorizationMessages.js';

describe('maintenanceAuthorizationMessage', () => {
  it('formats fields with the fixed delimiter expected by pqc.go BFR5', () => {
    const message = maintenanceAuthorizationMessage('VIN1', 'OIL_CHANGE', 12000, '更換機油');
    const text = new TextDecoder().decode(message);
    expect(text).toBe('AddMaintenance|VIN1|OIL_CHANGE|12000|更換機油');
  });

  it('produces different messages when mileage differs, so a signature cannot be replayed for a different value', () => {
    const a = maintenanceAuthorizationMessage('VIN1', 'OIL_CHANGE', 12000, 'x');
    const b = maintenanceAuthorizationMessage('VIN1', 'OIL_CHANGE', 99999, 'x');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe('queryAuthorizationMessage', () => {
  it('formats VIN and expiry with the fixed delimiter', () => {
    const message = queryAuthorizationMessage('VIN1', '2026-01-01T00:00:00.000Z');
    const text = new TextDecoder().decode(message);
    expect(text).toBe('QueryAuthorization|VIN1|2026-01-01T00:00:00.000Z');
  });

  it('produces different messages for different expiry times, so a signature cannot be replayed with an extended deadline', () => {
    const a = queryAuthorizationMessage('VIN1', '2026-01-01T00:00:00.000Z');
    const b = queryAuthorizationMessage('VIN1', '2026-01-01T00:10:00.000Z');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe('PQC key registration / rotation messages (plan_dApp.md D0, must match pqc.go)', () => {
  it('formats the proof-of-possession message', () => {
    const text = new TextDecoder().decode(pqcKeyRegistrationMessage('owner-1', 'abcd'));
    expect(text).toBe('RegisterPQCKey|owner-1|abcd');
  });

  it('binds the rotation message to the current key version to prevent replay', () => {
    const text = new TextDecoder().decode(pqcKeyRotationMessage('owner-1', 3, 'abcd'));
    expect(text).toBe('RotatePQCKey|owner-1|3|abcd');
  });
});
