//go:build linux && amd64

package main

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	custodyMaxTIDs = 4096
	custodyMaxFDsPerTask = 4096
	custodyMaxFDsTotal = 16384
	custodyStatusLimit = 16 * 1024
)

// FDHolder records an installed descriptor observed in a stopped task.
// Endpoint is "writer" or "reader". Queued SCM_RIGHTS and namespace-external
// holders are not observable; trusted launch code must prohibit descriptor exports.
type FDHolder struct { TID, TGID, FD int; Endpoint string; Inode uint32 }

// InspectCustody observes installed descriptors; this is not approval. Caller
// must hold a stable trace barrier for every TID and revalidate its task set.
func InspectCustody(providerTGID, gatewayTGID int, brokerTGIDs []int, stoppedTIDs []int, pair UnixPair) ([]FDHolder, error) {
	refuse := func() ([]FDHolder, error) { return nil, errAdmission }
	if providerTGID <= 0 || gatewayTGID <= 0 || providerTGID == gatewayTGID || len(stoppedTIDs) == 0 || len(stoppedTIDs) > custodyMaxTIDs || len(brokerTGIDs) > custodyMaxTIDs || pair.Writer.Inode == 0 || pair.Reader.Inode == 0 || pair.Writer.PeerInode != pair.Reader.Inode || pair.Reader.PeerInode != pair.Writer.Inode || !validCookie(pair.Writer.Cookie) || !validCookie(pair.Reader.Cookie) { return refuse() }
	allowed := map[int]bool{providerTGID:true, gatewayTGID:true}
	for _, id := range brokerTGIDs { if id <= 0 || allowed[id] { return refuse() }; allowed[id] = true }
	seen, members := make(map[int]bool, len(stoppedTIDs)), make(map[int]bool, len(stoppedTIDs))
	for _, tid := range stoppedTIDs { if tid <= 0 || seen[tid] { return refuse() }; seen[tid] = true; tgid,state,err:=readTaskStatus(tid); if err!=nil || (state!='t') { return refuse() }; members[tgid]=true }
	if !members[providerTGID] || !members[gatewayTGID] { return refuse() }
	total, gatewayReader, writerObserved := 0, false, false
	holders := make([]FDHolder,0)
	for _, tid := range stoppedTIDs {
		tgid,_,err:=readTaskStatus(tid); if err!=nil { return refuse() }
		fdDir:=filepath.Join("/proc",strconv.Itoa(tid),"fd")
		entries,err:=os.ReadDir(fdDir); if err!=nil || len(entries)>custodyMaxFDsPerTask { return refuse() }; total+=len(entries); if total>custodyMaxFDsTotal { return refuse() }
		for _, entry:=range entries {
			fd,err:=strconv.Atoi(entry.Name()); if err!=nil || fd<0 { return refuse() }
			target,err:=os.Readlink(filepath.Join(fdDir,entry.Name())); if err!=nil { return refuse() }
			inode,socket,ok:=parseSocketLink(target); if !ok { return refuse() }; if !socket { continue }
			role:=""
			if inode==pair.Writer.Inode { if tgid!=providerTGID || fd!=1 { return refuse() }; role="writer"; writerObserved=true }
			if inode==pair.Reader.Inode { if tgid!=gatewayTGID && !containsTGID(brokerTGIDs,tgid) { return refuse() }; role="reader"; if tgid==gatewayTGID { gatewayReader=true } }
			if role!="" { holders=append(holders,FDHolder{TID:tid,TGID:tgid,FD:fd,Endpoint:role,Inode:inode}) }
		}
	}
	if !writerObserved || !gatewayReader { return refuse() }
	return holders,nil
}

func readTaskStatus(tid int) (int,byte,error) {
	f,err:=os.Open(filepath.Join("/proc",strconv.Itoa(tid),"status")); if err!=nil { return 0,0,err }; defer f.Close()
	b,err:=io.ReadAll(io.LimitReader(f,custodyStatusLimit+1)); if err!=nil || len(b)>custodyStatusLimit { return 0,0,errAdmission }
	s:=bufio.NewScanner(strings.NewReader(string(b))); tgid:=0; var state byte
	for s.Scan() { line:=s.Text(); if strings.HasPrefix(line,"Tgid:") { v,e:=strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line,"Tgid:"))); if e!=nil || tgid!=0 { return 0,0,errAdmission }; tgid=v }; if strings.HasPrefix(line,"State:") { v:=strings.TrimSpace(strings.TrimPrefix(line,"State:")); if len(v)==0 || state!=0 { return 0,0,errAdmission }; state=v[0] } }
	if s.Err()!=nil || tgid<=0 || state==0 { return 0,0,errAdmission }; return tgid,state,nil
}

// parseSocketLink recognizes only the exact procfs socket symlink form.
func parseSocketLink(s string) (uint32,bool,bool) {
	if !strings.HasPrefix(s,"socket:") { return 0,false,true }
	if len(s)<10 || s[:8]!="socket:[" || s[len(s)-1]!=']' { return 0,false,false }
	n:=s[8:len(s)-1]; if n=="" || (len(n)>1 && n[0]=='0') { return 0,false,false }; v,e:=strconv.ParseUint(n,10,32); if e!=nil || v==0 { return 0,false,false }; return uint32(v),true,true
}
func containsTGID(ids []int,id int) bool { for _,v:=range ids { if v==id { return true } }; return false }
