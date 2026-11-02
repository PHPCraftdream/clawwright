package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

type Command struct {
	Path  string
	Args  []string
	Dir   string
	Env   []string
	Stdin []byte
	Limit int
}

type Result struct {
	Code          int
	Stdout, Stderr []byte
}

type Executor interface {
	Run(context.Context, Command) (Result, error)
}

type OSExecutor struct{}

func (OSExecutor) Run(ctx context.Context, c Command) (Result, error) {
	cmd := exec.CommandContext(ctx, c.Path, c.Args...)
	cmd.WaitDelay = 2 * time.Second
	cmd.Dir = c.Dir
	cmd.Env = c.Env
	var out, stderr limitedBuffer
	out.limit = c.Limit
	stderr.limit = c.Limit
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if c.Stdin != nil {
		cmd.Stdin = strings.NewReader(string(c.Stdin))
	}
	err := cmd.Run()
	code := 0
	if err != nil {
		if x, ok := err.(*exec.ExitError); ok {
			code = x.ExitCode()
		} else {
			return Result{Code: -1}, err
		}
	}
	if out.over || stderr.over {
		return Result{Code: code}, fmt.Errorf("bounded command output exceeded")
	}
	return Result{Code: code, Stdout: out.data, Stderr: stderr.data}, nil
}

type limitedBuffer struct {
	data  []byte
	limit int
	over  bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.limit <= 0 {
		b.limit = 1 << 20
	}
	if len(b.data)+len(p) > b.limit {
		b.over = true
		return len(p), nil
	}
	b.data = append(b.data, p...)
	return len(p), nil
}

func run(ex Executor, phase string, cmd Command) (Result, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	r, e := ex.Run(ctx, cmd)
	if e != nil || r.Code != 0 {
		return r, &Failure{Phase: phase, Exit: r.Code}
	}
	return r, nil
}

func gitRevision(ex Executor, product string, env []string) (string, error) {
	r, e := run(ex, "provenance", Command{Path: "git", Args: []string{"rev-parse", "HEAD"}, Dir: product, Env: env, Limit: 128})
	if e != nil || strings.TrimSpace(string(r.Stdout)) != ProductCommit {
		return "", fail("provenance")
	}
	s, e := run(ex, "provenance", Command{Path: "git", Args: []string{"status", "--porcelain=v1", "--untracked-files=all"}, Dir: product, Env: env, Limit: 4096})
	if e != nil || len(s.Stdout) != 0 {
		return "", fail("provenance")
	}
	return strings.TrimSpace(string(r.Stdout)), nil
}

func DockerInspect(host []byte) (map[string]any, error) {
	var rows []map[string]any
	if err := json.Unmarshal(host, &rows); err != nil || len(rows) != 1 {
		return nil, fmt.Errorf("invalid inspect")
	}
	v, ok := rows[0]["HostConfig"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("missing host config")
	}
	return v, nil
}
