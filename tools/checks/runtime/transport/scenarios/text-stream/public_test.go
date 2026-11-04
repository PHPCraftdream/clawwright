package textstreamchecks

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublicRecipeStreamHelpersUseOwningClient(t *testing.T) {
	for _, test := range []struct{ action, mode, status string }{
		{"deploy", "success", "received"},
		{"deploy", "lost-reply", "unknown"},
		{"backup", "success", "received"},
		{"backup", "lost-completion", "unknown"},
	} {
		t.Run(test.action+"-"+test.mode, func(t *testing.T) {
			parent := t.TempDir()
			template, output := filepath.Join(parent, "template"), filepath.Join(parent, "copy")
			input := join(bytes.Repeat([]byte("large public recipe config\n"), 50000), []byte(canonicalReference()))
			if err := os.WriteFile(template, input, 0600); err != nil {
				t.Fatal(err)
			}
			fixture := newOperationFixture(t, test.action, test.mode, template, input)
			status, err := runOperationClient(t, fixture, test.action, map[string]any{"profile": "selected", "file": "/approved/config", "references": []string{canonicalReference()}, "template": template, "output": output}, true)
			if err != nil || status != test.status {
				t.Fatalf("public helper lost its delivery result: %v", err)
			}
			if test.action == "deploy" {
				if fixture.prepare.Load() != 1 || fixture.execute.Load() != 1 || fixture.reverse.Load() != 0 {
					t.Fatal("public deploy bypassed, retried or crossed its capability")
				}
			} else {
				if fixture.reverse.Load() != 1 || fixture.prepare.Load() != 0 || fixture.execute.Load() != 0 {
					t.Fatal("public backup bypassed, retried or crossed its capability")
				}
				if test.status == "received" {
					stored, err := os.ReadFile(output)
					if err != nil || !bytes.Equal(stored, input) {
						t.Fatal("public backup did not publish exact reference-only bytes")
					}
				} else if _, err := os.Lstat(output); !os.IsNotExist(err) {
					t.Fatal("unknown public backup published a file")
				}
			}
			stored, err := os.ReadFile(template)
			if err != nil || !bytes.Equal(stored, input) {
				t.Fatal("public helper rewrote its source")
			}
			assertNoStaging(t, parent)
		})
	}
}

func TestPublicRecipeStreamDryRunRefusesBeforeTransport(t *testing.T) {
	for _, action := range []string{"deploy", "backup"} {
		fixture := newOperationFixture(t, action, "success", "", nil)
		_, err := runOperationClient(t, fixture, action, map[string]any{"profile": "selected", "file": "/approved/config", "references": []string{canonicalReference()}, "template": "unused", "output": "unused", "dryRun": true}, true)
		if err == nil || !strings.Contains(err.Error(), "recipe-kit refused: invalid-request") || fixture.requests.Load() != 0 {
			t.Fatal("dry-run stream helper contacted transport or changed its refusal category")
		}
	}
}
