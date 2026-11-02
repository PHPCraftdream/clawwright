//go:build linux && amd64

package main

import (
	"errors"
	"os"
	"syscall"
)

// ownedDirectory retains an open, no-follow descriptor for the exact directory
// created by this process. The descriptor anchors cleanup identity checks.
type ownedDirectory struct {
	path string
	file *os.File
	dev  uint64
	ino  uint64
	uid  uint32
}

func acquireOwnedDirectory(path string, expectedUID uint32) (*ownedDirectory, error) {
	if err := os.Mkdir(path, 0755); err != nil {
		return nil, errors.New("owned fixture directory must be absent")
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("owned fixture directory open failed")
	}
	f := os.NewFile(uintptr(fd), path)
	var st syscall.Stat_t
	if err = syscall.Fstat(fd, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Uid != expectedUID || st.Mode&07777 != 0755 {
		_ = f.Close()
		return nil, errors.New("owned fixture directory unsafe")
	}
	info, lerr := os.Lstat(path)
	lst, ok := (*syscall.Stat_t)(nil), false
	if lerr == nil {
		lst, ok = info.Sys().(*syscall.Stat_t)
	}
	if lerr != nil || !ok || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || lst.Dev != st.Dev || lst.Ino != st.Ino || lst.Uid != expectedUID || lst.Mode&07777 != 0755 {
		_ = f.Close()
		return nil, errors.New("owned fixture directory identity mismatch")
	}
	return &ownedDirectory{path: path, file: f, dev: uint64(st.Dev), ino: st.Ino, uid: expectedUID}, nil
}

func (o *ownedDirectory) Close() error {
	if o == nil || o.file == nil {
		return nil
	}
	info, err := os.Lstat(o.path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0755 {
		_ = o.file.Close()
		o.file = nil
		return errors.New("owned fixture directory changed")
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || uint64(st.Dev) != o.dev || st.Ino != o.ino || st.Uid != o.uid || st.Mode&07777 != 0755 {
		_ = o.file.Close()
		o.file = nil
		return errors.New("owned fixture directory changed")
	}
	if err = os.Remove(o.path); err != nil {
		_ = o.file.Close()
		o.file = nil
		return errors.New("owned fixture directory cleanup failed")
	}
	closeErr := o.file.Close()
	o.file = nil
	if closeErr != nil {
		return errors.New("owned fixture directory close failed")
	}
	return nil
}

func (o *ownedDirectory) run(callback func() error) error {
	callbackErr := callback()
	if cleanupErr := o.Close(); cleanupErr != nil {
		return cleanupErr
	}
	return callbackErr
}

func ownedProfileFixture() (*ownedDirectory, error) {
	if os.Geteuid() != 0 {
		return nil, errors.New("profile fixture requires root")
	}
	for _, path := range []string{"/run/task245-metadata.sock", "/run/task245-lab"} {
		if _, err := os.Lstat(path); err == nil || !errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("profile fixture must be fresh")
		}
	}
	for _, parent := range []string{"/", "/run"} {
		info, err := os.Lstat(parent)
		st, ok := (*syscall.Stat_t)(nil), false
		if err == nil {
			st, ok = info.Sys().(*syscall.Stat_t)
		}
		if err != nil || !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || st.Uid != 0 || st.Mode&0022 != 0 {
			return nil, errors.New("profile fixture parent unsafe")
		}
	}
	return acquireOwnedDirectory("/run/task245-services", 0)
}
