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
		if len(fields) != 2 || fields[0] != "task245-broker:" {
			return "", false
		}
		if strings.HasPrefix(fields[1], "stage=") {
			n, ok := number(strings.TrimPrefix(fields[1], "stage="), 1, 5)
			return "task245-broker: stage=" + strconv.Itoa(n), ok
		}
		if strings.HasPrefix(fields[1], "child=") {
			n, ok := number(strings.TrimPrefix(fields[1], "child="), 0, 255)
			return "task245-broker: child=" + strconv.Itoa(n), ok
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
	case "profile":
		return parseProfile(line)
	}
	return "", false
}

func parseProfile(line string) (string, bool) {
	const prefix = "task245-profile: "
	if !strings.HasPrefix(line, prefix) {
		return "", false
	}
	body := strings.TrimPrefix(line, prefix)
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
	for _, source := range []string{"broker", "metadata", "conductor", "init"} {
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
	return "", false
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
	if len(metadata) > 0 {
		if record, ok := parseRecord("metadata", "metadata-daemon: event=stderr"); ok {
			profile = append(profile, "task245-profile: "+record)
		}
	}
	for _, pair := range []struct {
		source string
		raw    []byte
	}{{"broker", broker}, {"init", broker}, {"metadata", metadata}} {
		for _, record := range Records(pair.source, pair.raw) {
			profile = append(profile, "task245-profile: "+record)
		}
	}
	seen := make(map[string]struct{})
	var size int
	count := 0
	const mainFailure = "task245-profile: failed\n"
	ordered := make([]string, 0, count)
	for _, record := range profile {
		if _, exists := seen[record]; exists {
			continue
		}
		if count >= maxLines-1 || size+len(record)+1 > maxCapture-len(mainFailure) {
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
