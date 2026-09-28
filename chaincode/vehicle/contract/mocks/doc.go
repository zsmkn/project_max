// Package mocks 提供單元測試用的 counterfeiter 產生假物件，模擬 Fabric shim 與
// contractapi 的介面，讓合約邏輯不需真實 peer 即可測試。執行 `go generate ./...`
// （需先安裝 counterfeiter：go install github.com/maxbrunsfeld/counterfeiter/v6@latest）
// 重新產生下方三個檔案。
package mocks

import (
	"github.com/hyperledger/fabric-chaincode-go/pkg/cid"
	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

//go:generate counterfeiter -o chaincodestub.go -fake-name ChaincodeStub . chaincodeStub
type chaincodeStub interface {
	shim.ChaincodeStubInterface
}

//go:generate counterfeiter -o statequeryiterator.go -fake-name StateQueryIterator . stateQueryIterator
type stateQueryIterator interface {
	shim.StateQueryIteratorInterface
}

//go:generate counterfeiter -o clientidentity.go -fake-name ClientIdentity . clientIdentity
type clientIdentity interface {
	cid.ClientIdentity
}

//go:generate counterfeiter -o transactioncontext.go -fake-name TransactionContext . transactionContext
type transactionContext interface {
	contractapi.TransactionContextInterface
}
