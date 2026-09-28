package contract

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/cloudflare/circl/sign/mldsa/mldsa65"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// pqcAlgorithm 是本專案登記／驗證的唯一 PQC 簽章演算法：CRYSTALS-Dilithium 第三安全等級，
// FIPS 204 標準化後的名稱為 ML-DSA-65（見 docs/stage0-validation.md）。鏈碼只做「驗證」，
// 不在鏈碼內簽章或產生金鑰（CLAUDE.md「密碼學與安全」：不自行實作密碼學演算法）。
const pqcAlgorithm = "ML-DSA-65"

// RegisterPQCKey 登記或輪替某身分（組織成員或車主化名雜湊）的 Dilithium 公鑰，對應
// plan.md §3.1 RegisterPQCKey、BFR5、NFR1，以及 plan_dApp.md §2 的安全修正。
// 車主並非 Fabric MSP 身分，因此不限制「哪個組織代送」，改以 PQC 簽章證明「誰有權變更」：
//   - 第一次登記：proofSignatureHex 須為「新私鑰」對 pqcKeyRegistrationMessage 的簽章
//     （持有證明，避免登記一把自己沒有私鑰的公鑰）。
//   - 已有公鑰（換鑰）：proofSignatureHex 須為「目前登記的舊私鑰」對
//     pqcKeyRotationMessage 的簽章；訊息含目前版本號，舊的換鑰簽章無法重放。
//
// 修正前任何組織都能直接覆寫他人公鑰，進而偽造 AddMaintenance 的車主授權（FFR2／BFR5
// 形同失效）；私鑰遺失時改由 ForceRebindPQCKey（僅限 REG）處理。
func (c *VehicleContract) RegisterPQCKey(
	ctx contractapi.TransactionContextInterface,
	identity string,
	publicKeyHex string,
	proofSignatureHex string,
) error {
	if identity == "" || publicKeyHex == "" {
		return fmt.Errorf("身分與公鑰皆為必填")
	}
	newPub, err := parseDilithiumPublicKey(publicKeyHex)
	if err != nil {
		return fmt.Errorf("Dilithium 公鑰格式錯誤：%w", err)
	}

	existing, err := getPQCKey(ctx, identity)
	if err != nil {
		return err
	}
	if existing == nil {
		if err := verifyDilithiumSignature(newPub, pqcKeyRegistrationMessage(identity, publicKeyHex), proofSignatureHex); err != nil {
			return fmt.Errorf("公鑰持有證明驗證失敗：%w", err)
		}
		return putPQCKey(ctx, identity, publicKeyHex, 1, PQCKeyActionRegister, "")
	}

	if existing.PublicKeyHex == publicKeyHex {
		return fmt.Errorf("新公鑰與目前登記的公鑰相同，無需換鑰")
	}
	oldPub, err := parseDilithiumPublicKey(existing.PublicKeyHex)
	if err != nil {
		return fmt.Errorf("已登記的 PQC 公鑰格式錯誤：%w", err)
	}
	if err := verifyDilithiumSignature(oldPub, pqcKeyRotationMessage(identity, existing.Version, publicKeyHex), proofSignatureHex); err != nil {
		return fmt.Errorf("換鑰須由目前登記的私鑰簽章授權：%w", err)
	}
	return putPQCKey(ctx, identity, publicKeyHex, existing.Version+1, PQCKeyActionRotate, "")
}

// ForceRebindPQCKey 私鑰遺失時的強制重新綁定（plan_dApp.md §2、§6 #3 已定案：監理站線下
// 核對身分後強制重綁）。僅限 REG 呼叫；仍要求新私鑰的持有證明，並寫入 PQCLOG 稽核紀錄與
// 鏈上事件，讓車主與其他組織事後都查得到「誰在何時、因何原因強制換了這把鑰匙」。
func (c *VehicleContract) ForceRebindPQCKey(
	ctx contractapi.TransactionContextInterface,
	identity string,
	publicKeyHex string,
	proofSignatureHex string,
	reason string,
) error {
	if err := requireOrg(ctx, mspREG); err != nil {
		return err
	}
	if identity == "" || publicKeyHex == "" || reason == "" {
		return fmt.Errorf("身分、公鑰與重綁原因皆為必填")
	}
	newPub, err := parseDilithiumPublicKey(publicKeyHex)
	if err != nil {
		return fmt.Errorf("Dilithium 公鑰格式錯誤：%w", err)
	}
	existing, err := getPQCKey(ctx, identity)
	if err != nil {
		return err
	}
	if existing == nil {
		return fmt.Errorf("身分 %s 尚未登記 PQC 公鑰，請改用一般登記流程", identity)
	}
	if err := verifyDilithiumSignature(newPub, pqcKeyRegistrationMessage(identity, publicKeyHex), proofSignatureHex); err != nil {
		return fmt.Errorf("公鑰持有證明驗證失敗：%w", err)
	}
	return putPQCKey(ctx, identity, publicKeyHex, existing.Version+1, PQCKeyActionForceRebind, reason)
}

// GetPQCKey 回傳 identity 目前登記的公鑰（plan_dApp.md D2：買家瀏覽器取鏈上公鑰自行驗證
// 車主簽章，不必相信 Gateway 的驗證結果）。任何組織皆可查詢。
func (c *VehicleContract) GetPQCKey(ctx contractapi.TransactionContextInterface, identity string) (*PQCKey, error) {
	key, err := getPQCKey(ctx, identity)
	if err != nil {
		return nil, err
	}
	if key == nil {
		return nil, fmt.Errorf("身分 %s 尚未登記 PQC 公鑰", identity)
	}
	return key, nil
}

// pqcKeyRegistrationMessage 是公鑰持有證明要簽署的訊息（第一次登記與強制重綁共用）。
func pqcKeyRegistrationMessage(identity, publicKeyHex string) []byte {
	return []byte(fmt.Sprintf("RegisterPQCKey|%s|%s", identity, publicKeyHex))
}

// pqcKeyRotationMessage 是換鑰時舊私鑰要簽署的訊息。currentVersion 讓每一次換鑰授權只對
// 當下版本有效：即使金鑰日後輪替回同一把舊鑰，先前的換鑰簽章也無法再被重放。
func pqcKeyRotationMessage(identity string, currentVersion int, newPublicKeyHex string) []byte {
	return []byte(fmt.Sprintf("RotatePQCKey|%s|%d|%s", identity, currentVersion, newPublicKeyHex))
}

func getPQCKey(ctx contractapi.TransactionContextInterface, identity string) (*PQCKey, error) {
	data, err := ctx.GetStub().GetState(PQCKeyKey(identity))
	if err != nil {
		return nil, fmt.Errorf("查詢 PQC 公鑰失敗：%w", err)
	}
	if data == nil {
		return nil, nil
	}
	var key PQCKey
	if err := json.Unmarshal(data, &key); err != nil {
		return nil, fmt.Errorf("解析 PQC 公鑰失敗：%w", err)
	}
	// 修正前登記的舊資料沒有 version 欄位，視為第 1 版。
	if key.Version == 0 {
		key.Version = 1
	}
	return &key, nil
}

// putPQCKey 寫入公鑰、PQCLOG 稽核紀錄，並發出 PQCKeyEvent 鏈上事件（D3）。
func putPQCKey(ctx contractapi.TransactionContextInterface, identity, publicKeyHex string, version int, action PQCKeyAction, reason string) error {
	ts, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("無法取得呼叫者組織身分：%w", err)
	}
	now := ts.Format(time.RFC3339)
	txID := ctx.GetStub().GetTxID()

	key := &PQCKey{
		DocType:      docTypePQCKey,
		Identity:     identity,
		Algorithm:    pqcAlgorithm,
		PublicKeyHex: publicKeyHex,
		RegisteredAt: now,
		Version:      version,
	}
	data, err := json.Marshal(key)
	if err != nil {
		return fmt.Errorf("序列化 PQC 公鑰失敗：%w", err)
	}
	if err := ctx.GetStub().PutState(PQCKeyKey(identity), data); err != nil {
		return fmt.Errorf("寫入 PQC 公鑰失敗：%w", err)
	}

	logEntry := &PQCKeyLog{
		DocType:       docTypePQCKeyLog,
		Identity:      identity,
		Action:        action,
		Version:       version,
		PublicKeyHash: hashSerial(publicKeyHex),
		SubmittingOrg: clientMSPID,
		Reason:        reason,
		TxID:          txID,
		Timestamp:     now,
	}
	logData, err := json.Marshal(logEntry)
	if err != nil {
		return fmt.Errorf("序列化 PQC 稽核紀錄失敗：%w", err)
	}
	if err := ctx.GetStub().PutState(PQCKeyLogKey(identity, ts.UnixNano(), txID), logData); err != nil {
		return fmt.Errorf("寫入 PQC 稽核紀錄失敗：%w", err)
	}
	return emitPQCKeyEvent(ctx, logEntry)
}

// parseDilithiumPublicKey 將十六進位字串解析為 mldsa65 公鑰物件，長度或格式錯誤時回傳錯誤。
func parseDilithiumPublicKey(publicKeyHex string) (*mldsa65.PublicKey, error) {
	raw, err := hex.DecodeString(publicKeyHex)
	if err != nil {
		return nil, fmt.Errorf("無法解析十六進位編碼：%w", err)
	}
	if len(raw) != mldsa65.PublicKeySize {
		return nil, fmt.Errorf("公鑰長度應為 %d bytes，實際為 %d bytes", mldsa65.PublicKeySize, len(raw))
	}
	pub := new(mldsa65.PublicKey)
	if err := pub.UnmarshalBinary(raw); err != nil {
		return nil, fmt.Errorf("無法還原公鑰：%w", err)
	}
	return pub, nil
}

// maintenanceAuthorizationMessage 組出 AddMaintenance 車主授權簽章要簽署的訊息，
// 以固定分隔符連接各欄位，確保訊息與內容一一對應（欄位篡改會導致簽章驗證失敗）。
func maintenanceAuthorizationMessage(vin, serviceType string, mileage int, description string) []byte {
	return []byte(fmt.Sprintf("AddMaintenance|%s|%s|%d|%s", vin, serviceType, mileage, description))
}

// verifyDilithiumAuthorization 查詢 identity 登記的 Dilithium 公鑰，驗證 message 的
// signatureHex 簽章是否有效；驗證失敗一律回傳錯誤拒絕交易（CLAUDE.md「密碼學與安全」：
// 簽章驗證失敗一律視為拒絕，不可降級為忽略），不寫入任何狀態。
func verifyDilithiumAuthorization(
	ctx contractapi.TransactionContextInterface,
	identity string,
	message []byte,
	signatureHex string,
) error {
	key, err := getPQCKey(ctx, identity)
	if err != nil {
		return err
	}
	if key == nil {
		return fmt.Errorf("身分 %s 尚未登記 PQC 公鑰，無法驗證授權簽章", identity)
	}
	pub, err := parseDilithiumPublicKey(key.PublicKeyHex)
	if err != nil {
		return fmt.Errorf("已登記的 PQC 公鑰格式錯誤：%w", err)
	}
	return verifyDilithiumSignature(pub, message, signatureHex)
}

// verifyDilithiumSignature 以 pub 驗證 message 的十六進位簽章，任何格式或驗證錯誤皆回傳錯誤。
func verifyDilithiumSignature(pub *mldsa65.PublicKey, message []byte, signatureHex string) error {
	if signatureHex == "" {
		return fmt.Errorf("缺少授權簽章")
	}
	sig, err := hex.DecodeString(signatureHex)
	if err != nil {
		return fmt.Errorf("無法解析授權簽章編碼：%w", err)
	}
	if len(sig) != mldsa65.SignatureSize {
		return fmt.Errorf("授權簽章長度不正確")
	}
	if !mldsa65.Verify(pub, message, nil, sig) {
		return fmt.Errorf("授權簽章驗證失敗")
	}
	return nil
}
