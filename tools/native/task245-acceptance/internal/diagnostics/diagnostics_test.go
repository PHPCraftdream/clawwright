package diagnostics

import (
	"bytes"
	"errors"
	"io"
	"strconv"
	"strings"
	"testing"
)

func TestReportFailureSanitizesAndOrdersCapture(t *testing.T) {
	var broker, metadata Capture
	for _, p := range []string{"task245-broker: stage=2\ntask245-init: checkpoint=110 ", "errno=7\ntask245-broker: child=3\npassword=hunter2\n"} {
		if _, err := io.WriteString(&broker, p); err != nil {
			t.Fatal(err)
		}
	}
	_, _ = io.WriteString(&metadata, "metadata-daemon: stage=6 auth=4 errno=9999\nraw conductor panic stack\n")
	var got bytes.Buffer
	err := ReportFailure(&got, true, "task245-profile: checkpoints=1-2-32", broker.Bytes(), metadata.Bytes(), "command_failed", 7)
	if err != nil {
		t.Fatal(err)
	}
	want := "task245-profile: checkpoints=1-2-32\ntask245-profile: task245-conductor: event=command_failed exit=7\ntask245-profile: metadata-daemon: event=stderr\ntask245-profile: task245-broker: stage=2\ntask245-profile: task245-broker: child=3\ntask245-profile: task245-init: checkpoint=110 errno=7\ntask245-profile: metadata-daemon: stage=6 auth=4 errno=9999\n"
	if got.String() != want {
		t.Fatalf("got %q, want %q", got.String(), want)
	}
	var container bytes.Buffer
	if err := ContainerFailure(&container, true, 7, 0, got.Bytes()); err != nil {
		t.Fatal(err)
	}
	prefix := "task245-container: command_exit=7 container_exit=0\n"
	if !strings.HasPrefix(container.String(), prefix) || container.String()[len(prefix):] != want {
		t.Fatalf("container output %q", container.String())
	}
}

func TestReportFailureReservesMainFailureRecord(t *testing.T) {
	var broker Capture
	for i := 0; i < 32; i++ {
		if _, err := io.WriteString(&broker, "task245-broker: child="+strconv.Itoa(i)+"\n"); err != nil {
			t.Fatal(err)
		}
	}
	var profile bytes.Buffer
	if err := ReportFailure(&profile, true, "task245-profile: checkpoints=1-2-32", broker.Bytes(), nil, "command_failed", 7); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(&profile, "task245-profile: stage=ceremony\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(&profile, "task245-profile: failed\n"); err != nil {
		t.Fatal(err)
	}
	if profile.Len() > maxCapture || strings.Count(profile.String(), "\n") > maxLines {
		t.Fatalf("profile output exceeds limits: %d bytes, %d lines", profile.Len(), strings.Count(profile.String(), "\n"))
	}
	var container bytes.Buffer
	if err := ContainerFailure(&container, true, 7, 0, profile.Bytes()); err != nil {
		t.Fatal(err)
	}
	output := container.String()
	if !strings.Contains(output, "task245-profile: checkpoints=1-2-32\n") || !strings.Contains(output, "task245-profile: task245-conductor: event=command_failed exit=7\n") {
		t.Fatalf("safe records missing from container output: %q", output)
	}
	if !strings.Contains(output, "task245-profile: stage=ceremony\n") || strings.Contains(output, "task245-profile: failed\n") {
		t.Fatalf("stage record missing or fixed failure record forwarded: %q", output)
	}
}

func TestNoOutputWhenSuccessful(t *testing.T) {
	var b bytes.Buffer
	if err := ReportFailure(&b, false, "bad", nil, nil, "bad", 999); err != nil || b.Len() != 0 {
		t.Fatalf("ReportFailure: %q %v", b.String(), err)
	}
	if err := ContainerFailure(&b, false, 0, 0, []byte("bad\n")); err != nil || b.Len() != 0 {
		t.Fatalf("ContainerFailure: %q %v", b.String(), err)
	}
}

func TestReportFailureRejectsUnsafeInputs(t *testing.T) {
	cases := []struct {
		name string
		raw  []byte
	}{
		{"unterminated", []byte("task245-broker: stage=1")},
		{"trailing secret", []byte("task245-broker: stage=1 token=x\n")},
		{"malformed", []byte("task245-broker: stage=x\n")},
		{"out of range", []byte("task245-broker: stage=6\n")},
		{"leading zero", []byte("task245-broker: stage=01\n")},
		{"sign", []byte("task245-broker: stage=+1\n")},
		{"control", []byte("task245-broker: stage=1\r\n")},
		{"non ascii", []byte("task245-broker: stage=1é\n")},
		{"long line", []byte("task245-broker: " + strings.Repeat("x", 185) + "\n")},
		{"too many lines", []byte(strings.Repeat("unknown\n", 33))},
		{"legacy conductor", []byte("task245-conductor: password secret\n")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var b bytes.Buffer
			_ = ReportFailure(&b, true, "task245-profile: checkpoints=1", tc.raw, nil, "stderr", 1)
			if strings.Contains(b.String(), "task245-broker:") || strings.Contains(b.String(), "task245-conductor: password") {
				t.Fatalf("unsafe record forwarded (output bytes: %d)", b.Len())
			}
		})
	}
	profileCases := [][]byte{
		[]byte("task245-profile: garbage\n"),
		[]byte("task245-profile: checkpoints=1\n" + strings.Repeat("x", 201) + "\n"),
	}
	for _, raw := range profileCases {
		if records := Records("profile", raw); len(records) != 0 {
			t.Fatalf("accepted unsafe profile record count: %d", len(records))
		}
	}
	for _, raw := range [][]byte{bytes.Repeat([]byte{'x'}, 4097), []byte("task245-broker: stage=1\n" + strings.Repeat("x", 201) + "\n")} {
		if records := Records("broker", raw); len(records) != 0 {
			t.Fatalf("accepted over-limit batch count: %d", len(records))
		}
	}
}

func TestCaptureOverflowLatches(t *testing.T) {
	var c Capture
	if n, err := c.Write(bytes.Repeat([]byte{'x'}, 4097)); err != nil || n != 4097 {
		t.Fatalf("Write = %d, %v", n, err)
	}
	_, _ = c.Write([]byte("task245-broker: stage=1\n"))
	if c.Bytes() != nil {
		t.Fatalf("overflow capture returned bytes")
	}
}

func TestProfileCheckpointGrammar(t *testing.T) {
	valid := "task245-profile: checkpoints=" + strings.TrimSuffix(strings.Repeat("1-", 48), "-") + "\n"
	if got := Records("profile", []byte(valid)); len(got) != 1 {
		t.Fatalf("48 checkpoints rejected: %q", got)
	}
	tooMany := "task245-profile: checkpoints=" + strings.TrimSuffix(strings.Repeat("1-", 49), "-") + "\n"
	if got := Records("profile", []byte(tooMany)); len(got) != 0 {
		t.Fatalf("49 checkpoints accepted: %q", got)
	}
	for _, s := range []string{"0", "33", "01", "+1", "-1", "1x"} {
		if got := Records("profile", []byte("task245-profile: checkpoints="+s+"\n")); len(got) != 0 {
			t.Fatalf("accepted %q", s)
		}
	}
}

func TestBrokerWaitLifecycleForwardingChain(t *testing.T) {
	var capture Capture
	for _, chunk := range []string{
		"task245-broker: wait=signal exit=-1 ",
		"signal=9\ntask245-broker: lifecycle=peer_eof errno=0\ntask245-broker: child=255\n",
	} {
		if _, err := io.WriteString(&capture, chunk); err != nil {
			t.Fatal(err)
		}
	}

	var report bytes.Buffer
	if err := ReportFailure(&report, true, "task245-profile: checkpoints=1-2-32", capture.Bytes(), nil, "command_failed", 7); err != nil {
		t.Fatal(err)
	}

	var container bytes.Buffer
	if err := ContainerFailure(&container, true, 7, 0, report.Bytes()); err != nil {
		t.Fatal(err)
	}

	want := "task245-container: command_exit=7 container_exit=0\ntask245-profile: checkpoints=1-2-32\ntask245-profile: task245-conductor: event=command_failed exit=7\ntask245-profile: task245-broker: wait=signal exit=-1 signal=9\ntask245-profile: task245-broker: lifecycle=peer_eof errno=0\ntask245-profile: task245-broker: child=255\n"
	if container.String() != want {
		t.Fatalf("got %q, want %q", container.String(), want)
	}
}

func TestBrokerMalformedWaitLifecycleNotForwarded(t *testing.T) {
	cases := []string{
		"task245-broker: wait=signal exit=0 signal=9\n",
		"task245-broker: wait=signal exit=-1 signal=0\n",
		"task245-broker: wait=signal exit=-1 signal=65\n",
		"task245-broker: wait=signal exit=-01 signal=9\n",
		"task245-broker: lifecycle=unknown errno=0\n",
		"task245-broker: lifecycle=peer_eof errno=0 rawsecret\n",
		"task245-broker: wait=signal exit=-1 signal=9 trailing\n",
	}
	for _, raw := range cases {
		t.Run(strings.TrimSpace(raw), func(t *testing.T) {
			var capture Capture
			_, _ = io.WriteString(&capture, raw)

			var report bytes.Buffer
			if err := ReportFailure(&report, true, "task245-profile: checkpoints=1", capture.Bytes(), nil, "stderr", 1); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(report.String(), "task245-profile: checkpoints=1\n") || !strings.Contains(report.String(), "task245-conductor: event=stderr exit=1") || strings.Contains(report.String(), "task245-broker:") {
				t.Fatalf("unexpected report %q", report.String())
			}
		})
	}
	for _, raw := range []string{
		"task245-profile: stage=unknown\n",
		"task245-profile: stage=ceremony trailingsecret\n",
	} {
		if records := Records("profile", []byte(raw)); len(records) != 0 {
			t.Fatalf("forwarded unsafe profile record %q", records)
		}
	}
}

func TestAllowedProfileStageRoundTrip(t *testing.T) {
	for _, stage := range []string{
		"setup", "identity", "freshness", "metadata_regression", "kernel", "capabilities",
		"inventory", "metadata_preflight", "tool_bind", "native_setup", "service_preflight", "ceremony",
	} {
		line := "task245-profile: stage=" + stage + "\n"
		var capture Capture
		_, _ = io.WriteString(&capture, line)

		var out bytes.Buffer
		if err := ForwardFailure(&out, true, capture.Bytes()); err != nil {
			t.Fatal(err)
		}
		if out.String() != line {
			t.Fatalf("stage %q roundtrip = %q", stage, out.String())
		}
	}
}

type failingWriter struct {
	err error
}

func (w failingWriter) Write([]byte) (int, error) {
	return 0, w.err
}

func TestForwardFailureReturnsWriterError(t *testing.T) {
	want := errors.New("write failed")
	if err := ForwardFailure(failingWriter{want}, true, []byte("task245-profile: checkpoints=1\n")); err != want {
		t.Fatalf("got %v, want %v", err, want)
	}
}
