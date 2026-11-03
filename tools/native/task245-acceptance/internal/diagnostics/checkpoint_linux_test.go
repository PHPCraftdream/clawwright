//go:build linux

package diagnostics

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestStartupFailureFileValidation(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root to create UID 65534 fixtures")
	}
	dir := t.TempDir()
	if err := os.Chown(dir, 65534, 65534); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "native-startup-failure")
	data := []byte("OCSF0001\x00\x01\x00\x02")
	write := func(b []byte) {
		t.Helper()
		if err := os.WriteFile(path, b, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(path, 65534, 65534); err != nil {
			t.Fatal(err)
		}
		if err := syscall.Chmod(path, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write([]byte("OCSF0001\x00\x12\x00\x01"))
	if got := startupFailureFile(path); got != "task245-worker: startup=tracker_seize errno=1" {
		t.Fatalf("unexpected tracker startup record: %q", got)
	}

	write([]byte("OCSF0001\x00\x21\x00\x0a"))
	if got := startupFailureFile(path); got != "task245-worker: startup=tracker_wait_nochild errno=10" {
		t.Fatalf("unexpected tracker wait startup record: %q", got)
	}

	write(data)
	if got := startupFailureFile(path); got != "task245-worker: startup=context errno=2" {
		t.Fatalf("unexpected startup record: %q", got)
	}

	for _, tc := range []struct {
		name string
		data []byte
	}{
		{name: "magic", data: []byte("BADMAGIC\x00\x01\x00\x02")},
		{name: "stage-zero", data: []byte("OCSF0001\x00\x00\x00\x02")},
		{name: "stage-invalid", data: []byte("OCSF0001\x00\x23\x00\x02")},
		{name: "errno-over", data: []byte("OCSF0001\x00\x01\x10\x00")},
		{name: "short", data: data[:11]},
		{name: "long", data: append(append([]byte(nil), data...), 0)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			write(tc.data)
			if got := startupFailureFile(path); got != "" {
				t.Fatalf("malformed record accepted: %q", got)
			}
		})
	}

	for _, tc := range []struct {
		name string
		uid  int
		mode uint32
	}{
		{name: "wrong-owner", uid: 0, mode: 0600},
		{name: "mode-0640", uid: 65534, mode: 0640},
		{name: "mode-04600", uid: 65534, mode: 04600},
	} {
		t.Run(tc.name, func(t *testing.T) {
			write(data)
			if err := os.Chown(path, tc.uid, tc.uid); err != nil {
				t.Fatal(err)
			}
			if err := syscall.Chmod(path, tc.mode); err != nil {
				t.Fatal(err)
			}
			if got := startupFailureFile(path); got != "" {
				t.Fatalf("invalid file at %q accepted: %q", path, got)
			}
		})
	}

	write(data)
	if err := os.Link(path, path+"-link"); err != nil {
		t.Fatal(err)
	}
	if got := startupFailureFile(path); got != "" {
		t.Fatalf("hard-linked record at %q accepted: %q", path, got)
	}
	if err := os.Remove(path + "-link"); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", path); err != nil {
		t.Fatal(err)
	}
	if got := startupFailureFile(path); got != "" {
		t.Fatalf("symlink at %q accepted: %q", path, got)
	}
}

func TestStartupFailureRejectsUnprotectedParent(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root")
	}

	for _, tc := range []struct {
		name string
		uid  int
		mode uint32
	}{
		{name: "wrong-owner", uid: 0, mode: 0700},
		{name: "wrong-mode", uid: 65534, mode: 0755},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.Chown(dir, tc.uid, tc.uid); err != nil {
				t.Fatal(err)
			}
			if err := syscall.Chmod(dir, tc.mode); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "native-startup-failure")
			if err := os.WriteFile(path, []byte("OCSF0001\x00\x01\x00\x02"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chown(path, 65534, 65534); err != nil {
				t.Fatal(err)
			}
			if err := syscall.Chmod(path, 0600); err != nil {
				t.Fatal(err)
			}
			if got := startupFailureFile(path); got != "" {
				t.Fatalf("file with unprotected parent %q accepted: %q", path, got)
			}
		})
	}
}

func checkpointFixture(t *testing.T, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "checkpoint")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(path, 65534, os.Getegid()); err != nil {
			t.Fatal(err)
		}
	}
	if err := syscall.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCheckpointFileAcceptsOwnedCanonicalFile(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("acceptance requires root to assign UID 65534; not an acceptance result")
	}
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{"three-bytes", []byte{1, 12, 32}},
		{"128-bytes", bytes.Repeat([]byte{1}, 128)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := checkpointFile(checkpointFixture(t, tc.data))
			want := "task245-profile: checkpoints=1-12-32"
			if tc.name == "128-bytes" {
				want = "task245-profile: checkpoints=" + strings.TrimSuffix(strings.Repeat("1-", 48), "-")
			}
			if got != want {
				t.Fatalf("checkpointFile() did not return expected canonical record")
			}
			if tc.name != "three-bytes" {
				return
			}
			var out bytes.Buffer
			if err := ReportFailure(&out, true, got, nil, nil, "stderr", 7); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), want+"\n") {
				t.Fatal("ReportFailure omitted checkpoint record")
			}
			out.Reset()
			if err := ContainerFailure(&out, true, 7, 0, []byte(got+"\n")); err != nil {
				t.Fatal(err)
			}
			wantTransport := "task245-container: command_exit=7 container_exit=0\n" + want + "\n"
			if out.String() != wantTransport {
				t.Fatal("ContainerFailure emitted unexpected transport record")
			}
		})
	}
}

func TestCheckpointFileRejectsWrongOwner(t *testing.T) {
	if os.Geteuid() == 65534 {
		t.Skip("cannot create a distinct wrong-owner fixture as UID 65534")
	}
	path := filepath.Join(t.TempDir(), "checkpoint")
	if err := os.WriteFile(path, []byte{1}, 0600); err != nil {
		t.Fatal(err)
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(path, 0, os.Getegid()); err != nil {
			t.Fatal(err)
		}
	}
	if err := syscall.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if got := checkpointFile(path); got != checkpointAbsent {
		t.Fatal("wrong-owner file was accepted")
	}
}

func TestCheckpointFileRejectsInvalidRootFixtures(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("invalid UID 65534 fixtures require root")
	}
	check := func(name string, path string) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			if got := checkpointFile(path); got != checkpointAbsent {
				t.Fatal("invalid fixture was accepted")
			}
		})
	}
	for _, mode := range []uint32{0640, 04600, 02600, 01600} {
		t.Run(fmt.Sprintf("mode-%o", mode), func(t *testing.T) {
			path := checkpointFixture(t, []byte{1})
			if err := syscall.Chmod(path, mode); err != nil {
				t.Fatal(err)
			}
			check("reject", path)
		})
	}
	path := checkpointFixture(t, []byte{1})
	if err := os.Link(path, path+"-link"); err != nil {
		t.Fatal(err)
	}
	check("hardlink", path)

	for name, data := range map[string][]byte{
		"empty": {}, "too-large": bytes.Repeat([]byte{1}, 129),
		"invalid-zero": {0}, "invalid-33": {33}, "invalid-ascii": {'1'},
	} {
		check(name, checkpointFixture(t, data))
	}

	fifo := filepath.Join(t.TempDir(), "fifo")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	check("fifo", fifo)
	target := checkpointFixture(t, []byte{1})
	link := filepath.Join(t.TempDir(), "symlink")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	check("symlink", link)
	check("directory", t.TempDir())
}
