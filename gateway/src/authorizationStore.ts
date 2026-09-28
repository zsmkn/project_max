import { type QueryAuthorization, queryAuthorizationId } from './authorizationMessages.js';

// 買家查詢授權的暫存區（plan_dApp.md D2）：ML-DSA-65 簽章放不進單一 QR Code，QR 只放內容
// 定址 ID，完整授權由此處轉交。Gateway 只是「傳話的人」：ID 即內容的 SHA-256，買家取回後
// 自行重算比對並以鏈上公鑰驗章，Gateway 竄改內容必定被發現，因此不需要信任本暫存區。
// 只存在記憶體（重啟即清空），到期自動失效；不上鏈，因為授權本身是短期、一次性的。

// 授權最長保留時間與總筆數上限，避免未驗證的上傳把記憶體塞滿。
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

interface StoredAuthorization {
  authorization: QueryAuthorization;
  expiresAtMs: number;
}

export class QueryAuthorizationStore {
  private readonly entries = new Map<string, StoredAuthorization>();

  constructor(private readonly now: () => number = Date.now) {}

  // put 保存授權並回傳其內容定址 ID；已過期、期限超過上限或格式錯誤時拋出錯誤。
  async put(authorization: QueryAuthorization): Promise<string> {
    const expiresAtMs = Date.parse(authorization.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      throw new Error('expiresAt 格式錯誤');
    }
    const remainingMs = expiresAtMs - this.now();
    if (remainingMs <= 0) {
      throw new Error('查詢授權已過期');
    }
    if (remainingMs > MAX_TTL_MS) {
      throw new Error('查詢授權有效期限不可超過 24 小時');
    }
    this.evictExpired();
    if (this.entries.size >= MAX_ENTRIES) {
      throw new Error('暫存的查詢授權過多，請稍後再試');
    }
    const id = await queryAuthorizationId(authorization);
    const { vin, ownerIdentity, expiresAt, signatureHex } = authorization;
    this.entries.set(id, { authorization: { vin, ownerIdentity, expiresAt, signatureHex }, expiresAtMs });
    return id;
  }

  // get 回傳尚未過期的授權，不存在或已過期時回傳 null。
  get(id: string): QueryAuthorization | null {
    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(id);
      return null;
    }
    return entry.authorization;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAtMs <= now) {
        this.entries.delete(id);
      }
    }
  }
}
