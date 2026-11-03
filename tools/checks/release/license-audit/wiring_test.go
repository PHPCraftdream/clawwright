package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const rootAuditCommand = "go -C tools/checks/release/license-audit run . --root ../../../.. --package-dir ../../../../packages/clawwright && go -C tools/checks/release/license-audit test -count=1 ./..."
const setupGoStep = "Set up Go"
const auditStep = "Fail-closed production license audit"
const setupGoAction = "actions/setup-go@d35c59abb061a4a6fb18e82ac0862c26744d6ab5"

func TestNpmAuditScriptIsTheCrossPlatformGoSafetyGate(t *testing.T) {
	manifest, err := os.ReadFile("../../../../package.json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(manifest), `"license:audit": "`+rootAuditCommand+`"`) {
		t.Fatal("public license:audit script does not run the Go auditor and uncached module tests in order")
	}
}

func workflowStep(text, name string) (string, bool) {
	marker := "      - name: " + name
	start := strings.Index(text, marker)
	if start < 0 {
		return "", false
	}
	end := strings.Index(text[start+len(marker):], "\n      - ")
	if end < 0 {
		end = len(text)
	} else {
		end += start + len(marker)
	}
	return text[start:end], true
}

func validateAuditWorkflow(text string) error {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	setup, ok := workflowStep(text, setupGoStep)
	if !ok {
		return fmt.Errorf("missing Go setup")
	}
	audit, ok := workflowStep(text, auditStep)
	if !ok {
		return fmt.Errorf("missing audit step")
	}
	if strings.Index(text, "      - name: "+setupGoStep) > strings.Index(text, "      - name: "+auditStep) {
		return fmt.Errorf("Go setup follows audit")
	}
	for _, required := range []string{setupGoAction, "go-version: '1.26.0'", "cache: false", "check-latest: false"} {
		if !strings.Contains(setup, required) {
			return fmt.Errorf("Go setup missing %q", required)
		}
	}
	if !strings.Contains(audit, "run: npm run license:audit") || !strings.Contains(audit, "GOTOOLCHAIN: local") || !strings.Contains(audit, "CGO_ENABLED: '0'") || !strings.Contains(audit, "run: npm run license:audit\n") {
		return fmt.Errorf("audit step missing command or environment")
	}
	if strings.Contains(audit, "continue-on-error:") || strings.Contains(audit, "if:") || strings.Contains(setup, "continue-on-error:") || strings.Contains(setup, "if:") {
		return fmt.Errorf("audit workflow step is conditional or non-fatal")
	}
	if strings.Contains(audit, "|| true") {
		return fmt.Errorf("audit step bypasses failure")
	}
	return nil
}

func TestAuditWorkflowCallerOrderingAndPins(t *testing.T) {
	for _, item := range []struct {
		path string
		jobs []string
	}{{"../../../../.github/workflows/publish.yml", []string{"verify"}}, {"../../../../.github/workflows/ci.yml", []string{"checks", "macos-checks", "windows-checks", "windows-wsl"}}} {
		data, err := os.ReadFile(item.path)
		if err != nil {
			t.Fatal(err)
		}
		data = []byte(strings.ReplaceAll(string(data), "\r\n", "\n"))
		text := string(data)
		for _, job := range item.jobs {
			start := strings.Index(text, "  "+job+":\n")
			if start < 0 {
				t.Fatalf("%s missing job %s", item.path, job)
			}
			end := len(text)
			for pos := start + len("  "+job+":\n"); pos < len(text); {
				relative := strings.Index(text[pos:], "\n  ")
				if relative < 0 {
					break
				}
				candidate := pos + relative + len("\n  ")
				if candidate < len(text) && text[candidate] != ' ' && text[candidate] != '\t' && text[candidate] != '\n' {
					end = candidate - len("\n  ")
					break
				}
				pos = candidate
			}
			if err := validateAuditWorkflow(text[start:end]); err != nil {
				t.Errorf("%s job %s: %v", item.path, job, err)
			}
		}
	}
}

func TestWorkflowGuardRejectsNegativeFixtures(t *testing.T) {
	setup := "      - name: Set up Go\n        uses: " + setupGoAction + "\n        with:\n          go-version: '1.26.0'\n          cache: false\n          check-latest: false\n"
	audit := "      - name: Fail-closed production license audit\n        env:\n          GOTOOLCHAIN: local\n          CGO_ENABLED: '0'\n        run: npm run license:audit\n"
	valid := setup + audit
	fixtures := map[string]string{
		"missing setup":   audit,
		"missing version": strings.Replace(valid, "go-version: '1.26.0'\n", "", 1),
		"wrong pin":       strings.Replace(valid, setupGoAction, "actions/setup-go@latest", 1),
		"guard":           strings.Replace(valid, audit, strings.Replace(audit, "        run:", "        if: always()\n        run:", 1), 1),
		"setup guard":     strings.Replace(valid, setup, strings.Replace(setup, "        uses:", "        if: false\n        uses:", 1), 1),
		"setup continue":  strings.Replace(valid, setup, strings.Replace(setup, "        uses:", "        continue-on-error: true\n        uses:", 1), 1),
		"audit bypass":    strings.Replace(valid, "run: npm run license:audit", "run: npm run license:audit || true", 1),
		"cache":           strings.Replace(valid, "cache: false", "cache: true", 1),
		"bypass":          strings.Replace(valid, "npm run license:audit", "go run .", 1),
		"reordered":       audit + setup,
	}
	if err := validateAuditWorkflow(valid); err != nil {
		t.Fatalf("valid fixture rejected: %v", err)
	}
	for name, fixture := range fixtures {
		t.Run(name, func(t *testing.T) {
			if err := validateAuditWorkflow(fixture); err == nil {
				t.Fatal("negative workflow fixture passed")
			}
		})
	}
}

func TestActualNpmCallerInSyntheticRepository(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	root, pkg := fixture(t)
	nested := filepath.Join(root, "tools", "checks", "release", "license-audit")
	if err := os.MkdirAll(nested, 0700); err != nil {
		t.Fatal(err)
	}
	framework := filepath.Join(root, "packages", "clawwright")
	if err := os.MkdirAll(framework, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"package.json", "LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "NOTICE"} {
		data, err := os.ReadFile(filepath.Join(pkg, name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(framework, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	manifest, err := os.ReadFile("../../../../package.json")
	if err != nil {
		t.Fatal(err)
	}
	var packageManifest struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(manifest, &packageManifest); err != nil {
		t.Fatal(err)
	}
	if packageManifest.Scripts["license:audit"] != rootAuditCommand {
		t.Fatal("unexpected actual npm audit command")
	}
	for _, name := range []string{"go.mod", "main.go", "audit.go", "input.go"} {
		data, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(nested, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "package.json"), manifest, 0600); err != nil {
		t.Fatal(err)
	}

	run := func() (int, string, string) {
		var cmd *exec.Cmd
		if runtime.GOOS == "windows" {
			cmd = exec.CommandContext(ctx, "cmd.exe", "/d", "/s", "/c", "npm run license:audit")
		} else {
			cmd = exec.CommandContext(ctx, "npm", "run", "license:audit")
		}
		cmd.Dir = root
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		if ctx.Err() != nil {
			t.Fatalf("npm audit timed out: %v", ctx.Err())
		}
		code := 0
		if err != nil {
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) {
				t.Fatalf("run npm audit: %v", err)
			}
			code = exitErr.ExitCode()
		}
		return code, stdout.String(), stderr.String()
	}
	code, stdout, stderr := run()
	if code != 0 || !strings.Contains(stdout, successOutput) || stderr != "" {
		t.Fatalf("success exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
	lockPath := filepath.Join(root, "package-lock.json")
	lock := readObject(t, lockPath)
	objectMap(packageEntries(lock)["node_modules/json5"])["integrity"] = "sha512-forged"
	saveLock(t, root, lock)
	code, stdout, stderr = run()
	if code == 0 || strings.Contains(stdout, successOutput) || !strings.Contains(stderr, "json5 lock metadata differs from the registry evidence reviewed for 2.2.3") {
		t.Fatalf("forged integrity exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
}
