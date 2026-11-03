//go:build task245lab && linux && amd64

package main

import (
	"fmt"
	"os"
	"strings"
	"syscall"
)

func main() {
	if os.Geteuid() != 0 { failLab() }
	if len(os.Args) != 1 { failLab() }
	path := "/lab/scenario"
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0444 { failLab() }
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != 0 || st.Nlink != 1 || st.Size < 1 || st.Size > 64 { failLab() }
	b, err := os.ReadFile(path)
	if err != nil || len(b) > 64 { failLab() }
	scenario := strings.TrimSpace(string(b))
	clear(b)
	if scenario == "positive" { if runStandaloneLab() != nil { failLab() }; return }
	if err := runNegativeLab(scenario); err != nil { _, _ = fmt.Fprintln(os.Stderr, "task245-conductor: " + err.Error()); failLab() }
}

func fail() { failLab() }

func failLab() { _, _ = fmt.Fprintln(os.Stderr, "synthetic lab unavailable"); os.Exit(1) }
