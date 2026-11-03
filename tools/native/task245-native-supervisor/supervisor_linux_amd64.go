//go:build linux && amd64

package main

import (
	"context"
	"errors"
	"os"
	"syscall"
	"time"
)

var domainExit245 = 80
var errSupervisor = errors.New("native supervisor rejected")
var errUnexpectedWriter245 = errors.New("unexpected writer custody")

func main() {
	var err error
	if len(os.Args) == 2 && os.Args[1] == "--task245-domain-worker" {
		err = domainWorkerMain()
	} else {
		err = run()
	}
	if err != nil {
		if len(os.Args) == 2 && os.Args[1] == "--task245-domain-worker" { os.Exit(domainExit245) }
		os.Exit(1)
	}
}

func run() error {
	labCheckpoint245(1)
	if len(os.Args) != 1 || len(os.Environ()) != 0 {
		return errSupervisor
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	keeper, err := openKeeper()
	if err != nil {
		return errSupervisor
	}
	defer keeper.close()
	stop := context.AfterFunc(ctx, keeper.close)
	defer stop()
	labCheckpoint245(2)
	return runIsolated(ctx, keeper)
}

func labCheckpoint245(code byte) {
	if code == 0 || code > 32 { return }
	cfg, err := trustedLaunchConfig()
	if err != nil || cfg.LabReceiptPath != "/var/lib/ssjack/synthetic/consumer-receipt" { return }
	var root, marker syscall.Stat_t
	if syscall.Lstat("/lab", &root) != nil || root.Mode&syscall.S_IFMT != syscall.S_IFDIR || root.Uid != 0 || root.Mode&0022 != 0 { return }
	if syscall.Lstat("/lab/disposable-profile", &marker) != nil || marker.Mode&syscall.S_IFMT != syscall.S_IFREG || marker.Uid != 0 || marker.Nlink != 1 || marker.Mode&07777 != 0444 { return }
	fd, err := syscall.Open("/var/lib/ssjack/synthetic", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil { return }
	defer syscall.Close(fd)
	var dir syscall.Stat_t
	if syscall.Fstat(fd, &dir) != nil || dir.Uid != uint32(os.Geteuid()) || dir.Mode&07777 != 0700 { return }
	out, err := syscall.Openat(fd, "native-checkpoints", syscall.O_WRONLY|syscall.O_APPEND|syscall.O_CREAT|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0600)
	if err != nil { return }
	defer syscall.Close(out)
	var st syscall.Stat_t
	if syscall.Fstat(out, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Uid != uint32(os.Geteuid()) || st.Nlink != 1 || st.Mode&07777 != 0600 || st.Size < 0 || st.Size >= 128 { return }
	_, _ = syscall.Write(out, []byte{code})
}
