package diagnostics

import (
	"bytes"
	"io"
	"strings"
)

const maxKernelCapture = 16384

func kernelLabel(s string) bool {
	switch s {
	case "fixture_case_open",
		"fixture_case_invalid",
		"fixture_socket",
		"fixture_connect",
		"fixture_metadata",
		"fixture_admission",
		"fixture_admission_magic",
		"fixture_payload_length",
		"fixture_mutation",
		"fixture_payload_read",
		"fixture_broker_socket",
		"fixture_broker_fork",
		"fixture_broker_dup",
		"fixture_provider_exec",
		"fixture_stdin",
		"fixture_transfer",
		"fixture_gateway_socket",
		"fixture_gateway_fork",
		"fixture_gateway_dup",
		"fixture_gateway_flags",
		"fixture_broker_exec",
		"fixture_gateway_recv",
		"fixture_gateway_rights",
		"private_mount",
		"chroot",
		"proc_mount",
		"read_executable",
		"gateway_start",
		"provider_accept_before_gateway_exec",
		"provider_accept_before_broker_exec",
		"provider_accept_after_provider_exec",
		"provider_accept_after_broker_exec",
		"provider_accept",
		"ready_handshake",
		"mutation_marker_absent",
		"admission_timeout",
		"negative_scenario_timed_out",
		"valid_holder_rejected",
		"between-write_rejection_or_context_failure",
		"actual_send_backpressure_not_observed",
		"worker_failed",
		"unclassified":
		return true
	}
	return false
}

func parseKernelFrame(line string) (string, bool) {
	for _, indent := range []string{"    ", "        "} {
		if !strings.HasPrefix(line, indent+"protocol_test.go:") {
			continue
		}
		s := strings.TrimPrefix(line, indent+"protocol_test.go:")
		i := strings.IndexByte(s, ':')
		if i < 0 {
			continue
		}
		if _, ok := number(s[:i], 1, 999999); !ok {
			continue
		}
		s = s[i+1:]
		const phrase = " namespace helper failed diagnostic="
		if !strings.HasPrefix(s, phrase) {
			continue
		}
		s = strings.TrimPrefix(s, phrase)
		j := strings.Index(s, " (output length ")
		if j < 0 {
			continue
		}
		label := s[:j]
		if !kernelLabel(label) {
			continue
		}
		s = strings.TrimPrefix(s[j:], " (output length ")
		if !strings.HasSuffix(s, ")") {
			continue
		}
		if _, ok := number(strings.TrimSuffix(s, ")"), 0, 2147483647); !ok {
			continue
		}
		return label, true
	}
	return "", false
}

func ReportKernelFailure(w io.Writer, failed bool, raw []byte) error {
	if !failed {
		return nil
	}
	if len(raw) > maxKernelCapture || (len(raw) > 0 && raw[len(raw)-1] != '\n') {
		return nil
	}
	if len(raw) == 0 {
		return nil
	}

	lines := bytes.Split(raw, []byte{'\n'})
	if len(lines) < 2 || len(lines)-1 > 256 || len(lines[len(lines)-1]) != 0 {
		return nil
	}
	for _, line := range lines[:len(lines)-1] {
		if len(line) > 512 {
			return nil
		}
	}

	seen := make(map[string]bool)
	var builder strings.Builder
	count := 0
	for _, line := range lines[:len(lines)-1] {
		ascii := true
		for _, value := range line {
			if value > 0x7f {
				ascii = false
				break
			}
		}
		if !ascii {
			continue
		}
		label, ok := parseKernelFrame(string(line))
		if !ok || seen[label] {
			continue
		}
		seen[label] = true
		if count == 8 {
			continue
		}
		builder.WriteString("task245-profile: kernel=")
		builder.WriteString(label)
		builder.WriteByte('\n')
		count++
	}
	return ForwardFailure(w, true, []byte(builder.String()))
}
