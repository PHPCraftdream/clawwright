//go:build task245lab && linux && amd64

package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/PHPCraftdream/ssjack/internal/declarativeauthority"
)

func runNegativeLab(scenario string) (err error) {
	modes := map[string]string{"wrong-holder": "withheld", "unexpected-exec": "withheld", "partial-ack": "unknown", "lost-ack": "unknown", "cancel": "cancel"}
	mode, ok := modes[scenario]
	if !ok || os.Geteuid() != 0 { return errors.New("synthetic lab unavailable") }
	marker, e := os.Lstat("/lab/isolation-ok")
	if e != nil || !marker.Mode().IsRegular() { return errors.New("synthetic lab unavailable") }
	for _, p := range []string{cliPath, driverSource, consumerSource, harnessPath, ptyPath, "/lab/conductor"} { if _, e = os.Stat(p); e != nil { return errors.New("synthetic lab unavailable") } }
	l := &deliveryLab{}
	defer func() { if l.anchor != nil { _ = l.anchor.Close() }; clear(l.master); clear(l.payload); if l.workspace != "" { _ = os.RemoveAll(l.workspace) } }()
	if l.anchor, err = newSyntheticAnchor(); err != nil { return errors.New("synthetic lab setup failed") }
	random := make([]byte, 32)
	if _, err = rand.Read(random); err != nil { clear(random); return errors.New("synthetic lab setup failed") }
	l.master = []byte(hex.EncodeToString(random))
	clear(random)
	l.payload = []byte("scoped secret")
	if err = l.provision(); err != nil { return errors.New("synthetic lab setup failed") }
	if err = l.storeSetup(); err != nil { return errors.New("synthetic lab setup failed") }
	if err = l.scanCiphertext(); err != nil { return errors.New("synthetic lab ciphertext check failed") }
	fields, e := l.inspect(); if e != nil { return errors.New("synthetic lab inspect failed") }
	if err = l.register(fields); err != nil { return errors.New("synthetic lab registration failed") }
	state := filepath.Join(declarativeauthority.StatePath, "state.json")
	if err = declarativeauthority.PrepareState(labUID); err != nil { return errors.New("synthetic state provisioning failed") }
	if err = l.resetGenesis(state); err != nil { return errors.New("synthetic genesis setup failed") }
	receipt := filepath.Join(declarativeauthority.StatePath, "consumer-receipt")
	faultPath := filepath.Join(declarativeauthority.StatePath, "native-fault-reached")
	if _, e = os.Lstat(faultPath); !errors.Is(e, os.ErrNotExist) { return errors.New("fault evidence was not fresh") }
	if _, e = os.Lstat(receipt); !errors.Is(e, os.ErrNotExist) { return errors.New("receipt was not fresh") }
	if _, e = os.Lstat(filepath.Join(declarativeauthority.StatePath, "native-cancel-owner")); !errors.Is(e, os.ErrNotExist) { return errors.New("cancel owner evidence was not fresh") }
	answers := []labAnswer{{"Exact canonical delivery reference: ", []byte(l.ref)}, {"Application-store master secret: ", l.master}}
	out, e := l.cli(labUID, answers, "appstore", "unlock", harnessPath, l.ref, mode)
	if e != nil || !strings.Contains(out, "DELIVERY_ACCEPTANCE_OK") { return errors.New("negative harness failed") }
	if scenario == "cancel" {
		if !strings.Contains(out, "DELIVERY_CANCELLED_OUTCOME_UNKNOWN") { return errors.New("cancel outcome missing") }
		if e = verifyCancelledConsumer(filepath.Join(declarativeauthority.StatePath, "native-cancel-owner")); e != nil { return errors.New("cancel consumer termination unverified") }
	}
	faultInfo, e := os.Lstat(faultPath)
	if e != nil || !faultInfo.Mode().IsRegular() || faultInfo.Mode()&os.ModeSymlink != 0 || faultInfo.Size() > 32 { return errors.New("native fault evidence invalid") }
	if st, ok := faultInfo.Sys().(*syscall.Stat_t); !ok || st.Uid != uint32(labUID) || st.Nlink != 1 || faultInfo.Mode().Perm() != 0600 { return errors.New("native fault evidence metadata invalid") }
	if e = ensureOwnerMode(faultPath, labUID, 0600); e != nil { return errors.New("native fault evidence metadata invalid") }
	fault, e := os.ReadFile(faultPath)
	if e != nil || string(fault) != scenario { clear(fault); return errors.New("native fault evidence missing") }; clear(fault)
	if scenario == "wrong-holder" || scenario == "unexpected-exec" { if _, e = os.Lstat(receipt); !errors.Is(e, os.ErrNotExist) { return errors.New("unexpected receipt") } } else { b, re := os.ReadFile(receipt); if re != nil || !validReceipt(b) || len(b) != 48 { clear(b); return errors.New("outcome receipt invalid") }; if e = ensureOwnerMode(receipt, labUID, 0600); e != nil { clear(b); return errors.New("outcome receipt metadata invalid") }; clear(b) }
	if err = l.revoke(); err != nil { return errors.New("revocation failed") }
	stateBefore, e := os.ReadFile(state); if e != nil { return errors.New("state verification failed") }
	receiptBefore, e := os.ReadFile(receipt); receiptBeforeMissing := errors.Is(e, os.ErrNotExist); if e != nil && !receiptBeforeMissing { clear(stateBefore); return errors.New("receipt verification failed") }
	faultBefore, e := os.ReadFile(faultPath); if e != nil { clear(stateBefore); clear(receiptBefore); return errors.New("fault verification failed") }
	_, e = l.cli(labUID, answers, "appstore", "unlock", harnessPath, l.ref, mode)
	var refusal *labRefusal
	if !errors.As(e, &refusal) || refusal.Code != "no-unique-active-grant" { clear(stateBefore); clear(receiptBefore); clear(faultBefore); return errors.New("replay refusal not verified") }
	stateAfter, se := os.ReadFile(state); receiptAfter, re := os.ReadFile(receipt); receiptAfterMissing := errors.Is(re, os.ErrNotExist); faultAfter, fe := os.ReadFile(faultPath)
	if se != nil || (re != nil && !receiptAfterMissing) || receiptBeforeMissing != receiptAfterMissing || fe != nil || !bytes.Equal(stateBefore, stateAfter) || !bytes.Equal(receiptBefore, receiptAfter) || !bytes.Equal(faultBefore, faultAfter) { clear(stateBefore); clear(receiptBefore); clear(faultBefore); clear(stateAfter); clear(receiptAfter); clear(faultAfter); return errors.New("replay changed evidence") }
	clear(stateBefore); clear(receiptBefore); clear(faultBefore); clear(stateAfter); clear(receiptAfter); clear(faultAfter)
	outcome := "UNKNOWN"
	if mode == "withheld" { outcome = "WITHHELD" }
	data, e := json.Marshal(map[string]string{"result":"task245-negative-complete", "scenario":scenario, "expected_outcome":outcome})
	if e != nil { return errors.New("metadata unavailable") }
	_, e = os.Stdout.Write(append(data, '\n'))
	return e
}
