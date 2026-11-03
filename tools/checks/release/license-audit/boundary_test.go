package main

import (
	"bytes"
	"context"
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

func TestStableFIFORejectedBeforeOpen(t *testing.T) {
	if os.Getenv("LICENSE_AUDIT_FIFO_HELPER") == "1" {
		path := os.Getenv("LICENSE_AUDIT_FIFO_PATH")
		_, err := readFile(path)
		want := "input is not a regular file: " + path
		if err == nil || err.Error() != want {
			fmt.Fprintf(os.Stderr, "readFile error = %v, want %q\n", err, want)
			os.Exit(2)
		}
		fmt.Fprintln(os.Stdout, err)
		os.Exit(0)
	}

	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("Unix named-pipe fixture is unsupported on " + runtime.GOOS)
	}

	path := filepath.Join(t.TempDir(), "audit.fifo")
	createCtx, cancelCreate := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelCreate()
	var createStdout, createStderr bytes.Buffer
	create := exec.CommandContext(createCtx, "mkfifo", path)
	create.Stdout = &createStdout
	create.Stderr = &createStderr
	if err := create.Run(); err != nil {
		if createCtx.Err() != nil {
			t.Fatalf("mkfifo timed out: %v; stdout=%q stderr=%q", createCtx.Err(), createStdout.String(), createStderr.String())
		}
		t.Fatalf("mkfifo failed: %v; stdout=%q stderr=%q", err, createStdout.String(), createStderr.String())
	}

	before, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("Lstat FIFO: %v", err)
	}
	if before.Mode()&os.ModeNamedPipe == 0 || before.Mode()&os.ModeSymlink != 0 || before.Mode().IsRegular() {
		t.Fatalf("fixture is not a non-symlink FIFO: mode %v", before.Mode())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestStableFIFORejectedBeforeOpen$")
	cmd.Env = append(os.Environ(), "LICENSE_AUDIT_FIFO_HELPER=1", "LICENSE_AUDIT_FIFO_PATH="+path)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("readFile blocked on stable FIFO without a writer: %v", ctx.Err())
	}
	if err != nil {
		t.Fatalf("FIFO helper failed: %v; stdout=%q stderr=%q", err, stdout.String(), stderr.String())
	}
	if got, want := stdout.String(), "input is not a regular file: "+path+"\n"; got != want {
		t.Fatalf("FIFO helper stdout = %q, want %q", got, want)
	}
	if stderr.Len() != 0 {
		t.Fatalf("FIFO helper stderr = %q, want empty", stderr.String())
	}
	after, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("Lstat FIFO after helper: %v", err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("FIFO identity changed while helper ran")
	}
}

func TestBoundaryInventoryCases(t *testing.T) {
	t.Run("directory is rejected", func(t *testing.T) {
		dir := t.TempDir()
		_, err := readFile(dir)
		if err == nil || !strings.Contains(err.Error(), "input is not a regular file: "+dir) {
			t.Fatalf("expected non-regular input error for %s, got %v", dir, err)
		}
	})

	for _, tc := range []struct {
		name, message string
		change        func(*testing.T, string, string)
	}{
		{"lock version", "Unsupported or incomplete npm lockfile", func(t *testing.T, root, _ string) {
			lock := readObject(t, filepath.Join(root, "package-lock.json"))
			lock["lockfileVersion"] = 2
			saveLock(t, root, lock)
		}},
		{"requires false", "Unsupported or incomplete npm lockfile", func(t *testing.T, root, _ string) {
			lock := readObject(t, filepath.Join(root, "package-lock.json"))
			lock["requires"] = false
			saveLock(t, root, lock)
		}},
		{"missing packages", "Unsupported or incomplete npm lockfile", func(t *testing.T, root, _ string) {
			lock := readObject(t, filepath.Join(root, "package-lock.json"))
			delete(lock, "packages")
			saveLock(t, root, lock)
		}},
		{"packages array", "Unsupported or incomplete npm lockfile", func(t *testing.T, root, _ string) {
			lock := readObject(t, filepath.Join(root, "package-lock.json"))
			lock["packages"] = []any{}
			saveLock(t, root, lock)
		}},
		{"packages null", "Unsupported or incomplete npm lockfile", func(t *testing.T, root, _ string) {
			lock := readObject(t, filepath.Join(root, "package-lock.json"))
			lock["packages"] = nil
			saveLock(t, root, lock)
		}},
		{"root package missing", "Unsupported or incomplete npm lockfile", func(t *testing.T, root, _ string) {
			lock := readObject(t, filepath.Join(root, "package-lock.json"))
			delete(packageEntries(lock), "")
			saveLock(t, root, lock)
		}},
		{"root dependency missing", "Root lock dependencies are missing", func(t *testing.T, root, _ string) {
			lock := readObject(t, filepath.Join(root, "package-lock.json"))
			delete(objectMap(packageEntries(lock)[""]), "dependencies")
			saveLock(t, root, lock)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, pkg := fixture(t)
			tc.change(t, root, pkg)
			expectError(t, root, pkg, tc.message)
		})
	}
}

func TestBoundaryPublishedMetadata(t *testing.T) {
	for _, tc := range []struct {
		name, field string
		value       any
		message     string
	}{
		{"peers", "peerDependencies", map[string]string{"host": "*"}, "Published peerDependencies are unsupported"},
		{"peer metadata", "peerDependenciesMeta", map[string]any{"host": map[string]any{"optional": true}}, "Published peerDependenciesMeta are unsupported"},
		{"bundles", "bundleDependencies", []string{"json5"}, "Published bundled dependencies are unsupported"},
		{"bundled", "bundledDependencies", []string{"json5"}, "Published bundled dependencies are unsupported"},
		{"null bundle", "bundleDependencies", nil, "Published bundled dependencies are unsupported"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, pkg := fixture(t)
			manifest := readObject(t, filepath.Join(pkg, "package.json"))
			manifest[tc.field] = tc.value
			saveManifest(t, pkg, manifest)
			expectError(t, root, pkg, tc.message)
		})
	}
	for _, value := range []any{nil, []any{}} {
		t.Run("malformed required dependencies", func(t *testing.T) {
			root, pkg := fixture(t)
			manifest := readObject(t, filepath.Join(pkg, "package.json"))
			manifest["dependencies"] = value
			saveManifest(t, pkg, manifest)
			expectError(t, root, pkg, "Published manifest lacks auditable production metadata")
		})
	}
	for _, field := range []string{"peerDependencies", "peerDependenciesMeta"} {
		t.Run("null "+field, func(t *testing.T) {
			root, pkg := fixture(t)
			manifest := readObject(t, filepath.Join(pkg, "package.json"))
			manifest[field] = nil
			saveManifest(t, pkg, manifest)
			expectError(t, root, pkg, "Published "+field+" are unsupported")
		})
	}
	t.Run("empty optional declaration without root edge", func(t *testing.T) {
		root, pkg := fixture(t)
		manifest := readObject(t, filepath.Join(pkg, "package.json"))
		manifest["optionalDependencies"] = map[string]string{}
		saveManifest(t, pkg, manifest)
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		delete(objectMap(packageEntries(lock)[""]), "optionalDependencies")
		saveLock(t, root, lock)
		expectError(t, root, pkg, "Root lock optionalDependencies are missing")
	})
	t.Run("required optional overlap", func(t *testing.T) {
		root, pkg := fixture(t)
		manifest := readObject(t, filepath.Join(pkg, "package.json"))
		manifest["optionalDependencies"] = map[string]string{"json5": "^2.2.3"}
		saveManifest(t, pkg, manifest)
		expectError(t, root, pkg, "Dependency declared in both required and optional sections")
	})
}

func TestBoundaryTransitiveAndProvenance(t *testing.T) {
	for _, tc := range []struct {
		name, message string
		mutate        func(map[string]any)
	}{
		{"peer object", "Transitive peerDependencies are unsupported until explicitly audited", func(entry map[string]any) { entry["peerDependencies"] = map[string]string{"host": "*"} }},
		{"peer null", "Unsupported peerDependencies metadata", func(entry map[string]any) { entry["peerDependencies"] = nil }},
		{"missing resolved", "Unsupported or incomplete resolved/integrity lock metadata", func(entry map[string]any) { delete(entry, "resolved") }},
		{"missing integrity", "Unsupported or incomplete resolved/integrity lock metadata", func(entry map[string]any) { delete(entry, "integrity") }},
		{"unknown integrity algorithm", "Unsupported or incomplete resolved/integrity lock metadata", func(entry map[string]any) { entry["integrity"] = "sha999-abc" }},
		{"non HTTPS", "Unsupported or incomplete resolved/integrity lock metadata", func(entry map[string]any) { entry["resolved"] = "http://registry.npmjs.org/json5.tgz" }},
		{"unreviewed version", "No exact-version reviewed provenance for json5@2.2.4", func(entry map[string]any) { entry["version"] = "2.2.4" }},
		{"blank license", "Missing version/license metadata", func(entry map[string]any) { entry["license"] = "  " }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, pkg := fixture(t)
			lock := readObject(t, filepath.Join(root, "package-lock.json"))
			tc.mutate(objectMap(packageEntries(lock)["node_modules/json5"]))
			saveLock(t, root, lock)
			expectError(t, root, pkg, tc.message)
		})
	}
	for _, value := range []any{nil, []any{}} {
		t.Run("malformed transitive dependencies", func(t *testing.T) {
			root, pkg := fixture(t)
			lock := readObject(t, filepath.Join(root, "package-lock.json"))
			objectMap(packageEntries(lock)["node_modules/json5"])["dependencies"] = value
			saveLock(t, root, lock)
			expectError(t, root, pkg, "Unsupported dependency metadata")
		})
	}
	t.Run("missing child", func(t *testing.T) {
		root, pkg := fixture(t)
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		packages := packageEntries(lock)
		objectMap(packages["node_modules/json5"])["dependencies"] = map[string]string{"child": "1.0.0"}
		saveLock(t, root, lock)
		expectError(t, root, pkg, "Dependency missing from lockfile: node_modules/json5 -> child")
	})
}

func TestBoundaryUnsupportedRangePrefixes(t *testing.T) {
	for _, prefix := range []string{"npm:", "file:", "workspace:", "git+", "http", "link:"} {
		t.Run("required "+prefix, func(t *testing.T) {
			root, pkg := fixture(t)
			manifest := readObject(t, filepath.Join(pkg, "package.json"))
			manifest["dependencies"] = map[string]string{"alias": prefix + "target"}
			saveManifest(t, pkg, manifest)
			expectError(t, root, pkg, "Unsupported dependency range or alias for alias")
		})
		t.Run("transitive "+prefix, func(t *testing.T) {
			root, pkg := fixture(t)
			lock := readObject(t, filepath.Join(root, "package-lock.json"))
			objectMap(packageEntries(lock)["node_modules/json5"])["dependencies"] = map[string]string{"alias": prefix + "target"}
			saveLock(t, root, lock)
			expectError(t, root, pkg, "Unsupported dependency range or alias for alias")
		})
	}
}

func TestBoundaryOptionalTraversalAndNotices(t *testing.T) {
	t.Run("transitive optional reviewed dependency", func(t *testing.T) {
		root, pkg := fixture(t)
		lock := readObject(t, filepath.Join(root, "package-lock.json"))
		packages := packageEntries(lock)
		objectMap(packages["node_modules/json5"])["optionalDependencies"] = map[string]string{"json5": "2.2.3"}
		packages["node_modules/json5/node_modules/json5"] = map[string]any{
			"version": "2.2.3", "license": "MIT",
			"resolved": "https://registry.npmjs.org/json5/-/json5-2.2.3.tgz", "integrity": json5Integrity,
		}
		saveLock(t, root, lock)
		out, err := auditOutput(root, pkg)
		want := "License audit passed for 2 exact-version reviewed production dependency entries; LICENSE/NOTICE copies match.\n"
		if err != nil || out != want {
			t.Fatalf("output=%q error=%v", out, err)
		}
	})
	for _, name := range []string{"LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "NOTICE"} {
		t.Run("mismatch "+name, func(t *testing.T) {
			root, pkg := fixture(t)
			if err := os.WriteFile(filepath.Join(pkg, name), []byte("different"), 0600); err != nil {
				t.Fatal(err)
			}
			expectError(t, root, pkg, "Repository/framework notice mismatch: "+name)
		})
	}
	t.Run("missing notice IO", func(t *testing.T) {
		root, pkg := fixture(t)
		if err := os.Remove(filepath.Join(root, "NOTICE")); err != nil {
			t.Fatal(err)
		}
		_, err := auditOutput(root, pkg)
		if err == nil || !strings.Contains(err.Error(), "NOTICE") {
			t.Fatalf("expected NOTICE read error, got %v", err)
		}
	})
	t.Run("writer error", func(t *testing.T) {
		root, pkg := fixture(t)
		want := errors.New("writer failed")
		err := audit(root, pkg, errorWriter{want})
		if !errors.Is(err, want) {
			t.Fatalf("got %v, want propagated %v", err, want)
		}
	})
}

type errorWriter struct{ err error }

func (w errorWriter) Write([]byte) (int, error) {
	return 0, w.err
}

func TestScopedDependencyIdentityCannotBorrowJson5Review(t *testing.T) {
	root, pkg := fixture(t)
	out, err := auditOutput(root, pkg)
	want := "License audit passed for 1 exact-version reviewed production dependency entries; LICENSE/NOTICE copies match.\n"
	if err != nil || out != want {
		t.Fatalf("output=%q error=%v", out, err)
	}

	name := "@evilnode_modules/json5"
	message := "No exact-version reviewed provenance for " + name + "@2.2.3"
	for _, tc := range []struct {
		name, path, section string
		rootEdge            bool
	}{
		{"root required", "node_modules/" + name, "dependencies", true},
		{"root optional", "node_modules/" + name, "optionalDependencies", true},
		{"transitive required hoisted", "node_modules/" + name, "dependencies", false},
		{"transitive required nested", "node_modules/json5/node_modules/" + name, "dependencies", false},
		{"transitive optional nested", "node_modules/json5/node_modules/" + name, "optionalDependencies", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, pkg := fixture(t)
			lock := readObject(t, filepath.Join(root, "package-lock.json"))
			manifest := readObject(t, filepath.Join(pkg, "package.json"))
			packages := packageEntries(lock)
			original := objectMap(packages["node_modules/json5"])
			forged := make(map[string]any, len(original))
			for key, value := range original {
				forged[key] = value
			}
			packages[tc.path] = forged
			if tc.rootEdge {
				manifest["dependencies"] = map[string]string{}
				manifest["optionalDependencies"] = map[string]string{}
				manifest[tc.section] = map[string]string{name: "2.2.3"}
				rootEntry := objectMap(packages[""])
				rootEntry["dependencies"] = map[string]string{}
				rootEntry["optionalDependencies"] = map[string]string{}
				rootEntry[tc.section] = map[string]string{name: "2.2.3"}
				delete(packages, "node_modules/json5")
				saveManifest(t, pkg, manifest)
			} else {
				original[tc.section] = map[string]string{name: "2.2.3"}
			}
			saveLock(t, root, lock)
			expectError(t, root, pkg, message)
		})
	}
}

func TestVisitedPathCannotHideIdentityMismatch(t *testing.T) {
	root, _ := fixture(t)
	lockPath := filepath.Join(root, "package-lock.json")
	var lock object
	if err := parseJSON(lockPath, &lock); err != nil {
		t.Fatal(err)
	}
	packages, err := fields(lock["packages"])
	if err != nil {
		t.Fatal(err)
	}

	visited, err := walkPackages(packages, []dependencyEntry{{name: "json5", path: "node_modules/json5"}})
	if err != nil {
		t.Fatalf("valid first entry failed: %v", err)
	}
	if !visited["node_modules/json5"] || len(visited) != 1 {
		t.Fatalf("visited = %v, want only node_modules/json5", visited)
	}

	_, err = walkPackages(packages, []dependencyEntry{
		{name: "json5", path: "node_modules/json5"},
		{name: "@other/json5", path: "node_modules/json5"},
	})
	want := "Unsupported or incomplete resolved/integrity lock metadata: node_modules/json5"
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
}

func TestMalformedDependencyNamesRefused(t *testing.T) {
	for _, bad := range []string{"", "/json5", "json5/extra", "@scope/json5/extra", "@/json5", "@scope/", "./json5", "../json5", "@scope/../json5", "json5\\extra", "@scope%2f/json5", "json5:other", "json5 other"} {
		for _, transitive := range []bool{false, true} {
			mode := "root"
			if transitive {
				mode = "transitive"
			}
			t.Run(mode+"/"+bad, func(t *testing.T) {
				root, pkg := fixture(t)
				lock := readObject(t, filepath.Join(root, "package-lock.json"))
				manifest := readObject(t, filepath.Join(pkg, "package.json"))
				packages := packageEntries(lock)
				original := objectMap(packages["node_modules/json5"])
				forged := make(map[string]any, len(original))
				for key, value := range original {
					forged[key] = value
				}
				if transitive {
					original["dependencies"] = map[string]string{bad: "2.2.3"}
					packages["node_modules/json5/node_modules/"+bad] = forged
				} else {
					manifest["dependencies"] = map[string]string{bad: "2.2.3"}
					objectMap(packages[""])["dependencies"] = map[string]string{bad: "2.2.3"}
					packages["node_modules/"+bad] = forged
				}
				saveLock(t, root, lock)
				saveManifest(t, pkg, manifest)
				expectError(t, root, pkg, "Unsupported dependency name: "+bad)
			})
		}
	}
}

func TestAnchoredPackageName(t *testing.T) {
	path := "node_modules/@evilnode_modules/json5"
	if got := packageName(path); got != "@evilnode_modules/json5" {
		t.Fatalf("packageName(%q) = %q", path, got)
	}
}

func TestBoundaryJSONDepthAndInputLimit(t *testing.T) {
	t.Run("depth exact and over, arrays unmarshaled to any", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "input.json")
		for _, tc := range []struct {
			n  int
			ok bool
		}{{maxDepth, true}, {maxDepth + 1, false}} {
			data := []byte(strings.Repeat("[", tc.n) + "0" + strings.Repeat("]", tc.n))
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			var value any
			err := parseJSON(path, &value)
			if (err == nil) != tc.ok {
				t.Errorf("nesting %d: value type %T, error %v", tc.n, value, err)
			}
			if tc.ok {
				v := value
				for i := 0; i < tc.n; i++ {
					a, ok := v.([]any)
					if !ok || len(a) != 1 {
						t.Fatalf("nesting %d did not decode as nested array", tc.n)
					}
					v = a[0]
				}
			}
		}
	})
	t.Run("exact input size and one byte over", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "input.json")
		for _, tc := range []struct {
			name string
			data []byte
			ok   bool
		}{
			{"exact", append([]byte("{}"), bytes.Repeat([]byte(" "), maxInput-2)...), true},
			{"over", append([]byte("{}"), bytes.Repeat([]byte(" "), maxInput-1)...), false},
		} {
			if err := os.WriteFile(path, tc.data, 0600); err != nil {
				t.Fatal(err)
			}
			var value any
			err := parseJSON(path, &value)
			if (err == nil) != tc.ok {
				t.Errorf("%s size %d: error %v", tc.name, len(tc.data), err)
			}
		}
	})
}
