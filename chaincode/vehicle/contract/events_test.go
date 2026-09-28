package contract

import (
	"fmt"
	"sort"
	"testing"

	"github.com/stretchr/testify/require"
)

// plan_dApp.md D3：寫入函式成功後發出 VehicleEvent，異常以 anomalies 欄位帶出。

func sortedKeys(state map[string][]byte) []string {
	keys := make([]string, 0, len(state))
	for k := range state {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func TestInitVehicle_EmitsVehicleEvent_D3(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	l.setCallerOrg(mspOEM)
	require.NoError(t, c.InitVehicle(l.ctx, testVIN, testEngineSerial, testTransmissionSerial, 2024, 800000, "owner-hash-1"))

	payload := l.mustVehicleEvent()
	require.Equal(t, testVIN, payload.VIN)
	require.Equal(t, EventTypeInit, payload.EventType)
	require.Equal(t, mspOEM, payload.SubmittingOrg)
	require.Equal(t, defaultInitialIntegrityScore, payload.IntegrityScore)
	require.Empty(t, payload.Anomalies)
}

func TestAddMaintenance_EmitsVehicleEvent_D3(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	ownerKey := initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspSVC)
	sig := ownerKey.signMaintenance(testVIN, "OIL_CHANGE", 10000, "更換機油")
	require.NoError(t, c.AddMaintenance(l.ctx, testVIN, "OIL_CHANGE", 10000, "更換機油", sig))

	payload := l.mustVehicleEvent()
	require.Equal(t, EventTypeMaintenance, payload.EventType)
	require.Equal(t, fmt.Sprintf("tx%03d", l.txCounter), payload.TxID)
	require.Empty(t, payload.Anomalies)
}

// TestSubmitInspection_MileageRollback_EmitsAnomalyEvent_D3_UC01 對應 plan_dApp.md D3 驗收：
// 鑑定師提交里程倒退的複檢後，事件內容要帶出扣 40 分的異常，車主頁據此即時通知。
func TestSubmitInspection_MileageRollback_EmitsAnomalyEvent_D3_UC01(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	ownerKey := initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)

	l.advanceTime()
	l.setCallerOrg(mspSVC)
	sig := ownerKey.signMaintenance(testVIN, "OIL_CHANGE", 50000, "更換機油")
	require.NoError(t, c.AddMaintenance(l.ctx, testVIN, "OIL_CHANGE", 50000, "更換機油", sig))

	l.advanceTime()
	l.setCallerOrg(mspAPP)
	require.NoError(t, c.SubmitInspection(l.ctx, testVIN, 30000, "儀表里程疑似遭調整"))

	payload := l.mustVehicleEvent()
	require.Equal(t, EventTypeInspection, payload.EventType)
	require.Equal(t, mspAPP, payload.SubmittingOrg)
	require.Len(t, payload.Anomalies, 1)
	require.Equal(t, AnomalyTypeMileageRollback, payload.Anomalies[0].AnomalyType)
	require.Equal(t, -40, payload.Anomalies[0].ScoreDelta)
	require.Equal(t, defaultInitialIntegrityScore-40, payload.IntegrityScore)
}

func TestAddMaintenance_SignatureRejected_EmitsNoEvent_D3(t *testing.T) {
	l := newTestLedger(t)
	c := newTestVehicleContract()
	initTestVehicle(t, l, c, testVIN, testEngineSerial, testTransmissionSerial)
	l.chaincodeEvent = nil

	l.advanceTime()
	l.setCallerOrg(mspSVC)
	err := c.AddMaintenance(l.ctx, testVIN, "OIL_CHANGE", 10000, "更換機油", "deadbeef")
	require.Error(t, err)
	require.Nil(t, l.chaincodeEvent, "被拒絕的交易不應發出事件")
}
