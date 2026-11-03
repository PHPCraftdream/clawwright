//go:build linux && amd64

package metadata

const (
	socketPath          = "/run/task245-metadata.sock"
	basePath            = "/var/lib/ssjack/synthetic"
	stateName           = "state.json"
	receiptName         = "consumer-receipt"
	requestPath         = basePath + "/cancel-ack"
	cancelFD            = 1023
	maxState            = 4096
	nrOpen              = 2
	nrClose             = 3
	nrOpenat             = 257
	nrUnlinkat           = 263
	nrCloseRange         = 436
	ioctlRecv            = 0xc0502100
	ioctlSend            = 0xc0182101
	ioctlValid           = 0x40082102
	ioctlAddFD           = 0x40182103
	notificationContinue = 1
	memfdCreate          = 319
	processVMReadv       = 310
	fcntlAddSeals        = 1033
	sealAll              = 15
)

type seccompData struct {
	Number int32
	Arch   uint32
	IP     uint64
	Args   [6]uint64
}

type notification struct {
	ID    uint64
	PID   uint32
	Flags uint32
	Data  seccompData
}

type response struct {
	ID    uint64
	Value int64
	Errno int32
	Flags uint32
}

type addFD struct {
	ID       uint64
	Flags    uint32
	Source   uint32
	NewFD    uint32
	NewFlags uint32
}

type iovec struct {
	Base   uintptr
	Length uintptr
}

type inode struct {
	Device uint64
	Number uint64
}

type processIdentity struct {
	PID   int
	Start uint64
}
