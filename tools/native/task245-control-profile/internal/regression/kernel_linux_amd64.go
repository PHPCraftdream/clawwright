//go:build linux && amd64

package regression

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type diagnosticFilter struct {
	out      io.Writer
	line     []byte
	dropping bool
}

func (w *diagnosticFilter) Write(p []byte) (int, error) {
	for _, b := range p {
		if w.dropping {
			if b == '\n' {
				w.dropping = false
				w.line = w.line[:0]
			}
			continue
		}

		if b != '\n' {
			if len(w.line) >= 256 {
				w.line = w.line[:0]
				w.dropping = true
				continue
			}
			w.line = append(w.line, b)
			continue
		}

		w.acceptLine()
	}

	return len(p), nil
}

func (w *diagnosticFilter) acceptLine() {
	line := string(w.line)
	w.line = w.line[:0]

	fields := strings.Split(line, " ")
	valid := false
	if len(fields) == 3 && fields[0] == "metadata-regression:" && strings.HasPrefix(fields[1], "stage=") {
		stage := strings.TrimPrefix(fields[1], "stage=")
		valid = diagnosticStage(stage) == stage &&
			(fields[2] == "event=start" || fields[2] == "event=done")
	} else if len(fields) == 6 && fields[0] == "metadata-regression:" && strings.HasPrefix(fields[1], "stage=") {
		stage := strings.TrimPrefix(fields[1], "stage=")
		valid = diagnosticStage(stage) == stage &&
			(fields[2] == "class=error" || fields[2] == "class=deadline" || fields[2] == "class=canceled")

		limits := []int{4095, 255, 64}
		for i, key := range []string{"errno=", "exit=", "signal="} {
			field := fields[i+3]
			if !strings.HasPrefix(field, key) {
				valid = false
				continue
			}

			value := strings.TrimPrefix(field, key)
			n, err := strconv.Atoi(value)
			min := 0
			if i == 1 {
				min = -1
			}
			if err != nil || n < min || n > limits[i] || strconv.Itoa(n) != value {
				valid = false
			}
		}
	}

	if valid {
		_, _ = io.WriteString(w.out, line+"\n")
	}
}

func RunKernelSuite() error { return runKernelSuite(false) }

// RunConfinementSuite exercises the real Go-to-Rust control path via the fixed probe.
func RunConfinementSuite() error { return runKernelSuite(true) }

func runKernelSuite(stageConfinement bool) error {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return errors.New("kernel suite requires root in GitHub Actions")
	}
	if _, err := os.Lstat("/lab"); err == nil {
		return errors.New("kernel suite prerequisite: /lab must be absent")
	} else if !errors.Is(err, syscall.ENOENT) {
		return err
	}
	if err := os.Mkdir("/lab", 0755); err != nil { return err }
	if err := os.Chmod("/lab", 0755); err != nil { return err }
	if err := os.Mkdir("/lab/bin", 0755); err != nil { return err }
	if err := os.Chmod("/lab/bin", 0755); err != nil { return err }
	artifacts := [][2]string{
		{"/input/control-profile", "/lab/control-profile"},
		{"/input/control-installer", "/lab/bin/control-installer"},
		{"/input/native-metadata", "/lab/bin/native-metadata"},
		{"/input/metadata-regression", "/lab/bin/harness"},
		{"/input/control-profile", "/lab/harness"},
		{"/input/metadata-regression", "/lab/ssjack"},
		{"/input/metadata-regression", "/lab/bin/metadata-child"},
	}
	if stageConfinement {
		artifacts = [][2]string{{"/input/control-profile", "/lab/control-profile"}, {"/input/control-installer", "/lab/bin/control-installer"}, {"/input/native-metadata", "/lab/bin/native-metadata"}, {"/input/probe", "/lab/bin/harness"}}
	}
	for _, a := range artifacts {
		if err := stageKernelBinary(a[0], a[1]); err != nil { return err }
	}
	if stageConfinement {
		if err := syscall.Mount("/lab/bin", "/lab/bin", "", syscall.MS_BIND, ""); err != nil { return err }
		if err := syscall.Mount("", "/lab/bin", "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY, ""); err != nil { return err }
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "/lab/control-profile", "fixture-ref", "golden")
		cmd.Env = []string{
			"SSJACK_ENV_TOKEN=fixture-bootstrap-token",
			"SSJACK_SESSION=fixture-session",
			"SSJACK_ENDPOINT=https://127.0.0.1:1",
			"SSJACK_CERTIFICATE_SHA256="+strings.Repeat("0", 64),
			"PATH=/lab/bin", "LANG=C", "LC_ALL=C",
		}
		cmd.Dir = "/lab"
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 65534, Gid: 65534, Groups: []uint32{}}}
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil { return errors.New("run golden confinement probe failed") }
		if stderr.Len() != 0 { return errors.New("golden confinement probe wrote to stderr") }
		if !bytes.Equal(out, []byte("CONTROL_CONFINEMENT_OK\n")) { return errors.New("unexpected golden confinement output") }
		return nil
	}
	if err := os.Chmod("/lab/ssjack", 0755); err != nil { return err }
	for p, content := range map[string][]byte{
		"/lab/disposable-profile": []byte("task249 component\n"),
		"/lab/scenario": []byte("cancel"),
	} {
		if err := os.WriteFile(p, content, 0444); err != nil { return err }
		if err := os.Chmod(p, 0444); err != nil { return err }
	}
	for _, p := range []string{"/var/lib/ssjack", "/var/lib/ssjack/synthetic"} {
		if err := os.MkdirAll(p, 0755); err != nil { return err }
		if err := os.Chmod(p, 0755); err != nil { return err }
		if err := os.Chown(p, 0, 0); err != nil { return err }
	}
	if err := os.Chown("/var/lib/ssjack/synthetic", 65534, 65534); err != nil { return err }
	if err := os.Chmod("/var/lib/ssjack/synthetic", 0700); err != nil { return err }
	state := "/var/lib/ssjack/synthetic/state.json"
	if err := os.WriteFile(state, []byte("{}"), 0600); err != nil { return err }
	if err := os.Chown(state, 65534, 65534); err != nil { return err }
	receipt := "/var/lib/ssjack/synthetic/consumer-receipt"
	if err := os.WriteFile(receipt, bytes.Repeat([]byte{0x5a}, 48), 0600); err != nil { return err }
	if err := os.Chown(receipt, 65534, 65534); err != nil { return err }
	fault := "/var/lib/ssjack/synthetic/native-fault-reached"
	if err := os.WriteFile(fault, []byte("cancel"), 0600); err != nil { return err }
	if err := os.Chown(fault, 65534, 65534); err != nil { return err }
	if err := os.Chmod(fault, 0600); err != nil { return err }
	if err := syscall.Mount("/lab/bin", "/lab/bin", "", syscall.MS_BIND, ""); err != nil { return err }
	if err := syscall.Mount("", "/lab/bin", "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY, ""); err != nil { return err }
	ReportStage("suite_ack")
	if err := RunACKRegression(); err != nil {
		ReportFailure("suite_ack", err)
		return err
	}
	ReportDone("suite_ack")
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/lab/ssjack", "--kernel-driver")
	cmd.Env = append(os.Environ(), "GITHUB_ACTIONS=true")
	cmd.Stderr = &diagnosticFilter{out: os.Stderr}
	ReportStage("suite_driver")
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return errors.Join(ctx.Err(), err)
		}
		return fmt.Errorf("run kernel driver: %w", err)
	}
	ReportDone("suite_driver")
	return nil
}

func stageKernelBinary(src, dst string) error {
	in, err := os.Open(src)
	if err != nil { return fmt.Errorf("open kernel artifact %s: %w", src, err) }
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
	if err != nil { return err }
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil { _ = os.Remove(dst); return copyErr }
	if closeErr != nil { _ = os.Remove(dst); return closeErr }
	if err := os.Chmod(dst, 0555); err != nil { return err }
	return os.Chown(dst, 0, 0)
}
