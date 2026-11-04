package textstreamchecks

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

const registeredCommandBridge = `
import {pathToFileURL} from "node:url";
const base = pathToFileURL(process.argv[1]);
const {executeCommand} = await import(new URL("../../../../../core/command/execute.ts", base).href);
const {orchestrationCommands} = await import(new URL("../../../../../commands/interface/groups/openclawCommands.orchestration.ts", base).href);
const {withOutputSink} = await import(new URL("../../../../../core/io/output.ts", base).href);
const pieces = []; for await (const piece of process.stdin) pieces.push(piece);
const input = JSON.parse(Buffer.concat(pieces).toString("utf8"));
for (const key of ["SSJACK_TEXT_ENDPOINT", "SSJACK_TEXT_TOKEN", "SSJACK_TEXT_CERTIFICATE_SHA256"]) delete process.env[key];
process.env.SSJACK_TEXT_LAUNCH = "1";
process.env.SSJACK_APP_ENDPOINT = input.bootstrap.endpoint;
process.env.SSJACK_APP_TOKEN = input.bootstrap.token;
process.env.SSJACK_APP_CERTIFICATE_SHA256 = input.bootstrap.pin;
process.env.SSJACK_TEXT_PROFILE = "selected";
const output = [];
const app = {name: "fixture", description: "fixture", commands: orchestrationCommands};
const result = await withOutputSink(chunk => output.push(chunk), () => executeCommand(app, input.command, {kind: "argv", argv: input.argv}, {surface: "terminal"}));
process.stdout.write(JSON.stringify({stage: result.stage, reachedRun: result.reachedRun, exitCode: result.exitCode ?? 0, error: result.error?.message ?? "", output: output.join("")}));
`

type registeredCommandResult struct {
	Stage      string `json:"stage"`
	ReachedRun bool   `json:"reachedRun"`
	ExitCode   int    `json:"exitCode"`
	Error      string `json:"error"`
	Output     string `json:"output"`
}

func runRegisteredCommand(t *testing.T, fixture *operationFixture, commandName string, argv []string) registeredCommandResult {
	t.Helper()
	digest := sha256.Sum256(fixture.server.Certificate().Raw)
	input, err := json.Marshal(map[string]any{"bootstrap": map[string]string{"endpoint": fixture.server.URL + "/mcp", "token": strings.Repeat("a", 64), "pin": hex.EncodeToString(digest[:])}, "command": commandName, "argv": argv})
	if err != nil {
		t.Fatal(err)
	}
	module, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "..", "..", "packages", "clawwright", "runtime", "transport", "remote", "text", "stream", "client.ts"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "--experimental-strip-types", "--input-type=module", "-e", registeredCommandBridge, module)
	command.Stdin = bytes.NewReader(input)
	var output, diagnostics bytes.Buffer
	command.Stdout, command.Stderr = &output, &diagnostics
	if err := command.Run(); err != nil {
		t.Fatalf("registered command did not finish: %s", diagnostics.Bytes())
	}
	var result registeredCommandResult
	if json.Unmarshal(output.Bytes(), &result) != nil {
		t.Fatal("registered command omitted its bounded result")
	}
	return result
}

func TestRegisteredStreamingCommandsTransferLargeFiles(t *testing.T) {
	for _, test := range []struct {
		action, mode, status string
		exit                 int
	}{
		{"deploy", "success", "received", 0}, {"deploy", "lost-reply", "unknown", 1},
		{"backup", "success", "received", 0}, {"backup", "lost-completion", "unknown", 1},
	} {
		t.Run(test.action+"-"+test.mode, func(t *testing.T) {
			parent := t.TempDir()
			template, output, refs := filepath.Join(parent, "template"), filepath.Join(parent, "copy"), filepath.Join(parent, "refs.json")
			input := join(bytes.Repeat([]byte("large registered command config\n"), 50000), []byte(canonicalReference()))
			if err := os.WriteFile(template, input, 0600); err != nil {
				t.Fatal(err)
			}
			references, err := json.Marshal([]string{canonicalReference()})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(refs, references, 0600); err != nil {
				t.Fatal(err)
			}
			fixture := newOperationFixture(t, test.action, test.mode, template, input)
			argv := []string{"--file", "/approved/config", "--profile", "selected", "--stream", "--references", refs}
			if test.action == "deploy" {
				argv = append(argv, "--template", template)
			} else {
				argv = append(argv, "--output", output)
			}
			result := runRegisteredCommand(t, fixture, test.action+"-text", argv)
			if !result.ReachedRun || result.Stage != "run" || result.ExitCode != test.exit || result.Output != "{\"status\":\""+test.status+"\"}\n" {
				t.Fatalf("registered command lost delivery/exit status: %+v", result)
			}
			if test.exit == 0 && result.Error != "" {
				t.Fatal("successful command reported an error")
			}
			if test.action == "deploy" {
				if fixture.prepare.Load() != 1 || fixture.execute.Load() != 1 {
					t.Fatal("registered deploy bypassed or retried its client")
				}
			} else {
				if fixture.reverse.Load() != 1 {
					t.Fatal("registered backup bypassed or retried its client")
				}
				if test.exit == 0 {
					stored, err := os.ReadFile(output)
					if err != nil || !bytes.Equal(stored, input) {
						t.Fatal("registered backup did not publish exact bytes")
					}
				} else if _, err := os.Lstat(output); !os.IsNotExist(err) {
					t.Fatal("incomplete registered backup published output")
				}
			}
			assertNoStaging(t, parent)
		})
	}
}

func TestRegisteredStreamingFlagsAreExplicitlyPaired(t *testing.T) {
	for _, commandName := range []string{"deploy-text", "backup-text"} {
		fixture := newOperationFixture(t, "deploy", "success", "", nil)
		base := []string{"--file", "/approved/config", "--profile", "selected"}
		if commandName == "deploy-text" {
			base = append(base, "--template", "unused")
		} else {
			base = append(base, "--output", "unused")
		}
		for _, extra := range [][]string{{"--stream"}, {"--references", "unused"}} {
			argv := append(append([]string(nil), base...), extra...)
			result := runRegisteredCommand(t, fixture, commandName, argv)
			if result.ReachedRun || result.Stage != "prepare" || !strings.Contains(result.Error, "SSJACK_TEXT_OPERATION_FAILED") || fixture.requests.Load() != 0 {
				t.Fatal("unpaired stream selection contacted transport or silently used v1")
			}
		}
	}
}

func TestRegisteredStreamingMetadataRefusesBeforeHTTP(t *testing.T) {
	good, err := json.Marshal([]string{canonicalReference()})
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"deploy", "backup"} {
		for _, body := range [][]byte{[]byte("not-json"), []byte("[]"), []byte(`["not-a-ref"]`), append(append([]byte(nil), good...), bytes.Repeat([]byte(" "), 16385-len(good))...)} {
			parent := t.TempDir()
			template, output, refs := filepath.Join(parent, "template"), filepath.Join(parent, "copy"), filepath.Join(parent, "refs.json")
			input := []byte(canonicalReference())
			if err := os.WriteFile(template, input, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(refs, body, 0600); err != nil {
				t.Fatal(err)
			}
			fixture := newOperationFixture(t, action, "success", template, input)
			argv := []string{"--file", "/approved/config", "--profile", "selected", "--stream", "--references", refs}
			if action == "deploy" {
				argv = append(argv, "--template", template)
			} else {
				argv = append(argv, "--output", output)
			}
			result := runRegisteredCommand(t, fixture, action+"-text", argv)
			if !result.ReachedRun || !strings.Contains(result.Error, "SSJACK_TEXT_OPERATION_FAILED") || fixture.requests.Load() != 0 {
				t.Fatal("invalid or oversized reference metadata contacted HTTP")
			}
			if _, err := os.Lstat(output); !os.IsNotExist(err) {
				t.Fatal("metadata refusal created an output")
			}
			assertNoStaging(t, parent)
		}
	}
}
