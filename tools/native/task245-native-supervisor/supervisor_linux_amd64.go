//go:build linux && amd64

package main

import (
	"context"
	"errors"
	"os"
	"time"
)

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
		os.Exit(1)
	}
}

func run() error {
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
	return runIsolated(ctx, keeper)
}
