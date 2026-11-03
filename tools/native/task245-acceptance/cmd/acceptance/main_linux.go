//go:build linux

package main

import (
	"fmt"
	"os"

	"clawforge/tools/native/task240-native/task245-acceptance/internal/runner"
)

func main() {
	if err := runner.Run(os.Args[1:], os.Environ()); err != nil {
		fmt.Fprintln(os.Stderr, runner.SafeError(err))
		os.Exit(1)
	}
}
