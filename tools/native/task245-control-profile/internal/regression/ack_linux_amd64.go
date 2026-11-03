//go:build linux && amd64

package regression

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"strings"
	"time"

	"clawforge/tools/native/task240-native/task245-control-profile/internal/metadata"
)

var errACKPreexisting = errors.New("preexisting ACK path")
var errACKUnexpectedWait = errors.New("invalid ACK entered pending wait")

func RunACKRegression() error {
	return metadata.RunACKRegression()
}

// ReportFailure emits only finite diagnostic codes and numeric process metadata.
func ReportFailure(stage string, err error) {
	fmt.Fprint(os.Stderr, formatFailure(stage, err))
}

func formatFailure(stage string, err error) string {
	stage = diagnosticStage(stage)
	class, errno, exit, signal := "error", 0, 0, 0
	if errors.Is(err, context.DeadlineExceeded) {
		class = "deadline"
	} else if errors.Is(err, context.Canceled) {
		class = "canceled"
	}
	var syscallErr syscall.Errno
	if errors.As(err, &syscallErr) && syscallErr >= 0 && syscallErr <= 4095 {
		errno = int(syscallErr)
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		exit = exitErr.ExitCode()
		if exit < -1 || exit > 255 {
			exit = -1
		}
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			signal = int(status.Signal())
			if signal < 0 || signal > 64 {
				signal = 0
			}
		}
	}
	return fmt.Sprintf("metadata-regression: stage=%s class=%s errno=%d exit=%d signal=%d\n", stage, class, errno, exit, signal)
}

// ReportStage emits a validated progress breadcrumb.
func ReportStage(stage string) {
	fmt.Fprintf(os.Stderr, "metadata-regression: stage=%s event=start\n", diagnosticStage(stage))
}

func ReportDone(stage string) {
	fmt.Fprintf(os.Stderr, "metadata-regression: stage=%s event=done\n", diagnosticStage(stage))
}

func diagnosticStage(stage string) string {
	switch stage {
	case "suite_ack", "suite_driver", "observer_positive", "observer_negative", "lifetime_cases", "service_proofs", "inactive", "active", "fault_write", "fault_fsync", "fault_close", "refusal_receipt", "refusal_fault", "fifo", "life_no_client", "life_handoff", "life_listener", "life_canceled", "life_hash", "life_start", "life_socket", "life_proof", "life_holder", "life_marker", "life_daemon_wait", "life_holder_wait", "life_kill_daemon", "life_kill_holder", "life_cleanup", "daemon_peer_credential", "daemon_peer_start", "daemon_peer_identity", "daemon_root_open", "daemon_registration", "daemon_listener_probe", "daemon_notifier_loop", "daemon_unknown", "client_gate", "client_descriptors", "client_inactive_ack", "client_receipt", "client_active_ack", "client_identity", "client_same_image", "client_same_pid", "fd_state_contents", "fd_state_seals", "fd_state_denial", "fd_ioctl_set", "fd_ioctl_clear", "fd_operation", "fd_expected_errno":
		return stage
	default:
		return "unknown"
	}
}

func RunDiagnosticRegression() error {
	var got bytes.Buffer
	filter := &diagnosticFilter{out: &got}
	valid := "metadata-regression: stage=suite_ack event=start\n" +
		"metadata-regression: stage=life_socket event=start\n" +
		"metadata-regression: stage=life_socket event=done\n" +
		"metadata-regression: stage=unknown event=done\n" +
		"metadata-regression: stage=active class=error errno=13 exit=-1 signal=0\n" +
		"metadata-regression: stage=fifo class=deadline errno=0 exit=0 signal=0\n" +
		"metadata-regression: stage=client_gate class=error errno=13 exit=0 signal=0\n" +
		"metadata-regression: stage=client_same_pid class=error errno=13 exit=0 signal=0\n" +
		"metadata-regression: stage=fd_state_contents class=error errno=0 exit=0 signal=0\n" +
		"metadata-regression: stage=daemon_peer_identity class=error errno=13 exit=0 signal=0\n"
	for i := 0; i < len(valid); i += 3 {
		end := min(i+3, len(valid))
		_, _ = filter.Write([]byte(valid[i:end]))
	}

	invalid := []string{
		"metadata-regression: stage=unknownstage class=error errno=13 exit=0 signal=0\n",
		"metadata-regression: stage=daemon_anything class=error errno=13 exit=0 signal=0\n",
		"metadata-regression: stage=daemon_peer_identity class=error errno=13 exit=0 signal=0 trailingsecret\n",
		"metadata-regression: stage=client_gatex class=error errno=13 exit=0 signal=0\n",
		"metadata-regression: stage=client_gate class=error errno=13 exit=0 signal=0 payload=secret\n",
		"metadata-regression: stage=client_gate class=error errno=13 exit=0 signal=0 trailing\n",
		"metadata-regression: stage=active class=unknownclass errno=0 exit=0 signal=0\n",
		"metadata-regression: stage=active class=error errno=4096 exit=0 signal=0\n",
		"metadata-regression: stage=active class=error errno=0 exit=256 signal=0\n",
		"metadata-regression: stage=active class=error errno=0 exit=0 signal=65\n",
		"metadata-regression: stage=active class=error errno=01 exit=0 signal=0\n",
		"metadata-regression: stage=active event=done secret=private\n",
		"private bootstrap=secret\n",
		strings.Repeat("x", 257) + "\n",
	}
	for _, line := range invalid {
		_, _ = filter.Write([]byte(line))
	}
	_, _ = filter.Write([]byte("metadata-regression: stage=active event=done\n"))

	want := "metadata-regression: stage=suite_ack event=start\n" +
		"metadata-regression: stage=life_socket event=start\n" +
		"metadata-regression: stage=life_socket event=done\n" +
		"metadata-regression: stage=unknown event=done\n" +
		"metadata-regression: stage=active class=error errno=13 exit=-1 signal=0\n" +
		"metadata-regression: stage=fifo class=deadline errno=0 exit=0 signal=0\n" +
		"metadata-regression: stage=client_gate class=error errno=13 exit=0 signal=0\n" +
		"metadata-regression: stage=client_same_pid class=error errno=13 exit=0 signal=0\n" +
		"metadata-regression: stage=fd_state_contents class=error errno=0 exit=0 signal=0\n" +
		"metadata-regression: stage=daemon_peer_identity class=error errno=13 exit=0 signal=0\n" +
		"metadata-regression: stage=active event=done\n"

	if got.String() != want {
		return errors.New("diagnostic filter output mismatch")
	}
	if strings.Contains(got.String(), "secret") {
		return errors.New("diagnostic filter leaked invalid input")
	}
	if strings.Contains(formatFailure("active", errors.New("sensitive diagnostic")), "sensitive diagnostic") {
		return errors.New("failure formatter leaked error text")
	}
	if formatFailure("active", fmt.Errorf("wrapped: %w", syscall.EACCES)) != "metadata-regression: stage=active class=error errno=13 exit=0 signal=0\n" {
		return errors.New("failure formatter lost errno")
	}
	if formatFailure("active", context.DeadlineExceeded) != "metadata-regression: stage=active class=deadline errno=0 exit=0 signal=0\n" {
		return errors.New("failure formatter lost deadline class")
	}
	return nil
}

func requireACKAbsent(path string) error {
	_, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect stale ACK path: %w", err)
	}
	return errACKPreexisting
}

func createACKFixture(path, content string, uid, mode int) error {
	if err := os.WriteFile(path, []byte(content), os.FileMode(mode)); err != nil {
		return err
	}
	if err := os.Chown(path, uid, uid); err != nil {
		return err
	}
	return os.Chmod(path, os.FileMode(mode))
}

func assertACKRetained(path string) error {
	if _, err := os.Lstat(path); err != nil {
		return fmt.Errorf("ACK path not retained: %w", err)
	}
	return nil
}

func rejectACK(path string, want error) error {
	waits := 0
	err := observeACK(path, context.Background(), time.Second, func(stage string) error {
		if stage == "waiting" {
			waits++
			return errACKUnexpectedWait
		}
		return nil
	})
	if !errors.Is(err, want) {
		return fmt.Errorf("ACK rejection: got %v, want %v", err, want)
	}
	if waits != 0 {
		return fmt.Errorf("invalid ACK entered pending wait %d times", waits)
	}
	return assertACKRetained(path)
}

func runACKObserverFailures() error {
	dir, err := os.MkdirTemp("/lab", "ack-observer-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	fixtures := []struct {
		name    string
		content string
		uid     int
		mode    int
		want    error
	}{
		{name: "wrongmode", content: "release", uid: 65534, mode: 0644, want: errACKMetadata},
		{name: "wronguid", content: "release", uid: 65533, mode: 0600, want: errACKMetadata},
		{name: "rootfull", content: "release", uid: 0, mode: 0600, want: errACKContents},
		{name: "hardlink", content: "release", uid: 65534, mode: 0600, want: errACKMetadata},
		{name: "malformed", content: "invalid", uid: 65534, mode: 0600, want: errACKContents},
		{name: "oversized", content: "release!", uid: 65534, mode: 0600, want: errACKContents},
		{name: "partial", content: "rel", uid: 65534, mode: 0600, want: errACKContents},
	}
	for _, fixture := range fixtures {
		path := filepath.Join(dir, fixture.name)
		if err := createACKFixture(path, fixture.content, fixture.uid, fixture.mode); err != nil {
			return err
		}
		if fixture.name == "hardlink" {
			if err := os.Link(path, path+".link"); err != nil {
				return err
			}
		}
		if err := rejectACK(path, fixture.want); err != nil {
			return fmt.Errorf("%s: %w", fixture.name, err)
		}
		if err := os.Remove(path); err != nil {
			return err
		}
		if fixture.name == "hardlink" {
			if err := os.Remove(path + ".link"); err != nil {
				return err
			}
		}
	}

	invalidPaths := []struct {
		name string
		make func(string) error
	}{
		{name: "directory", make: func(path string) error { return os.Mkdir(path, 0700) }},
		{name: "fifo", make: func(path string) error { return syscall.Mkfifo(path, 0600) }},
	}
	for _, fixture := range invalidPaths {
		path := filepath.Join(dir, fixture.name)
		if err := fixture.make(path); err != nil {
			return err
		}
		if err := rejectACK(path, errACKMetadata); err != nil {
			return fmt.Errorf("%s: %w", fixture.name, err)
		}
	}

	preexisting := filepath.Join(dir, "preexisting")
	if err := createACKFixture(preexisting, "release", 65534, 0600); err != nil {
		return err
	}
	if err := requireACKAbsent(preexisting); !errors.Is(err, errACKPreexisting) {
		return fmt.Errorf("preexisting ACK: got %v", err)
	}
	if err := assertACKRetained(preexisting); err != nil {
		return err
	}
	if err := os.Remove(preexisting); err != nil {
		return err
	}
	if err := requireACKAbsent(preexisting); err != nil {
		return fmt.Errorf("removed ACK path still present: %w", err)
	}

	path := filepath.Join(dir, "snapshot")
	if err := createACKFixture(path, "", 65534, 0600); err != nil {
		return err
	}
	hooked := false
	err = observeACK(path, context.Background(), time.Second, func(stage string) error {
		if stage == "before-read" && !hooked {
			hooked = true
			return os.WriteFile(path, []byte("release"), 0600)
		}
		return nil
	})
	if err != nil || !hooked {
		return fmt.Errorf("snapshot success: err=%v hook=%t", err, hooked)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("snapshot path remains: %v", err)
	}

	if err := checkACKDisappearance(dir); err != nil {
		return err
	}
	if err := checkACKReplacement(dir); err != nil {
		return err
	}
	return checkACKContexts(dir)
}

func checkACKDisappearance(dir string) error {
	path := filepath.Join(dir, "disappeared")
	if err := createACKFixture(path, "", 65534, 0600); err != nil {
		return err
	}
	hooked := false
	hookErr := error(nil)
	waits := 0
	err := observeACK(path, context.Background(), time.Second, func(stage string) error {
		if stage == "waiting" {
			waits++
			return errACKUnexpectedWait
		}
		if stage != "empty" || hooked {
			return nil
		}
		hooked = true
		hookErr = os.Remove(path)
		return hookErr
	})
	if !hooked || hookErr != nil {
		return fmt.Errorf("disappearance setup: hooked=%t err=%v", hooked, hookErr)
	}
	if waits != 0 {
		return fmt.Errorf("disappearance entered pending wait %d times", waits)
	}
	if !errors.Is(err, errACKDisappeared) {
		return fmt.Errorf("disappearance: got %v", err)
	}
	if _, statErr := os.Lstat(path); !errors.Is(statErr, os.ErrNotExist) {
		return fmt.Errorf("disappeared path remains: %v", statErr)
	}
	return nil
}

func verifyACKReplacement(path string, want syscall.Stat_t) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("replacement path not retained: %w", err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("replacement stat has unexpected type %T", info.Sys())
	}
	if stat.Dev != want.Dev || stat.Ino != want.Ino {
		return fmt.Errorf("replacement identity changed: got dev=%d ino=%d, want dev=%d ino=%d", stat.Dev, stat.Ino, want.Dev, want.Ino)
	}
	if stat.Uid != 65534 || info.Mode().Perm() != 0600 || !info.Mode().IsRegular() || stat.Nlink != 1 || info.Size() != 7 {
		return fmt.Errorf("replacement metadata changed: uid=%d mode=%#o regular=%t nlink=%d size=%d", stat.Uid, info.Mode().Perm(), info.Mode().IsRegular(), stat.Nlink, info.Size())
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read replacement content: %w", err)
	}
	if string(content) != "release" {
		return fmt.Errorf("replacement content changed: %q", content)
	}
	return nil
}

func checkACKReplacement(dir string) error {
	path := filepath.Join(dir, "replacement")
	old := path + ".old"
	if err := createACKFixture(path, "", 65534, 0600); err != nil {
		return err
	}
	replaced := false
	var hookErr error
	var replacementStat syscall.Stat_t
	waits := 0
	err := observeACK(path, context.Background(), time.Second, func(stage string) error {
		if stage == "waiting" {
			waits++
			return errACKUnexpectedWait
		}
		if stage == "empty" && !replaced {
			replaced = true
			if hookErr = os.Rename(path, old); hookErr != nil {
				return hookErr
			}
			hookErr = createACKFixture(path, "release", 65534, 0600)
			if hookErr != nil {
				return hookErr
			}
			info, statErr := os.Lstat(path)
			if statErr != nil {
				hookErr = statErr
				return hookErr
			}
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !ok {
				hookErr = fmt.Errorf("replacement stat has unexpected type %T", info.Sys())
				return hookErr
			}
			replacementStat = *stat
		}
		return nil
	})
	if !replaced || hookErr != nil {
		return fmt.Errorf("replacement setup: replaced=%t err=%v", replaced, hookErr)
	}
	if waits != 0 {
		return fmt.Errorf("replacement entered pending wait %d times", waits)
	}
	if !errors.Is(err, errACKPathChanged) {
		return fmt.Errorf("replacement: got %v", err)
	}
	if err := verifyACKReplacement(path, replacementStat); err != nil {
		return err
	}
	return assertACKRetained(old)
}

func checkACKContexts(dir string) error {
	cases := []struct {
		name string
		ctx  context.Context
		want error
	}{
		{name: "canceled", ctx: canceledACKContext(), want: context.Canceled},
		{name: "expired", ctx: expiredACKContext(), want: context.DeadlineExceeded},
	}
	for _, testCase := range cases {
		path := filepath.Join(dir, testCase.name)
		if err := createACKFixture(path, "", 65534, 0600); err != nil {
			return err
		}
		err := observeACK(path, testCase.ctx, time.Second, nil)
		if !errors.Is(err, testCase.want) {
			return fmt.Errorf("%s context: got %v", testCase.name, err)
		}
		if err := assertACKRetained(path); err != nil {
			return fmt.Errorf("%s: %w", testCase.name, err)
		}
	}
	return nil
}

func canceledACKContext() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

func expiredACKContext() context.Context {
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	return ctx
}

func replaceReceiptWithFIFO() error {
	if err := syscall.Unlink(clientReceiptPath); err != nil {
		return fmt.Errorf("unlink receipt before FIFO replacement: %w", err)
	}
	if err := syscall.Mkfifo(clientReceiptPath, 0600); err != nil {
		return fmt.Errorf("create receipt FIFO: %w", err)
	}
	if err := os.Chown(clientReceiptPath, 65534, 65534); err != nil {
		return fmt.Errorf("chown receipt FIFO: %w", err)
	}
	if err := os.Chmod(clientReceiptPath, 0600); err != nil {
		return fmt.Errorf("chmod receipt FIFO: %w", err)
	}
	var stat syscall.Stat_t
	if err := syscall.Lstat(clientReceiptPath, &stat); err != nil {
		return fmt.Errorf("stat receipt FIFO: %w", err)
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFIFO || stat.Uid != 65534 || stat.Mode&07777 != 0600 || stat.Nlink != 1 {
		return fmt.Errorf("receipt FIFO metadata mismatch: type=%#o uid=%d mode=%#o nlink=%d", stat.Mode&syscall.S_IFMT, stat.Uid, stat.Mode&07777, stat.Nlink)
	}
	return nil
}

func removeFIFOReceipt() error {
	var stat syscall.Stat_t
	if err := syscall.Lstat(clientReceiptPath, &stat); err != nil {
		return fmt.Errorf("stat receipt before FIFO cleanup: %w", err)
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFIFO {
		return fmt.Errorf("refusing to remove non-FIFO receipt (mode=%#o)", stat.Mode&syscall.S_IFMT)
	}
	if err := syscall.Unlink(clientReceiptPath); err != nil {
		return fmt.Errorf("unlink receipt FIFO: %w", err)
	}
	return nil
}
