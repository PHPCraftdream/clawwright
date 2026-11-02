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
