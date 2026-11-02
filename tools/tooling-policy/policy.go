package main

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

const baseline = "8eadbd4e8dcfac3d6e11fe5ee49525da5baa3482"

type inventory struct {
	mode string
	blob string
}

type report struct {
	Files      []string
	Debt       []string
	Violations []string
}

func check(root string) (report, error) {
	resolved, err := filepath.Abs(root)
	if err != nil {
		return report{}, err
	}
	topLevel, err := git(resolved, "rev-parse", "--show-toplevel")
	if err != nil {
		return report{}, fmt.Errorf("outside Git worktree (resolve repository root): %w", err)
	}
	root = strings.TrimSuffix(string(topLevel), "\n")
	root = strings.TrimSuffix(root, "\r")
	current, err := tracked(root)
	if err != nil {
		return report{}, fmt.Errorf("current index inventory: %w", err)
	}
	legacy, err := baselineInventory(root)
	if err != nil {
		return report{}, fmt.Errorf("baseline inventory: %w", err)
	}
	reader := func(item inventory) (int, error) {
		data, err := git(root, "cat-file", "blob", item.blob)
		if err != nil {
			return 0, err
		}
		return lineCount(data), nil
	}
	approved := approvedTask251(legacy)
	for path, blob := range approvedTask258(legacy, task258CurrentReceipts()) {
		approved[path] = blob
	}
	for path, blob := range approvedLicenseCallers(legacy) {
		approved[path] = blob
	}
	const runnerPath = "tools/native/task245-acceptance/run.py"
	if old, ok := legacy[runnerPath]; ok {
		oldBytes, err := git(root, "cat-file", "blob", old.blob)
		if err != nil {
			return report{}, fmt.Errorf("baseline runner blob: %w", err)
		}
		if transformed, err := approvedRunner(oldBytes); err == nil {
			approved[runnerPath] = gitBlobID(transformed)
		}
	}
	const profilePath = "tools/native/task245-acceptance/profile.py"
	if old, ok := legacy[profilePath]; ok {
		oldBytes, err := git(root, "cat-file", "blob", old.blob)
		if err != nil {
			return report{}, fmt.Errorf("baseline profile blob: %w", err)
		}
		if transformed, err := approvedControlProfile(oldBytes); err == nil {
			approved[profilePath] = gitBlobID(transformed)
		}
	}
	return evaluateWithTransitions(current, legacy, reader, approved), nil
}

const oldRunnerAnchor = `        for source, output in (("task245-domain-init/init.c","native-init"),("task240-launch-stub/stub.c","native-stub"),("task245-control-profile/control-profile.c","control-profile"),`
const rustRunnerBlock = `        for source, output in (("task245-domain-init/main.rs", "native-init"), ("task240-launch-stub/main.rs", "native-stub")):
            PHASE = "compile-" + output
            invoke(["rustc", "--edition=2021", "--target=x86_64-unknown-linux-gnu", "-C", "opt-level=2", "-C", "panic=abort", "-C", "target-feature=+crt-static", "-o", str(stage/output), str(NATIVE/source)])
            (stage/output).chmod(0o755)
        for source, output in (("task245-control-profile/control-profile.c","control-profile"),`

func approvedLicenseCallers(legacy map[string]inventory) map[string]string {
	transitions := map[string]struct{ old, next string }{
		"tools/checks/ci/ci-tiers.check.ts": {"dc8d01cc5ad57f2bd4bede88f2a18a2d6a6a325c", "1c339eac001b4d0cd5ccd86dba521c137ea43b2b"},
		"tools/checks/kit/selection/rules.ts": {"e24d463345f84ce455cded12efab52118aae0373", "e8549159c7e4f9e6bd29789c8a80839fd3bd12ec"},
	}
	approved := make(map[string]string)
	for path, transition := range transitions {
		if old, ok := legacy[path]; ok && old.blob == transition.old {
			approved[path] = transition.next
		}
	}
	return approved
}

func approvedRunner(b []byte) ([]byte, error) {
	transformed, err := approvedLaunchRunner(b)
	if err != nil {
		return nil, err
	}
	return approvedControlRunner(transformed)
}

func approvedLaunchRunner(b []byte) ([]byte, error) {
	if bytes.Count(b, []byte(oldRunnerAnchor)) != 1 {
		return nil, fmt.Errorf("runner anchor must occur exactly once")
	}
	return bytes.Replace(b, []byte(oldRunnerAnchor), []byte(rustRunnerBlock), 1), nil
}

func gitBlobID(data []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", len(data))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

func lineCount(data []byte) int {
	if len(data) == 0 {
		return 0
	}
	count := bytes.Count(data, []byte{'\n'})
	if data[len(data)-1] != '\n' {
		count++
	}
	return count
}

func git(root string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git %v: %w", args, err)
	}
	return out, nil
}

func parseRecords(data []byte, tree bool) (map[string]inventory, error) {
	items := make(map[string]inventory)
	if len(data) == 0 {
		return items, nil
	}
	if data[len(data)-1] != 0 {
		return nil, fmt.Errorf("truncated Git record stream")
	}
	for _, record := range bytes.Split(data[:len(data)-1], []byte{0}) {
		meta, name, ok := bytes.Cut(record, []byte{'\t'})
		fields := strings.Fields(string(meta))
		if !ok || len(fields) != 3 || len(name) == 0 {
			return nil, fmt.Errorf("malformed Git record %q", record)
		}
		mode := fields[0]
		oid := fields[1]
		if tree {
			if fields[1] != "blob" && fields[1] != "commit" && fields[1] != "tree" {
				return nil, fmt.Errorf("invalid tree object type %q", fields[1])
			}
			oid = fields[2]
			if mode != "100644" && mode != "100755" && mode != "120000" && mode != "040000" && mode != "160000" {
				return nil, fmt.Errorf("invalid tree mode %q", mode)
			}
			if mode == "040000" && fields[1] != "tree" {
				return nil, fmt.Errorf("invalid tree object type %q", fields[1])
			}
			if mode != "040000" && fields[1] == "tree" {
				return nil, fmt.Errorf("invalid tree object type %q", fields[1])
			}
		} else {
			if fields[2] != "0" {
				return nil, fmt.Errorf("unmerged index stage %q for %q", fields[2], name)
			}
			if mode != "100644" && mode != "100755" && mode != "120000" && mode != "160000" {
				return nil, fmt.Errorf("invalid index mode %q for %q", mode, name)
			}
		}
		if len(oid) != 40 && len(oid) != 64 {
			return nil, fmt.Errorf("invalid object id %q for %q", oid, name)
		}
		if _, err := hex.DecodeString(oid); err != nil {
			return nil, fmt.Errorf("invalid object id %q", oid)
		}
		if _, exists := items[string(name)]; exists {
			return nil, fmt.Errorf("duplicate path %q", name)
		}
		items[string(name)] = inventory{mode: mode, blob: oid}
	}
	return items, nil
}

func tracked(root string) (map[string]inventory, error) {
	data, err := git(root, "ls-files", "--full-name", "--stage", "-z", "--", "tools/")
	if err != nil {
		return nil, err
	}
	return parseRecords(data, false)
}

func baselineInventory(root string) (map[string]inventory, error) {
	data, err := git(root, "ls-tree", "-r", "-z", baseline)
	if err != nil {
		return nil, err
	}
	return parseRecords(data, true)
}

func classify(name string) string {
	base := pathBase(name)
	switch base {
	case "go.mod", "go.sum", "LICENSE", "LICENSE-APACHE", "LICENSE-MIT", "NOTICE", "THIRD_PARTY_NOTICES", ".env.example":
		return "metadata"
	}
	ext := strings.ToLower(pathExt(name))
	switch ext {
	case ".go", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".c", ".h", ".cc", ".cpp", ".hpp", ".py", ".rs", ".sh", ".ps1":
		return "implementation"
	case ".json", ".yaml", ".yml", ".toml", ".txt", ".md", ".xml", ".lock", ".sum", ".map":
		return "data"
	default:
		return "unknown"
	}
}

func pathBase(name string) string {
	i := strings.LastIndexByte(name, '/')
	return name[i+1:]
}

func pathExt(name string) string {
	base := pathBase(name)
	i := strings.LastIndexByte(base, '.')
	if i < 0 {
		return ""
	}
	return base[i:]
}

func approvedRustFallback(name string) bool {
	switch name {
	case "tools/native/task240-launch-stub/main.rs", "tools/native/task240-launch-stub/linux.rs", "tools/native/task240-launch-stub/packet.rs", "tools/native/task245-domain-init/main.rs", "tools/native/task245-control-profile/installer/main.rs", "tools/native/task245-control-profile/installer/linux.rs", "tools/native/task245-control-profile/installer/filters.rs":
		return true
	default:
		return false
	}
}

func evaluate(current, legacy map[string]inventory, lines func(inventory) (int, error)) report {
	return evaluateWithTransitions(current, legacy, lines, nil)
}

func evaluateWithTransitions(current, legacy map[string]inventory, lines func(inventory) (int, error), approved map[string]string) report {
	result := report{Files: make([]string, 0), Debt: make([]string, 0), Violations: make([]string, 0)}
	language := make(map[string]int)
	currentDirs := directoryEntries(current)
	legacyDirs := directoryEntries(legacy)
	paths := sortedKeys(current)
	for _, name := range paths {
		item := current[name]
		if !strings.HasPrefix(name, "tools/") {
			continue
		}
		if item.mode == "120000" || item.mode == "160000" {
			result.Violations = append(result.Violations, name+": symlink/submodule prohibited")
			continue
		}
		kind := classify(name)
		if kind == "unknown" {
			result.Violations = append(result.Violations, name+": unknown classification")
			continue
		}
		if kind == "implementation" {
			ext := strings.ToLower(pathExt(name))
			language[ext]++
			old, existed := legacy[name]
			transitionApproved := approved[name] != "" && approved[name] == item.blob
			if ext != ".go" && (!existed || old.blob != item.blob) && !(ext == ".rs" && approvedRustFallback(name)) && !transitionApproved {
				result.Violations = append(result.Violations, name+": implementation is new or changed from baseline")
			}
			count, err := lines(item)
			if err != nil {
				result.Violations = append(result.Violations, name+": unreadable blob: "+err.Error())
			} else if count > 700 {
				oldCount := 0
				if existed {
					oldCount, err = lines(old)
				}
				if !existed || err != nil || count > oldCount {
					result.Violations = append(result.Violations, fmt.Sprintf("%s: %d lines exceeds 700 (baseline %d)", name, count, oldCount))
				} else {
					result.Debt = append(result.Debt, fmt.Sprintf("%s: grandfathered line debt %d/700 (baseline %d)", name, count, oldCount))
				}
			}
			if ext != ".go" && existed && old.blob == item.blob {
				result.Debt = append(result.Debt, name+": non-Go implementation remains frozen")
			}
			if ext == ".rs" && approvedRustFallback(name) {
				result.Debt = append(result.Debt, name+": narrowly approved Rust fallback debt; not a general language allowance")
			}
		}
	}
	for _, ext := range sortedIntKeys(language) {
		result.Files = append(result.Files, fmt.Sprintf("inventory: %s implementation files=%d", ext, language[ext]))
	}
	for _, dir := range sortedKeys(currentDirs) {
		count := len(currentDirs[dir])
		if count <= 7 {
			continue
		}
		oldEntries := legacyDirs[dir]
		newChild := false
		for child := range currentDirs[dir] {
			if !oldEntries[child] {
				newChild = true
			}
		}
		if len(oldEntries) >= count && !newChild {
			result.Debt = append(result.Debt, fmt.Sprintf("%s: grandfathered immediate-entry debt %d/7", dir, count))
		} else {
			result.Violations = append(result.Violations, fmt.Sprintf("%s: %d immediate entries exceeds 7", dir, count))
		}
	}
	sort.Strings(result.Files)
	sort.Strings(result.Debt)
	sort.Strings(result.Violations)
	return result
}

func directoryEntries(items map[string]inventory) map[string]map[string]bool {
	entries := make(map[string]map[string]bool)
	for name := range items {
		if !strings.HasPrefix(name, "tools/") {
			continue
		}
		parent, child := splitPath(name)
		for {
			if entries[parent] == nil {
				entries[parent] = make(map[string]bool)
			}
			entries[parent][child] = true
			if parent == "tools" || parent == "." {
				break
			}
			parent, child = splitPath(parent)
		}
	}
	return entries
}

func sortedKeys[T any](items map[string]T) []string {
	keys := make([]string, 0, len(items))
	for key := range items {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sortedIntKeys(items map[string]int) []string {
	return sortedKeys(items)
}

func splitPath(name string) (string, string) {
	i := strings.LastIndexByte(name, '/')
	if i < 0 {
		return ".", name
	}
	return name[:i], name[i+1:]
}
