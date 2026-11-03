package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"clawforge/tools/native/task240-native/task245-acceptance/internal/diagnostics"
)

func containerRun(ex Executor, parent, stage string, e Env, scenario string) (string, []byte, error) {
	image := Image
	name := fmt.Sprintf("task245-acceptance-%s-%d", e.Get("GITHUB_RUN_ID"), os.Getpid())
	created := false
	defer func() {
		if created {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_, _ = ex.Run(ctx, Command{Path: "docker", Args: []string{"rm", "-f", name}, Limit: 4096})
		}
	}()
	if _, err := run(ex, "container-image", Command{Path: "docker", Args: []string{"pull", image}, Limit: 1 << 20}); err != nil {
		return "", nil, err
	}
	envs := []string{"PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "GITHUB_ACTIONS=true", "GITHUB_SHA=" + e.Get("GITHUB_SHA"), "GITHUB_RUN_ID=" + e.Get("GITHUB_RUN_ID")}
	args := []string{"create", "--name", name, "--network=none", "--cap-drop=ALL"}
	for _, cap := range []string{"CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID", "SYS_ADMIN", "SYS_CHROOT", "SYS_PTRACE"} {
		args = append(args, "--cap-add="+cap)
	}
	args = append(args, "--security-opt=no-new-privileges", "--security-opt=apparmor=unconfined", "--pids-limit=256", "--memory=4g", "--memory-swap=4g", "--ulimit", "core=0", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m")
	for _, v := range envs {
		args = append(args, "--env", v)
	}
	args = append(args, "--entrypoint", "/usr/bin/env", image, "-i")
	args = append(args, envs...)
	args = append(args, "/lab/profile")
	if scenario == "confinement" {
		args = append(args, "--confinement")
	} else if scenario != "connected" {
		args = append(args, "--scenario", scenario)
	}
	if _, err := run(ex, "container-create", Command{Path: "docker", Args: args, Limit: 1 << 20}); err != nil {
		return "", nil, err
	}
	created = true
	tarData, err := BuildArchive(stage)
	if err != nil {
		return "", nil, fail("stage-container")
	}
	if _, err = run(ex, "stage-container", Command{Path: "docker", Args: []string{"cp", "-", name + ":/"}, Stdin: tarData, Limit: 1 << 20}); err != nil {
		return "", nil, err
	}
	ins, err := run(ex, "inspect-policy", Command{Path: "docker", Args: []string{"inspect", name}, Limit: 1 << 20})
	if err != nil {
		return "", nil, err
	}
	host, err := DockerInspect(ins.Stdout)
	if err != nil || !dockerPolicy(host) {
		return "", nil, fail("inspect-policy")
	}
	started, startErr := run(ex, "application", Command{Path: "docker", Args: []string{"start", "-a", "-i", name}, Limit: 16384})
	state, stateErr := run(ex, "application", Command{Path: "docker", Args: []string{"inspect", name}, Limit: 1 << 20})
	return applicationResult(started, startErr, state, stateErr, os.Stderr)
}

func applicationResult(started Result, startErr error, state Result, stateErr error, w io.Writer) (string, []byte, error) {
	var rows []struct {
		Image string `json:"Image"`
		State struct {
			ExitCode *int `json:"ExitCode"`
		} `json:"State"`
	}
	exit := -1
	validState := false
	if stateErr == nil && state.Code == 0 && len(state.Stderr) == 0 && len(state.Stdout) <= 1<<20 && json.Unmarshal(state.Stdout, &rows) == nil && len(rows) == 1 && rows[0].Image != "" && rows[0].State.ExitCode != nil && *rows[0].State.ExitCode >= 0 && *rows[0].State.ExitCode <= 255 {
		exit = *rows[0].State.ExitCode
		validState = true
	}
	if startErr != nil || started.Code != 0 || len(started.Stderr) != 0 || len(started.Stdout) > 16384 || !validState || exit != 0 || !json.Valid(started.Stdout) || strings.TrimSpace(string(started.Stdout)) == "" {
		commandExit := started.Code
		if commandExit < -1 || commandExit > 255 {
			commandExit = -1
		}
		_ = diagnostics.ContainerFailure(w, true, commandExit, exit, started.Stderr)
		return "", nil, fail("application")
	}
	return rows[0].Image, started.Stdout, nil
}
