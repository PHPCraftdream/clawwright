package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublicCLIAgainstTemporaryCheckout(t *testing.T) {
	binary := buildCLI(t)
	source := repositoryRoot(t)
	clone := filepath.Join(t.TempDir(), "checkout")
	gitTest(t, filepath.Dir(clone), "clone", "--no-hardlinks", "--local", source, clone)

	rootOutput := runCLI(t, binary, clone)
	if rootOutput.exitCode != 0 {
		t.Fatalf("CLI from clone root exited %d: %s", rootOutput.exitCode, rootOutput.stderr)
	}
	if !strings.Contains(rootOutput.stdout, "inventory: .go implementation files=") || strings.Contains(rootOutput.stdout, "files=0") {
		t.Fatalf("expected nonempty Go inventory, got %q", rootOutput.stdout)
	}
	if !strings.Contains(rootOutput.stdout, "debt:") {
		t.Fatalf("expected grandfathered debt in output, got %q", rootOutput.stdout)
	}

	subdirectoryOutput := runCLI(t, binary, filepath.Join(clone, "tools", "tooling-policy"))
	if subdirectoryOutput.exitCode != 0 || subdirectoryOutput.stdout != rootOutput.stdout {
		t.Fatalf("CLI from policy directory differed: exit=%d stdout=%q stderr=%q", subdirectoryOutput.exitCode, subdirectoryOutput.stdout, subdirectoryOutput.stderr)
	}

	explicitOutput := runCLI(t, binary, t.TempDir(), "--root", filepath.Join(clone, "tools", "tooling-policy"))
	if explicitOutput.exitCode != 0 || explicitOutput.stdout != rootOutput.stdout {
		t.Fatalf("explicit --root differed: exit=%d stdout=%q stderr=%q", explicitOutput.exitCode, explicitOutput.stdout, explicitOutput.stderr)
	}

	worktree := filepath.Join(t.TempDir(), "linked worktree with spaces")
	gitTest(t, clone, "worktree", "add", "--detach", worktree, "HEAD")
	linkedOutput := runCLI(t, binary, filepath.Join(worktree, "tools", "tooling-policy"))
	if linkedOutput.exitCode != 0 || linkedOutput.stdout != rootOutput.stdout {
		t.Fatalf("linked-worktree output differed: exit=%d stdout=%q stderr=%q", linkedOutput.exitCode, linkedOutput.stdout, linkedOutput.stderr)
	}

	outside := runCLI(t, binary, t.TempDir())
	if outside.exitCode != 1 || !strings.Contains(outside.stderr, "outside Git worktree") {
		t.Fatalf("outside-Git result = %+v", outside)
	}
}

func TestPublicCLIReadsStagedBlobAndRequiresStaging(t *testing.T) {
	binary := buildCLI(t)
	clone := cloneCheckout(t)
	initial := runCLI(t, binary, clone)
	if initial.exitCode != 0 {
		t.Fatalf("initial CLI failed: %s", initial.stderr)
	}

	fixture := "tools/tooling-policy/cli-fixture.go"
	writeRepo(t, clone, fixture, "package fixture\n")
	unstaged := runCLI(t, binary, clone)
	if unstaged.exitCode != 0 || unstaged.stdout != initial.stdout {
		t.Fatalf("untracked source changed inventory: exit=%d stdout=%q stderr=%q", unstaged.exitCode, unstaged.stdout, unstaged.stderr)
	}

	gitTest(t, clone, "add", fixture)
	stagedValid := runCLI(t, binary, clone)
	if stagedValid.exitCode != 0 || goInventoryCount(t, stagedValid.stdout) != goInventoryCount(t, initial.stdout)+1 {
		t.Fatalf("staged source was not inventoried: exit=%d stdout=%q stderr=%q", stagedValid.exitCode, stagedValid.stdout, stagedValid.stderr)
	}

	writeRepo(t, clone, fixture, repeatedLines(701))
	stagedBytesOnly := runCLI(t, binary, clone)
	if stagedBytesOnly.exitCode != 0 || stagedBytesOnly.stdout != stagedValid.stdout {
		t.Fatalf("unstaged oversized contents affected CLI: exit=%d stdout=%q stderr=%q", stagedBytesOnly.exitCode, stagedBytesOnly.stdout, stagedBytesOnly.stderr)
	}

	gitTest(t, clone, "add", fixture)
	stagedOversized := runCLI(t, binary, clone)
	if stagedOversized.exitCode != 1 || !strings.Contains(stagedOversized.stderr, fixture) || !strings.Contains(stagedOversized.stderr, "exceeds 700") {
		t.Fatalf("staged oversized content was not rejected: exit=%d stdout=%q stderr=%q", stagedOversized.exitCode, stagedOversized.stdout, stagedOversized.stderr)
	}
}

func TestPublicCLIAcceptsOnlyApprovedRunnerTransitionFromBaseline(t *testing.T) {
	binary := buildCLI(t)
	clone := cloneCheckout(t)
	const runnerPath = "tools/native/task245-acceptance/run.py"

	baselineBytes, err := git(clone, "show", baseline+":"+runnerPath)
	if err != nil {
		t.Fatalf("read immutable baseline runner: %v", err)
	}
	approvedBytes, err := approvedRunner(baselineBytes)
	if err != nil {
		t.Fatalf("derive approved runner from baseline blob: %v", err)
	}
	writeRepo(t, clone, runnerPath, string(approvedBytes))
	gitTest(t, clone, "add", runnerPath)

	accepted := runCLI(t, binary, clone)
	if accepted.exitCode != 0 || strings.Contains(accepted.stderr, runnerPath+": implementation is new or changed from baseline") {
		t.Fatalf("exact staged baseline transition rejected: exit=%d stdout=%q stderr=%q", accepted.exitCode, accepted.stdout, accepted.stderr)
	}

	writeRepo(t, clone, runnerPath, string(approvedBytes)+"\n# unrelated business change\n")
	gitTest(t, clone, "add", runnerPath)
	rejected := runCLI(t, binary, clone)
	if rejected.exitCode != 1 || !strings.Contains(rejected.stderr, runnerPath+": implementation is new or changed from baseline") {
		t.Fatalf("extra staged runner change was not rejected: exit=%d stdout=%q stderr=%q", rejected.exitCode, rejected.stdout, rejected.stderr)
	}
}

func TestPublicCLIMissingBaselineAndUnreadableBlob(t *testing.T) {
	binary := buildCLI(t)
	empty := initRepository(t)
	missing := runCLI(t, binary, empty)
	if missing.exitCode != 1 || !strings.Contains(missing.stderr, "baseline inventory") {
		t.Fatalf("missing-baseline result = %+v", missing)
	}

	clone := cloneCheckout(t)
	path := "tools/tooling-policy/missing-blob.go"
	missingOID := strings.Repeat("1", 40)
	cmd := exec.Command("git", "cat-file", "-e", missingOID)
	cmd.Dir = clone
	if err := cmd.Run(); err == nil {
		t.Fatal("fixture object unexpectedly exists")
	}
	gitTest(t, clone, "update-index", "--add", "--info-only", "--cacheinfo", "100644,"+missingOID+","+path)
	unreadable := runCLI(t, binary, clone)
	if unreadable.exitCode != 1 || !strings.Contains(unreadable.stderr, path) || !strings.Contains(unreadable.stderr, "unreadable blob") {
		t.Fatalf("missing-blob result = %+v", unreadable)
	}
}

type cliResult struct {
	stdout   string
	stderr   string
	exitCode int
}

func goInventoryCount(t *testing.T, stdout string) int {
	t.Helper()
	const prefix = "inventory: .go implementation files="
	for _, line := range strings.Split(stdout, "\n") {
		if strings.HasPrefix(line, prefix) {
			var count int
			if _, err := fmt.Sscanf(line, "inventory: .go implementation files=%d", &count); err != nil {
				t.Fatalf("parse Go inventory count from %q: %v", line, err)
			}
			return count
		}
	}
	t.Fatalf("Go inventory count not found in %q", stdout)
	return 0
}

func buildCLI(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "tooling-policy")
	if os.PathSeparator == '\\' {
		binary += ".exe"
	}
	cmd := exec.Command("go", "build", "-o", binary, ".")
	cmd.Dir = "."
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build public CLI: %v: %s", err, output)
	}
	return binary
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	output, err := git(cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		t.Fatalf("resolve source checkout from current directory: %v", err)
	}
	return strings.TrimSuffix(strings.TrimSuffix(string(output), "\n"), "\r")
}

func cloneCheckout(t *testing.T) string {
	t.Helper()
	source := repositoryRoot(t)
	clone := filepath.Join(t.TempDir(), "checkout")
	gitTest(t, filepath.Dir(clone), "clone", "--no-hardlinks", "--local", source, clone)
	return clone
}

func runCLI(t *testing.T, binary, cwd string, args ...string) cliResult {
	t.Helper()
	cmd := exec.Command(binary, args...)
	cmd.Dir = cwd
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		} else {
			t.Fatalf("run CLI: %v", err)
		}
	}
	return cliResult{stdout: stdout.String(), stderr: stderr.String(), exitCode: code}
}

func initRepository(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	gitTest(t, root, "init")
	return root
}

func gitTest(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_COUNT=2", "GIT_CONFIG_KEY_0=user.name", "GIT_CONFIG_VALUE_0=Tooling Policy Test", "GIT_CONFIG_KEY_1=user.email", "GIT_CONFIG_VALUE_1=tooling-policy@example.invalid")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

func writeRepo(t *testing.T, root, name, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func repeatedLines(count int) string {
	return strings.Repeat("package fixture\n", count)
}
