// 瀏覽器自持金鑰錢包的儲存層（plan_dApp.md D1）：私鑰存在本機 IndexedDB，Gateway 只看得到
// 公鑰與簽章。密碼學運算見 walletCrypto.js。
//
// 限制（報告需註明）：ML-DSA 尚未納入 WebCrypto，私鑰只能以原始位元組存放，無法設為
// non-extractable；同源的任何腳本都讀得到。因此所有頁面腳本都從 web/ 同源載入，不使用 CDN。

import { generateKeyPair, signMessage } from './walletCrypto.js';

const DB_NAME = 'vehiclenet-wallet';
const STORE_NAME = 'keys';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'identity' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`無法開啟本機錢包：${request.error?.message}`));
  });
}

async function withStore(mode, operation) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = operation(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(new Error(`本機錢包操作失敗：${tx.error?.message}`));
    });
  } finally {
    db.close();
  }
}

// loadKey 回傳 { identity, publicKeyHex, secretKeyHex, createdAt }，不存在時回傳 null。
export async function loadKey(identity) {
  return (await withStore('readonly', (store) => store.get(identity))) ?? null;
}

export async function saveKey(record) {
  await withStore('readwrite', (store) => store.put({ ...record, createdAt: record.createdAt || new Date().toISOString() }));
}

export async function listIdentities() {
  return withStore('readonly', (store) => store.getAllKeys());
}

// newKeyRecord 產生尚未保存的新金鑰；呼叫端在鏈上登記成功後才 saveKey，避免本機與鏈上不一致。
export function newKeyRecord(identity) {
  return { identity, ...generateKeyPair(), createdAt: new Date().toISOString() };
}

export async function signAs(identity, message) {
  const record = await loadKey(identity);
  if (!record) {
    throw new Error(`此瀏覽器沒有身分 ${identity} 的私鑰，請先產生金鑰或匯入備份`);
  }
  return signMessage(record.secretKeyHex, message);
}
