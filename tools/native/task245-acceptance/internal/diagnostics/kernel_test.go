package diagnostics

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
)

func kernelFrame(line int, label string, length string) string {
	return fmt.Sprintf("    protocol_test.go:%d: namespace helper failed diagnostic=%s (output length %s)\n", line, label, length)
}

func TestReportKernelFailureLabels(t *testing.T) {
	labels := []string{
		"fixture_case_open",
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
		"unclassified",
	}
	for i, label := range labels {
		t.Run(label, func(t *testing.T) {
			raw := []byte(kernelFrame(i+1, label, "8192"))
			var got bytes.Buffer
			if err := ReportKernelFailure(&got, true, raw); err != nil {
				t.Fatal(err)
			}
			want := "task245-profile: kernel=" + label + "\n"
			if got.String() != want {
				t.Fatalf("got %q, want %q", got.String(), want)
			}
			if records := Records("profile", got.Bytes()); len(records) != 1 || records[0] != strings.TrimSuffix(want, "\n") {
				t.Fatalf("unsafe outer record: %#v", records)
			}
			got.Reset()
			if err := ReportKernelFailure(&got, false, raw); err != nil {
				t.Fatal(err)
			}
			if got.Len() != 0 {
				t.Fatalf("nonfailure emitted %q", got.String())
			}
		})
	}
}

func TestReportKernelFailureVerboseBatch(t *testing.T) {
	labels := []string{
		"fixture_case_open",
		"fixture_case_invalid",
		"fixture_socket",
		"fixture_connect",
		"fixture_metadata",
		"fixture_admission",
		"fixture_admission_magic",
		"fixture_payload_length",
	}
	var raw strings.Builder
	raw.WriteString("=== RUN   TestConnectedReleaseKernel\n")
	for i, label := range labels {
		fmt.Fprintf(&raw, "=== RUN   TestConnectedReleaseKernel/%s\n", label)
		fmt.Fprintf(&raw, "--- FAIL: TestConnectedReleaseKernel/%s (0.00s)\n", label)
		raw.WriteString(kernelFrame(i+1, label, "8192"))
	}
	raw.WriteString("--- FAIL: TestConnectedReleaseKernel (0.01s)\nFAIL\n")
	var got bytes.Buffer
	if err := ReportKernelFailure(&got, true, []byte(raw.String())); err != nil {
		t.Fatal(err)
	}
	var want strings.Builder
	for _, label := range labels {
		fmt.Fprintf(&want, "task245-profile: kernel=%s\n", label)
	}
	if got.String() != want.String() {
		t.Fatalf("got %q, want %q", got.String(), want.String())
	}
	if records := Records("profile", got.Bytes()); len(records) != 8 {
		t.Fatalf("outer records = %#v", records)
	}
	for _, forbidden := range []string{
		"namespace helper",
		"protocol_test.go",
		"=== RUN",
		"--- FAIL",
		"FAIL\n",
	} {
		if strings.Contains(got.String(), forbidden) {
			t.Fatalf("leaked %q", forbidden)
		}
	}
}

func TestReportKernelFailureRejectsWholeBatch(t *testing.T) {
	valid := kernelFrame(51, "fixture_socket", "8192")
	bad := []struct {
		name string
		raw  string
	}{
		{"unknown label", kernelFrame(1, "kernel_secret", "8192")},
		{"suffix", kernelFrame(1, "fixture_socket-secret", "8192")},
		{"same-frame appended secret", strings.TrimSuffix(valid, "\n") + " secret\n"},
		{"label injection", kernelFrame(1, "fixture_socket secret", "8192")},
		{"nul in frame", strings.Replace(valid, "fixture_socket", "fixture_socket\x00", 1)},
		{"crlf", strings.ReplaceAll(valid, "\n", "\r\n")},
		{"incomplete", strings.TrimSuffix(valid, "\n")},
		{"malformed line number", strings.Replace(valid, ":51:", ":x:", 1)},
		{"leading zero", strings.Replace(valid, ":51:", ":051:", 1)},
		{"signed line", strings.Replace(valid, ":51:", ":+51:", 1)},
		{"malformed output length", strings.Replace(valid, "8192", "08", 1)},
		{"overflow output length", strings.Replace(valid, "8192", "999999999999999999999999999999", 1)},
		{"oversized bytes", strings.Repeat("x", maxKernelCapture+1) + "\n" + valid},
		{"too many lines", strings.Repeat("x\n", 256) + valid},
		{"too long line", strings.Repeat("x", 513) + "\n" + valid},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			var got bytes.Buffer
			if err := ReportKernelFailure(&got, true, []byte(tc.raw)); err != nil {
				t.Fatal(err)
			}
			if got.Len() != 0 {
				t.Fatalf("partial batch accepted: %q", got.String())
			}
		})
	}
}

func TestReportKernelFailureDeduplicatesAndWaitsForLF(t *testing.T) {
	frame := kernelFrame(1, "fixture_socket", "8192")
	var got bytes.Buffer
	if err := ReportKernelFailure(&got, true, []byte(frame+frame)); err != nil {
		t.Fatal(err)
	}
	if got.String() != "task245-profile: kernel=fixture_socket\n" {
		t.Fatalf("duplicate output %q", got.String())
	}
	got.Reset()
	capture := &Capture{}
	if _, err := capture.Write([]byte(strings.TrimSuffix(frame, "\n"))); err != nil {
		t.Fatal(err)
	}
	if err := ReportKernelFailure(&got, true, capture.Bytes()); err != nil {
		t.Fatal(err)
	}
	if got.Len() != 0 {
		t.Fatalf("partial write accepted: %q", got.String())
	}
	if _, err := capture.Write([]byte("\n")); err != nil {
		t.Fatal(err)
	}
	if err := ReportKernelFailure(&got, true, capture.Bytes()); err != nil {
		t.Fatal(err)
	}
	if got.String() != "task245-profile: kernel=fixture_socket\n" {
		t.Fatalf("completed output %q", got.String())
	}
}

func TestProfileOuterRejectsUnknownAndTrailingKernel(t *testing.T) {
	for _, raw := range []string{
		"task245-profile: kernel=not_a_label\n",
		"task245-profile: kernel=fixture_socket-extra\n",
		"task245-profile: kernel=fixture_socket trailing\n",
	} {
		if records := Records("profile", []byte(raw)); len(records) != 0 {
			t.Fatalf("accepted %q as %#v", raw, records)
		}
	}
	var got bytes.Buffer
	if err := ForwardFailure(&got, true, []byte("task245-profile: kernel=fixture_socket trailing\n")); err != nil {
		t.Fatal(err)
	}
	if got.Len() != 0 {
		t.Fatalf("forwarded unsafe kernel record: %q", got.String())
	}
}
