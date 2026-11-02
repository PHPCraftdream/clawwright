//go:build linux && amd64

package main

import (
	"fmt"
	"os"
	"errors"
	"syscall"

	"clawforge/tools/native/task240-native/task245-control-profile/internal/metadata"
)

func canceledFailure(err error) {
	stage := "unknown"
	switch metadata.FailureStage(err) {
	case "peer_credential", "peer_start", "peer_identity", "root_open", "registration", "listener_probe", "notifier_loop":
		stage = metadata.FailureStage(err)
	}
	var errno syscall.Errno
	n := 0
	if errors.As(err, &errno) && errno <= 4095 {
		n = int(errno)
	}
	fmt.Fprintf(os.Stderr, "metadata-regression: stage=daemon_%s class=error errno=%d exit=0 signal=0\n", stage, n)
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "metadata-daemon: invalid arguments")
		os.Exit(2)
	}

	switch os.Args[1] {
	case "--disposable-lab":
		if err := metadata.Serve(); err != nil {
			fmt.Fprintln(os.Stderr, "metadata-daemon:", err)
			os.Exit(1)
		}
	case "--owning-regression-daemon-write":
		if err := metadata.ServeACKRegression("write"); err != nil {
			fmt.Fprintln(os.Stderr, "metadata-daemon:", err)
			os.Exit(1)
		}
	case "--owning-regression-daemon-lifetime":
		if err := metadata.ServeLifetimeRegression(); err != nil {
			fmt.Fprintln(os.Stderr, "metadata-daemon:", err)
			os.Exit(1)
		}
	case "--owning-regression-daemon-canceled":
		if err := metadata.ServeCanceledRegression(); err != nil {
			canceledFailure(err)
			os.Exit(1)
		}
	case "--owning-regression-daemon-fsync":
		if err := metadata.ServeACKRegression("fsync"); err != nil {
			fmt.Fprintln(os.Stderr, "metadata-daemon:", err)
			os.Exit(1)
		}
	case "--owning-regression-daemon-close":
		if err := metadata.ServeACKRegression("close"); err != nil {
			fmt.Fprintln(os.Stderr, "metadata-daemon:", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "metadata-daemon: invalid arguments")
		os.Exit(2)
	}
}
