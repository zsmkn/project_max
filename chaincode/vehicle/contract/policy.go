package contract

import (
	// fabric-protos-go v0.3.0 產生的是舊版（APIv1）protobuf 型別，需搭配
	// github.com/golang/protobuf/proto（相容殼層），而非 google.golang.org/protobuf/proto。
	"github.com/golang/protobuf/proto"
	"github.com/hyperledger/fabric-protos-go/common"
	mspproto "github.com/hyperledger/fabric-protos-go/msp"
)

// 五個業務組織的 MSP ID，對應 network/scripts/orgs.sh 的 ORG_MSP。
const (
	mspREG = "REGMSP"
	mspOEM = "OEMMSP"
	mspSVC = "SVCMSP"
	mspINS = "INSMSP"
	mspAPP = "APPMSP"
)

// channel 層級的鏈碼預設背書政策（--signature-policy）只能設定一種，無法依交易類型
// 區分。因此每個寫入函式改以 Fabric 的狀態背書（state-based endorsement）機制，
// 在該次交易新建立的 EVT 事件鍵上呼叫 SetStateValidationParameter 設定 plan.md §3.3
// 指定的專屬政策；VEH 主檔鍵不設定狀態背書，維持鏈碼層級預設政策（見 network/README.md
// 「背書策略與鏈碼」，commit 時建議設為 OutOf(2, REG,OEM,SVC,INS,APP)）。
// 因為每個事件鍵僅由建立它的那筆交易寫入一次，不會有後續交易在同一把鍵上要求不同
// 背書組織而互相衝突。
//
// fabric-chaincode-go 的 pkg/statebased 便利 API（NewStateEP／AddOrgs）只支援
// 「所有列出的組織都必須背書」（AND-of-orgs），無法表達 plan.md 要求的
// AND(主責組織, OutOf(1, 見證組織...)) 語意，因此在此手動組出對應的
// SignaturePolicyEnvelope（與 cauthdsl 字串政策底層是同一份 protobuf 結構）。

type policyBuilder struct {
	identities []*mspproto.MSPPrincipal
}

// signedBy 建立「必須由 mspID 成員身分簽署」的規則。
func (b *policyBuilder) signedBy(mspID string) (*common.SignaturePolicy, error) {
	roleBytes, err := proto.Marshal(&mspproto.MSPRole{MspIdentifier: mspID, Role: mspproto.MSPRole_MEMBER})
	if err != nil {
		return nil, err
	}
	idx := int32(len(b.identities))
	b.identities = append(b.identities, &mspproto.MSPPrincipal{
		PrincipalClassification: mspproto.MSPPrincipal_ROLE,
		Principal:               roleBytes,
	})
	return &common.SignaturePolicy{
		Type: &common.SignaturePolicy_SignedBy{SignedBy: idx},
	}, nil
}

func nOutOf(n int32, rules ...*common.SignaturePolicy) *common.SignaturePolicy {
	return &common.SignaturePolicy{
		Type: &common.SignaturePolicy_NOutOf_{
			NOutOf: &common.SignaturePolicy_NOutOf{N: n, Rules: rules},
		},
	}
}

func (b *policyBuilder) envelope(rule *common.SignaturePolicy) ([]byte, error) {
	envelope := &common.SignaturePolicyEnvelope{
		Version:    0,
		Rule:       rule,
		Identities: b.identities,
	}
	return proto.Marshal(envelope)
}

// andPolicy 建立要求全部列出組織皆背書的政策位元組，對應 plan.md §3.3 的 AND(...)。
func andPolicy(mspIDs ...string) ([]byte, error) {
	b := &policyBuilder{}
	rules := make([]*common.SignaturePolicy, 0, len(mspIDs))
	for _, id := range mspIDs {
		rule, err := b.signedBy(id)
		if err != nil {
			return nil, err
		}
		rules = append(rules, rule)
	}
	return b.envelope(nOutOf(int32(len(rules)), rules...))
}

// requiredWithWitness 建立 AND(requiredMSP, OutOf(1, witnessMSPs...)) 政策位元組，
// 對應 plan.md §3.3「主責組織 + 至少一個見證組織背書」的設計（NFR3：其中一個見證組織
// 離線時仍可背書）。
func requiredWithWitness(requiredMSP string, witnessMSPs ...string) ([]byte, error) {
	b := &policyBuilder{}
	requiredRule, err := b.signedBy(requiredMSP)
	if err != nil {
		return nil, err
	}
	witnessRules := make([]*common.SignaturePolicy, 0, len(witnessMSPs))
	for _, id := range witnessMSPs {
		rule, err := b.signedBy(id)
		if err != nil {
			return nil, err
		}
		witnessRules = append(witnessRules, rule)
	}
	rule := nOutOf(2, requiredRule, nOutOf(1, witnessRules...))
	return b.envelope(rule)
}
