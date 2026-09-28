package contract

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// plan_dApp.md §2／D0：RegisterPQCKey 的登記、換鑰與強制重綁規則。
// 修正前任何組織都能覆寫他人公鑰並偽造車主授權，以下測試鎖定修正後的行為。

const testOwnerIdentity = "owner-hash-dapp"

func (l *testLedger) mustGetPQCKey(identity string) *PQCKey {
	l.t.Helper()
	data, ok := l.state[PQCKeyKey(identity)]
	require.True(l.t, ok, "身分 %s 的 PQC 公鑰應存在於世界狀態", identity)
	var key PQCKey
	require.NoError(l.t, json.Unmarshal(data, &key))
	return &key
}

// pqcKeyLogs 回傳 identity 的所有公鑰變更稽核紀錄（依鍵序，即時間序）。
func (l *testLedger) pqcKeyLogs(identity string) []*PQCKeyLog {
	l.t.Helper()
	prefix := pqcKeyLogPrefix + identity + ":"
	logs := []*PQCKeyLog{}
	for _, k := range sortedKeys(l.state) {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		var entry PQCKeyLog
		require.NoError(l.t, json.Unmarshal(l.state[k], &entry))
		logs = append(logs, &entry)
	}
	return logs
}

func (k *testOwnerKey) rotationProof(identity string, currentVersion int, newKey *testOwnerKey) string {
	return k.sign(pqcKeyRotationMessage(identity, currentVersion, newKey.publicKeyHex()))
}

func TestRegisterPQCKey_WithoutProof_Rejected_D0(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	key := newTestOwnerKey(t)

	err := c.RegisterPQCKey(l.ctx, testOwnerIdentity, key.publicKeyHex(), "")
	require.ErrorContains(t, err, "持有證明")
	require.Empty(t, l.state)
}

func TestRegisterPQCKey_ProofSignedByOtherKey_Rejected_D0(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	key := newTestOwnerKey(t)
	other := newTestOwnerKey(t)

	// 登記一把自己沒有私鑰的公鑰（用另一把私鑰簽持有證明）應被拒絕。
	proof := other.sign(pqcKeyRegistrationMessage(testOwnerIdentity, key.publicKeyHex()))
	err := c.RegisterPQCKey(l.ctx, testOwnerIdentity, key.publicKeyHex(), proof)
	require.ErrorContains(t, err, "持有證明")
	require.Empty(t, l.state)
}

func TestRegisterPQCKey_FirstRegistration_WritesVersionLogAndEvent_D0(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	registerTestOwnerKey(t, l, c, testOwnerIdentity)

	require.Equal(t, 1, l.mustGetPQCKey(testOwnerIdentity).Version)
	logs := l.pqcKeyLogs(testOwnerIdentity)
	require.Len(t, logs, 1)
	require.Equal(t, PQCKeyActionRegister, logs[0].Action)
	require.NotNil(t, l.chaincodeEvent)
	require.Equal(t, chaincodeEventPQCKey, l.chaincodeEvent.name)
}

// TestRegisterPQCKey_OverwriteByAttacker_Rejected_D0 重現修正前的漏洞：攻擊者持有自己的
// 新金鑰、也能附上合法的持有證明，但沒有車主的舊私鑰，因此不得覆寫車主公鑰。
func TestRegisterPQCKey_OverwriteByAttacker_Rejected_D0(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	ownerKey := registerTestOwnerKey(t, l, c, testOwnerIdentity)
	attacker := newTestOwnerKey(t)

	l.advanceTime()
	l.setCallerOrg(mspSVC)
	err := c.RegisterPQCKey(l.ctx, testOwnerIdentity, attacker.publicKeyHex(), attacker.registrationProof(testOwnerIdentity))
	require.ErrorContains(t, err, "目前登記的私鑰")

	l.advanceTime()
	err = c.RegisterPQCKey(l.ctx, testOwnerIdentity, attacker.publicKeyHex(), attacker.rotationProof(testOwnerIdentity, 1, attacker))
	require.ErrorContains(t, err, "目前登記的私鑰")

	stored := l.mustGetPQCKey(testOwnerIdentity)
	require.Equal(t, ownerKey.publicKeyHex(), stored.PublicKeyHex, "車主公鑰不應被覆寫")
}

func TestRegisterPQCKey_RotationSignedByOldKey_Succeeds_D0(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	oldKey := initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)
	newKey := newTestOwnerKey(t)

	l.advanceTime()
	err := c.RegisterPQCKey(l.ctx, "owner-hash-init", newKey.publicKeyHex(), oldKey.rotationProof("owner-hash-init", 1, newKey))
	require.NoError(t, err)
	stored := l.mustGetPQCKey("owner-hash-init")
	require.Equal(t, newKey.publicKeyHex(), stored.PublicKeyHex)
	require.Equal(t, 2, stored.Version)

	// 換鑰後，舊私鑰簽的保養授權失效，新私鑰簽的才會被接受。
	l.advanceTime()
	l.setCallerOrg(mspSVC)
	err = c.AddMaintenance(l.ctx, testVIN, "OIL_CHANGE", 10000, "更換機油", oldKey.signMaintenance(testVIN, "OIL_CHANGE", 10000, "更換機油"))
	require.ErrorContains(t, err, "授權驗證失敗")
	l.advanceTime()
	err = c.AddMaintenance(l.ctx, testVIN, "OIL_CHANGE", 10000, "更換機油", newKey.signMaintenance(testVIN, "OIL_CHANGE", 10000, "更換機油"))
	require.NoError(t, err)
}

// TestRegisterPQCKey_RotationReplay_Rejected_D0：A→B→A 之後，重放當初 A→B 的換鑰簽章
// 不得生效（換鑰訊息含版本號）。
func TestRegisterPQCKey_RotationReplay_Rejected_D0(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	keyA := registerTestOwnerKey(t, l, c, testOwnerIdentity)
	keyB := newTestOwnerKey(t)

	replayable := keyA.rotationProof(testOwnerIdentity, 1, keyB)
	l.advanceTime()
	require.NoError(t, c.RegisterPQCKey(l.ctx, testOwnerIdentity, keyB.publicKeyHex(), replayable))
	l.advanceTime()
	require.NoError(t, c.RegisterPQCKey(l.ctx, testOwnerIdentity, keyA.publicKeyHex(), keyB.rotationProof(testOwnerIdentity, 2, keyA)))

	l.advanceTime()
	err := c.RegisterPQCKey(l.ctx, testOwnerIdentity, keyB.publicKeyHex(), replayable)
	require.ErrorContains(t, err, "目前登記的私鑰")
	require.Equal(t, keyA.publicKeyHex(), l.mustGetPQCKey(testOwnerIdentity).PublicKeyHex)
}

func TestForceRebindPQCKey_ByREG_Succeeds_AndLogged_D0(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	registerTestOwnerKey(t, l, c, testOwnerIdentity)
	replacement := newTestOwnerKey(t)

	l.advanceTime()
	l.setCallerOrg(mspREG)
	err := c.ForceRebindPQCKey(l.ctx, testOwnerIdentity, replacement.publicKeyHex(), replacement.registrationProof(testOwnerIdentity), "車主遺失私鑰，監理站臨櫃核對身分證件")
	require.NoError(t, err)

	stored := l.mustGetPQCKey(testOwnerIdentity)
	require.Equal(t, replacement.publicKeyHex(), stored.PublicKeyHex)
	require.Equal(t, 2, stored.Version)

	logs := l.pqcKeyLogs(testOwnerIdentity)
	require.Len(t, logs, 2)
	last := logs[1]
	require.Equal(t, PQCKeyActionForceRebind, last.Action)
	require.Equal(t, mspREG, last.SubmittingOrg)
	require.Contains(t, last.Reason, "臨櫃")
	require.Equal(t, hashSerial(replacement.publicKeyHex()), last.PublicKeyHash)

	require.Equal(t, chaincodeEventPQCKey, l.chaincodeEvent.name)
	var payload PQCKeyLog
	require.NoError(t, json.Unmarshal(l.chaincodeEvent.payload, &payload))
	require.Equal(t, PQCKeyActionForceRebind, payload.Action)
}

func TestForceRebindPQCKey_NonREG_Rejected_D0(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	ownerKey := registerTestOwnerKey(t, l, c, testOwnerIdentity)
	replacement := newTestOwnerKey(t)

	for _, msp := range []string{mspOEM, mspSVC, mspINS, mspAPP} {
		l.advanceTime()
		l.setCallerOrg(msp)
		err := c.ForceRebindPQCKey(l.ctx, testOwnerIdentity, replacement.publicKeyHex(), replacement.registrationProof(testOwnerIdentity), "偽造")
		require.ErrorContains(t, err, mspREG, "%s 不應能強制重綁", msp)
	}
	require.Equal(t, ownerKey.publicKeyHex(), l.mustGetPQCKey(testOwnerIdentity).PublicKeyHex)
}

func TestForceRebindPQCKey_WithoutProofOrReason_Rejected_D0(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	registerTestOwnerKey(t, l, c, testOwnerIdentity)
	replacement := newTestOwnerKey(t)

	l.advanceTime()
	l.setCallerOrg(mspREG)
	err := c.ForceRebindPQCKey(l.ctx, testOwnerIdentity, replacement.publicKeyHex(), "", "遺失私鑰")
	require.ErrorContains(t, err, "持有證明")
	err = c.ForceRebindPQCKey(l.ctx, testOwnerIdentity, replacement.publicKeyHex(), replacement.registrationProof(testOwnerIdentity), "")
	require.ErrorContains(t, err, "必填")
}

func TestGetPQCKey_ReturnsRegisteredKey_D0(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	key := registerTestOwnerKey(t, l, c, testOwnerIdentity)

	got, err := c.GetPQCKey(l.ctx, testOwnerIdentity)
	require.NoError(t, err)
	require.Equal(t, key.publicKeyHex(), got.PublicKeyHex)
	require.Equal(t, pqcAlgorithm, got.Algorithm)

	_, err = c.GetPQCKey(l.ctx, "nobody")
	require.ErrorContains(t, err, "尚未登記")
}

// TestGetPQCKey_LegacyRecordWithoutVersion_TreatedAsVersion1_D0：修正前登記的公鑰沒有
// version 欄位，升級鏈碼後仍須能以舊私鑰簽章換鑰（版本視為 1）。
func TestGetPQCKey_LegacyRecordWithoutVersion_TreatedAsVersion1_D0(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	legacy := newTestOwnerKey(t)
	l.state[PQCKeyKey(testOwnerIdentity)] = []byte(`{"docType":"pqcKey","identity":"` + testOwnerIdentity +
		`","algorithm":"ML-DSA-65","publicKeyHex":"` + legacy.publicKeyHex() + `","registeredAt":"2026-09-23T00:00:00Z"}`)

	got, err := c.GetPQCKey(l.ctx, testOwnerIdentity)
	require.NoError(t, err)
	require.Equal(t, 1, got.Version)

	next := newTestOwnerKey(t)
	l.advanceTime()
	require.NoError(t, c.RegisterPQCKey(l.ctx, testOwnerIdentity, next.publicKeyHex(), legacy.rotationProof(testOwnerIdentity, 1, next)))
	require.Equal(t, 2, l.mustGetPQCKey(testOwnerIdentity).Version)
}
