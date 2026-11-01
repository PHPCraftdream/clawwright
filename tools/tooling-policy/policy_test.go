package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestClassification(t *testing.T) {
	cases := map[string]string{
		"tools/a.ts": "implementation",
		"tools/a.sh": "implementation",
		"tools/a.ps1": "implementation",
		"tools/a.c": "implementation",
		"tools/a.h": "implementation",
		"tools/a.py": "implementation",
		"tools/a.rs": "implementation",
		"tools/go.mod": "metadata",
		"tools/.env.example": "metadata",
		"tools/LICENSE": "metadata",
		"tools/a.json": "data",
		"tools/a.bin": "unknown",
	}
	for name, want := range cases {
		if got := classify(name); got != want {
			t.Errorf("classify(%q)=%q, want %q", name, got, want)
		}
	}
}

func TestLineCountingPhysicalLines(t *testing.T) {
	cases := []struct {
		data string
		want int
	}{
		{"", 0},
		{"one", 1},
		{"one\n", 1},
		{"one\ntwo", 2},
		{"one\ntwo\n", 2},
	}
	for _, tc := range cases {
		if got := lineCount([]byte(tc.data)); got != tc.want {
			t.Errorf("lineCount(%q)=%d, want %d", tc.data, got, tc.want)
		}
	}
}

func TestLineCeilingSeparatesReportFromViolations(t *testing.T) {
	cases := []struct {
		count        int
		wantViolation bool
		wantDebt      bool
	}{
		{700, false, false},
		{701, true, false},
	}
	for _, tc := range cases {
		current := map[string]inventory{
			"tools/a.go": {mode: "100644", blob: "current"},
		}
		result := evaluate(current, nil, func(inventory) (int, error) {
			return tc.count, nil
		})
		if got := len(result.Violations) > 0; got != tc.wantViolation {
			t.Errorf("%d lines violation=%v, want %v", tc.count, got, tc.wantViolation)
		}
		if got := len(result.Debt) > 0; got != tc.wantDebt {
			t.Errorf("%d lines debt=%v, want %v", tc.count, got, tc.wantDebt)
		}
	}
}

func TestImmediateDirectoryEntriesCompareCurrentAndLegacy(t *testing.T) {
	cases := []struct {
		name string
		count int
		legacyCount int
		wantViolation bool
		wantDebt bool
	}{
		{"at limit", 7, 0, false, false},
		{"new over limit", 8, 0, true, false},
		{"grandfathered unchanged", 8, 8, false, true},
		{"new child while debt remains", 8, 8, true, false},
		{"legacy count reduced", 8, 9, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			current := directoryFixture(tc.count)
			legacy := directoryFixture(tc.legacyCount)
			if tc.name == "new child while debt remains" {
				delete(legacy, "tools/a/file0.go")
				legacy["tools/a/legacy.go"] = inventory{mode: "100644", blob: "old"}
			}
			result := evaluate(current, legacy, func(inventory) (int, error) {
				return 1, nil
			})
			if got := len(result.Violations) > 0; got != tc.wantViolation {
				t.Fatalf("violations=%v", result.Violations)
			}
			if got := len(result.Debt) > 0; got != tc.wantDebt {
				t.Fatalf("debt=%v", result.Debt)
			}
		})
	}
}

func directoryFixture(count int) map[string]inventory {
	items := make(map[string]inventory)
	for i := 0; i < count; i++ {
		name := fmt.Sprintf("tools/a/file%d.go", i)
		items[name] = inventory{mode: "100644", blob: "same"}
	}
	return items
}

func TestBaselineRatchets(t *testing.T) {
	baseline := map[string]inventory{
		"tools/large.py": {mode: "100644", blob: "large"},
		"tools/unchanged.ts": {mode: "100644", blob: "same"},
	}
	cases := []struct {
		name string
		path string
		blob string
		count int
		wantViolation bool
		wantDebt bool
	}{
		{"Go at ceiling", "tools/new.go", "new", 700, false, false},
		{"new Go over ceiling", "tools/new.go", "new", 701, true, false},
		{"oversized Go without baseline", "tools/large.go", "large", 701, true, false},
		{"unchanged non-Go frozen", "tools/unchanged.ts", "same", 1, false, true},
		{"changed non-Go", "tools/unchanged.ts", "changed", 1, true, false},
		{"new non-Go", "tools/new.py", "new", 1, true, false},
		{"new metadata", "tools/config.toml", "new", 900, false, false},
		{"unknown", "tools/file.bin", "new", 1, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			current := map[string]inventory{
				tc.path: {mode: "100644", blob: tc.blob},
			}
			result := evaluate(current, baseline, func(item inventory) (int, error) {
				if item.blob == "large" {
					return 800, nil
				}
				return tc.count, nil
			})
			if got := len(result.Violations) > 0; got != tc.wantViolation {
				t.Fatalf("violations=%v", result.Violations)
			}
			if got := len(result.Debt) > 0; got != tc.wantDebt {
				t.Fatalf("debt=%v", result.Debt)
			}
		})
	}
}

func TestGoBaselineCeilingRatchet(t *testing.T) {
	legacy := map[string]inventory{"tools/large.go": {mode: "100644", blob: "old"}}
	cases := []struct {
		name string
		count int
		wantViolation, wantDebt bool
	}{
		{"unchanged 800", 800, false, true},
		{"reduced 750", 750, false, true},
		{"new blob 800", 800, false, true},
		{"increased 801", 801, true, false},
		{"reduced 700", 700, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			current := map[string]inventory{"tools/large.go": {mode: "100644", blob: "new"}}
			if tc.name == "unchanged 800" {
				current["tools/large.go"] = legacy["tools/large.go"]
			}
			got := evaluate(current, legacy, func(item inventory) (int, error) {
				if item.blob == "old" {
					return 800, nil
				}
				return tc.count, nil
			})
			if (len(got.Violations) > 0) != tc.wantViolation || (len(got.Debt) > 0) != tc.wantDebt {
				t.Fatalf("report=%+v", got)
			}
		})
	}
}

func TestDirectoryEntriesIgnoreRepositoryOutsideTools(t *testing.T) {
	items := map[string]inventory{"tools/a.go": {mode: "100644"}}
	for i := 0; i < 20; i++ {
		items[fmt.Sprintf("docs/section%d/file.md", i)] = inventory{mode: "100644"}
	}
	entries := directoryEntries(items)
	if len(entries) != 1 || len(entries["tools"]) != 1 {
		t.Fatalf("out-of-scope directory entries included: %v", entries)
	}
}

func TestNestedDirectoryFilesCountTowardParentLimit(t *testing.T) {
	cases := []struct {
		name          string
		fileCount     int
		wantViolation bool
	}{
		{"eight entries violate", 7, true},
		{"seven entries allowed", 6, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			current := directoryFixture(tc.fileCount)
			current["tools/a/nested/leaf.go"] = inventory{mode: "100644", blob: "same"}
			result := evaluate(current, nil, func(inventory) (int, error) {
				return 1, nil
			})
			if got := len(result.Violations) > 0; got != tc.wantViolation {
				t.Fatalf("violations=%v, want violation=%v", result.Violations, tc.wantViolation)
			}
		})
	}
}

func TestEvaluatorRejectsNewNonGoAndSymlinkSubmodule(t *testing.T) {
	legacy := map[string]inventory{"tools/existing.sh": {mode: "100644", blob: "same"}}
	current := map[string]inventory{
		"tools/new.sh": {mode: "100644", blob: "new"},
		"tools/new.py": {mode: "100644", blob: "new"},
		"tools/new.c": {mode: "100644", blob: "new"},
		"tools/new.rs": {mode: "100644", blob: "new"},
		"tools/link.go": {mode: "120000", blob: "link"},
		"tools/submodule": {mode: "160000", blob: "commit"},
	}
	got := evaluate(current, legacy, func(inventory) (int, error) { return 1, nil })
	if len(got.Violations) != len(current) {
		t.Fatalf("violations=%v", got.Violations)
	}
}

func TestEvaluatorIgnoresRepositoryPathsOutsideTools(t *testing.T) {
	current := map[string]inventory{"tools/a.go": {mode: "100644", blob: "same"}}
	legacy := map[string]inventory{}
	for i := 0; i < 20; i++ {
		name := fmt.Sprintf("docs/section%d/file.md", i)
		current[name] = inventory{mode: "100644", blob: "new"}
		legacy[name] = inventory{mode: "100644", blob: "old"}
	}
	got := evaluate(current, legacy, func(inventory) (int, error) { return 1, nil })
	if len(got.Violations) != 0 || len(got.Debt) != 0 {
		t.Fatalf("out-of-scope paths affected report: %+v", got)
	}
}

func TestGitRecordParsing(t *testing.T) {
	validOID := strings.Repeat("a", 40)
	validIndex := []byte("100644 " + validOID + " 0\ttools/a file.go\x00")
	index, err := parseRecords(validIndex, false)
	if err != nil || len(index) != 1 {
		t.Fatalf("valid index parse: items=%v err=%v", index, err)
	}
	validTree := []byte("100644 blob " + validOID + "\ttools/a file.go\x00")
	tree, err := parseRecords(validTree, true)
	if err != nil || len(tree) != 1 {
		t.Fatalf("valid tree parse: items=%v err=%v", tree, err)
	}
	badCases := []struct {
		name string
		raw []byte
		tree bool
		category string
	}{
		{"malformed", []byte("100644 blob\x00"), true, "malformed Git record"},
		{"truncated", []byte("100644 blob " + validOID + "\tpath"), true, "truncated"},
		{"duplicate", []byte("100644 blob " + validOID + "\ta\x00100644 blob " + validOID + "\ta\x00"), true, "duplicate path"},
		{"invalid mode", []byte("100600 blob " + validOID + "\ta\x00"), true, "invalid tree mode"},
		{"invalid object type", []byte("100644 tree " + validOID + "\ta\x00"), true, "invalid tree object type"},
		{"non-hex oid", []byte("100644 blob " + strings.Repeat("z", 40) + "\ta\x00"), true, "invalid object id"},
		{"short oid", []byte("100644 blob abc\ta\x00"), true, "invalid object id"},
		{"index stage", []byte("100644 " + validOID + " 2\ta\x00"), false, "unmerged index stage"},
		{"index mode", []byte("100600 " + validOID + " 0\ta\x00"), false, "invalid index mode"},
	}
	for _, tc := range badCases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseRecords(tc.raw, tc.tree)
			if err == nil || !strings.Contains(err.Error(), tc.category) {
				t.Fatalf("error=%v, want category %q", err, tc.category)
			}
		})
	}
}

func TestUnreadableBlobIsViolation(t *testing.T) {
	current := map[string]inventory{
		"tools/a.go": {mode: "100644", blob: "missing"},
	}
	result := evaluate(current, nil, func(inventory) (int, error) {
		return 0, fmt.Errorf("missing blob")
	})
	if len(result.Violations) != 1 || !strings.Contains(result.Violations[0], "unreadable blob") {
		t.Fatalf("violations=%v", result.Violations)
	}
}
