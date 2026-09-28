// 車主授權訊息格式改由 web/shared/authMessages.js 統一定義（plan_dApp.md D1：網頁與 Gateway
// 共用同一份，避免瀏覽器錢包與 Gateway 託管錢包的格式漂移）。格式須與
// chaincode/vehicle/contract/pqc.go 逐位元組一致。
//
// 買家查詢授權（queryAuthorizationMessage）僅為 PoC 示範用途：履歷資料設計上本就公開可查
// （區塊鏈透明性），此簽章驗證的是「車主同意查詢」這個意圖本身，不是資料存取的硬性關卡。
export type { QueryAuthorization } from '../../web/shared/authMessages.js';
export {
  canonicalQueryAuthorization,
  maintenanceAuthorizationMessage,
  pqcKeyRegistrationMessage,
  pqcKeyRotationMessage,
  queryAuthorizationId,
  queryAuthorizationMessage,
} from '../../web/shared/authMessages.js';
