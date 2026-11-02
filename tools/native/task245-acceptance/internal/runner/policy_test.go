package runner

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"clawforge/tools/native/task240-native/task245-acceptance/internal/diagnostics"
)

func validInputs() Env {
	return Env{"TASK245_LAB_CASE": "connected", "CI": "true", "GITHUB_ACTIONS": "true", "TASK245_PRODUCT_CHECKOUT": "/tmp/product", "TASK245_PRODUCT_COMMIT": ProductCommit, "TASK245_PRODUCT_BASE": ProductBase, "TASK245_IMAGE": Image, "RUNNER_TEMP": "/tmp/run", "GITHUB_SHA": "0123456789012345678901234567890123456789", "GITHUB_RUN_ID": "42"}
}

func TestValidateInputsRejectsMutableAndUnknownCases(t *testing.T) {
	mutations := []struct {
		name   string
		change func(Env)
	}{
		{"unknown case", func(e Env) { e["TASK245_LAB_CASE"] = "unknown" }},
		{"mutable tag", func(e Env) { e["TASK245_PRODUCT_TAG"] = "mutable" }},
		{"wrong product commit", func(e Env) { e["TASK245_PRODUCT_COMMIT"] = "wrong" }},
		{"wrong base", func(e Env) { e["TASK245_PRODUCT_BASE"] = "wrong" }},
		{"wrong image", func(e Env) { e["TASK245_IMAGE"] = "latest" }},
		{"case sensitivity", func(e Env) { e["TASK245_LAB_CASE"] = "Connected" }},
		{"invalid CI identity", func(e Env) { e["GITHUB_SHA"] = "not-a-commit" }},
	}
	if _, err := ValidateInputs(validInputs(), true, "/repo", "/repo/tools"); err != nil {
		t.Fatal("valid inputs rejected")
	}
	for _, tc := range mutations {
		t.Run(tc.name, func(t *testing.T) {
			e := validInputs()
			tc.change(e)
			if _, err := ValidateInputs(e, true, "/repo", "/repo/tools"); err == nil {
				t.Fatal("mutated inputs accepted")
			}
		})
	}
}

func TestPatchSyntheticDriverChangesOnlyExactRanges(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if err = ValidateSyntheticELF(original); err != nil {
		t.Fatalf("test executable is not supported ELF: %v", err)
	}
	path := filepath.Join(t.TempDir(), "fixture.elf")
	if err = os.WriteFile(path, original, 0755); err != nil {
		t.Fatal(err)
	}
	if err = PatchSyntheticDriver(path); err != nil {
		t.Fatal(err)
	}
	patched, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(patched) != len(original) {
		t.Fatalf("size changed: %d to %d", len(original), len(patched))
	}
	for i := range original {
		inRange := i >= 40 && i < 48 || i >= 58 && i < 64
		if inRange {
			if patched[i] != 0 {
				t.Fatalf("patch byte %d not zero", i)
			}
		} else if patched[i] != original[i] {
			t.Fatalf("unexpected change at byte %d", i)
		}
	}
}

func TestValidateSyntheticELFRejectsMalformedHeaders(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	valid, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if err = ValidateSyntheticELF(valid); err != nil {
		t.Fatalf("test executable is not supported ELF: %v", err)
	}
	mutations := []struct {
		name   string
		offset int
		value  byte
	}{
		{"magic", 0, 0}, {"class", 4, 1}, {"data", 5, 2}, {"machine", 18, 0}, {"type", 16, 0}, {"header size", 52, 0},
	}
	for _, tc := range mutations {
		t.Run(tc.name, func(t *testing.T) {
			candidate := append([]byte(nil), valid...)
			candidate[tc.offset] = tc.value
			if err := ValidateSyntheticELF(candidate); err == nil {
				t.Fatal("malformed ELF accepted")
			}
		})
	}
	if err := ValidateSyntheticELF(valid[:63]); err == nil {
		t.Fatal("truncated ELF accepted")
	}
}

func TestDockerPolicyRequiresExactCapsAndLimits(t *testing.T) {
	h := map[string]any{"Privileged": false, "Binds": []any{}, "Mounts": []any{}, "NetworkMode": "none", "PidMode": "", "CapDrop": []any{"ALL"}, "CapAdd": []any{"CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_KILL", "CAP_SETGID", "CAP_SETUID", "CAP_SYS_ADMIN", "CAP_SYS_CHROOT", "CAP_SYS_PTRACE"}, "SecurityOpt": []any{"no-new-privileges", "apparmor=unconfined"}, "Memory": float64(4 << 30), "MemorySwap": float64(4 << 30), "PidsLimit": float64(256), "Ulimits": []any{map[string]any{"Name": "core", "Soft": float64(0), "Hard": float64(0)}}, "Tmpfs": map[string]any{"/tmp": "rw,nosuid,nodev,noexec,size=256m"}}
	if !dockerPolicy(h) {
		t.Fatal("exact policy rejected")
	}
	mutations := []struct {
		name   string
		change func(map[string]any)
	}{
		{"network", func(m map[string]any) { m["NetworkMode"] = "bridge" }},
		{"binding", func(m map[string]any) { m["Binds"] = []any{"/host:/host"} }},
		{"extra capability", func(m map[string]any) { m["CapAdd"] = append(m["CapAdd"].([]any), "CAP_NET_ADMIN") }},
		{"pids", func(m map[string]any) { m["PidsLimit"] = float64(257) }},
		{"ulimit", func(m map[string]any) { m["Ulimits"] = []any{map[string]any{"Name": "core", "Soft": float64(1), "Hard": float64(1)}} }},
		{"tmpfs privileged", func(m map[string]any) { m["Tmpfs"] = map[string]any{"/tmp": "rw,exec,size=256m"} }},
	}
	for _, tc := range mutations {
		t.Run(tc.name, func(t *testing.T) {
			candidate := make(map[string]any, len(h))
			for k, v := range h {
				candidate[k] = v
			}
			tc.change(candidate)
			if dockerPolicy(candidate) {
				t.Fatal("mutated policy accepted")
			}
		})
	}
}

func TestProfileEvidenceRejectsAdoptionClaim(t *testing.T) {
	good := []byte(`{"status":"task245-negative-complete","product_base":"` + ProductBase + `","mechanism_only":true,"adoption":false,"scenario":"lost-ack"}`)
	if _, _, err := validateProfileOutput(good, "lost-ack"); err != nil {
		t.Fatal(err)
	}
	mutations := []struct {
		name, output, scenario string
	}{
		{"adoption claim", `{"status":"task245-negative-complete","product_base":"` + ProductBase + `","mechanism_only":true,"adoption":true,"scenario":"lost-ack"}`, "lost-ack"},
		{"wrong scenario", `{"status":"task245-negative-complete","product_base":"` + ProductBase + `","mechanism_only":true,"adoption":false,"scenario":"cancel"}`, "lost-ack"},
		{"wrong status", `{"status":"wrong","product_base":"` + ProductBase + `","mechanism_only":true,"adoption":false,"scenario":"lost-ack"}`, "lost-ack"},
		{"wrong base", `{"status":"task245-negative-complete","product_base":"wrong","mechanism_only":true,"adoption":false,"scenario":"lost-ack"}`, "lost-ack"},
		{"wrong mechanism", `{"status":"task245-negative-complete","product_base":"` + ProductBase + `","mechanism_only":false,"adoption":false,"scenario":"lost-ack"}`, "lost-ack"},
		{"multiline framing", `{"status":"task245-negative-complete","product_base":"` + ProductBase + `","mechanism_only":true,"adoption":false,"scenario":"lost-ack"}` + "\n{}", "lost-ack"},
	}
	for _, tc := range mutations {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := validateProfileOutput([]byte(tc.output), tc.scenario); err == nil {
				t.Fatal("invalid profile output accepted")
			}
		})
	}
}

func TestApplicationFailureDiagnosticTransport(t *testing.T) {
	var profile, out bytes.Buffer
	var capture diagnostics.Capture
	if _, err := capture.Write([]byte("task245-broker: sta")); err != nil {
		t.Fatal(err)
	}
	if _, err := capture.Write([]byte("ge=2\nsecret-like=do-not-forward\n")); err != nil {
		t.Fatal(err)
	}
	if err := diagnostics.ReportFailure(&profile, true, "task245-profile: checkpoints=absent", capture.Bytes(), nil, "command_failed", 7); err != nil {
		t.Fatal(err)
	}
	image, stdout, err := applicationResult(Result{Code: 7, Stderr: profile.Bytes()}, errors.New("private error"), Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":7}}]`)}, nil, &out)
	want := "task245-container: command_exit=7 container_exit=7\ntask245-profile: checkpoints=absent\ntask245-profile: task245-conductor: event=command_failed exit=7\ntask245-profile: task245-broker: stage=2\n"
	if err == nil || image != "" || stdout != nil || out.String() != want {
		t.Fatalf("unexpected result: image=%q stdout=%q err=%v output=%q", image, stdout, err, out.String())
	}
	for _, raw := range []string{"secret-like=do-not-forward", "private error"} {
		if bytes.Contains(out.Bytes(), []byte(raw)) {
			t.Fatalf("raw diagnostic forwarded: %q", raw)
		}
	}
}

func TestApplicationResultFailureClassification(t *testing.T) {
	cases := []struct {
		name      string
		started   Result
		startErr  error
		state     Result
		stateErr  error
		wantExit  string
	}{
		{"zero code with stderr", Result{Stdout: []byte(`{}`), Stderr: []byte("private stderr")}, nil, Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":0}}]`)}, nil, "0"},
		{"nonzero container", Result{Stdout: []byte(`{}`)}, nil, Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":9}}]`)}, nil, "9"},
		{"inspect error", Result{Stdout: []byte(`{}`)}, nil, Result{}, errors.New("private inspect error"), "-1"},
		{"missing image", Result{Stdout: []byte(`{}`)}, nil, Result{Stdout: []byte(`[{"State":{"ExitCode":0}}]`)}, nil, "-1"},
		{"empty image", Result{Stdout: []byte(`{}`)}, nil, Result{Stdout: []byte(`[{"Image":"","State":{"ExitCode":0}}]`)}, nil, "-1"},
		{"missing exit", Result{Stdout: []byte(`{}`)}, nil, Result{Stdout: []byte(`[{"Image":"image","State":{}}]`)}, nil, "-1"},
		{"null exit", Result{Stdout: []byte(`{}`)}, nil, Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":null}}]`)}, nil, "-1"},
		{"malformed inspect", Result{Stdout: []byte(`{}`)}, nil, Result{Stdout: []byte("{")}, nil, "-1"},
		{"out of range exit", Result{Stdout: []byte(`{}`)}, nil, Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":256}}]`)}, nil, "-1"},
		{"start error zero code", Result{Stdout: []byte(`{}`)}, errors.New("private start error"), Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":0}}]`)}, nil, "0"},
		{"safe LF diagnostic", Result{Stdout: []byte(`{}`), Stderr: []byte("task245-profile: checkpoints=1\n")}, nil, Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":0}}]`)}, nil, "0"},
		{"unterminated diagnostic", Result{Stdout: []byte(`{}`), Stderr: []byte("task245-profile: checkpoints=1")}, nil, Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":0}}]`)}, nil, "0"},
		{"malformed trailing secret", Result{Stdout: []byte(`{}`), Stderr: []byte("task245-profile: checkpoints=1\nsecret=hidden\n")}, nil, Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":0}}]`)}, nil, "0"},
		{"same-line trailing secret", Result{Stdout: []byte(`{}`), Stderr: []byte("task245-profile: checkpoints=1 secret=hidden\n")}, nil, Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":0}}]`)}, nil, "0"},
		{"ASCII panic", Result{Stdout: []byte(`{}`), Stderr: []byte("panic: private failure\n")}, nil, Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":0}}]`)}, nil, "0"},
		{"oversized stderr", Result{Stdout: []byte(`{}`), Stderr: bytes.Repeat([]byte("x"), 4097)}, nil, Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":0}}]`)}, nil, "0"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			_, stdout, err := applicationResult(tc.started, tc.startErr, tc.state, tc.stateErr, &out)
			want := "task245-container: command_exit=0 container_exit=" + tc.wantExit + "\n"
			if tc.name == "safe LF diagnostic" || tc.name == "malformed trailing secret" {
				want += "task245-profile: checkpoints=1\n"
			}
			if err == nil || stdout != nil || out.String() != want {
				t.Fatalf("unexpected result: stdout=%q err=%v output=%q", stdout, err, out.String())
			}
			for _, raw := range []string{"private stderr", "private inspect error", "private start error"} {
				if bytes.Contains(out.Bytes(), []byte(raw)) {
					t.Fatalf("raw error forwarded: %q", raw)
				}
			}
		})
	}
}

func TestStartupFailureSuppressedConsumerPipeline(t *testing.T) {
	if runtime.GOOS != "linux" || os.Getenv("TASK245_STARTUP_PIPELINE") != "1" {
		t.Skip("requires disposable Linux root startup pipeline")
	}
	consumer := os.Getenv("TASK245_STARTUP_CONSUMER")
	if consumer == "" {
		t.Fatal("TASK245_STARTUP_CONSUMER required")
	}
	if os.Geteuid() != 0 {
		t.Fatal("root CI container required")
	}
	if _, err := os.Stat(consumer); err != nil {
		t.Fatal(err)
	}
	lab := "/lab"
	if err := os.Mkdir(lab, 0755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(lab, "disposable-profile")
	if err := os.WriteFile(marker, []byte("fixture\n"), 0444); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(marker, 0, 0); err != nil {
		t.Fatal(err)
	}
	base := "/var/lib/ssjack"
	if err := os.Mkdir(base, 0755); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(base, "synthetic")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(dir, 65534, 65534); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name, wantRecord string
		status, errno    uint32
		wantExit         int
	}{
		{name: "crossbinding", status: 2, errno: 13, wantExit: 102},
		{name: "valid", status: 2, errno: 2, wantExit: 101, wantRecord: "task245-worker: startup=node errno=2"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC, 0)
			if err != nil {
				t.Fatal(err)
			}
			parent := os.NewFile(uintptr(fds[0]), "parent-control")
			child := os.NewFile(uintptr(fds[1]), "child-control")
			defer parent.Close()
			defer child.Close()
			var header [64]byte
			copy(header[:8], "SSINK001")
			copy(header[8:24], "0123456789abcdef")
			copy(header[24:56], strings.Repeat("b", 32))
			binary.BigEndian.PutUint64(header[56:], 8192)
			if n, e := syscall.SendmsgN(fds[0], header[:], nil, nil, syscall.MSG_NOSIGNAL); e != nil || n != len(header) {
				t.Fatalf("send header: n=%d err=%v", n, e)
			}
			var refusal [64]byte
			copy(refusal[:8], "OCSTART1")
			copy(refusal[8:56], header[8:56])
			binary.BigEndian.PutUint32(refusal[56:60], tc.status)
			binary.BigEndian.PutUint32(refusal[60:64], tc.errno)
			if tc.name == "crossbinding" {
				refusal[8] ^= 1
			}
			if n, e := syscall.SendmsgN(fds[0], refusal[:], nil, nil, syscall.MSG_NOSIGNAL); e != nil || n != len(refusal) {
				t.Fatalf("send refusal: n=%d err=%v", n, e)
			}

			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, consumer, "--task245-startup-consumer-probe")
			cmd.Env = []string{}
			cmd.ExtraFiles = []*os.File{child}
			cmd.Stderr = io.Discard
			var stdout bytes.Buffer
			cmd.Stdout = &stdout
			cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 65534, Gid: 65534}}
			err = cmd.Run()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != tc.wantExit {
				t.Fatalf("consumer exit=%v want=%d", err, tc.wantExit)
			}
			if stdout.Len() != 0 {
				t.Fatalf("consumer wrote unexpected stdout (%d bytes)", stdout.Len())
			}

			gotStartup := diagnostics.StartupFailure()
			var profile bytes.Buffer
			if e := diagnostics.ReportLabFailure(&profile, true, diagnostics.Checkpoints(), []byte("private secret marker\n"), nil, "command_failed", 1); e != nil {
				t.Fatal(e)
			}
			var outer bytes.Buffer
			image, resultStdout, pipelineErr := applicationResult(Result{Code: 1, Stderr: profile.Bytes()}, errors.New("private command error"), Result{Stdout: []byte(`[{"Image":"fixture","State":{"ExitCode":1}}]`)}, nil, &outer)
			if pipelineErr == nil || image != "" || resultStdout != nil {
				t.Fatalf("unexpected result: image=%q stdout=%q err=%v", image, resultStdout, pipelineErr)
			}
			if tc.wantRecord == "" {
				if gotStartup != "" || strings.Contains(outer.String(), "task245-worker") {
					t.Fatalf("crossbinding exposed startup record: startup=%q output=%q", gotStartup, outer.String())
				}
			} else {
				want := "task245-container: command_exit=1 container_exit=1\ntask245-profile: checkpoints=absent\ntask245-profile: task245-conductor: event=command_failed exit=1\ntask245-profile: task245-worker: startup=node errno=2\n"
				if gotStartup != tc.wantRecord || outer.String() != want {
					t.Fatalf("startup=%q output=%q want startup=%q output=%q", gotStartup, outer.String(), tc.wantRecord, want)
				}
			}
			if strings.Contains(outer.String(), "private secret marker") {
				t.Fatalf("raw broker line forwarded: %q", outer.String())
			}
		})
	}
}

func TestKernelFailureDiagnosticPipeline(t *testing.T) {
	const validFrame = "    protocol_test.go:51: namespace helper failed diagnostic=between-write_rejection_or_context_failure (output length 23)\n"
	const header = "task245-container: command_exit=1 container_exit=1\n"

	cases := []struct {
		name       string
		frame      []byte
		failed     bool
		wantOutput string
		state      Result
	}{
		{
			name:       "recognized kernel failure",
			frame:      []byte(validFrame),
			failed:     true,
			wantOutput: header + "task245-profile: kernel=between-write_rejection_or_context_failure\n",
			state:      Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":1}}]`)},
		},
		{
			name:       "malformed frame does not forward raw text",
			frame:      []byte(validFrame[:len(validFrame)-1] + " secret=hidden\n"),
			failed:     true,
			wantOutput: header,
			state:      Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":1}}]`)},
		},
		{
			name:       "kernel success emits nothing",
			frame:      []byte(validFrame),
			failed:     false,
			state:      Result{Stdout: []byte(`[{"Image":"image","State":{"ExitCode":0}}]`)},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var profile, out bytes.Buffer
			if err := diagnostics.ReportKernelFailure(&profile, tc.failed, tc.frame); err != nil {
				t.Fatal(err)
			}

			started := Result{Code: 1, Stderr: profile.Bytes()}
			startErr := errors.New("private failure")
			if tc.name == "kernel success emits nothing" {
				started = Result{Code: 0, Stdout: []byte(`{}`)}
				startErr = nil
			}
			image, stdout, err := applicationResult(started, startErr, tc.state, nil, &out)
			if tc.name == "kernel success emits nothing" {
				if err != nil || image != "image" || string(stdout) != `{}` || out.Len() != 0 {
					t.Fatalf("unexpected success: image=%q stdout=%q err=%v output=%q", image, stdout, err, out.String())
				}
				return
			}
			if err == nil || image != "" || stdout != nil || out.String() != tc.wantOutput {
				t.Fatalf("unexpected failure: image=%q stdout=%q err=%v output=%q", image, stdout, err, out.String())
			}
		})
	}
}
