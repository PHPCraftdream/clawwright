//go:build linux && amd64

package regression

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"clawforge/tools/native/task240-native/task245-control-profile/internal/metadata"
)

var errACKPreexisting = errors.New("preexisting ACK path")
var errACKUnexpectedWait = errors.New("invalid ACK entered pending wait")

func RunACKRegression() error {
	return metadata.RunACKRegression()
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
