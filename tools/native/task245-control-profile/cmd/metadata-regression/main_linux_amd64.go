//go:build linux && amd64

package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"clawforge/tools/native/task240-native/task245-control-profile/internal/regression"
)

func main() {
	args := os.Args[1:]
	if len(args) == 1 && args[0] == "--initial-identity-child" {
		if err := regression.InitialIdentityChild(false); err != nil {
			runtimeError("metadata initial identity child", err)
		}
		return
	}
	if len(args) == 1 && args[0] == "--initial-identity-exec" {
		if err := regression.InitialIdentityChild(true); err != nil {
			runtimeError("metadata initial identity exec", err)
		}
		return
	}
	if len(args) == 1 && args[0] == "--proof-readiness-child" {
		if err := regression.ProofReadinessChild(); err != nil {
			runtimeError("metadata proof readiness child", err)
		}
		return
	}
	if len(args) == 0 {
		if err := regression.RunACKRegression(); err != nil {
			runtimeError("metadata cancel-ack regression", err)
		}
		fmt.Println("metadata cancel-ack regression: PASS")
		return
	}

	if len(args) == 2 && args[0] == "kernel-lifetime" && args[1] == "cancel" {
		if err := regression.KernelLifetimeClient(); err != nil {
			runtimeError("metadata kernel lifetime client", err)
		}
		return
	}
	if len(args) == 2 && ((args[0] == "kernel-active" && args[1] == "cancel") || (args[0] == "kernel-inactive" && (args[1] == "cancel" || args[1] == "withheld"))) {
		if err := regression.KernelClient(args[0] == "kernel-active"); err != nil {
			runtimeError("metadata kernel client", err)
		}
		return
	}
	if len(args) == 2 && strings.HasPrefix(args[0], "kernel-refusal-") && args[1] == "cancel" {
		kind := strings.TrimPrefix(args[0], "kernel-refusal-")
		switch kind { case "badreceipt", "wrongfault", "receiptfifo": default: fail("invalid kernel refusal kind") }
		if err := regression.KernelRefusalClient(kind); err != nil { runtimeError("metadata kernel refusal client", err) }
		return
	}

	if len(args) == 2 && strings.HasPrefix(args[0], "kernel-fault-") && args[1] == "cancel" {
		phase := strings.TrimPrefix(args[0], "kernel-fault-")
		switch phase {
		case "write", "fsync", "close":
		default:
			fail("invalid kernel fault phase")
		}
		if err := regression.KernelFaultClient(phase); err != nil {
			runtimeError("metadata kernel fault client", err)
		}
		return
	}
	if len(args) == 2 && (args[0] == "--notifier-same-image-child" || args[0] == "--notifier-same-pid-exec") {
		pid, err := strconv.Atoi(args[1])
		if err != nil {
			fail("invalid expected PID")
		}
		if pid <= 1 {
			fail("invalid expected PID")
		}
		if args[0] == "--notifier-same-image-child" {
			if err := regression.SameImageChild(pid); err != nil {
				runtimeError("metadata same-image child", err)
			}
		} else {
			if err := regression.SamePIDExecClient(pid); err != nil {
				runtimeError("metadata same-pid exec", err)
			}
		}
		return
	}
	if len(args) != 1 {
		fail("invalid arguments")
	}

	switch args[0] {
	case "--initial-identity-suite":
		if err := regression.RunInitialIdentityRegression(); err != nil {
			runtimeError("metadata initial identity regression", err)
		}
		fmt.Println("metadata initial identity regression: PASS")
	case "--owned-cleanup-refusal":
		if err := regression.RunOwnedCleanupRefusal(); err != nil {
			runtimeError("metadata owned cleanup refusal", err)
		}
		fmt.Println("metadata owned cleanup refusal: PASS")
	case "--owned-cleanup-child":
		if err := regression.OwnedCleanupChild(); err != nil {
			runtimeError("metadata owned cleanup child", err)
		}
	case "--lifetime-handoff":
		if err := regression.LifetimeHandoffClient(); err != nil {
			runtimeError("metadata lifetime handoff client", err)
		}
	case "--notifier-exec":
		if err := regression.KernelExecClient(); err != nil {
			runtimeError("metadata notifier exec", err)
		}
		fmt.Print("metadata notifier exec: PASS\n")
	case "--confinement-suite":
		if err := regression.RunConfinementSuite(); err != nil {
			runtimeError("metadata confinement suite", err)
		}
		fmt.Print("metadata confinement suite: PASS\n")
	case "--kernel-suite":
		if err := regression.RunKernelSuite(); err != nil {
			runtimeError("metadata component kernel suite", err)
		}
		fmt.Print("metadata component kernel suite: PASS\n")
	case "--kernel-driver":
		ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
		defer cancel()
		if err := regression.RunKernelDriver(ctx); err != nil {
			runtimeError("metadata kernel driver", err)
		}
	case "--notifier-inactive":
		if err := regression.RunNotifierPreflight(false); err != nil {
			runtimeError("metadata notifier inactive", err)
		}
		fmt.Println("metadata notifier inactive: PASS")
	case "--notifier":
		if err := regression.RunNotifierPreflight(true); err != nil {
			runtimeError("metadata notifier regression", err)
		}
		fmt.Println("metadata notifier regression: PASS")
	case "--service-peer":
		if err := regression.RunServicePeer(); err != nil {
			runtimeError("metadata service peer", err)
		}
	case "--service-peer-child":
		if err := regression.ServicePeerChild(); err != nil {
			runtimeError("metadata service peer child", err)
		}
	default:
		fail("unknown regression mode")
	}
}

func runtimeError(context string, err error) {
	stage := "unknown"
	switch context {
	case "metadata cancel-ack regression":
		stage = "suite_ack"
	case "metadata owned cleanup refusal":
		stage = "suite_driver"
	case "metadata kernel driver", "metadata component kernel suite", "metadata confinement suite":
		stage = "suite_driver"
	}
	regression.ReportFailure(stage, err)
	os.Exit(1)
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, "metadata-regression:", message)
	os.Exit(2)
}
