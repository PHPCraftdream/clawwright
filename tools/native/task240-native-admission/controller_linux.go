//go:build linux && amd64

package admission

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"sort"
	"sync"
)

var errKernelObservation = errors.New("kernel observation refused")

// KernelObservation records evidence under a held barrier. The opaque private
// frame is keeper evidence, not operation authority or launch approval.
// Immutable-image validation and recvmsg event retry are not implemented here.
type KernelObservation struct {
	KeeperNonce [16]byte
	KeeperBinding [32]byte
	Digest [32]byte
	BarrierGeneration uint64
	Tasks []taskIdentity
	Endpoints UnixPair
	Holders []FDHolder
	tracker *TraceTracker
	snapshot *traceSnapshot
	mu sync.Mutex
	closed bool
}

// ObserveKernelState freezes and records actual kernel evidence. The caller
// supplies the authenticated SSINK001 header; this function records its nonce
// and binding but does not authenticate it, authorize, emit readiness, or send bytes.
func ObserveKernelState(ctx context.Context, tracker *TraceTracker, providerTGID, gatewayTGID int, brokerTGIDs []int, writerInode uint32, header [64]byte) (*KernelObservation, error) {
	if ctx == nil || tracker == nil || writerInode == 0 || string(header[:8]) != "SSINK001" {
		return nil, errKernelObservation
	}
	length := binary.BigEndian.Uint64(header[56:64])
	if length == 0 || length > 16384 { return nil, errKernelObservation }
	var nonce [16]byte
	copy(nonce[:], header[8:24])
	var binding [32]byte
	copy(binding[:], header[24:56])
	var nz byte
	for _, b := range nonce { nz |= b }
	if nz == 0 { return nil, errKernelObservation }
	nz = 0
	for _, b := range binding { nz |= b }
	if nz == 0 { return nil, errKernelObservation }
	snapshot, err := tracker.Freeze(ctx)
	if err != nil { tracker.Close(); return nil, errKernelObservation }
	fail := func() (*KernelObservation, error) { tracker.Close(); return nil, errKernelObservation }
	if snapshot == nil || snapshot.owner != tracker || snapshot.generation == 0 || len(snapshot.tasks) == 0 || len(snapshot.tasks) > 4096 { return fail() }
	if tracker.CheckNamespace(snapshot) != nil { return fail() }
	tasks := append([]taskIdentity(nil), snapshot.tasks...)
	ids := make([]int, 0, len(tasks))
	providerExec, gatewayExec := false, false
	for _, task := range tasks {
		if task.TID <= 0 || task.TGID <= 0 { return fail() }
		if task.TGID == providerTGID && task.ExecGeneration > 0 { providerExec = true }
		if task.TGID == gatewayTGID && task.ExecGeneration > 0 { gatewayExec = true }
		ids = append(ids, task.TID)
	}
	if !providerExec || !gatewayExec { return fail() }
	pair, err := ObserveUnixPair(ctx, writerInode)
	if err != nil { return fail() }
	holders, err := InspectCustody(providerTGID, gatewayTGID, brokerTGIDs, ids, pair)
	if err != nil { return fail() }
	sort.Slice(tasks, func(i, j int) bool { return tasks[i].TID < tasks[j].TID })
	holders = append([]FDHolder(nil), holders...)
	sort.Slice(holders, func(i, j int) bool { if holders[i].TID != holders[j].TID { return holders[i].TID < holders[j].TID }; return holders[i].FD < holders[j].FD })
	o := &KernelObservation{KeeperNonce: nonce, KeeperBinding: binding, BarrierGeneration: snapshot.generation, Tasks: tasks, Endpoints: pair, Holders: holders, tracker: tracker, snapshot: snapshot}
	o.Digest = digestKernelObservation(o)
	return o, nil
}

// ReleaseBarrier relinquishes the held barrier only while the observation is
// live. The caller remains responsible for completing all independent checks.
func (o *KernelObservation) ReleaseBarrier() error {
	if o == nil { return errKernelObservation }
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed || o.tracker == nil || o.snapshot == nil || o.snapshot.owner != o.tracker || o.snapshot.generation != o.BarrierGeneration {
		return errKernelObservation
	}
	if err := o.tracker.Release(o.snapshot); err != nil { return errKernelObservation }
	o.closed = true
	o.tracker, o.snapshot = nil, nil
	return nil
}

// Close invalidates the held observation and closes the tracker domain. The
// domain's cleanup kills traced tasks; this intentionally never resumes them.
func (o *KernelObservation) Close() error {
	if o == nil { return errKernelObservation }
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed { return nil }
	o.closed = true
	if o.tracker == nil || o.snapshot == nil { return errKernelObservation }
	o.tracker.Close()
	o.tracker, o.snapshot = nil, nil
	return nil
}

func digestKernelObservation(o *KernelObservation) [32]byte {
	h := sha256.New()
	_, _ = h.Write([]byte("clawwright-native-observation-v1"))
	_, _ = h.Write(o.KeeperNonce[:])
	_, _ = h.Write(o.KeeperBinding[:])
	put := func(v uint64) { var b [8]byte; binary.BigEndian.PutUint64(b[:], v); _, _ = h.Write(b[:]) }
	put(o.BarrierGeneration)
	put(uint64(len(o.Tasks)))
	for _, t := range o.Tasks { put(uint64(t.TID)); put(uint64(t.TGID)); put(t.StartTicks); put(t.ExecGeneration) }
	put(uint64(o.Endpoints.Writer.Inode)); put(uint64(o.Endpoints.Writer.Cookie[0])); put(uint64(o.Endpoints.Writer.Cookie[1])); put(uint64(o.Endpoints.Writer.PeerInode))
	put(uint64(o.Endpoints.Reader.Inode)); put(uint64(o.Endpoints.Reader.Cookie[0])); put(uint64(o.Endpoints.Reader.Cookie[1])); put(uint64(o.Endpoints.Reader.PeerInode))
	put(uint64(len(o.Holders)))
	for _, holder := range o.Holders {
		put(uint64(holder.TID)); put(uint64(holder.TGID)); put(uint64(holder.FD)); put(uint64(holder.Inode))
		role := uint64(0); if holder.Endpoint == "writer" { role = 1 } else if holder.Endpoint == "reader" { role = 2 }; put(role)
	}
	var digest [32]byte
	copy(digest[:], h.Sum(nil))
	return digest
}
