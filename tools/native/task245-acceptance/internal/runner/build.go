package runner

import (
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var goEnvNames = []string{"PATH", "HOME", "GOPROXY", "GOSUMDB", "GOTOOLCHAIN", "CGO_ENABLED", "GOMODCACHE", "GOCACHE"}

func sanitizedEnv(src Env, additions map[string]string) []string {
	merged := make(map[string]string, len(goEnvNames)+len(additions))
	for _, k := range goEnvNames {
		if v := src[k]; v != "" {
			merged[k] = v
		}
	}
	for k, v := range additions {
		merged[k] = v
	}
	keys := make([]string, 0, len(merged))
	for k := range merged {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+merged[k])
	}
	return out
}

func buildGo(ex Executor, phase, root, cache, output, pkg string, src Env, product bool, overlay string) error {
	proxy := src["GOPROXY"]
	if proxy == "" {
		proxy = "https://proxy.golang.org,direct"
	}
	additions := map[string]string{
		"GOTOOLCHAIN": "local",
		"CGO_ENABLED": "0",
		"GOMODCACHE":  filepath.Join(cache, "gomodcache"),
		"GOCACHE":     filepath.Join(cache, "gocache"),
	}
	if product {
		additions["GOPROXY"] = proxy
	} else {
		additions["GOPROXY"] = "off"
	}
	e := sanitizedEnv(src, additions)
	args := []string{"build"}
	if overlay != "" {
		args = append(args, "-tags", "task245lab", "-overlay", overlay)
	}
	args = append(args, "-mod=readonly", "-trimpath", "-buildmode=exe")
	if product && pkg == "./cmd/ssjack" {
		args = append(args, "-ldflags", "-X github.com/PHPCraftdream/ssjack/internal/buildinfo.Commit="+ProductCommit)
	}
	args = append(args, "-o", output, pkg)
	_, err := run(ex, phase, Command{Path: "go", Args: args, Dir: root, Env: e, Limit: 1 << 20})
	if err != nil {
		return err
	}
	return os.Chmod(output, 0755)
}

func compileRust(ex Executor, phase, source, output string) (error) {
	_, e := run(ex, phase, Command{
		Path: "rustc",
		Args: []string{"--edition=2021", "--target=x86_64-unknown-linux-gnu", "-C", "opt-level=2", "-C", "panic=abort", "-C", "target-feature=+crt-static", "-o", output, source},
		Limit: 1 << 20,
	})
	if e == nil {
		mode := os.FileMode(0755)
		if strings.HasSuffix(output, "control-installer") {
			mode = 0555
		}
		e = os.Chmod(output, mode)
	}
	return e
}

func dockerPolicy(host map[string]any) bool {
	if host["Privileged"] != false || host["Binds"] != nil && lenAny(host["Binds"]) != 0 || host["Mounts"] != nil && lenAny(host["Mounts"]) != 0 || host["NetworkMode"] != "none" || host["PidMode"] != "" {
		return false
	}
	if !equalStrings(host["CapDrop"], []string{"ALL"}) || !equalSet(host["CapAdd"], []string{"CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_SETGID", "CAP_SETUID", "CAP_KILL", "CAP_SYS_ADMIN", "CAP_SYS_PTRACE", "CAP_SYS_CHROOT"}) || !equalSet(host["SecurityOpt"], []string{"no-new-privileges", "apparmor=unconfined"}) {
		return false
	}
	mem, mok := number(host["Memory"])
	swap, sok := number(host["MemorySwap"])
	pids, pok := number(host["PidsLimit"])
	if !mok || !sok || !pok || mem != 4<<30 || swap != mem || pids != 256 {
		return false
	}
	ulimits, ok := host["Ulimits"].([]any)
	if !ok || len(ulimits) != 1 {
		return false
	}
	u, ok := ulimits[0].(map[string]any)
	if !ok || u["Name"] != "core" {
		return false
	}
	soft, sok := number(u["Soft"])
	hard, hok := number(u["Hard"])
	if !sok || !hok || soft != 0 || hard != 0 {
		return false
	}
	tmpfs, ok := host["Tmpfs"].(map[string]any)
	if !ok || len(tmpfs) != 1 || tmpfs["/tmp"] != "rw,nosuid,nodev,noexec,size=256m" {
		return false
	}
	return true
}

func lenAny(v any) int {
	if a, ok := v.([]any); ok {
		return len(a)
	}
	if a, ok := v.([]string); ok {
		return len(a)
	}
	return 1
}

func number(v any) (int64, bool) {
	n, ok := v.(float64)
	return int64(n), ok && n == float64(int64(n))
}

func equalStrings(v any, want []string) bool {
	a, ok := stringSlice(v)
	if !ok || len(a) != len(want) {
		return false
	}
	for i := range a {
		if a[i] != want[i] {
			return false
		}
	}
	return true
}

func equalSet(v any, want []string) bool {
	a, ok := stringSlice(v)
	if !ok || len(a) != len(want) {
		return false
	}
	m := map[string]bool{}
	for _, s := range a {
		m[s] = true
	}
	for _, s := range want {
		if !m[s] {
			return false
		}
	}
	return true
}

func stringSlice(v any) ([]string, bool) {
	switch a := v.(type) {
	case []string:
		return a, true
	case []any:
		r := make([]string, 0, len(a))
		for _, x := range a {
			s, ok := x.(string)
			if !ok {
				return nil, false
			}
			r = append(r, s)
		}
		return r, true
	}
	return nil, false
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, e := os.Open(src)
	if e != nil {
		return e
	}
	defer in.Close()
	out, e := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if e != nil {
		return e
	}
	_, e = io.Copy(out, in)
	ce := out.Close()
	if e == nil {
		e = ce
	}
	if e == nil {
		e = os.Chmod(dst, mode)
	}
	return e
}
