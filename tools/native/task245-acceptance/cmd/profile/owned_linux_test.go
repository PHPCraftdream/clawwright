//go:build linux && amd64

package main

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestOwnedDirectoryLifecycle(t *testing.T) {
	for _, callbackErr := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "callback error"}[callbackErr], func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "task245-services")
			owner, err := acquireOwnedDirectory(path, uint32(os.Geteuid()))
			if err != nil {
				t.Fatal(err)
			}
			wantErr := error(nil)
			if callbackErr {
				wantErr = os.ErrInvalid
			}
			err = owner.run(func() error {
				listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: filepath.Join(path, "proof.sock"), Net: "unix"})
				if err != nil {
					return err
				}
				listener.SetUnlinkOnClose(false)
				if err = listener.Close(); err != nil {
					return err
				}
				if err = os.WriteFile(filepath.Join(path, "proof"), []byte("proof"), 0600); err != nil {
					return err
				}
				if err = os.Remove(filepath.Join(path, "proof")); err != nil {
					return err
				}
				if err = os.Remove(filepath.Join(path, "proof.sock")); err != nil {
					return err
				}
				return wantErr
			})
			if callbackErr {
				if err != wantErr {
					t.Fatalf("callback error = %v, want %v", err, wantErr)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if _, err = os.Lstat(path); !os.IsNotExist(err) {
				t.Fatalf("owned dir remains: %v", err)
			}
		})
	}
}

func TestOwnedDirectoryRefusesExisting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "task245-services")
	if err := os.Mkdir(path, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := acquireOwnedDirectory(path, uint32(os.Geteuid())); err == nil {
		t.Fatal("existing directory accepted")
	}
	if info, err := os.Lstat(path); err != nil || !info.IsDir() {
		t.Fatal("existing directory changed")
	}
}

func TestOwnedDirectoryReplacementAndNonempty(t *testing.T) {
	for _, replace := range []bool{true, false} {
		t.Run(map[bool]string{true: "replacement", false: "nonempty"}[replace], func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "task245-services")
			owner, err := acquireOwnedDirectory(path, uint32(os.Geteuid()))
			if err != nil {
				t.Fatal(err)
			}
			if replace {
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(path, 0755); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(filepath.Join(path, "unknown"), []byte("keep"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := owner.Close(); err == nil {
				t.Fatal("unsafe cleanup succeeded")
			}
			if replace {
				if info, err := os.Lstat(path); err != nil || !info.IsDir() {
					t.Fatal("replacement removed")
				}
			} else if _, err := os.Stat(filepath.Join(path, "unknown")); err != nil {
				t.Fatal("unknown content removed")
			}
		})
	}
}

func TestOwnedDirectoryRefusesOwnerOrModeChange(t *testing.T) {
	for _, mode := range []uint32{0700, 0777} {
		t.Run("mode", func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "task245-services")
			owner, err := acquireOwnedDirectory(path, uint32(os.Geteuid()))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(path, os.FileMode(mode)); err != nil {
				t.Fatal(err)
			}
			if err := owner.Close(); err == nil {
				t.Fatal("changed mode accepted")
			}
		})
	}
	if os.Geteuid() == 0 {
		path := filepath.Join(t.TempDir(), "task245-services")
		owner, err := acquireOwnedDirectory(path, 0)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(path, 1, -1); err != nil {
			t.Fatal(err)
		}
		if err := owner.Close(); err == nil {
			t.Fatal("changed owner accepted")
		}
	}
}
