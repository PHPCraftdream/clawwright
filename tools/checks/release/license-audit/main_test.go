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
	"strings"
	"testing"
	"time"
)

const json5Integrity = "sha512-XmOWe7eyHYH14cLdVPoyg+GOH3rYX++KpzrylJwSW98t3Nk+U8XOl8FWKOgwtzdb8lXGf6zYwDUzeHMWfxasyg=="
const successOutput = "License audit passed for 1 exact-version reviewed production dependency entries; LICENSE/NOTICE copies match.\n"

func fixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	pkg := filepath.Join(root, "framework")
	if err := os.MkdirAll(pkg, 0700); err != nil {
		t.Fatal(err)
	}
	manifest := map[string]any{
		"name":    "framework",
		"version": "1.0.0",
		"dependencies": map[string]string{
			"json5": "^2.2.3",
		},
	}
	lock := map[string]any{
		"lockfileVersion": 3,
		"requires":       true,
		"packages": map[string]any{
			"": map[string]any{
				"dependencies": map[string]string{
					"json5": "^2.2.3",
				},
			},
			"node_modules/json5": map[string]any{
				"version":   "2.2.3",
				"license":   "MIT",
				"resolved":  "https://registry.npmjs.org/json5/-/json5-2.2.3.tgz",
				"integrity": json5Integrity,
			},
		},
	}
	putJSON(t, filepath.Join(root, "package-lock.json"), lock)
	putJSON(t, filepath.Join(pkg, "package.json"), manifest)
	for _, name := range []string{"LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "NOTICE"} {
		data := []byte("notice bytes\n" + name)
		if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(pkg, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root, pkg
}

func putJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func readObject(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func saveLock(t *testing.T, root string, lock map[string]any) {
	t.Helper()
	putJSON(t, filepath.Join(root, "package-lock.json"), lock)
}

func saveManifest(t *testing.T, pkg string, manifest map[string]any) {
	t.Helper()
	putJSON(t, filepath.Join(pkg, "package.json"), manifest)
}

func packageEntries(lock map[string]any) map[string]any {
	return objectMap(lock["packages"])
}

func auditOutput(root, pkg string) (string, error) {
	var out bytes.Buffer
	err := audit(root, pkg, &out)
	return out.String(), err
}

func expectError(t *testing.T, root, pkg, substring string) {
	t.Helper()
	out, err := auditOutput(root, pkg)
	if err == nil || !strings.Contains(err.Error(), substring) {
		t.Fatalf("expected error containing %q; stdout=%q error=%v", substring, out, err)
	}
	if out != "" {
		t.Fatalf("refusal wrote stdout %q", out)
	}
}

func objectMap(value any) map[string]any {
	return value.(map[string]any)
}

func stringMap(values map[string]string) map[string]any {
	result := map[string]any{}
	for key, value := range values {
		result[key] = value
	}
	return result
}

type mutation func(*testing.T, string, string)

func adversary(t *testing.T, name, expected string, mutate mutation) {
	t.Helper()
	t.Run(name, func(t *testing.T) {
		root, pkg := fixture(t)
		mutate(t, root, pkg)
		expectError(t, root, pkg, expected)
	})
}

func TestValidInventoryAndEmptyDependencies(t *testing.T) {
	root, pkg := fixture(t)
	out, err := auditOutput(root, pkg)
	if err != nil || out != successOutput {
		t.Fatalf("output=%q error=%v", out, err)
	}

	manifest := readObject(t, filepath.Join(pkg, "package.json"))
	manifest["dependencies"] = map[string]string{}
	saveManifest(t, pkg, manifest)

	lock := readObject(t, filepath.Join(root, "package-lock.json"))
	entries := objectMap(lock["packages"])
	rootEntry := objectMap(entries[""])
	rootEntry["dependencies"] = map[string]string{}
	saveLock(t, root, lock)

	out, err = auditOutput(root, pkg)
	expected := "License audit passed for 0 exact-version reviewed production dependency entries; LICENSE/NOTICE copies match.\n"
	if err != nil || out != expected {
		t.Fatalf("empty required map: %q %v", out, err)
	}
}

func TestElevenOriginalAdversaries(t *testing.T) {
	adversary(t, "forged integrity", "json5 lock metadata differs", func(t *testing.T, root, pkg string) {
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		objectMap(packageEntries(lock)["node_modules/json5"])["integrity"] = "sha512-forged"
		saveLock(t, root, lock)
	})
	adversary(t, "evil registry", "json5 lock metadata differs", func(t *testing.T, root, pkg string) {
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		objectMap(packageEntries(lock)["node_modules/json5"])["resolved"] = "https://evil.example/json5.tgz"
		saveLock(t, root, lock)
	})
	adversary(t, "changed license", "No exact-version reviewed provenance for json5@2.2.3", func(t *testing.T, root, pkg string) {
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		objectMap(packageEntries(lock)["node_modules/json5"])["license"] = "Apache-2.0"
		saveLock(t, root, lock)
	})
	adversary(t, "missing license", "Missing version/license metadata", func(t *testing.T, root, pkg string) {
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		delete(objectMap(packageEntries(lock)["node_modules/json5"]), "license")
		saveLock(t, root, lock)
	})
	adversary(t, "unreviewed root dependency", "No exact-version reviewed provenance for unreviewed-package@1.0.0", func(t *testing.T, root, pkg string) {
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		manifest := readObject(t, filepath.Join(pkg, "package.json"))
		dependencies := map[string]string{
			"json5":              "^2.2.3",
			"unreviewed-package": "1.0.0",
		}
		manifest["dependencies"] = dependencies
		objectMap(packageEntries(lock)[""])["dependencies"] = dependencies
		objectMap(packageEntries(lock))["node_modules/unreviewed-package"] = map[string]any{
			"version":   "1.0.0",
			"resolved":  "https://registry.npmjs.org/unreviewed-package/-/unreviewed-package-1.0.0.tgz",
			"integrity": "sha512-abc",
			"license":   "MIT",
		}
		saveManifest(t, pkg, manifest)
		saveLock(t, root, lock)
	})
	adversary(t, "transitive peer host", "Transitive peerDependencies are unsupported", func(t *testing.T, root, pkg string) {
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		packages := packageEntries(lock)
		objectMap(packages["node_modules/json5"])["dependencies"] = map[string]string{"nested-peer-host": "1.0.0"}
		packages["node_modules/nested-peer-host"] = map[string]any{
			"version":          "1.0.0",
			"resolved":         "https://registry.npmjs.org/nested-peer-host/-/nested-peer-host-1.0.0.tgz",
			"integrity":        "sha512-abc",
			"license":          "MIT",
			"peerDependencies": map[string]string{"absent": "*"},
		}
		saveLock(t, root, lock)
	})
	adversary(t, "scoped unreviewed dependency", "No exact-version reviewed provenance for @unreviewed/pkg@1.0.0", func(t *testing.T, root, pkg string) {
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		packages := packageEntries(lock)
		objectMap(packages["node_modules/json5"])["dependencies"] = map[string]string{"@unreviewed/pkg": "1.0.0"}
		packages["node_modules/@unreviewed/pkg"] = map[string]any{
			"version":   "1.0.0",
			"resolved":  "https://registry.npmjs.org/@unreviewed/pkg/-/pkg-1.0.0.tgz",
			"integrity": "sha512-abc",
			"license":   "MIT",
		}
		saveLock(t, root, lock)
	})
	adversary(t, "hoisted unreviewed dependency", "No exact-version reviewed provenance for nested-peer-host@1.0.0", func(t *testing.T, root, pkg string) {
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		packages := packageEntries(lock)
		objectMap(packages["node_modules/json5"])["dependencies"] = map[string]string{"nested-peer-host": "1.0.0"}
		packages["node_modules/nested-peer-host"] = map[string]any{
			"version":   "1.0.0",
			"resolved":  "https://registry.npmjs.org/nested-peer-host/-/nested-peer-host-1.0.0.tgz",
			"integrity": "sha512-abc",
			"license":   "MIT",
		}
		saveLock(t, root, lock)
	})
	adversary(t, "transitive alias", "Unsupported dependency range or alias for nested-peer-host", func(t *testing.T, root, pkg string) {
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		objectMap(packageEntries(lock)["node_modules/json5"])["dependencies"] = map[string]string{"nested-peer-host": "git+https://example.com/pkg.git"}
		saveLock(t, root, lock)
	})
	adversary(t, "manifest mismatch", "Manifest/lock range mismatch for json5", func(t *testing.T, root, pkg string) {
		manifest := readObject(t, filepath.Join(pkg, "package.json"))
		manifest["dependencies"] = map[string]string{"json5": "^2.2.4"}
		saveManifest(t, pkg, manifest)
	})
	adversary(t, "published bundle", "Published bundled dependencies are unsupported", func(t *testing.T, root, pkg string) {
		manifest := readObject(t, filepath.Join(pkg, "package.json"))
		manifest["bundleDependencies"] = []string{"json5"}
		saveManifest(t, pkg, manifest)
	})
}

func TestNoticeMutation(t *testing.T) {
	root, pkg := fixture(t)
	if err := os.WriteFile(filepath.Join(pkg, "NOTICE"), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	expectError(t, root, pkg, "Repository/framework notice mismatch: NOTICE")
}

func TestRequiredAndOptionalDependencies(t *testing.T) {
	t.Run("optional dependency with matching root edges", func(t *testing.T) {
		root, pkg := fixture(t)
		manifest := readObject(t, filepath.Join(pkg, "package.json"))
		manifest["dependencies"] = map[string]string{}
		manifest["optionalDependencies"] = map[string]string{"json5": "^2.2.3"}
		saveManifest(t, pkg, manifest)

		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		objectMap(packageEntries(lock)[""])["optionalDependencies"] = map[string]string{"json5": "^2.2.3"}
		saveLock(t, root, lock)
		if _, err := auditOutput(root, pkg); err != nil {
			t.Fatal(err)
		}
	})

	for _, tc := range []struct {
		name    string
		message string
		change  func(*testing.T, string, string)
	}{
		{
			name:    "missing required map",
			message: "Published manifest lacks auditable production metadata",
			change: func(t *testing.T, root, pkg string) {
				manifest := readObject(t, filepath.Join(pkg, "package.json"))
				delete(manifest, "dependencies")
				saveManifest(t, pkg, manifest)
			},
		},
		{
			name:    "missing optional map",
			message: "Unsupported published optionalDependencies metadata",
			change: func(t *testing.T, root, pkg string) {
				manifest := readObject(t, filepath.Join(pkg, "package.json"))
				manifest["optionalDependencies"] = nil
				saveManifest(t, pkg, manifest)
			},
		},
		{
			name:    "optional root edges absent",
			message: "Root lock optionalDependencies are missing",
			change: func(t *testing.T, root, pkg string) {
				manifest := readObject(t, filepath.Join(pkg, "package.json"))
				manifest["dependencies"] = map[string]string{}
				manifest["optionalDependencies"] = map[string]string{"json5": "^2.2.3"}
				saveManifest(t, pkg, manifest)
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, pkg := fixture(t)
			tc.change(t, root, pkg)
			expectError(t, root, pkg, tc.message)
		})
	}
}

func TestGlobalBundleAndReviewedEvidence(t *testing.T) {
	t.Run("unused bundled lock entry", func(t *testing.T) {
		root, pkg := fixture(t)
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		packageEntries(lock)["node_modules/unused"] = map[string]any{"inBundle": true}
		saveLock(t, root, lock)
		expectError(t, root, pkg, "Bundled lock entry unsupported: node_modules/unused")
	})
	t.Run("reviewed gitHead evidence", func(t *testing.T) {
		old := reviewed["json5"]
		t.Cleanup(func() { reviewed["json5"] = old })
		changed := old
		changed.gitHead = "forged"
		reviewed["json5"] = changed
		root, pkg := fixture(t)
		expectError(t, root, pkg, "json5 reviewed source provenance mismatch")
	})
	t.Run("sha1 integrity refused", func(t *testing.T) {
		root, pkg := fixture(t)
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		packageEntries(lock)["node_modules/json5"].(map[string]any)["integrity"] = "sha1-abc="
		saveLock(t, root, lock)
		expectError(t, root, pkg, "json5 lock metadata differs")
	})
}

func TestDependencyGraphCyclesAndResolution(t *testing.T) {
	t.Run("self cycle is visited once", func(t *testing.T) {
		root, pkg := fixture(t)
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		packageEntries(lock)["node_modules/json5"].(map[string]any)["dependencies"] = map[string]string{"json5": "2.2.3"}
		saveLock(t, root, lock)
		out, err := auditOutput(root, pkg)
		if err != nil || out != successOutput {
			t.Fatalf("%q %v", out, err)
		}
	})
	t.Run("nested cycle counts both installed entries", func(t *testing.T) {
		root, pkg := fixture(t)
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		packages := packageEntries(lock)
		packages["node_modules/json5"].(map[string]any)["dependencies"] = map[string]string{"json5": "2.2.3"}
		packages["node_modules/json5/node_modules/json5"] = map[string]any{
			"version":      "2.2.3",
			"license":      "MIT",
			"resolved":     "https://registry.npmjs.org/json5/-/json5-2.2.3.tgz",
			"integrity":    json5Integrity,
			"dependencies": map[string]string{"json5": "2.2.3"},
		}
		saveLock(t, root, lock)
		out, err := auditOutput(root, pkg)
		expected := "License audit passed for 2 exact-version reviewed production dependency entries; LICENSE/NOTICE copies match.\n"
		if err != nil || out != expected {
			t.Fatalf("%q %v", out, err)
		}
	})

	for _, tc := range []struct {
		name    string
		packages object
		parent  string
		nameDep string
		want    string
		ok      bool
	}{
		{
			name:    "nearest nested",
			packages: object{
				"node_modules/a/node_modules/x": nil,
				"node_modules/a/node_modules/y": nil,
				"node_modules/y":                nil,
			},
			parent: "node_modules/a/node_modules/x",
			nameDep: "y",
			want:    "node_modules/a/node_modules/y",
			ok:      true,
		},
		{
			name:    "hoisted",
			packages: object{
				"node_modules/a/node_modules/x": nil,
				"node_modules/y":                nil,
			},
			parent:  "node_modules/a/node_modules/x",
			nameDep: "y",
			want:    "node_modules/y",
			ok:      true,
		},
		{
			name:    "scoped",
			packages: object{
				"node_modules/a/node_modules/@scope/pkg": nil,
			},
			parent:  "node_modules/a",
			nameDep: "@scope/pkg",
			want:    "node_modules/a/node_modules/@scope/pkg",
			ok:      true,
		},
		{
			name:    "missing",
			packages: object{},
			parent:  "",
			nameDep: "absent",
			want:    "",
			ok:      false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := resolveLock(tc.packages, tc.parent, tc.nameDep)
			if (ok && got != tc.want) || ok != tc.ok {
				t.Fatalf("resolveLock=%q,%v", got, ok)
			}
		})
	}
	t.Run("mutable transitive range is refused", func(t *testing.T) {
		root, pkg := fixture(t)
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		packages := packageEntries(lock)
		packages["node_modules/json5"].(map[string]any)["dependencies"] = map[string]string{"nested": "^2.2.3"}
		packages["node_modules/json5/node_modules/nested"] = map[string]any{
			"version":   "2.2.3",
			"resolved":  "https://registry.npmjs.org/nested/-/nested-2.2.3.tgz",
			"integrity": "sha512-abc",
			"license":   "MIT",
		}
		saveLock(t, root, lock)
		expectError(t, root, pkg, "Dependency range/version mismatch for nested")
	})
}

func TestStrictJSONAndInputBounds(t *testing.T) {
	inputs := [][]byte{
		[]byte(`{"a":1,"a":2}`),
		[]byte(`{} {}`),
		{0xff},
		append(
			append(bytes.Repeat([]byte("["), maxDepth+1), []byte("0")...),
			bytes.Repeat([]byte("]"), maxDepth+1)...,
		),
	}
	for _, input := range inputs {
		t.Run(fmt.Sprintf("invalid %d bytes", len(input)), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "input")
			if err := os.WriteFile(path, input, 0600); err != nil {
				t.Fatal(err)
			}
			var value map[string]any
			if err := parseJSON(path, &value); err == nil {
				t.Fatal("accepted invalid JSON")
			}
		})
	}

	path := filepath.Join(t.TempDir(), "boundary")
	if err := os.WriteFile(path, bytes.Repeat([]byte(" "), maxInput), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readFile(path); err != nil {
		t.Fatalf("maxInput bytes rejected: %v", err)
	}
	if err := os.WriteFile(path, bytes.Repeat([]byte("x"), maxInput+1), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readFile(path); err == nil {
		t.Fatal("accepted maxInput+1")
	}
	if _, err := readFile(filepath.Join(filepath.Dir(path), "missing")); err == nil {
		t.Fatal("accepted missing input")
	}
}

func TestNoticeComparisonUsesRawBytes(t *testing.T) {
	root, pkg := fixture(t)
	raw := []byte{'n', 'o', 't', 'i', 'c', 'e', 0xff, '\r', '\n'}
	if err := os.WriteFile(filepath.Join(root, "NOTICE"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkg, "NOTICE"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := auditOutput(root, pkg); err != nil {
		t.Fatalf("identical invalid UTF-8 bytes rejected: %v", err)
	}
	raw = append(raw, '!')
	if err := os.WriteFile(filepath.Join(pkg, "NOTICE"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	expectError(t, root, pkg, "Repository/framework notice mismatch: NOTICE")
}

func TestCLIExactContracts(t *testing.T) {
	root, pkg := fixture(t)
	var out, stderr bytes.Buffer
	if code := cli([]string{"--root", root, "--package-dir", pkg}, &out, &stderr); code != 0 || out.String() != successOutput || stderr.Len() != 0 {
		t.Fatalf("success code=%d stdout=%q stderr=%q", code, out.String(), stderr.String())
	}
	for _, tc := range []struct {
		name   string
		args   []string
		code   int
		output string
	}{
		{name: "refusal", args: []string{"--root", filepath.Join(root, "missing"), "--package-dir", pkg}, code: 1, output: ""},
		{name: "bad option", args: []string{"--bogus"}, code: 2, output: ""},
		{name: "missing root value", args: []string{"--root"}, code: 2, output: ""},
		{name: "missing package value", args: []string{"--package-dir"}, code: 2, output: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stdout, errout bytes.Buffer
			code := cli(tc.args, &stdout, &errout)
			if code != tc.code || stdout.String() != tc.output || errout.Len() == 0 {
				t.Fatalf("code=%d stdout=%q stderr=%q", code, stdout.String(), errout.String())
			}
		})
	}
}

func TestCLIActualSelfExecution(t *testing.T) {
	root, pkg := fixture(t)
	for _, tc := range []struct {
		name   string
		bad    bool
		exit   int
		stdout string
	}{
		{name: "success", bad: false, exit: 0, stdout: successOutput},
		{name: "refusal", bad: true, exit: 1, stdout: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			packageDir := pkg
			if tc.bad {
				packageDir = filepath.Join(root, "missing")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCLIActualSelfExecution$")
			cmd.Env = append(os.Environ(),
				"LICENSE_AUDIT_CLI_HELPER=1",
				"LICENSE_AUDIT_ROOT="+root,
				"LICENSE_AUDIT_PACKAGE="+packageDir,
			)
			var stdout, stderr bytes.Buffer
			cmd.Stdout = &stdout
			cmd.Stderr = &stderr
			err := cmd.Run()
			if ctx.Err() != nil {
				t.Fatal(ctx.Err())
			}
			code := 0
			if err != nil {
				var exitErr *exec.ExitError
				if !errors.As(err, &exitErr) {
					t.Fatal(err)
				}
				code = exitErr.ExitCode()
			}
			if code != tc.exit || stdout.String() != tc.stdout {
				t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
			}
			if tc.exit == 0 && stderr.Len() != 0 {
				t.Fatalf("unexpected stderr %q", stderr.String())
			}
			if tc.exit != 0 && stderr.Len() == 0 {
				t.Fatal("missing refusal stderr")
			}
		})
	}
}

func init() {
	if os.Getenv("LICENSE_AUDIT_CLI_HELPER") == "1" {
		os.Exit(cli([]string{
			"--root", os.Getenv("LICENSE_AUDIT_ROOT"),
			"--package-dir", os.Getenv("LICENSE_AUDIT_PACKAGE"),
		}, os.Stdout, os.Stderr))
	}
}
