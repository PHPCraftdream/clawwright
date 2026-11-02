package main

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCurrentRunnerAndWorkflowUseGoSource(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	read := func(path string) []byte {
		t.Helper()
		b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
		if err != nil {
			t.Fatalf("read current source %s: %v", path, err)
		}
		return b
	}
	run := string(read("tools/native/task245-acceptance/internal/runner/run.go"))
	container := string(read("tools/native/task245-acceptance/internal/runner/container.go"))
	for _, token := range []string{"./task245-acceptance/cmd/profile", "./task245-control-profile/cmd/control-probe", "./task245-acceptance/fixtures/gateway", "./task245-acceptance/fixtures/release"} {
		if !strings.Contains(run, token) && !strings.Contains(container, token) {
			t.Errorf("Go runner source missing expected package path %q", token)
		}
	}
	f, err := parser.ParseFile(token.NewFileSet(), filepath.Join(root, "tools/native/task245-acceptance/internal/runner/run.go"), nil, 0)
	if err != nil {
		t.Fatalf("parse live Go runner: %v", err)
	}
	foundContainerRun := false
	ast.Inspect(f, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		ident, ok := call.Fun.(*ast.Ident)
		foundContainerRun = foundContainerRun || ok && ident.Name == "containerRun"
		return true
	})
	if !foundContainerRun {
		t.Error("live Go runner has no containerRun call")
	}
	if strings.Contains(run, "run.py") || strings.Contains(run, "python3") || strings.Contains(container, "/lab/run") {
		t.Fatal("live Go runner retains a legacy Python run path")
	}
	for _, path := range []string{
		"tools/native/task245-acceptance/cmd/profile/main_linux.go",
		"tools/native/task245-acceptance/cmd/profile/setup_linux.go",
		"tools/native/task245-acceptance/cmd/profile/ceremony_linux.go",
		"tools/native/task245-acceptance/fixtures/gateway/main_linux.go",
		"tools/native/task245-acceptance/fixtures/release/main_linux.go",
		"tools/native/task245-control-profile/cmd/control-probe/main_linux.go",
	} {
		read(path)
	}
	workflow := string(read(".github/workflows/native-supervisor.yml"))
	for _, token := range []string{"working-directory: tools/native", "go run ./task245-acceptance/cmd/acceptance", "lab_case:", "- confinement", "- connected", "- wrong-holder", "- unexpected-exec", "- partial-ack", "- lost-ack", "- cancel"} {
		if !strings.Contains(workflow, token) {
			t.Errorf("workflow lost expected working-directory/source/matrix element %q", token)
		}
	}
	if strings.Count(workflow, "go run ./task245-acceptance/cmd/acceptance") != 1 {
		t.Fatal("workflow Go runner invocation changed")
	}
}

func TestControlProfileRejectsAdditionalEdits(t *testing.T) {
	const profilePath = "tools/native/task245-acceptance/profile.py"
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	baselineBytes, err := git(root, "show", baseline+":"+profilePath)
	if err != nil {
		t.Fatalf("read immutable baseline profile: %v", err)
	}
	approvedBytes, err := approvedControlProfile(baselineBytes)
	if err != nil {
		t.Fatalf("derive approved baseline profile transition: %v", err)
	}
	legacy := map[string]inventory{profilePath: {mode: "100644", blob: gitBlobID(baselineBytes)}}
	approved := map[string]string{profilePath: gitBlobID(approvedBytes)}
	check := func(name string, current map[string]inventory, wantViolations bool) {
		t.Helper()
		got := evaluateWithTransitions(current, legacy, func(inventory) (int, error) { return 1, nil }, approved)
		if hasViolations := len(got.Violations) != 0; hasViolations != wantViolations {
			t.Errorf("%s: violations=%v, want violations=%t", name, got.Violations, wantViolations)
		}
	}
	check("exact approved profile", map[string]inventory{profilePath: {mode: "100644", blob: gitBlobID(approvedBytes)}}, false)
	mutated := append(append([]byte(nil), approvedBytes...), '\n')
	check("profile with appended newline", map[string]inventory{profilePath: {mode: "100644", blob: gitBlobID(mutated)}}, true)
	check("sibling Python file with same blob", map[string]inventory{"tools/native/task245-acceptance/sibling.py": {mode: "100644", blob: gitBlobID(approvedBytes)}}, true)
}

func TestControlRunnerRejectsTamperingAndNearMisses(t *testing.T) {
	const runnerPath = "tools/native/task245-acceptance/run.py"
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	baselineBytes, err := git(root, "show", baseline+":"+runnerPath)
	if err != nil {
		t.Fatalf("read immutable baseline runner: %v", err)
	}
	approvedBytes, err := approvedRunner(baselineBytes)
	if err != nil {
		t.Fatal(err)
	}
	legacy := map[string]inventory{runnerPath: {mode: "100644", blob: gitBlobID(baselineBytes)}}
	approved := map[string]string{runnerPath: gitBlobID(approvedBytes)}
	for name, data := range map[string][]byte{"approved": approvedBytes, "tampered": append(append([]byte(nil), approvedBytes...), '\n')} {
		got := evaluateWithTransitions(map[string]inventory{runnerPath: {mode: "100644", blob: gitBlobID(data)}}, legacy, func(inventory) (int, error) { return 1, nil }, approved)
		if name == "approved" && len(got.Violations) != 0 {
			t.Errorf("exact approved runner rejected: %v", got.Violations)
		}
		if name == "tampered" && len(got.Violations) == 0 {
			t.Errorf("tampered runner admitted")
		}
	}
	for _, path := range []string{"tools/native/task245-control-profile/installer/extra.rs", "tools/native/task245-control-profile/installer-copy/main.rs"} {
		if approvedRustFallback(path) {
			t.Errorf("near-miss Rust path admitted: %s", path)
		}
	}
}

func TestTask251TransitionsAreExactAndPathBound(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	transitions := task251Transitions()
	if len(transitions) != 78 {
		t.Fatalf("expected 78 reviewed transitions, got %d", len(transitions))
	}
	legacy := make(map[string]inventory, len(transitions))
	current := make(map[string]inventory, len(transitions))
	for path, pair := range transitions {
		baselineBytes, err := git(root, "show", baseline+":"+path)
		if err != nil {
			t.Fatalf("read immutable baseline %s: %v", path, err)
		}
		if got := gitBlobID(baselineBytes); got != pair.baseline {
			t.Errorf("%s baseline blob=%s, configured=%s", path, got, pair.baseline)
		}
		legacy[path] = inventory{mode: "100644", blob: pair.baseline}
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
		if err != nil {
			t.Fatalf("read current %s: %v", path, err)
		}
		if got := gitBlobID(data); got != pair.current {
			t.Errorf("%s current blob=%s, configured=%s", path, got, pair.current)
		}
		current[path] = inventory{mode: "100644", blob: pair.current}
	}
	approved := approvedTask251(legacy)
	if len(approved) != len(transitions) {
		t.Fatalf("approved %d of %d exact transitions", len(approved), len(transitions))
	}
	check := func(name string, candidate, old map[string]inventory, wantViolation bool) {
		t.Helper()
		got := evaluateWithTransitions(candidate, old, func(inventory) (int, error) { return 1, nil }, approved)
		if violated := len(got.Violations) != 0; violated != wantViolation {
			t.Errorf("%s: violations=%v, want violation=%t", name, got.Violations, wantViolation)
		}
	}
	check("all exact transitions", current, legacy, false)
	mutated := make(map[string]inventory, len(current))
	for path, item := range current {
		mutated[path] = item
	}
	mutatedPath := ""
	for path := range mutated {
		mutatedPath = path
		break
	}
	mutatedData, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(mutatedPath)))
	if err != nil {
		t.Fatalf("read source for tamper case %s: %v", mutatedPath, err)
	}
	mutated[mutatedPath] = inventory{mode: "100644", blob: gitBlobID(append(mutatedData, '\n'))}
	check("transition with appended newline", mutated, legacy, true)
	neighbor := make(map[string]inventory, len(current))
	for path, item := range current {
		neighbor[path] = item
	}
	neighbor["tools/checks/adjacent-unapproved.ts"] = current["tools/build-framework-package.ts"]
	check("neighbor path with approved blob", neighbor, legacy, true)
	changedBaseline := make(map[string]inventory, len(legacy))
	for path, item := range legacy {
		changedBaseline[path] = item
	}
	changedPath := ""
	for path := range changedBaseline {
		changedPath = path
		break
	}
	changedBaseline[changedPath] = inventory{mode: "100644", blob: "0000000000000000000000000000000000000000"}
	if got := approvedTask251(changedBaseline); len(got) != len(approved)-1 {
		t.Errorf("changed baseline unexpectedly retained transition: got %d approvals", len(got))
	}
	if approvedRustFallback("tools/native/task251/extra.rs") {
		t.Error("task251 Rust path unexpectedly approved")
	}
}

func TestControlRunnerRejectsMissingOrDuplicateAnchors(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	baselineBytes, err := git(root, "show", baseline+":tools/native/task245-acceptance/run.py")
	if err != nil {
		t.Fatal(err)
	}
	if count := bytes.Count(baselineBytes, []byte(oldRunnerAnchor)); count != 1 {
		t.Fatalf("expected one baseline runner anchor; found %d", count)
	}
	intermediate := bytes.Replace(baselineBytes, []byte(oldRunnerAnchor), []byte(rustRunnerBlock), 1)
	if _, err := approvedControlRunner(intermediate); err != nil {
		t.Fatalf("rejected intermediate Rust runner: %v", err)
	}
	anchor := []byte(`        for source, output in (("task245-domain-init/main.rs", "native-init"), ("task240-launch-stub/main.rs", "native-stub")):
            PHASE = "compile-" + output
            invoke(["rustc", "--edition=2021", "--target=x86_64-unknown-linux-gnu", "-C", "opt-level=2", "-C", "panic=abort", "-C", "target-feature=+crt-static", "-o", str(stage/output), str(NATIVE/source)])
            (stage/output).chmod(0o755)
`)
	if count := bytes.Count(intermediate, anchor); count != 1 {
		t.Fatalf("expected one intermediate control-runner anchor; found %d", count)
	}
	missing := bytes.Replace(intermediate, anchor, []byte("removed anchor"), 1)
	duplicate := append(append([]byte(nil), intermediate...), anchor...)
	for name, input := range map[string][]byte{"missing": missing, "duplicate": duplicate} {
		if _, err := approvedControlRunner(input); err == nil {
			t.Errorf("accepted %s control-runner anchor", name)
		}
	}
}
