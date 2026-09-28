package contract

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"testing"

	"github.com/cloudflare/circl/sign/mldsa/mldsa65"
	"github.com/golang/protobuf/ptypes/timestamp"
	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-protos-go/ledger/queryresult"
	"github.com/stretchr/testify/require"

	"vehiclenet.tw/chaincode/vehicle/contract/mocks"
)

// fakeIterator 是 GetStateByRange 用的簡易假迭代器，依鍵值排序回傳世界狀態子集。
type fakeIterator struct {
	items []*queryresult.KV
	pos   int
}

func (it *fakeIterator) HasNext() bool { return it.pos < len(it.items) }

func (it *fakeIterator) Next() (*queryresult.KV, error) {
	item := it.items[it.pos]
	it.pos++
	return item, nil
}

func (it *fakeIterator) Close() error { return nil }

// testLedger 用記憶體 map 模擬 Fabric 世界狀態，讓 counterfeiter 產生的 ChaincodeStub／
// TransactionContext／ClientIdentity 假物件的行為接近真實 peer，避免每個測試都要手動
// 設定每一次呼叫的回傳值。
type testLedger struct {
	t              *testing.T
	stub           *mocks.ChaincodeStub
	ctx            *mocks.TransactionContext
	clientIdentity *mocks.ClientIdentity
	state          map[string][]byte
	policies       map[string][]byte
	chaincodeEvent *recordedChaincodeEvent
	nowSeconds     int64
	txCounter      int
}

func newTestLedger(t *testing.T) *testLedger {
	l := &testLedger{
		t:              t,
		stub:           &mocks.ChaincodeStub{},
		ctx:            &mocks.TransactionContext{},
		clientIdentity: &mocks.ClientIdentity{},
		state:          map[string][]byte{},
		policies:       map[string][]byte{},
		nowSeconds:     1_700_000_000,
	}

	l.stub.GetStateCalls(func(key string) ([]byte, error) {
		return l.state[key], nil
	})
	l.stub.PutStateCalls(func(key string, value []byte) error {
		l.state[key] = append([]byte(nil), value...)
		return nil
	})
	l.stub.SetStateValidationParameterCalls(func(key string, policy []byte) error {
		l.policies[key] = append([]byte(nil), policy...)
		return nil
	})
	l.stub.SetEventCalls(func(name string, payload []byte) error {
		l.chaincodeEvent = &recordedChaincodeEvent{name: name, payload: append([]byte(nil), payload...)}
		return nil
	})
	l.stub.GetStateByRangeCalls(func(start, end string) (shim.StateQueryIteratorInterface, error) {
		keys := make([]string, 0, len(l.state))
		for k := range l.state {
			if k >= start && k < end {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		items := make([]*queryresult.KV, 0, len(keys))
		for _, k := range keys {
			items = append(items, &queryresult.KV{Key: k, Value: l.state[k]})
		}
		return &fakeIterator{items: items}, nil
	})

	l.ctx.GetStubReturns(l.stub)
	l.ctx.GetClientIdentityReturns(l.clientIdentity)
	l.setCallerOrg(mspOEM)
	l.advanceTime()
	return l
}

// recordedChaincodeEvent 記錄最近一次 SetEvent 的內容（Fabric 每筆交易只保留最後一個事件）。
type recordedChaincodeEvent struct {
	name    string
	payload []byte
}

// mustVehicleEvent 解析最近一次發出的 VehicleEvent（plan_dApp.md D3）。
func (l *testLedger) mustVehicleEvent() VehicleEventPayload {
	l.t.Helper()
	require.NotNil(l.t, l.chaincodeEvent, "應發出鏈碼事件")
	require.Equal(l.t, chaincodeEventVehicle, l.chaincodeEvent.name)
	var payload VehicleEventPayload
	require.NoError(l.t, json.Unmarshal(l.chaincodeEvent.payload, &payload))
	return payload
}

func (l *testLedger) setCallerOrg(mspID string) {
	l.clientIdentity.GetMSPIDReturns(mspID, nil)
}

// advanceTimeByDays 除了推進交易 ID，另外把模擬時間往前推 days 天，供測試「理賠後 N 天內
// 無維修紀錄」（BFR3）這類需要時間跨度的情境使用。
func (l *testLedger) advanceTimeByDays(days int) {
	l.txCounter++
	l.nowSeconds += int64(days) * 24 * 60 * 60
	l.stub.GetTxTimestampReturns(&timestamp.Timestamp{Seconds: l.nowSeconds}, nil)
	l.stub.GetTxIDReturns(fmt.Sprintf("tx%03d", l.txCounter))
}

// advanceTime 模擬下一筆交易的時間戳與交易 ID。合約邏輯一律透過
// stub.GetTxTimestamp() 取得時間（而非系統時間），維持鏈碼決定性
// （CLAUDE.md「智慧合約規則」），測試中每筆交易呼叫前都應先推進一次。
func (l *testLedger) advanceTime() {
	l.txCounter++
	l.nowSeconds++
	l.stub.GetTxTimestampReturns(&timestamp.Timestamp{Seconds: l.nowSeconds}, nil)
	l.stub.GetTxIDReturns(fmt.Sprintf("tx%03d", l.txCounter))
}

func (l *testLedger) mustGetVehicle(vin string) *Vehicle {
	l.t.Helper()
	data, ok := l.state[VehicleKey(vin)]
	require.True(l.t, ok, "車輛 %s 應存在於世界狀態", vin)
	var vehicle Vehicle
	require.NoError(l.t, json.Unmarshal(data, &vehicle))
	return &vehicle
}

func (l *testLedger) mustGetPart(partHash string) *PartBinding {
	l.t.Helper()
	data, ok := l.state[PartKey(partHash)]
	require.True(l.t, ok, "零件綁定 %s 應存在於世界狀態", partHash)
	var binding PartBinding
	require.NoError(l.t, json.Unmarshal(data, &binding))
	return &binding
}

// findEvent 回傳指定 VIN 底下第一筆符合 eventType 的事件（依鍵序，即時間序）及其狀態鍵。
func (l *testLedger) findEvent(vin string, eventType EventType) (*Event, string) {
	l.t.Helper()
	events, keys := l.findAllEvents(vin, eventType)
	if len(events) == 0 {
		return nil, ""
	}
	return events[0], keys[0]
}

// findAllEvents 回傳指定 VIN 底下所有符合 eventType 的事件與對應狀態鍵，依鍵序（即時間序）排列。
func (l *testLedger) findAllEvents(vin string, eventType EventType) ([]*Event, []string) {
	l.t.Helper()
	allKeys := make([]string, 0)
	for k := range l.state {
		if len(k) >= len(eventKeyPrefix) && k[:len(eventKeyPrefix)] == eventKeyPrefix {
			allKeys = append(allKeys, k)
		}
	}
	sort.Strings(allKeys)
	events := make([]*Event, 0)
	keys := make([]string, 0)
	for _, k := range allKeys {
		var event Event
		require.NoError(l.t, json.Unmarshal(l.state[k], &event))
		if event.VIN == vin && event.Type == eventType {
			events = append(events, &event)
			keys = append(keys, k)
		}
	}
	return events, keys
}

func newTestVehicleContract() *VehicleContract {
	return &VehicleContract{}
}

const (
	testVIN                = "VIN00000000TEST1"
	testEngineSerial       = "ENGINE-SERIAL-001"
	testTransmissionSerial = "TRANS-SERIAL-001"
)

// initTestVehicle 建立測試車輛，車主固定為 "owner-hash-init"，並順便登記該車主的
// Dilithium 公鑰（回傳對應私鑰，供測試簽署 AddMaintenance 的車主授權訊息）。
func initTestVehicle(t *testing.T, l *testLedger, c *VehicleContract, vin, engineSerial, transmissionSerial string) *testOwnerKey {
	t.Helper()
	l.setCallerOrg(mspOEM)
	err := c.InitVehicle(l.ctx, vin, engineSerial, transmissionSerial, 2024, 800000, "owner-hash-init")
	require.NoError(t, err)
	return registerTestOwnerKey(t, l, c, "owner-hash-init")
}

// --- PQC 測試輔助（BFR5） ---

// testOwnerKey 包裝一組測試用 mldsa65（Dilithium／ML-DSA-65）金鑰，供測試模擬車主
// 對 AddMaintenance 的授權簽章。
type testOwnerKey struct {
	pub  *mldsa65.PublicKey
	priv *mldsa65.PrivateKey
}

func newTestOwnerKey(t *testing.T) *testOwnerKey {
	t.Helper()
	pub, priv, err := mldsa65.GenerateKey(rand.Reader)
	require.NoError(t, err)
	return &testOwnerKey{pub: pub, priv: priv}
}

func (k *testOwnerKey) publicKeyHex() string {
	return hex.EncodeToString(k.pub.Bytes())
}

// sign 對 message 產生十六進位編碼的 Dilithium 簽章。
func (k *testOwnerKey) sign(message []byte) string {
	sig := make([]byte, mldsa65.SignatureSize)
	mldsa65.SignTo(k.priv, message, nil, false, sig)
	return hex.EncodeToString(sig)
}

// signMaintenance 簽署與 AddMaintenance 相同的訊息格式（見 pqc.go
// maintenanceAuthorizationMessage），方便測試組出合法的車主授權簽章。
func (k *testOwnerKey) signMaintenance(vin, serviceType string, mileage int, description string) string {
	return k.sign(maintenanceAuthorizationMessage(vin, serviceType, mileage, description))
}

// registrationProof 以此金鑰對「登記 identity」的訊息簽章，作為公鑰持有證明（plan_dApp.md §2）。
func (k *testOwnerKey) registrationProof(identity string) string {
	return k.sign(pqcKeyRegistrationMessage(identity, k.publicKeyHex()))
}

// registerTestOwnerKey 產生一組新金鑰並以 RegisterPQCKey 登記給 identity，回傳金鑰供測試簽章。
func registerTestOwnerKey(t *testing.T, l *testLedger, c *VehicleContract, identity string) *testOwnerKey {
	t.Helper()
	key := newTestOwnerKey(t)
	err := c.RegisterPQCKey(l.ctx, identity, key.publicKeyHex(), key.registrationProof(identity))
	require.NoError(t, err)
	return key
}

// --- InitVehicle（BFR1） ---

func TestInitVehicle_Success_BFR1(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	l.setCallerOrg(mspOEM)

	err := c.InitVehicle(l.ctx, testVIN, testEngineSerial, testTransmissionSerial, 2024, 800000, "owner-hash-1")
	require.NoError(t, err)

	vehicle := l.mustGetVehicle(testVIN)
	require.Equal(t, VehicleStatusActive, vehicle.Status)
	require.Equal(t, 0, vehicle.Mileage)
	require.Equal(t, defaultInitialIntegrityScore, vehicle.IntegrityScore)
	require.InEpsilon(t, 800000.0, vehicle.ResidualValue, 0.0001)
	require.Equal(t, hashSerial(testEngineSerial), vehicle.EngineHash)
	require.Equal(t, hashSerial(testTransmissionSerial), vehicle.TransmissionHash)

	enginePart := l.mustGetPart(vehicle.EngineHash)
	require.False(t, enginePart.Released)
	require.Equal(t, testVIN, enginePart.VIN)

	event, key := l.findEvent(testVIN, EventTypeInit)
	require.NotNil(t, event, "應寫入 INIT 事件")

	expectedPolicy, err := andPolicy(mspOEM, mspREG)
	require.NoError(t, err)
	require.Equal(t, expectedPolicy, l.policies[key], "InitVehicle 背書政策應為 AND(OEM, REG)")
}

func TestInitVehicle_WrongOrg_Rejected_BFR1(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	l.setCallerOrg(mspSVC)

	err := c.InitVehicle(l.ctx, testVIN, testEngineSerial, testTransmissionSerial, 2024, 800000, "owner-hash-1")
	require.ErrorContains(t, err, mspOEM)
	require.Empty(t, l.state, "非 OEM 呼叫應被拒絕，不應寫入任何狀態")
}

func TestInitVehicle_DuplicateVIN_Rejected_BFR1(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspOEM)
	err := c.InitVehicle(l.ctx, testVIN, "OTHER-ENGINE", "OTHER-TRANS", 2024, 900000, "owner-hash-2")
	require.ErrorContains(t, err, "已存在")
}

func TestInitVehicle_DuplicatePartHash_Rejected_BFR1(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspOEM)
	err := c.InitVehicle(l.ctx, "VIN00000000TEST2", testEngineSerial, "ANOTHER-TRANS", 2024, 900000, "owner-hash-2")
	require.ErrorContains(t, err, "套牌")
}

// --- AddMaintenance（BFR2, FFR2） ---

func TestAddMaintenance_Success_BFR2(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	ownerKey := initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspSVC)
	sig := ownerKey.signMaintenance(testVIN, "OIL_CHANGE", 15000, "更換機油與濾芯")
	err := c.AddMaintenance(l.ctx, testVIN, "OIL_CHANGE", 15000, "更換機油與濾芯", sig)
	require.NoError(t, err)

	vehicle := l.mustGetVehicle(testVIN)
	require.Equal(t, 15000, vehicle.Mileage)

	event, key := l.findEvent(testVIN, EventTypeMaintenance)
	require.NotNil(t, event)
	require.Equal(t, "OIL_CHANGE", event.ServiceType)
	require.Equal(t, 15000, event.Mileage)

	expectedPolicy, err := requiredWithWitness(mspSVC, mspREG, mspAPP)
	require.NoError(t, err)
	require.Equal(t, expectedPolicy, l.policies[key], "AddMaintenance 背書政策應為 AND(SVC, OutOf(1, REG, APP))")
}

func TestAddMaintenance_ScrappedVehicle_Rejected_BFR2(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspREG)
	require.NoError(t, c.ScrapVehicle(l.ctx, testVIN, "事故全損"))

	l.advanceTime()
	l.setCallerOrg(mspSVC)
	// 車輛已報廢的檢查發生在簽章驗證之前，這裡不需要合法簽章即可測到預期錯誤。
	err := c.AddMaintenance(l.ctx, testVIN, "OIL_CHANGE", 15000, "更換機油", "")
	require.ErrorContains(t, err, "已報廢")
}

// --- PQC 公鑰登記與簽章授權（BFR5, FFR2） ---

func TestRegisterPQCKey_Success_BFR5(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	key := newTestOwnerKey(t)

	err := c.RegisterPQCKey(l.ctx, "owner-hash-abc", key.publicKeyHex(), key.registrationProof("owner-hash-abc"))
	require.NoError(t, err)

	data, ok := l.state[PQCKeyKey("owner-hash-abc")]
	require.True(t, ok, "PQC 公鑰應寫入世界狀態")
	var stored PQCKey
	require.NoError(t, json.Unmarshal(data, &stored))
	require.Equal(t, pqcAlgorithm, stored.Algorithm)
	require.Equal(t, key.publicKeyHex(), stored.PublicKeyHex)
}

func TestRegisterPQCKey_InvalidPublicKey_Rejected_BFR5(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()

	err := c.RegisterPQCKey(l.ctx, "owner-hash-abc", "not-a-valid-hex-key", "")
	require.Error(t, err)
	require.Empty(t, l.state, "格式錯誤的公鑰不應寫入世界狀態")
}

func TestAddMaintenance_TamperedSignature_Rejected_BFR5(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	ownerKey := initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspSVC)
	// 對「里程 15000」簽章，卻送出「里程 99999」的交易內容——簽章與實際內容不符，應被拒絕。
	sig := ownerKey.signMaintenance(testVIN, "OIL_CHANGE", 15000, "更換機油")
	err := c.AddMaintenance(l.ctx, testVIN, "OIL_CHANGE", 99999, "更換機油", sig)
	require.ErrorContains(t, err, "授權驗證失敗")

	vehicle := l.mustGetVehicle(testVIN)
	require.Equal(t, 0, vehicle.Mileage, "簽章驗證失敗時不應寫入任何狀態變更")
}

func TestAddMaintenance_WrongSignerKey_Rejected_BFR5(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)
	impostorKey := newTestOwnerKey(t) // 未登記給車主身分的另一組金鑰

	l.advanceTime()
	l.setCallerOrg(mspSVC)
	sig := impostorKey.signMaintenance(testVIN, "OIL_CHANGE", 15000, "更換機油")
	err := c.AddMaintenance(l.ctx, testVIN, "OIL_CHANGE", 15000, "更換機油", sig)
	require.ErrorContains(t, err, "授權驗證失敗")
}

func TestAddMaintenance_OwnerKeyNotRegistered_Rejected_BFR5(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	// 直接呼叫 InitVehicle（不透過 initTestVehicle），車主不登記任何 PQC 公鑰。
	l.setCallerOrg(mspOEM)
	require.NoError(t, c.InitVehicle(l.ctx, testVIN, testEngineSerial, testTransmissionSerial, 2024, 800000, "owner-hash-unregistered"))

	l.advanceTime()
	l.setCallerOrg(mspSVC)
	err := c.AddMaintenance(l.ctx, testVIN, "OIL_CHANGE", 15000, "更換機油", "deadbeef")
	require.ErrorContains(t, err, "尚未登記")
}

// --- RecordClaim（BFR2, EIR2） ---

func TestRecordClaim_Success_BFR2(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspINS)
	err := c.RecordClaim(l.ctx, testVIN, "CLM-001", "COLLISION", 50000, "FRONT_BUMPER")
	require.NoError(t, err)

	event, key := l.findEvent(testVIN, EventTypeClaim)
	require.NotNil(t, event)
	require.Equal(t, "CLM-001", event.ClaimID)
	require.InEpsilon(t, 50000.0, event.IncidentAmount, 0.0001)

	require.Equal(t, []byte(testVIN), l.state[ClaimKey("CLM-001")])

	expectedPolicy, err := requiredWithWitness(mspINS, mspREG, mspAPP)
	require.NoError(t, err)
	require.Equal(t, expectedPolicy, l.policies[key], "RecordClaim 背書政策應為 AND(INS, OutOf(1, REG, APP))")
}

func TestRecordClaim_DuplicateClaimID_Rejected_BFR2(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspINS)
	require.NoError(t, c.RecordClaim(l.ctx, testVIN, "CLM-001", "COLLISION", 50000, "FRONT_BUMPER"))

	l.advanceTime()
	err := c.RecordClaim(l.ctx, testVIN, "CLM-001", "COLLISION", 60000, "REAR_BUMPER")
	require.ErrorContains(t, err, "已存在")
}

// --- TransferOwnership（BFR2） ---

func TestTransferOwnership_Success_BFR2(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspREG)
	err := c.TransferOwnership(l.ctx, testVIN, "owner-hash-new")
	require.NoError(t, err)

	vehicle := l.mustGetVehicle(testVIN)
	require.Equal(t, "owner-hash-new", vehicle.OwnerHash)

	event, key := l.findEvent(testVIN, EventTypeTransfer)
	require.NotNil(t, event)
	require.Equal(t, "owner-hash-init", event.PreviousOwnerHash)
	require.Equal(t, "owner-hash-new", event.NewOwnerHash)

	expectedPolicy, err := requiredWithWitness(mspREG, mspOEM, mspAPP)
	require.NoError(t, err)
	require.Equal(t, expectedPolicy, l.policies[key], "TransferOwnership 背書政策應為 AND(REG, OutOf(1, OEM, APP))")
}

// --- ScrapVehicle（BFR2, EIR1） ---

func TestScrapVehicle_ReleasesParts_BFR2_EIR1(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspREG)
	err := c.ScrapVehicle(l.ctx, testVIN, "事故全損")
	require.NoError(t, err)

	vehicle := l.mustGetVehicle(testVIN)
	require.Equal(t, VehicleStatusScrapped, vehicle.Status)

	enginePart := l.mustGetPart(vehicle.EngineHash)
	require.True(t, enginePart.Released, "報廢後引擎零件綁定應標記為已釋出")

	event, key := l.findEvent(testVIN, EventTypeScrap)
	require.NotNil(t, event)
	expectedPolicy, err := requiredWithWitness(mspREG, mspOEM, mspAPP)
	require.NoError(t, err)
	require.Equal(t, expectedPolicy, l.policies[key], "ScrapVehicle 背書政策應為 AND(REG, OutOf(1, OEM, APP))")
}

func TestScrapVehicle_PartReleaseAllowsRebinding_EIR1(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspREG)
	require.NoError(t, c.ScrapVehicle(l.ctx, testVIN, "報廢回收"))

	// 零件轉生：引擎序號已釋出，合法回收後應可重新綁定至另一輛新車。
	l.advanceTime()
	l.setCallerOrg(mspOEM)
	err := c.InitVehicle(l.ctx, "VIN00000000TEST9", testEngineSerial, "TRANS-SERIAL-999", 2025, 500000, "owner-hash-3")
	require.NoError(t, err, "已報廢車輛的零件應可合法重新綁定至其他車輛")
}

func TestScrapVehicle_AlreadyScrapped_Rejected_BFR2(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspREG)
	require.NoError(t, c.ScrapVehicle(l.ctx, testVIN, "報廢回收"))

	l.advanceTime()
	err := c.ScrapVehicle(l.ctx, testVIN, "重複報廢")
	require.ErrorContains(t, err, "已報廢")
}

// --- 查詢（FFR1, IIR2） ---

func TestGetSummary_NotFound_ReturnsError(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()

	_, err := c.GetSummary(l.ctx, "VIN-NOT-EXIST")
	require.ErrorContains(t, err, "不存在")
}

func TestGetVehicleHistory_FiltersByTimeRange_IIR2(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	ownerKey := initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspSVC)
	sig1 := ownerKey.signMaintenance(testVIN, "TIRE_ROTATION", 5000, "輪胎換位")
	require.NoError(t, c.AddMaintenance(l.ctx, testVIN, "TIRE_ROTATION", 5000, "輪胎換位", sig1))

	l.advanceTime()
	sig2 := ownerKey.signMaintenance(testVIN, "OIL_CHANGE", 15000, "更換機油")
	require.NoError(t, c.AddMaintenance(l.ctx, testVIN, "OIL_CHANGE", 15000, "更換機油", sig2))

	all, err := c.GetVehicleHistory(l.ctx, testVIN, "", "")
	require.NoError(t, err)
	require.Len(t, all, 3, "應包含 INIT + 2 筆 MAINTENANCE 事件")

	// 以第 2 筆事件（TIRE_ROTATION）的時間戳為下界，應排除 INIT 事件。
	cutoff := all[1].Timestamp
	filtered, err := c.GetVehicleHistory(l.ctx, testVIN, cutoff, "")
	require.NoError(t, err)
	require.Len(t, filtered, 2)
	for _, e := range filtered {
		require.NotEqual(t, EventTypeInit, e.Type)
	}
}

// --- SubmitInspection（BFR3, FFR3, FFR4, UC-01） ---

func TestSubmitInspection_Success_BFR3_FFR3(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	ownerKey := initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspSVC)
	sig := ownerKey.signMaintenance(testVIN, "OIL_CHANGE", 10000, "更換機油")
	require.NoError(t, c.AddMaintenance(l.ctx, testVIN, "OIL_CHANGE", 10000, "更換機油", sig))

	l.advanceTime()
	l.setCallerOrg(mspAPP)
	err := c.SubmitInspection(l.ctx, testVIN, 12000, "外觀與機件狀況正常")
	require.NoError(t, err)

	vehicle := l.mustGetVehicle(testVIN)
	require.Equal(t, 12000, vehicle.Mileage)
	require.Equal(t, defaultInitialIntegrityScore, vehicle.IntegrityScore, "里程正常遞增，不應扣分")

	event, key := l.findEvent(testVIN, EventTypeInspection)
	require.NotNil(t, event)
	require.Equal(t, 12000, event.Mileage)
	expectedPolicy, err := requiredWithWitness(mspAPP, mspREG, mspINS)
	require.NoError(t, err)
	require.Equal(t, expectedPolicy, l.policies[key], "SubmitInspection 背書政策應為 AND(APP, OutOf(1, REG, INS))")

	anomalies, _ := l.findAllEvents(testVIN, EventTypeAnomaly)
	require.Empty(t, anomalies)
}

func TestSubmitInspection_WrongOrg_Rejected_BFR3(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspSVC)
	err := c.SubmitInspection(l.ctx, testVIN, 12000, "外觀正常")
	require.ErrorContains(t, err, mspAPP)
}

// TestSubmitInspection_MileageRollback_DeductsScore_BFR3 對應 UC-01 例外流程：鑑定師複檢
// 發現里程低於鏈上已知最高里程，合約不得拒絕交易（CLAUDE.md「異常要記錄而不是拒絕」），
// 而是照常寫入複檢事件、額外記錄異常事件，並扣 40 分（plan.md §3.4）。
func TestSubmitInspection_MileageRollback_DeductsScore_BFR3(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	ownerKey := initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspSVC)
	sig := ownerKey.signMaintenance(testVIN, "OIL_CHANGE", 50000, "更換機油")
	require.NoError(t, c.AddMaintenance(l.ctx, testVIN, "OIL_CHANGE", 50000, "更換機油", sig))

	l.advanceTime()
	l.setCallerOrg(mspAPP)
	err := c.SubmitInspection(l.ctx, testVIN, 30000, "儀表里程與外觀有明顯落差")
	require.NoError(t, err, "里程倒退不應拒絕交易，應改為記錄異常並扣分")

	vehicle := l.mustGetVehicle(testVIN)
	require.Equal(t, 30000, vehicle.Mileage, "複檢回報里程仍應如實記錄")
	require.Equal(t, defaultInitialIntegrityScore-40, vehicle.IntegrityScore, "里程倒退應扣 40 分")

	inspectionEvent, _ := l.findEvent(testVIN, EventTypeInspection)
	require.NotNil(t, inspectionEvent, "複檢事件仍應成功上鏈")

	anomalyEvent, _ := l.findEvent(testVIN, EventTypeAnomaly)
	require.NotNil(t, anomalyEvent, "異常事件應上鏈")
	require.Equal(t, AnomalyTypeMileageRollback, anomalyEvent.AnomalyType)
	require.Equal(t, -40, anomalyEvent.ScoreDelta)
	require.Equal(t, inspectionEvent.TxID, anomalyEvent.RelatedTxID)
}

func TestSubmitInspection_RollbackRecalcIsIdempotent_BFR3(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	ownerKey := initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspSVC)
	sig := ownerKey.signMaintenance(testVIN, "OIL_CHANGE", 50000, "更換機油")
	require.NoError(t, c.AddMaintenance(l.ctx, testVIN, "OIL_CHANGE", 50000, "更換機油", sig))

	l.advanceTime()
	l.setCallerOrg(mspAPP)
	require.NoError(t, c.SubmitInspection(l.ctx, testVIN, 30000, "里程倒退"))

	// 再觸發一次重算（過戶不影響里程或事件歷史），分數不應因重複重算而再次被扣分，
	// 也不應重複寫入同一筆異常事件（scoring.go 的 anomalyDedupeKey 去重）。
	l.advanceTime()
	l.setCallerOrg(mspREG)
	require.NoError(t, c.TransferOwnership(l.ctx, testVIN, "owner-hash-new"))

	vehicle := l.mustGetVehicle(testVIN)
	require.Equal(t, defaultInitialIntegrityScore-40, vehicle.IntegrityScore, "同一異常不應被重複扣分")

	anomalies, _ := l.findAllEvents(testVIN, EventTypeAnomaly)
	require.Len(t, anomalies, 1, "同一異常不應被重複寫入")
}

// --- 有理賠卻無維修證明（BFR3） ---

func TestRecordClaim_NoMaintenanceAfterWindow_DeductsScore_BFR3(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspINS)
	require.NoError(t, c.RecordClaim(l.ctx, testVIN, "CLM-001", "COLLISION", 50000, "FRONT_BUMPER"))

	vehicleAfterClaim := l.mustGetVehicle(testVIN)
	require.Equal(t, defaultInitialIntegrityScore, vehicleAfterClaim.IntegrityScore, "觀察期尚未開始，理賠當下不應扣分")

	// 31 天後才有下一筆寫入交易觸發重算，且期間無任何維修紀錄。
	l.advanceTimeByDays(31)
	l.setCallerOrg(mspINS)
	require.NoError(t, c.RecordClaim(l.ctx, testVIN, "CLM-002", "COLLISION", 10000, "REAR_BUMPER"))

	vehicle := l.mustGetVehicle(testVIN)
	require.Equal(t, defaultInitialIntegrityScore-20, vehicle.IntegrityScore, "理賠後 30 天內無維修紀錄應扣 20 分")

	anomalyEvent, _ := l.findEvent(testVIN, EventTypeAnomaly)
	require.NotNil(t, anomalyEvent)
	require.Equal(t, AnomalyTypeClaimWithoutService, anomalyEvent.AnomalyType)
}

func TestRecordClaim_MaintenanceWithinWindow_NoDeduction_BFR3(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	ownerKey := initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspINS)
	require.NoError(t, c.RecordClaim(l.ctx, testVIN, "CLM-001", "COLLISION", 50000, "FRONT_BUMPER"))

	l.advanceTimeByDays(10)
	l.setCallerOrg(mspSVC)
	sig := ownerKey.signMaintenance(testVIN, "BODY_REPAIR", 5000, "保險桿維修")
	require.NoError(t, c.AddMaintenance(l.ctx, testVIN, "BODY_REPAIR", 5000, "保險桿維修", sig))

	l.advanceTimeByDays(30)
	l.setCallerOrg(mspINS)
	require.NoError(t, c.RecordClaim(l.ctx, testVIN, "CLM-002", "COLLISION", 10000, "REAR_BUMPER"))

	vehicle := l.mustGetVehicle(testVIN)
	require.Equal(t, defaultInitialIntegrityScore, vehicle.IntegrityScore, "觀察期內已有維修紀錄，不應扣分")
}
