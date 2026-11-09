package textstreamchecks

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestOperationClientDeployIsTwoPassAndNeverRetries(t *testing.T) {
	for _, test := range []struct {
		mode, status string
		err          bool
		executions   int32
	}{
		{"success", "received", false, 1},
		{"empty", "received", false, 1},
		{"changed-source", "unknown", false, 1},
		{"lost-reply", "unknown", false, 1},
		{"withheld", "withheld", false, 0},
		{"malformed-prepare", "", true, 0},
		{"duplicate-prepare", "", true, 0},
		{"duplicate-execute", "unknown", false, 1},
	} {
		t.Run(test.mode, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "template")
			input := join(bytes.Repeat([]byte("large synthetic template\n"), 50000), []byte(canonicalReference()))
			if test.mode == "empty" {
				input = nil
			}
			if err := os.WriteFile(path, input, 0600); err != nil {
				t.Fatal(err)
			}
			fixture := newOperationFixture(t, "deploy", test.mode, path, input)
			status, err := runOperationClient(t, fixture, "deploy", map[string]any{"profile": "selected", "file": "/approved/config", "references": []string{canonicalReference()}, "template": path})
			if (err != nil) != test.err || status != test.status {
				t.Fatal("deploy result did not preserve pre-run versus dispatched uncertainty")
			}
			if fixture.prepare.Load() != 1 || fixture.execute.Load() != test.executions || fixture.reverse.Load() != 0 {
				t.Fatal("deploy retried or crossed direction")
			}
			if test.mode == "changed-source" {
				input[0] = 'L'
			}
			stored, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(stored, input) {
				t.Fatal("client modified its template file")
			}
		})
	}
}

func TestOperationClientBackupPublishesOnlyCompleteCorrelatedCopy(t *testing.T) {
	for _, test := range []struct {
		mode, status string
		exists       bool
	}{
		{"success", "received", true},
		{"empty", "received", true},
		{"withheld", "withheld", false},
		{"lost-completion", "unknown", false},
		{"late-nul", "unknown", false},
		{"wrong-operation", "unknown", false},
		{"existing-output", "unknown", true},
	} {
		t.Run(test.mode, func(t *testing.T) {
			parent := t.TempDir()
			output := filepath.Join(parent, "copy")
			input := join(bytes.Repeat([]byte("large reference-only copy\n"), 50000), []byte(canonicalReference()))
			if test.mode == "empty" {
				input = nil
			}
			if test.mode == "existing-output" {
				if err := os.WriteFile(output, []byte("preserved"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			fixture := newOperationFixture(t, "backup", test.mode, "", input)
			status, err := runOperationClient(t, fixture, "backup", map[string]any{"profile": "selected", "file": "/approved/config", "references": []string{canonicalReference()}, "output": output})
			if err != nil || status != test.status || fixture.reverse.Load() != 1 || fixture.prepare.Load() != 0 || fixture.execute.Load() != 0 {
				t.Fatal("backup result retried, crossed direction or lost uncertainty")
			}
			if test.exists {
				want := input
				if test.mode == "existing-output" {
					want = []byte("preserved")
				}
				stored, err := os.ReadFile(output)
				if err != nil || !bytes.Equal(stored, want) {
					t.Fatal("backup did not preserve exact exclusive output bytes")
				}
			} else if _, err := os.Lstat(output); !os.IsNotExist(err) {
				t.Fatal("failed backup published an output")
			}
			assertNoStaging(t, parent)
		})
	}
}

func TestOperationClientScopeAdmissionDoesNotContactHTTP(t *testing.T) {
	fixture := newOperationFixture(t, "deploy", "success", "", nil)
	for _, refs := range [][]string{{"not-a-reference"}, {canonicalReference(), canonicalReference()}} {
		if _, err := runOperationClient(t, fixture, "deploy", map[string]any{"profile": "selected", "file": "/approved/config", "references": refs, "template": "unused"}); err == nil {
			t.Fatal("invalid refs were admitted")
		}
	}
	if _, err := runOperationClient(t, fixture, "deploy", map[string]any{"profile": "other", "file": "/approved/config", "references": []string{canonicalReference()}, "template": "unused"}); err == nil {
		t.Fatal("another profile was admitted")
	}
	if fixture.requests.Load() != 0 {
		t.Fatal("metadata admission failure contacted the keeper")
	}
}
