package contract

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// testScoringConfig 回傳一份與 scoring_config.json 相同數值的設定，供純函式測試使用，
// 不依賴內嵌檔案本身（即使日後調整 scoring_config.json 的預設值，這裡的測試仍驗證公式邏輯本身）。
func testScoringConfig() *ScoringConfig {
	return &ScoringConfig{
		InitialScore:                      100,
		MinScore:                          0,
		MileageRollbackDeduction:          40,
		ClaimWithoutMaintenanceDeduction:  20,
		ClaimWithoutMaintenanceWindowDays: 30,
		DuplicatePartDeduction:            30,
		ResidualValue: ResidualValueConfig{
			AgeCoefficientPerYear:       0.12,
			AgeCoefficientMin:           0.2,
			MileageCoefficientDivisorKm: 400000,
			MileageCoefficientMin:       0.5,
			IntegrityCoefficientBase:    0.6,
			IntegrityCoefficientWeight:  0.4,
		},
	}
}

func mustParseRFC3339(t *testing.T, s string) time.Time {
	t.Helper()
	tm, err := time.Parse(time.RFC3339, s)
	require.NoError(t, err)
	return tm
}

// --- DetectMileageRollbacks（BFR3、UC-01） ---

func TestDetectMileageRollbacks_NoRollback_NoAnomaly_BFR3(t *testing.T) {
	cfg := testScoringConfig()
	events := []*Event{
		{Type: EventTypeInit, Mileage: 0, TxID: "tx1", Timestamp: "2026-01-01T00:00:00Z"},
		{Type: EventTypeMaintenance, Mileage: 5000, TxID: "tx2", Timestamp: "2026-02-01T00:00:00Z"},
		{Type: EventTypeInspection, Mileage: 8000, TxID: "tx3", Timestamp: "2026-03-01T00:00:00Z"},
	}
	anomalies := DetectMileageRollbacks(cfg, events)
	require.Empty(t, anomalies, "里程持續遞增不應判定為異常")
}

func TestDetectMileageRollbacks_Rollback_DeductsScore_BFR3(t *testing.T) {
	cfg := testScoringConfig()
	events := []*Event{
		{Type: EventTypeInit, Mileage: 0, TxID: "tx1", Timestamp: "2026-01-01T00:00:00Z"},
		{Type: EventTypeMaintenance, Mileage: 20000, TxID: "tx2", Timestamp: "2026-02-01T00:00:00Z"},
		{Type: EventTypeInspection, Mileage: 15000, TxID: "tx3", Timestamp: "2026-03-01T00:00:00Z"},
	}
	anomalies := DetectMileageRollbacks(cfg, events)
	require.Len(t, anomalies, 1)
	require.Equal(t, AnomalyTypeMileageRollback, anomalies[0].Type)
	require.Equal(t, 40, anomalies[0].Deduction)
	require.Equal(t, "tx3", anomalies[0].RelatedTxID)
}

func TestDetectMileageRollbacks_MultipleRollbacks_EachDeductsSeparately_BFR3(t *testing.T) {
	cfg := testScoringConfig()
	events := []*Event{
		{Type: EventTypeInit, Mileage: 0, TxID: "tx1", Timestamp: "2026-01-01T00:00:00Z"},
		{Type: EventTypeMaintenance, Mileage: 30000, TxID: "tx2", Timestamp: "2026-02-01T00:00:00Z"},
		{Type: EventTypeInspection, Mileage: 10000, TxID: "tx3", Timestamp: "2026-03-01T00:00:00Z"},
		{Type: EventTypeMaintenance, Mileage: 9000, TxID: "tx4", Timestamp: "2026-04-01T00:00:00Z"},
	}
	anomalies := DetectMileageRollbacks(cfg, events)
	require.Len(t, anomalies, 2, "兩筆都低於當時的歷史最高里程（30000），應各自判定為異常")
	require.Equal(t, "tx3", anomalies[0].RelatedTxID)
	require.Equal(t, "tx4", anomalies[1].RelatedTxID)
}

// --- DetectClaimsWithoutMaintenance（BFR3） ---

func TestDetectClaimsWithoutMaintenance_HasMaintenanceWithinWindow_NoAnomaly_BFR3(t *testing.T) {
	cfg := testScoringConfig()
	events := []*Event{
		{Type: EventTypeClaim, ClaimID: "CLM-1", TxID: "tx1", Timestamp: "2026-01-01T00:00:00Z"},
		{Type: EventTypeMaintenance, TxID: "tx2", Timestamp: "2026-01-10T00:00:00Z"},
	}
	asOf := mustParseRFC3339(t, "2026-03-01T00:00:00Z")
	anomalies, err := DetectClaimsWithoutMaintenance(cfg, events, asOf)
	require.NoError(t, err)
	require.Empty(t, anomalies, "觀察期內已有維修紀錄，不應判定為異常")
}

func TestDetectClaimsWithoutMaintenance_NoMaintenanceAfterWindow_DeductsScore_BFR3(t *testing.T) {
	cfg := testScoringConfig()
	events := []*Event{
		{Type: EventTypeClaim, ClaimID: "CLM-1", TxID: "tx1", Timestamp: "2026-01-01T00:00:00Z"},
	}
	asOf := mustParseRFC3339(t, "2026-02-05T00:00:00Z") // 已超過理賠後 30 天
	anomalies, err := DetectClaimsWithoutMaintenance(cfg, events, asOf)
	require.NoError(t, err)
	require.Len(t, anomalies, 1)
	require.Equal(t, AnomalyTypeClaimWithoutService, anomalies[0].Type)
	require.Equal(t, 20, anomalies[0].Deduction)
	require.Equal(t, "tx1", anomalies[0].RelatedTxID)
}

func TestDetectClaimsWithoutMaintenance_WithinWindow_NotYetJudged_BFR3(t *testing.T) {
	cfg := testScoringConfig()
	events := []*Event{
		{Type: EventTypeClaim, ClaimID: "CLM-1", TxID: "tx1", Timestamp: "2026-01-01T00:00:00Z"},
	}
	asOf := mustParseRFC3339(t, "2026-01-15T00:00:00Z") // 尚未滿 30 天觀察期
	anomalies, err := DetectClaimsWithoutMaintenance(cfg, events, asOf)
	require.NoError(t, err)
	require.Empty(t, anomalies, "觀察期尚未屆滿，不應提前判定")
}

func TestDetectClaimsWithoutMaintenance_MaintenanceBeforeClaim_StillDeducts_BFR3(t *testing.T) {
	cfg := testScoringConfig()
	events := []*Event{
		{Type: EventTypeMaintenance, TxID: "tx0", Timestamp: "2025-12-01T00:00:00Z"},
		{Type: EventTypeClaim, ClaimID: "CLM-1", TxID: "tx1", Timestamp: "2026-01-01T00:00:00Z"},
	}
	asOf := mustParseRFC3339(t, "2026-02-05T00:00:00Z")
	anomalies, err := DetectClaimsWithoutMaintenance(cfg, events, asOf)
	require.NoError(t, err)
	require.Len(t, anomalies, 1, "理賠之前的維修紀錄不構成理賠後的維修證明")
}

// --- DetectDuplicatePartUsage（BFR3） ---

func TestDetectDuplicatePartUsage_SharedHash_DeductsScore_BFR3(t *testing.T) {
	cfg := testScoringConfig()
	index := map[string][]string{
		"hash-shared": {"VIN-A", "VIN-B"},
		"hash-unique": {"VIN-A"},
	}
	anomalies := DetectDuplicatePartUsage(cfg, "VIN-A", index)
	require.Len(t, anomalies, 1)
	require.Equal(t, AnomalyTypeDuplicatePart, anomalies[0].Type)
	require.Equal(t, 30, anomalies[0].Deduction)
}

func TestDetectDuplicatePartUsage_NotInvolved_NoAnomaly_BFR3(t *testing.T) {
	cfg := testScoringConfig()
	index := map[string][]string{
		"hash-shared": {"VIN-B", "VIN-C"},
	}
	anomalies := DetectDuplicatePartUsage(cfg, "VIN-A", index)
	require.Empty(t, anomalies, "該零件重複綁定與查詢的車輛無關，不應扣分")
}

// --- ComputeResidualValue（plan.md §3.4） ---

func TestComputeResidualValue_Formula_BFR3(t *testing.T) {
	cfg := testScoringConfig()
	asOf := mustParseRFC3339(t, "2027-01-01T00:00:00Z") // 車齡 3 年（2024 出廠）
	residual := ComputeResidualValue(cfg, 800000, 2024, 30000, 100, asOf)

	ageCoef := 1 - 0.12*3
	mileageCoef := 1 - 30000.0/400000
	integrityCoef := 0.6 + 0.4*100.0/100
	expected := 800000 * ageCoef * mileageCoef * integrityCoef
	require.InEpsilon(t, expected, residual, 0.0001)
}

func TestComputeResidualValue_CoefficientsFloorAtMinimum_BFR3(t *testing.T) {
	cfg := testScoringConfig()
	asOf := mustParseRFC3339(t, "2050-01-01T00:00:00Z") // 車齡極高
	residual := ComputeResidualValue(cfg, 800000, 2000, 900000, 0, asOf)

	// 車齡係數應觸底於 0.2，里程係數應觸底於 0.5，誠信係數在分數 0 時為 0.6。
	expected := 800000 * 0.2 * 0.5 * 0.6
	require.InEpsilon(t, expected, residual, 0.0001)
}

// --- Recalculate（整合純函式，去重邏輯） ---

func TestRecalculate_DeductsForEachDistinctAnomaly_BFR3(t *testing.T) {
	cfg := testScoringConfig()
	vehicle := &Vehicle{MsrpAmount: 800000, ManufactureYear: 2024, Mileage: 15000}
	events := []*Event{
		{Type: EventTypeInit, Mileage: 0, TxID: "tx1", Timestamp: "2026-01-01T00:00:00Z"},
		{Type: EventTypeMaintenance, Mileage: 20000, TxID: "tx2", Timestamp: "2026-02-01T00:00:00Z"},
		{Type: EventTypeInspection, Mileage: 15000, TxID: "tx3", Timestamp: "2026-03-01T00:00:00Z"},
	}
	asOf := mustParseRFC3339(t, "2026-03-01T00:00:00Z")

	result, err := Recalculate(cfg, vehicle, events, map[string]bool{}, asOf)
	require.NoError(t, err)
	require.Equal(t, 60, result.IntegrityScore, "初始 100 分扣 40 分里程倒退 = 60 分")
	require.Len(t, result.NewAnomalies, 1)
}

func TestRecalculate_AlreadyRecordedAnomaly_NotDuplicated_BFR3(t *testing.T) {
	cfg := testScoringConfig()
	vehicle := &Vehicle{MsrpAmount: 800000, ManufactureYear: 2024, Mileage: 15000}
	events := []*Event{
		{Type: EventTypeInit, Mileage: 0, TxID: "tx1", Timestamp: "2026-01-01T00:00:00Z"},
		{Type: EventTypeMaintenance, Mileage: 20000, TxID: "tx2", Timestamp: "2026-02-01T00:00:00Z"},
		{Type: EventTypeInspection, Mileage: 15000, TxID: "tx3", Timestamp: "2026-03-01T00:00:00Z"},
	}
	asOf := mustParseRFC3339(t, "2026-03-01T00:00:00Z")
	alreadyRecorded := map[string]bool{AnomalyTypeMileageRollback + "|tx3": true}

	result, err := Recalculate(cfg, vehicle, events, alreadyRecorded, asOf)
	require.NoError(t, err)
	require.Equal(t, 60, result.IntegrityScore, "分數仍應反映異常扣分，即使不再重複寫入事件")
	require.Empty(t, result.NewAnomalies, "已記錄過的異常不應再次列入 NewAnomalies")
}

func TestRecalculate_ScoreFloorsAtMinScore_BFR3(t *testing.T) {
	cfg := testScoringConfig()
	vehicle := &Vehicle{MsrpAmount: 800000, ManufactureYear: 2024, Mileage: 1000}
	events := []*Event{
		{Type: EventTypeInit, Mileage: 0, TxID: "tx1", Timestamp: "2026-01-01T00:00:00Z"},
		{Type: EventTypeMaintenance, Mileage: 50000, TxID: "tx2", Timestamp: "2026-02-01T00:00:00Z"},
		{Type: EventTypeInspection, Mileage: 1000, TxID: "tx3", Timestamp: "2026-03-01T00:00:00Z"},
		{Type: EventTypeMaintenance, Mileage: 900, TxID: "tx4", Timestamp: "2026-04-01T00:00:00Z"},
		{Type: EventTypeMaintenance, Mileage: 800, TxID: "tx5", Timestamp: "2026-05-01T00:00:00Z"},
	}
	asOf := mustParseRFC3339(t, "2026-05-01T00:00:00Z")

	result, err := Recalculate(cfg, vehicle, events, map[string]bool{}, asOf)
	require.NoError(t, err)
	require.Equal(t, cfg.MinScore, result.IntegrityScore, "扣分總和超過 100 分時應以 minScore 為下限")
}
