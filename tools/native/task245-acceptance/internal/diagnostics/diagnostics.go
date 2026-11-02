package diagnostics

import (
	"bytes"
	"io"
	"strconv"
	"strings"
	"sync"
)

const (
	maxCapture = 4096
	maxLines   = 32
	maxLine    = 200
)

type Capture struct {
	mu       sync.Mutex
	data     []byte
	overflow bool
}

func (c *Capture) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.overflow {
		return len(p), nil
	}
	if len(p) > maxCapture-len(c.data) {
		c.data = nil
		c.overflow = true
		return len(p), nil
	}
	c.data = append(c.data, p...)
	return len(p), nil
}

func (c *Capture) Bytes() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.overflow {
		return nil
	}
	return append([]byte(nil), c.data...)
}

func Records(source string, raw []byte) []string {
	if len(raw) > maxCapture || (len(raw) > 0 && raw[len(raw)-1] != '\n') {
		return nil
	}
	if len(raw) == 0 {
		return nil
	}
	lines := bytes.Split(raw, []byte{'\n'})
	if len(lines) < 2 || len(lines)-1 > maxLines || len(lines[len(lines)-1]) != 0 {
		return nil
	}
	out := make([]string, 0, len(lines)-1)
	seen := make(map[string]struct{})
	for _, line := range lines[:len(lines)-1] {
		if len(line) > maxLine {
			return nil
		}
		if len(line) == 0 || !ascii(line) {
			continue
		}
		if record, ok := parseRecord(source, string(line)); ok {
			if _, exists := seen[record]; !exists {
				seen[record] = struct{}{}
				out = append(out, record)
			}
		}
	}
	return out
}

func ascii(line []byte) bool {
	for _, b := range line {
		if b < 0x20 || b > 0x7e {
			return false
		}
	}
	return true
}

func number(s string, min, max int) (int, bool) {
	n, err := strconv.Atoi(s)
	return n, err == nil && n >= min && n <= max && strconv.Itoa(n) == s
}

func parseRecord(source, line string) (string, bool) {
	fields := strings.Split(line, " ")
	switch source {
	case "broker":
		if len(fields) < 2 || fields[0] != "task245-broker:" {
			return "", false
		}
		if len(fields) == 2 && strings.HasPrefix(fields[1], "stage=") {
			n, ok := number(strings.TrimPrefix(fields[1], "stage="), 1, 5)
			return "task245-broker: stage=" + strconv.Itoa(n), ok
		}
		if len(fields) == 2 && strings.HasPrefix(fields[1], "child=") {
			n, ok := number(strings.TrimPrefix(fields[1], "child="), 0, 255)
			return "task245-broker: child=" + strconv.Itoa(n), ok
		}
		if len(fields) == 4 && fields[1] == "wait=exit" && strings.HasPrefix(fields[2], "exit=") && strings.HasPrefix(fields[3], "signal=") {
			exit, ok1 := number(strings.TrimPrefix(fields[2], "exit="), 0, 255)
			signal, ok2 := number(strings.TrimPrefix(fields[3], "signal="), 0, 0)
			return "task245-broker: wait=exit exit=" + strconv.Itoa(exit) + " signal=" + strconv.Itoa(signal), ok1 && ok2
		}
		if len(fields) == 4 && fields[1] == "wait=signal" && strings.HasPrefix(fields[2], "exit=") && strings.HasPrefix(fields[3], "signal=") {
			exit, ok1 := number(strings.TrimPrefix(fields[2], "exit="), -1, -1)
			signal, ok2 := number(strings.TrimPrefix(fields[3], "signal="), 1, 64)
			return "task245-broker: wait=signal exit=" + strconv.Itoa(exit) + " signal=" + strconv.Itoa(signal), ok1 && ok2
		}
		if len(fields) == 4 && fields[1] == "wait=error" && strings.HasPrefix(fields[2], "exit=") && strings.HasPrefix(fields[3], "signal=") {
			exit, ok1 := number(strings.TrimPrefix(fields[2], "exit="), -1, -1)
			signal, ok2 := number(strings.TrimPrefix(fields[3], "signal="), 0, 0)
			return "task245-broker: wait=error exit=" + strconv.Itoa(exit) + " signal=" + strconv.Itoa(signal), ok1 && ok2
		}
		if len(fields) == 3 && strings.HasPrefix(fields[1], "lifecycle=") && strings.HasPrefix(fields[2], "errno=") {
			lifecycle := strings.TrimPrefix(fields[1], "lifecycle=")
			switch lifecycle {
			case "timeout_setup", "child_exit", "context_done", "peer_eof", "peer_data", "peer_rights", "peer_error":
				errno, ok := number(strings.TrimPrefix(fields[2], "errno="), 0, 4095)
				return "task245-broker: lifecycle=" + lifecycle + " errno=" + strconv.Itoa(errno), ok
			}
		}
	case "metadata":
		if line == "metadata-daemon: event=stderr" {
			return line, true
		}
		if len(fields) != 4 || fields[0] != "metadata-daemon:" || !strings.HasPrefix(fields[1], "stage=") || !strings.HasPrefix(fields[2], "auth=") || !strings.HasPrefix(fields[3], "errno=") {
			return "", false
		}
		a, ok1 := number(strings.TrimPrefix(fields[1], "stage="), 0, 6)
		b, ok2 := number(strings.TrimPrefix(fields[2], "auth="), 0, 4)
		c, ok3 := number(strings.TrimPrefix(fields[3], "errno="), 0, 9999)
		return "metadata-daemon: stage=" + strconv.Itoa(a) + " auth=" + strconv.Itoa(b) + " errno=" + strconv.Itoa(c), ok1 && ok2 && ok3
	case "init":
		if len(fields) != 3 || fields[0] != "task245-init:" || !strings.HasPrefix(fields[1], "checkpoint=") || !strings.HasPrefix(fields[2], "errno=") {
			return "", false
		}
		a, ok1 := number(strings.TrimPrefix(fields[1], "checkpoint="), 110, 129)
		b, ok2 := number(strings.TrimPrefix(fields[2], "errno="), 0, 9999)
		return "task245-init: checkpoint=" + strconv.Itoa(a) + " errno=" + strconv.Itoa(b), ok1 && ok2
	case "conductor":
		if len(fields) != 3 || fields[0] != "task245-conductor:" {
			return "", false
		}
		switch fields[1] {
		case "event=command_failed", "event=stderr", "event=evidence":
		default:
			return "", false
		}
		if !strings.HasPrefix(fields[2], "exit=") {
			return "", false
		}
		n, ok := number(strings.TrimPrefix(fields[2], "exit="), -1, 255)
		return "task245-conductor: " + fields[1] + " exit=" + strconv.Itoa(n), ok
	case "worker":
		if len(fields) != 3 || fields[0] != "task245-worker:" || !strings.HasPrefix(fields[1], "startup=") || !strings.HasPrefix(fields[2], "errno=") {
			return "", false
		}
		startup := strings.TrimPrefix(fields[1], "startup=")
		switch startup {
		case "context", "node", "stub", "provider", "packet", "gate_pipe", "args_pipe", "fork", "tracker", "args_write", "args_close", "gate_write", "gate_close", "tracker_context", "tracker_guard", "tracker_identity", "tracker_tasks", "tracker_seize", "tracker_interrupt", "tracker_wait", "tracker_recheck", "tracker_resume":
		default:
			return "", false
		}
		errno, ok := number(strings.TrimPrefix(fields[2], "errno="), 0, 4095)
		return "task245-worker: startup=" + startup + " errno=" + strconv.Itoa(errno), ok
	case "profile":
		return parseProfile(line)
	}
	return "", false
}

func ProfileStage(stage string) bool {
	_, ok := parseProfile("task245-profile: stage=" + stage)
	return ok
}

func parseProfile(line string) (string, bool) {
	const prefix = "task245-profile: "
	if !strings.HasPrefix(line, prefix) {
		return "", false
	}
	body := strings.TrimPrefix(line, prefix)
	if strings.HasPrefix(body, "stage=") {
		stage := strings.TrimPrefix(body, "stage=")
		for _, allowed := range []string{"setup", "identity", "freshness", "metadata_regression", "kernel", "capabilities", "inventory", "metadata_preflight", "tool_bind", "native_setup", "service_preflight", "ceremony"} {
			if stage == allowed {
				return prefix + "stage=" + stage, true
			}
		}
		return "", false
	}
	if strings.HasPrefix(body, "kernel=") {
		label := strings.TrimPrefix(body, "kernel=")
		if kernelLabel(label) {
			return prefix + "kernel=" + label, true
		}
		return "", false
	}
	if body == "checkpoints=absent" {
		return prefix + body, true
	}
	for _, source := range []string{"broker", "metadata", "conductor", "init", "worker"} {
		if safe, ok := parseRecord(source, body); ok {
			return prefix + safe, true
		}
	}
	const cp = "checkpoints="
	if strings.HasPrefix(body, cp) {
		parts := strings.Split(strings.TrimPrefix(body, cp), "-")
		if len(parts) == 0 || len(parts) > 48 {
			return "", false
		}
		values := make([]string, 0, len(parts))
		for _, part := range parts {
			n, ok := number(part, 1, 32)
			if !ok {
				return "", false
			}
			values = append(values, strconv.Itoa(n))
		}
		return prefix + cp + strings.Join(values, "-"), true
	}
	if strings.HasPrefix(body, "service ") {
		fields := strings.Split(body, " ")
		if len(fields) != 4 || fields[0] != "service" || !strings.HasPrefix(fields[1], "role=") || !strings.HasPrefix(fields[2], "case=") || !strings.HasPrefix(fields[3], "code=") {
			return "", false
		}
		role := strings.TrimPrefix(fields[1], "role=")
		scenario := strings.TrimPrefix(fields[2], "case=")
		code := strings.TrimPrefix(fields[3], "code=")
		if !validServiceRole(role) || !validServiceCase(scenario) || !validServiceCode(code) {
			return "", false
		}
		return prefix + "service role=" + role + " case=" + scenario + " code=" + code, true
	}
	return "", false
}

func validServiceRole(s string) bool {
	switch s {
	case "unknown", "metadata", "broker":
		return true
	default:
		return false
	}
}

func validServiceCase(s string) bool {
	switch s {
	case "unknown", "setup", "good", "bad_pid", "bad_start", "bad_exe_inode", "bad_socket_inode", "malformed_hash", "malformed_record", "unprivileged_record", "unprivileged_socket", "wrong_service":
		return true
	default:
		return false
	}
}

func validServiceCode(s string) bool {
	switch s {
	case "unknown", "attestation-directory", "attestation-exists", "auth-dir-cleanup", "bad-proof-fixture", "child-stop", "ci-required", "control-harness-hash", "directory", "executable-file", "executable-size", "file-open", "file-size", "forged-listener-handoff", "forged-listener-timeout", "fresh-root-ci-required", "harness-replace", "harness-restore", "harness-restore-hash", "kill-refused", "lab-not-readonly", "listener", "listener-owner", "listener-table", "malformed-hash", "malformed-record", "preflight-not-fresh", "preflight-path", "preflight-timeout", "process", "process-changed", "process-executable", "process-exited", "process-fds", "process-stat", "probe-status", "probe-timeout", "profile-marker", "proof-mutate", "proof-read", "publish", "publish-write", "readiness-timeout", "reap-timeout", "remove", "role", "role-path", "root-required", "runtime-dir", "runtime-dir-changed", "runtime-dir-cleanup", "scenario", "scenario-changed", "scenario-cleanup", "socket", "socket-changed", "socket-chown", "socket-cleanup", "start", "synthetic-dir", "synthetic-parent", "synthetic-root", "wrong-executable-accepted", "wrong-role-proof":
		return true
	default:
		return false
	}
}

func ServiceFailure(w io.Writer, failed bool, role, scenario, code string) error {
	if !failed {
		return nil
	}
	if !validServiceRole(role) {
		role = "unknown"
	}
	if !validServiceCase(scenario) {
		scenario = "unknown"
	}
	if !validServiceCode(code) {
		code = "unknown"
	}
	record := "task245-profile: service role=" + role + " case=" + scenario + " code=" + code + "\n"
	return ForwardFailure(w, true, []byte(record))
}

func ForwardFailure(w io.Writer, failed bool, raw []byte) error {
	if !failed {
		return nil
	}
	for _, record := range Records("profile", raw) {
		if _, err := io.WriteString(w, record+"\n"); err != nil {
			return err
		}
	}
	return nil
}

func ReportFailure(w io.Writer, failed bool, checkpoint string, broker, metadata []byte, event string, exit int) error {
	return reportFailure(w, failed, checkpoint, broker, metadata, event, exit, "")
}

func reportFailure(w io.Writer, failed bool, checkpoint string, broker, metadata []byte, event string, exit int, startup string) error {
	if !failed {
		return nil
	}
	checkpointRecords := Records("profile", []byte(checkpoint+"\n"))
	if len(checkpointRecords) != 1 {
		return nil
	}
	profile := []string{checkpointRecords[0]}
	conductor, ok := parseRecord("conductor", "task245-conductor: event="+event+" exit="+strconv.Itoa(exit))
	if !ok {
		return nil
	}
	profile = append(profile, "task245-profile: "+conductor)
	if startup != "" {
		for _, record := range Records("worker", []byte(startup+"\n")) {
			profile = append(profile, "task245-profile: "+record)
		}
	}
	if len(metadata) > 0 {
		if record, ok := parseRecord("metadata", "metadata-daemon: event=stderr"); ok {
			profile = append(profile, "task245-profile: "+record)
		}
	}
	for _, pair := range []struct {
		source string
		raw    []byte
	}{{"broker", broker}, {"init", broker}, {"metadata", metadata}, {"worker", broker}} {
		for _, record := range Records(pair.source, pair.raw) {
			profile = append(profile, "task245-profile: "+record)
		}
	}
	seen := make(map[string]struct{})
	var size int
	count := 0
	const mainFailure = "task245-profile: failed\n"
	const longestStage = "task245-profile: stage=metadata_regression\n"
	reserveBytes := len(longestStage) + len(mainFailure)
	ordered := make([]string, 0, count)
	for _, record := range profile {
		if _, exists := seen[record]; exists {
			continue
		}
		if count >= maxLines-2 || size+len(record)+1 > maxCapture-reserveBytes {
			continue
		}
		seen[record] = struct{}{}
		size += len(record) + 1
		count++
		ordered = append(ordered, record)
	}
	var raw strings.Builder
	for _, record := range ordered {
		raw.WriteString(record)
		raw.WriteByte('\n')
	}
	return ForwardFailure(w, true, []byte(raw.String()))
}

func ContainerFailure(w io.Writer, failed bool, commandExit, containerExit int, raw []byte) error {
	if !failed {
		return nil
	}
	if commandExit < -1 || commandExit > 255 || containerExit < -1 || containerExit > 255 {
		return nil
	}
	line := "task245-container: command_exit=" + strconv.Itoa(commandExit) + " container_exit=" + strconv.Itoa(containerExit) + "\n"
	if _, err := io.WriteString(w, line); err != nil {
		return err
	}
	return ForwardFailure(w, true, raw)
}
