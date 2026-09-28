import { describe, expect, it } from 'vitest';

import { userFacingErrorMessage } from './gatewayErrors.js';

function gatewayError(message: string, details: { message: string }[] = []) {
  return Object.assign(new Error(message), { details });
}

describe('userFacingErrorMessage', () => {
  it('surfaces the chaincode rejection reason from endorsement details (deduplicated across peers)', () => {
    const err = gatewayError('10 ABORTED: failed to endorse transaction, see attached details for more info', [
      { message: 'chaincode response 500, 車主保養授權驗證失敗：授權簽章驗證失敗' },
      { message: 'chaincode response 500, 車主保養授權驗證失敗：授權簽章驗證失敗' },
    ]);
    expect(userFacingErrorMessage(err)).toBe('車主保養授權驗證失敗：授權簽章驗證失敗');
  });

  it('strips the endorser prefix from evaluate errors that carry the message inline', () => {
    const err = gatewayError('10 ABORTED: evaluate call to endorser returned error: chaincode response 500, 車輛 X 不存在');
    expect(userFacingErrorMessage(err)).toBe('車輛 X 不存在');
  });

  it('falls back to the original message when there is no chaincode response', () => {
    expect(userFacingErrorMessage(gatewayError('14 UNAVAILABLE: connection refused'))).toBe(
      '14 UNAVAILABLE: connection refused',
    );
  });

  it('does not leak anything for non-Error values', () => {
    expect(userFacingErrorMessage('boom')).toBe('未知錯誤');
  });
});
