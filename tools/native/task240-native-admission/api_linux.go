//go:build linux && amd64

package admission

import (
	"context"
	"encoding/binary"
	"sort"
)

// TaskIdentity is a value-copy of a tracked task identity at a frozen barrier.
type TaskIdentity struct {
	TID, TGID int
	StartTicks, ExecGeneration uint64
}

// ObserveHeldKernelState records kernel evidence using an already frozen snapshot.
// The caller owns the snapshot barrier; this API does not freeze or release it.
func ObserveHeldKernelState(ctx context.Context, tracker *TraceTracker, snapshot *traceSnapshot, providerTGID, gatewayTGID int, brokerTGIDs []int, writerInode uint32, header [64]byte) (*KernelObservation, error) {
	if ctx == nil || tracker == nil || snapshot == nil || writerInode == 0 || string(header[:8]) != "SSINK001" || snapshot.owner != tracker || snapshot.generation == 0 || len(snapshot.tasks) == 0 || len(snapshot.tasks) > 4096 || tracker.CheckNamespace(snapshot) != nil { return nil, errKernelObservation }
	length := binary.BigEndian.Uint64(header[56:64]); if length == 0 || length > 16384 { return nil, errKernelObservation }
	var nonce [16]byte; copy(nonce[:], header[8:24]); var binding [32]byte; copy(binding[:], header[24:56]); var nz byte
	for _, b := range nonce { nz |= b }; if nz == 0 { return nil, errKernelObservation }; nz = 0
	for _, b := range binding { nz |= b }; if nz == 0 { return nil, errKernelObservation }
	tasks := append([]taskIdentity(nil), snapshot.tasks...); ids := make([]int, 0, len(tasks)); providerExec, gatewayExec := false, false
	for _, task := range tasks { if task.TID <= 0 || task.TGID <= 0 { return nil, errKernelObservation }; if task.TGID == providerTGID && task.ExecGeneration > 0 { providerExec = true }; if task.TGID == gatewayTGID && task.ExecGeneration > 0 { gatewayExec = true }; ids = append(ids, task.TID) }
	if !providerExec || !gatewayExec { return nil, errKernelObservation }; pair, err := ObserveUnixPair(ctx, writerInode); if err != nil { return nil, errKernelObservation }; holders, err := InspectCustody(providerTGID, gatewayTGID, brokerTGIDs, ids, pair); if err != nil { return nil, errKernelObservation }
	sort.Slice(tasks, func(i, j int) bool { return tasks[i].TID < tasks[j].TID }); sort.Slice(holders, func(i, j int) bool { if holders[i].TID != holders[j].TID { return holders[i].TID < holders[j].TID }; return holders[i].FD < holders[j].FD })
	o := &KernelObservation{KeeperNonce: nonce, KeeperBinding: binding, BarrierGeneration: snapshot.generation, Tasks: tasks, Endpoints: pair, Holders: append([]FDHolder(nil), holders...), tracker: tracker, snapshot: snapshot}; o.Digest = digestKernelObservation(o); return o, nil
}

func (t *TraceTracker) Candidates(s *traceSnapshot) ([]RecvCandidate,uint64,error) { if t==nil||s==nil||s.owner!=t||s.generation==0{return nil,0,errTrace}; if err:=t.CheckNamespace(s);err!=nil{return nil,0,errTrace}; out:=make([]RecvCandidate,len(s.candidates));for i,v:=range s.candidates{out[i]=RecvCandidate{TID:v.TID,TGID:v.TGID,FD:v.FD,Generation:v.Generation}};return out,s.generation,nil }
type RecvCandidate struct { TID,TGID,FD int; Generation uint64 }

// SnapshotTasks validates ownership and namespace while returning only copies.
func SnapshotTasks(tracker *TraceTracker, snapshot *traceSnapshot) ([]TaskIdentity, uint64, error) {
	if tracker == nil || snapshot == nil || snapshot.owner != tracker || snapshot.generation == 0 || len(snapshot.tasks) == 0 || len(snapshot.tasks) > maxTraceTasks {
		return nil, 0, errTrace
	}
	if err := tracker.CheckNamespace(snapshot); err != nil {
		return nil, 0, errTrace
	}
	out := make([]TaskIdentity, len(snapshot.tasks))
	for i, task := range snapshot.tasks {
		out[i] = TaskIdentity{TID: task.TID, TGID: task.TGID, StartTicks: task.StartTicks, ExecGeneration: task.ExecGeneration}
	}
	return out, snapshot.generation, nil
}
