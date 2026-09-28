// 把 Fabric Gateway 的錯誤轉成可以直接顯示給使用者的訊息。
//
// submitTransaction 背書失敗時，err.message 只有「10 ABORTED: failed to endorse transaction,
// see attached details」，鏈碼真正的拒絕原因（我們設計給使用者看的中文訊息，例如「授權簽章
// 驗證失敗」）放在 err.details[].message 裡，而且每個背書節點各一份。這裡取出鏈碼訊息並去重；
// 沒有 details 時（例如 evaluateTransaction）退回 err.message。只回傳鏈碼訊息本身，不含節點
// 位址等內部資訊（CLAUDE.md「面向使用者的錯誤訊息不洩漏內部路徑」）。

const CHAINCODE_RESPONSE_PREFIX = /^.*chaincode response \d+, /s;

function stripPrefix(message: string): string {
  return message.replace(CHAINCODE_RESPONSE_PREFIX, '').trim();
}

export function userFacingErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return '未知錯誤';
  }
  const details = (err as { details?: { message?: string }[] }).details ?? [];
  const chaincodeMessages = [
    ...new Set(details.map((d) => d.message ?? '').filter((m) => CHAINCODE_RESPONSE_PREFIX.test(m)).map(stripPrefix)),
  ];
  if (chaincodeMessages.length > 0) {
    return chaincodeMessages.join('；');
  }
  return stripPrefix(err.message);
}
