//go:build linux && amd64

package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"clawforge/tools/native/task240-native/task245-acceptance/internal/diagnostics"
)

const (
	lab                = "/lab"
	runtimeDir         = "/run/task245-lab"
	metadataSocket     = "/run/task245-metadata.sock"
	brokerSocket       = runtimeDir + "/broker.sock"
	metadataExe        = "/lab/bin/native-metadata"
	brokerExe          = "/lab/bin/native-lab-broker"
	controlProfile     = "/lab/control-profile"
	harness            = "/lab/harness"
	metadataRegression = "/lab/metadata-regression"
	syntheticRoot      = "/var/lib/ssjack"
	syntheticDir       = syntheticRoot + "/synthetic"
	maxFile            = 64 << 20
)

func parseRecord(data []byte) (record, error) {
	var r record
	if len(data) < 1 || len(data) > 511 || data[len(data)-1] != '\n' || bytes.Count(data, []byte{'\n'}) != 1 {
		return r, fail("malformed-record")
	}
	fields := strings.Split(string(data[:len(data)-1]), " ")
	if len(fields) != 8 || fields[0] != "OCLABAUTH1" || len(fields[7]) != 64 {
		return r, fail("malformed-record")
	}
	values := make([]uint64, 6)
	for i := range values {
		n, err := strconv.ParseUint(fields[i+1], 10, 64)
		if err != nil || strconv.FormatUint(n, 10) != fields[i+1] {
			return r, fail("malformed-record")
		}
		values[i] = n
	}
	for _, c := range fields[7] {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return r, fail("malformed-hash")
		}
	}
	r = record{
		pid: values[0], start: values[1], execDev: values[2], execIno: values[3],
		socketDev: values[4], socketIno: values[5], hash: fields[7],
	}
	if r.pid <= 1 || r.pid > 2147483647 || r.start == 0 || r.execIno == 0 || r.socketIno == 0 {
		return record{}, fail("malformed-record")
	}
	return r, nil
}

type record struct {
	pid, start, execDev, execIno, socketDev, socketIno uint64
	hash                                              string
}

// StartDaemon deliberately does not inherit the caller's environment.
func StartDaemon(env []string, executable string, args ...string) (*Child, error) {
	cmd := exec.Command(executable, args...)
	cmd.Env = append([]string{}, env...)
	cmd.Stdin, cmd.Stdout = nil, nil
	capture := &diagnostics.Capture{}
	cmd.Stderr = capture
	cmd.WaitDelay = 2 * time.Second
	child, err := startOwned(cmd, procStart)
	if child != nil {
		child.diagnostics = capture
	}
	return child, err
}

func CheckServices(ctx context.Context) (result error) {
	need := func(ok bool, code string) error {
		if !ok {
			return fail(code)
		}
		return nil
	}
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return fail("fresh-root-ci-required")
	}
	if err := ctx.Err(); err != nil {
		return fail("preflight-timeout")
	}
	for _, p := range []string{"/run/task245-services", metadataSocket, runtimeDir} {
		if _, err := os.Lstat(p); err == nil {
			return fail("preflight-not-fresh")
		} else if !errors.Is(err, os.ErrNotExist) {
			return fail("preflight-path")
		}
	}
	var marker syscall.Stat_t
	err := syscall.Lstat(lab+"/disposable-profile", &marker)
	if err != nil || marker.Mode&syscall.S_IFMT != syscall.S_IFREG || marker.Mode&07777 != 0444 || marker.Uid != 0 {
		return fail("profile-marker")
	}
	created := []string{}
	defer func() {
		if err := os.Remove(authDir); err != nil && !errors.Is(err, os.ErrNotExist) && result == nil {
			result = fail("auth-dir-cleanup")
		}
		for i := len(created) - 1; i >= 0; i-- {
			_ = os.Remove(created[i])
		}
	}()
	for _, p := range []string{"/var", "/var/lib"} {
		if err := safeRootDir(p); err != nil {
			return err
		}
	}
	if _, err := os.Lstat(syntheticRoot); errors.Is(err, os.ErrNotExist) {
		if err = os.Mkdir(syntheticRoot, 0755); err != nil {
			return fail("synthetic-root")
		}
		created = append(created, syntheticRoot)
		if err = os.Chown(syntheticRoot, 0, 0); err != nil {
			return fail("synthetic-root")
		}
		if err = os.Chmod(syntheticRoot, 0755); err != nil {
			return fail("synthetic-root")
		}
	} else if err != nil {
		return fail("synthetic-root")
	}
	if err := safeRootDir(syntheticRoot); err != nil {
		return err
	}
	if _, err := os.Lstat(syntheticDir); errors.Is(err, os.ErrNotExist) {
		if err = os.Mkdir(syntheticDir, 0700); err != nil {
			return fail("synthetic-dir")
		}
		created = append(created, syntheticDir)
		if err = os.Chown(syntheticDir, 65534, 65534); err != nil {
			return fail("synthetic-dir")
		}
		if err = os.Chmod(syntheticDir, 0700); err != nil {
			return fail("synthetic-dir")
		}
	} else if err != nil {
		return fail("synthetic-dir")
	}
	var sd syscall.Stat_t
	if syscall.Lstat(syntheticDir, &sd) != nil || sd.Mode&syscall.S_IFMT != syscall.S_IFDIR || sd.Uid != 65534 || sd.Gid != 65534 || sd.Mode&07777 != 0700 {
		return fail("synthetic-dir")
	}
	createdScenario := false
	ownedScenario := false
	var ownedScenarioInfo os.FileInfo
	if _, err := os.Lstat(lab + "/scenario"); errors.Is(err, os.ErrNotExist) {
		createdScenario = true
	} else if err != nil {
		return fail("scenario")
	}
	var controlHash, originalHash string
	restored := false
	defer func() {
		if ownedScenario {
			info, err := os.Lstat(lab + "/scenario")
			if err != nil || !os.SameFile(ownedScenarioInfo, info) {
				if result == nil {
					result = fail("scenario-changed")
				}
			} else if err := os.Remove(lab + "/scenario"); err != nil && result == nil {
				result = fail("scenario-cleanup")
			}
		}
		if controlHash != "" && originalHash != "" {
			if e := copyFile(controlProfile, harness); e != nil {
				if result == nil {
					result = fail("harness-restore")
				}
			} else if e = os.Chmod(harness, 0755); e != nil {
				if result == nil {
					result = fail("harness-restore")
				}
			} else if h, e := fileHash(harness); e != nil || h != controlHash || h != originalHash {
				if result == nil {
					result = fail("harness-restore-hash")
				}
			} else {
				restored = true
			}
			if !restored && result == nil {
				result = fail("harness-restore")
			}
		}
	}()
	brokerHash, err := fileHash(brokerExe)
	if err != nil {
		return err
	}
	controlHash, err = fileHash(controlProfile)
	if err != nil {
		return err
	}
	originalHash, err = fileHash(harness)
	if err != nil {
		return err
	}
	if err = need(originalHash == controlHash, "control-harness-hash"); err != nil {
		return err
	}
	if _, err = fileHash(metadataRegression); err != nil {
		return err
	}
	if err = copyFile(metadataRegression, harness); err != nil {
		return fail("harness-replace")
	}
	if err = os.Chmod(harness, 0755); err != nil {
		return fail("harness-replace")
	}
	if createdScenario {
		f, openErr := os.OpenFile(lab+"/scenario", os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0444)
		if openErr != nil {
			return fail("scenario")
		}
		ownedScenario = true
		ownedScenarioInfo, err = f.Stat()
		if err != nil {
			_ = f.Close()
			return fail("scenario")
		}
		if err = ctx.Err(); err != nil {
			_ = f.Close()
			return fail("preflight-timeout")
		}
		n, writeErr := f.Write([]byte("cancel"))
		if writeErr != nil || n != len("cancel") {
			_ = f.Close()
			return fail("scenario")
		}
		if err = f.Chown(0, 0); err != nil {
			_ = f.Close()
			return fail("scenario")
		}
		if err = f.Chmod(0444); err != nil {
			_ = f.Close()
			return fail("scenario")
		}
		if err = f.Close(); err != nil {
			return fail("scenario")
		}
	}
	cases := []string{"good", "bad_pid", "bad_start", "bad_exe_inode", "bad_socket_inode", "malformed_hash", "malformed_record", "unprivileged_record", "unprivileged_socket", "wrong_service"}
	for _, role := range []string{"metadata", "broker"} {
		for _, tc := range cases {
			if err := ctx.Err(); err != nil {
				return fail("preflight-timeout")
			}
			if role == "metadata" {
				if err = os.Mkdir(runtimeDir, 0755); err != nil {
					return fail("runtime-dir")
				}
				if err = os.Chown(runtimeDir, 0, 0); err != nil {
					return fail("runtime-dir")
				}
				if err = os.Chmod(runtimeDir, 0755); err != nil {
					return fail("runtime-dir")
				}
			}
			if err = serveCase(role, tc, brokerHash); err != nil {
				return err
			}
		}
	}
	return nil
}

func safeRootDir(path string) error {
	var s syscall.Stat_t
	if syscall.Lstat(path, &s) != nil || s.Mode&syscall.S_IFMT != syscall.S_IFDIR || s.Uid != 0 || s.Mode&0022 != 0 {
		return fail("synthetic-parent")
	}
	return nil
}

func fileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fail("file-open")
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, maxFile+1))
	if err != nil || n > maxFile {
		return "", fail("file-size")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(out, io.LimitReader(in, maxFile+1))
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if n > maxFile {
		return fail("file-size")
	}
	return closeErr
}

func serveCase(role, tc, brokerHash string) (result error) {
	spec := roles[role]
	child, err := StartDaemon([]string{}, spec.executable, "--disposable-lab")
	if err != nil {
		if child != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			cleanupErr := child.Stop(ctx)
			cancel()
			if cleanupErr != nil {
				return cleanupErr
			}
		}
		return err
	}
	endpoint := spec.socket
	var runtimeInfo os.FileInfo
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		stopErr := child.Stop(stopCtx)
		cancel()
		if stopErr != nil && result == nil {
			result = fail("child-stop")
		}
		if stopErr == nil {
			if err := Remove(role); err != nil && result == nil {
				result = err
			}
			if tc == "wrong_service" {
				other := "metadata"
				if role == other {
					other = "broker"
				}
				if err := Remove(other); err != nil && result == nil {
					result = err
				}
			}
			if err := os.Remove(endpoint); err != nil && !errors.Is(err, os.ErrNotExist) && result == nil {
				result = fail("socket-cleanup")
			}
			if runtimeInfo != nil {
				info, err := os.Lstat(runtimeDir)
				if errors.Is(err, os.ErrNotExist) {
					// The daemon may remove its runtime directory while stopping.
				} else if err != nil || !os.SameFile(runtimeInfo, info) {
					if result == nil {
						result = fail("runtime-dir-changed")
					}
				} else if err := os.Remove(runtimeDir); err != nil && result == nil {
					result = fail("runtime-dir-cleanup")
				}
			}
		}
	}()
	ready, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	err = WaitReady(ready, child, endpoint)
	cancel()
	if err != nil {
		return err
	}
	runtimeInfo, err = os.Lstat(runtimeDir)
	if err != nil {
		return fail("runtime-dir")
	}
	if tc == "good" {
		if err = checkPublisherModes(child, role); err != nil {
			return err
		}
	}
	if tc == "wrong_service" {
		other := "metadata"
		if role == other {
			other = "broker"
		}
		ospec := roles[other]
		if e := Attest(child, ospec.executable, ospec.socket, other); e == nil {
			return fail("wrong-executable-accepted")
		}
		if _, e := os.Lstat(filepath.Join(authDir, other+".auth")); !errors.Is(e, os.ErrNotExist) {
			return fail("wrong-role-proof")
		}
		return nil
	}
	if err = Attest(child, spec.executable, endpoint, role); err != nil {
		return err
	}
	proof := filepath.Join(authDir, role+".auth")
	original, err := os.ReadFile(proof)
	if err != nil {
		return fail("proof-read")
	}
	if len(bytes.Fields(original)) != 8 || !bytes.HasSuffix(original, []byte{'\n'}) {
		return fail("bad-proof-fixture")
	}
	if tc != "good" {
		if tc == "unprivileged_socket" {
			if err = os.Chown(endpoint, 65534, 65534); err != nil {
				return fail("socket-chown")
			}
		} else {
			fields := bytes.Fields(original)
			switch tc {
			case "bad_pid":
				fields[1] = []byte("99999999")
			case "bad_start":
				fields[2] = []byte("1")
			case "bad_exe_inode":
				n, _ := strconv.ParseUint(string(fields[4]), 10, 64)
				fields[4] = []byte(strconv.FormatUint(n+1, 10))
			case "bad_socket_inode":
				n, _ := strconv.ParseUint(string(fields[6]), 10, 64)
				fields[6] = []byte(strconv.FormatUint(n+1, 10))
			case "malformed_hash":
				fields[7] = bytes.Repeat([]byte{'x'}, 64)
			}
			payload := []byte("OCLABAUTH1 broken\n")
			if tc != "malformed_record" {
				payload = append(bytes.Join(fields, []byte{' '}), '\n')
			}
			tmp := strings.TrimSuffix(proof, ".auth") + ".test"
			if err = os.WriteFile(tmp, payload, 0600); err != nil {
				return fail("proof-mutate")
			}
			if err = os.Chown(tmp, 0, 0); err != nil {
				return fail("proof-mutate")
			}
			if err = os.Chmod(tmp, 0444); err != nil {
				return fail("proof-mutate")
			}
			if err = os.Rename(tmp, proof); err != nil {
				return fail("proof-mutate")
			}
			if tc == "unprivileged_record" {
				if err = os.Chown(proof, 65534, 65534); err != nil {
					return fail("proof-mutate")
				}
			}
		}
	}
	if err = probe(role, tc == "good", brokerHash); err != nil {
		return err
	}
	if role == "metadata" && tc == "good" {
		c, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		done := make(chan error, 1)
		go func() { done <- child.Wait() }()
		select {
		case e := <-done:
			var exited *exec.ExitError
			if !errors.As(e, &exited) || exited.ExitCode() != 1 {
				return fail("forged-listener-handoff")
			}
		case <-c.Done():
			return fail("forged-listener-timeout")
		}
	}
	return nil
}

func probe(role string, expect bool, brokerHash string) error {
	var path string
	var args []string
	var env []string
	var sys *syscall.SysProcAttr
	if role == "metadata" {
		path, args, env = "/lab/harness", []string{"--service-peer"}, []string{"GITHUB_ACTIONS=true"}
	} else {
		path, args = "/lab/release-test", []string{"-test.run=^TestLabServicePeerKernel$"}
		env = []string{"TASK245_SERVICE_PEER=1", "TASK245_BROKER_HASH=" + brokerHash}
		sys = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 65534, Gid: 65534, Groups: []uint32{}}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Dir, cmd.Env, cmd.SysProcAttr = lab, env, sys
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	err := cmd.Run()
	if ctx.Err() != nil {
		return fail("probe-timeout")
	}
	want := 0
	if !expect {
		want = 1
	}
	var exit *exec.ExitError
	if want == 0 && err == nil {
		return nil
	}
	if want == 1 && errors.As(err, &exit) && exit.ExitCode() == 1 {
		return nil
	}
	return fail("probe-status")
}
