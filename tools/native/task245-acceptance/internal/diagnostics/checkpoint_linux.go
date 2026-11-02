//go:build linux

package diagnostics

import (
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

const checkpointAbsent = "task245-profile: checkpoints=absent"
const startupFailurePath = "/var/lib/ssjack/synthetic/native-startup-failure"

var startupStages = [...]string{"context", "node", "stub", "provider", "packet", "gate_pipe", "args_pipe", "fork", "tracker", "args_write", "args_close", "gate_write", "gate_close", "tracker_context", "tracker_guard", "tracker_identity", "tracker_tasks", "tracker_seize", "tracker_interrupt", "tracker_wait", "tracker_recheck", "tracker_resume"}

func StartupFailure() string {
	return startupFailureFile(startupFailurePath)
}

func startupFailureFile(path string) string {
	parent, name := filepath.Split(path)
	if parent == "" || name != "native-startup-failure" {
		return ""
	}
	dfd, err := syscall.Open(strings.TrimSuffix(parent, "/"), syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return ""
	}
	defer syscall.Close(dfd)

	var dir syscall.Stat_t
	if syscall.Fstat(dfd, &dir) != nil || dir.Mode&syscall.S_IFMT != syscall.S_IFDIR || dir.Uid != 65534 || dir.Nlink == 0 || dir.Mode&07777 != 0700 {
		return ""
	}
	fd, err := syscall.Openat(dfd, name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return ""
	}
	f := os.NewFile(uintptr(fd), name)
	if f == nil {
		_ = syscall.Close(fd)
		return ""
	}
	defer f.Close()

	var before syscall.Stat_t
	if syscall.Fstat(fd, &before) != nil || before.Mode&syscall.S_IFMT != syscall.S_IFREG || before.Uid != 65534 || before.Mode&07777 != 0600 || before.Nlink != 1 || before.Size != 12 {
		return ""
	}
	data, err := io.ReadAll(io.LimitReader(f, 13))
	var after syscall.Stat_t
	if err != nil || len(data) != 12 || syscall.Fstat(fd, &after) != nil || !sameCheckpointStat(&before, &after) {
		return ""
	}
	if string(data[:8]) != "OCSF0001" {
		return ""
	}
	stage, errno := int(data[8])<<8|int(data[9]), int(data[10])<<8|int(data[11])
	if stage < 1 || stage > len(startupStages) || errno > 4095 {
		return ""
	}
	line := "task245-worker: startup=" + startupStages[stage-1] + " errno=" + strconv.Itoa(errno) + "\n"
	records := Records("worker", []byte(line))
	if len(records) != 1 {
		return ""
	}
	return records[0]
}

func ReportLabFailure(w io.Writer, failed bool, checkpoint string, broker, metadata []byte, event string, exit int) error {
	if !failed {
		return nil
	}
	return reportFailure(w, failed, checkpoint, broker, metadata, event, exit, StartupFailure())
}

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
