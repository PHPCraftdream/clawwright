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
	"strings"
	"syscall"
	"time"
)

// RunKernelSuite stages the fixed, prebuilt artifacts in the disposable lab.
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
	if err := RunACKRegression(); err != nil { return err }
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/lab/ssjack", "--kernel-driver")
	cmd.Env = append(os.Environ(), "GITHUB_ACTIONS=true")
	if err := cmd.Run(); err != nil { return fmt.Errorf("run /lab/ssjack: %w", err) }
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
