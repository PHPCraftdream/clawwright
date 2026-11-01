package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestControlRunnerMatchesWorkingSource(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	baselineBytes, err := git(root, "show", baseline+":tools/native/task245-acceptance/run.py")
	if err != nil {
		t.Fatalf("read immutable baseline runner: %v", err)
	}
	approvedBytes, err := approvedRunner(baselineBytes)
	if err != nil {
		t.Fatalf("derive approved runner from baseline blob: %v", err)
	}
	workingBytes, err := os.ReadFile(filepath.Join(root, "tools", "native", "task245-acceptance", "run.py"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(workingBytes, approvedBytes) {
		t.Fatal("working runner does not exactly match approved baseline transition")
	}
}


func TestControlProfileMatchesWorkingSource(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	baselineBytes, err := git(root, "show", baseline+":tools/native/task245-acceptance/profile.py")
	if err != nil {
		t.Fatalf("read immutable baseline profile: %v", err)
	}
	approvedBytes, err := approvedControlProfile(baselineBytes)
	if err != nil {
		t.Fatalf("derive approved baseline profile transition: %v", err)
	}
	workingBytes, err := os.ReadFile(filepath.Join(root, "tools", "native", "task245-acceptance", "profile.py"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(workingBytes, approvedBytes) {
		t.Fatal("working profile does not exactly match approved baseline transition")
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
