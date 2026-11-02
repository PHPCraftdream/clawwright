//go:build linux && amd64

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"time"

	"clawforge/tools/native/task240-native/task245-acceptance/internal/diagnostics"
	"clawforge/tools/native/task240-native/task245-acceptance/internal/service"
)

func runCeremony(scenario, supervisor, keeper, broker string) (result error) {
	if _, err := os.Lstat("/var/lib/ssjack/synthetic/native-startup-failure"); err == nil || !errors.Is(err, os.ErrNotExist) {
		return errors.New("startup diagnostic must be fresh")
	}
	var child, meta *service.Child
	event, exit := "evidence", -1
	cleaned := false
	cleanup := func() error {
		if cleaned {
			return nil
		}
		cleaned = true
		var first error
		stopped := map[string]bool{"metadata": meta == nil, "broker": child == nil}
		for _, item := range []struct {
			role    string
			process *service.Child
		}{{"metadata", meta}, {"broker", child}} {
			if item.process == nil {
				continue
			}
			stopCtx, stopCancel := context.WithTimeout(context.Background(), 2*time.Second)
			err := item.process.Stop(stopCtx)
			stopCancel()
			if err != nil {
				if first == nil {
					first = errors.New("lab service stop failed")
				}
			} else {
				stopped[item.role] = true
			}
		}
		if stopped["metadata"] {
			if err := service.Remove("metadata"); err != nil && first == nil {
				first = errors.New("metadata attestation removal failed")
			}
		}
		if stopped["broker"] {
			if err := service.Remove("broker"); err != nil && first == nil {
				first = errors.New("broker attestation removal failed")
			}
		}
		return first
	}
	fail := func(err error) error {
		cleanupErr := cleanup()
		reportErr := diagnostics.ReportLabFailure(os.Stderr, true, diagnostics.Checkpoints(), child.DiagnosticBytes(), meta.DiagnosticBytes(), event, exit)
		if cleanupErr != nil {
			return cleanupErr
		}
		if reportErr != nil {
			return errors.New("failure diagnostic output failed")
		}
		return err
	}

	var err error
	child, err = service.StartDaemon([]string{}, broker, "--disposable-lab")
	if err != nil {
		return fail(errors.New("lab broker start failed"))
	}
	ready, readyCancel := context.WithTimeout(context.Background(), 2*time.Second)
	err = service.WaitReady(ready, child, "/run/task245-lab/broker.sock")
	readyCancel()
	if err != nil {
		return fail(errors.New("lab broker readiness failed"))
	}
	if err = service.Attest(child, "/lab/bin/native-lab-broker", "/run/task245-lab/broker.sock", "broker"); err != nil {
		return fail(errors.New("lab broker attestation failed"))
	}
	if scenario != "" {
		var startErr error
		meta, startErr = service.StartDaemon([]string{}, "/lab/bin/native-metadata", "--disposable-lab")
		if startErr != nil {
			return fail(errors.New("metadata start failed"))
		}
		mctx, mcancel := context.WithTimeout(context.Background(), 2*time.Second)
		startErr = service.WaitReady(mctx, meta, "/run/task245-metadata.sock")
		mcancel()
		if startErr != nil {
			return fail(errors.New("metadata readiness failed"))
		}
		if startErr = service.Attest(meta, "/lab/bin/native-metadata", "/run/task245-metadata.sock", "metadata"); startErr != nil {
			return fail(errors.New("metadata attestation failed"))
		}
	}

	stdout, stderr, err := command(lab+"/conductor", nil, []string{"PATH=/usr/local/bin:/usr/bin:/bin", "GITHUB_SHA=" + os.Getenv("GITHUB_SHA"), "GITHUB_RUN_ID=" + os.Getenv("GITHUB_RUN_ID")}, 600*time.Second, false)
	if err != nil {
		event = "command_failed"
		if exitErr := new(exec.ExitError); errors.As(err, &exitErr) {
			code := exitErr.ExitCode()
			if code >= 0 && code <= 255 {
				exit = code
			}
		}
		return fail(errors.New("ordinary conductor acceptance failed"))
	}
	if len(stderr) != 0 {
		event, exit = "stderr", 0
		return fail(errors.New("ordinary conductor acceptance failed"))
	}
	if len(stdout) == 0 || len(stdout) > 16384 || bytes.Count(stdout, []byte{'\n'}) != 1 || stdout[len(stdout)-1] != '\n' {
		return fail(errors.New("conductor output not a single JSON record"))
	}
	dec := json.NewDecoder(bytes.NewReader(stdout))
	var data map[string]any
	if err = dec.Decode(&data); err != nil {
		return fail(errors.New("conductor JSON invalid"))
	}
	var extra any
	if err = dec.Decode(&extra); err != io.EOF {
		return fail(errors.New("conductor JSON has extra data"))
	}
	keys := func(want ...string) bool {
		if len(data) != len(want) {
			return false
		}
		for _, key := range want {
			if _, ok := data[key]; !ok {
				return false
			}
		}
		return true
	}
	if scenario != "" {
		outcome := "UNKNOWN"
		if scenario == "wrong-holder" || scenario == "unexpected-exec" {
			outcome = "WITHHELD"
		}
		if !keys("result", "scenario", "expected_outcome") || data["result"] != "task245-negative-complete" || data["scenario"] != scenario || data["expected_outcome"] != outcome {
			return fail(errors.New("unexpected negative evidence"))
		}
	} else {
		if !keys("result", "product_base", "source_revision", "run_id", "binary_sha256") || data["result"] != "synthetic-delivery-complete" || data["product_base"] != productBase || data["source_revision"] != os.Getenv("GITHUB_SHA") || data["run_id"] != os.Getenv("GITHUB_RUN_ID") {
			return fail(errors.New("unexpected product evidence"))
		}
		hashes, ok := data["binary_sha256"].(map[string]any)
		if !ok || len(hashes) != 5 {
			return fail(errors.New("unexpected binary hash evidence"))
		}
		for name, path := range map[string]string{
			"ssjack":   lab + "/ssjack",
			"harness":  lab + "/harness",
			"driver":   lab + "/driver",
			"consumer": lab + "/consumer",
			"conductor": lab + "/conductor",
		} {
			want, hashErr := hash(path)
			if hashErr != nil || hashes[name] != want {
				return fail(errors.New("staged binary hash mismatch"))
			}
		}
	}
	if err = cleanup(); err != nil {
		return fail(err)
	}

	wrappers := map[string]any{
		"mechanism_only": true,
		"adoption":      false,
		"product_base":  productBase,
		"binary_sha256": map[string]string{},
		"conductor":     data,
	}
	for name, path := range map[string]string{"consumer": supervisor, "keeper": keeper, "broker": broker} {
		h, hashErr := hash(path)
		if hashErr != nil {
			return errors.New("wrapper binary hash failed")
		}
		wrappers["binary_sha256"].(map[string]string)[name] = h
	}
	if scenario != "" {
		wrappers["status"], wrappers["scenario"] = "task245-negative-complete", scenario
	} else {
		wrappers["status"] = "task245-connected-lab-complete"
	}
	if err = line(wrappers); err != nil {
		return errors.New("result output failed")
	}
	return nil
}
