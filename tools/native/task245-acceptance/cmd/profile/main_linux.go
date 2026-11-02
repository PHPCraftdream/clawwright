//go:build linux && amd64

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"clawforge/tools/native/task240-native/task245-acceptance/internal/diagnostics"
)

const lab = "/lab"
const productBase = "2997e692cdc24f5b9a5aa23cadc3b22ab1b32f02"

type output struct {
	Status        string            `json:"status"`
	MechanismOnly bool              `json:"mechanism_only"`
	Adoption      bool              `json:"adoption"`
	ProductBase   string            `json:"product_base"`
	Scenario      string            `json:"scenario,omitempty"`
	BinarySHA256  map[string]string `json:"binary_sha256,omitempty"`
	Conductor     map[string]any    `json:"conductor,omitempty"`
}

func require(ok bool, why string) error {
	if !ok {
		return errors.New(why)
	}
	return nil
}

func hash(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

func bindRO(path string) error {
	if err := syscall.Mount(path, path, "", syscall.MS_BIND, ""); err != nil {
		return err
	}
	if err := syscall.Mount("", path, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY, ""); err != nil {
		_ = syscall.Unmount(path, 0)
		return err
	}
	return nil
}

func unbind(path string) error {
	return syscall.Unmount(path, 0)
}

func command(path string, args []string, env []string, timeout time.Duration, uid bool) ([]byte, []byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	c := exec.CommandContext(ctx, path, args...)
	c.WaitDelay = 2 * time.Second
	c.Env = env
	c.Stdin = nil
	var out, errout bounded
	c.Stdout = &out
	c.Stderr = &errout
	if uid {
		c.SysProcAttr = &syscall.SysProcAttr{
			Credential: &syscall.Credential{Uid: 65534, Gid: 65534, Groups: []uint32{}},
		}
	}

	err := c.Run()
	if ctx.Err() != nil {
		return out.Bytes(), errout.Bytes(), ctx.Err()
	}
	if out.overflow || errout.overflow {
		return out.Bytes(), errout.Bytes(), errors.New("command output exceeded limit")
	}
	return out.Bytes(), errout.Bytes(), err
}

type bounded struct {
	b        []byte
	overflow bool
}

func (w *bounded) Write(p []byte) (int, error) {
	n := len(p)
	room := (1 << 20) - len(w.b)
	if room > 0 {
		if room > n {
			room = n
		}
		w.b = append(w.b, p[:room]...)
	}
	if room < n {
		w.overflow = true
	}
	return n, nil
}

func (w *bounded) Bytes() []byte {
	return w.b
}

func line(v any) error {
	e := json.NewEncoder(os.Stdout)
	e.SetEscapeHTML(false)
	return e.Encode(v)
}

func confinement() error {
	if err := require(os.Geteuid() == 0 && os.Getenv("GITHUB_ACTIONS") == "true", "Linux root and GitHub Actions required"); err != nil {
		return err
	}
	if _, err := os.Stat(lab + "/disposable-profile"); !os.IsNotExist(err) {
		return errors.New("profile must be fresh")
	}
	if err := bindRO(lab + "/bin"); err != nil {
		return err
	}
	defer unbind(lab + "/bin")

	env := []string{
		"PATH=/lab/bin",
		"SSJACK_ENV_TOKEN=fixture-bootstrap-token",
		"SSJACK_SESSION=fixture-session",
		"SSJACK_ENDPOINT=https://127.0.0.1:1",
		"SSJACK_CERTIFICATE_SHA256=" + strings.Repeat("0", 64),
	}
	out, stderr, err := command("/lab/harness", []string{"fixture-ref", "golden"}, env, time.Minute, true)
	if err != nil {
		return errors.New("control confinement probe returned nonzero")
	}
	if string(out) != "CONTROL_CONFINEMENT_OK\n" || len(stderr) != 0 {
		return errors.New("control confinement probe output mismatch")
	}
	return line(output{Status: "control-confinement-passed", MechanismOnly: true, Adoption: false, ProductBase: productBase})
}

func directKernelResult(w io.Writer, out, stderr []byte, commandErr error) error {
	if commandErr != nil || len(stderr) != 0 {
		if err := diagnostics.ReportKernelFailure(w, true, out); err != nil {
			return errors.New("kernel diagnostic output failed")
		}
		return errors.New("connected release kernel test failed")
	}
	return nil
}

func mainRun(args []string) error {
	if len(args) == 1 && args[0] == "--confinement" {
		return confinement()
	}
	scenarios := map[string]bool{
		"wrong-holder": true,
		"unexpected-exec": true,
		"partial-ack": true,
		"lost-ack": true,
		"cancel": true,
	}
	scenario := ""
	if len(args) == 2 && args[0] == "--scenario" && scenarios[args[1]] {
		scenario = args[1]
	} else if len(args) != 0 {
		return errors.New("invalid arguments")
	}
	if err := require(os.Geteuid() == 0 && os.Getenv("GITHUB_ACTIONS") == "true" && os.Getenv("GITHUB_SHA") != "" && os.Getenv("GITHUB_RUN_ID") != "", "Linux root and GitHub CI identity required"); err != nil {
		return err
	}
	if _, err := os.Stat(lab + "/disposable-profile"); !os.IsNotExist(err) {
		return errors.New("profile must be fresh")
	}
	if _, err := os.Stat("/lab/native-root"); !os.IsNotExist(err) {
		return errors.New("native root must be fresh")
	}
	if scenario == "" {
		out, stderr, err := command(lab+"/metadata-regression", nil, []string{"GITHUB_ACTIONS=true"}, 15*time.Second, false)
		if err != nil || string(out) != "metadata cancel-ack regression: PASS\n" || len(stderr) != 0 {
			return errors.New("metadata cancel-ack regression failed")
		}
		out, stderr, err = command(lab+"/release-test", []string{"-test.run=^TestConnectedReleaseKernel$", "-test.v"}, []string{"TASK245_KERNEL=1", "TASK245_RELEASE_FIXTURE=/lab/release-fixture", "TASK240_STUB=/lab/native-stub"}, time.Minute, false)
		if err := directKernelResult(os.Stderr, out, stderr, err); err != nil {
			return err
		}
	}
	return runProfile(scenario)
}

func main() {
	if err := mainRun(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "task245-profile: failed")
		os.Exit(1)
	}
}
