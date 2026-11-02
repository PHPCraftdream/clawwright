//go:build linux

package diagnostics

import (
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"
)

const checkpointAbsent = "task245-profile: checkpoints=absent"

func Checkpoints() string {
	return checkpointFile("/var/lib/ssjack/synthetic/native-checkpoints")
}

func checkpointFile(path string) string {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return checkpointAbsent
	}
	f := os.NewFile(uintptr(fd), path)
	if f == nil {
		_ = syscall.Close(fd)
		return checkpointAbsent
	}
	defer f.Close()

	var before syscall.Stat_t
	if err := syscall.Fstat(fd, &before); err != nil || !validCheckpointStat(&before) {
		return checkpointAbsent
	}

	data, err := io.ReadAll(io.LimitReader(f, 129))
	if err != nil || len(data) != int(before.Size) || len(data) < 1 || len(data) > 128 {
		return checkpointAbsent
	}
	for _, b := range data {
		if b < 1 || b > 32 {
			return checkpointAbsent
		}
	}

	var after syscall.Stat_t
	if err := syscall.Fstat(fd, &after); err != nil || !sameCheckpointStat(&before, &after) {
		return checkpointAbsent
	}

	start := 0
	if len(data) > 48 {
		start = len(data) - 48
	}
	parts := make([]string, 0, len(data)-start)
	for _, b := range data[start:] {
		parts = append(parts, strconv.Itoa(int(b)))
	}
	return "task245-profile: checkpoints=" + strings.Join(parts, "-")
}

func validCheckpointStat(st *syscall.Stat_t) bool {
	return st.Mode&syscall.S_IFMT == syscall.S_IFREG &&
		st.Uid == 65534 && st.Nlink == 1 && st.Mode&07777 == 0600 &&
		st.Size >= 1 && st.Size <= 128
}

func sameCheckpointStat(a, b *syscall.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Mode == b.Mode &&
		a.Uid == b.Uid && a.Gid == b.Gid && a.Nlink == b.Nlink &&
		a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}
