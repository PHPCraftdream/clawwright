package textstreamchecks

import (
	"bytes"
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const fileBridge = `
import {pathToFileURL} from "node:url";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";
const url = pathToFileURL(process.argv[1]);
const files = await import(url.href);
if (process.argv[2] === "read") {
  const source = await files.TextStreamTemplate.open(process.argv[3]);
  try { for (let pass = 0; pass < 2; pass += 1) await pipeline(Readable.from(source.read()), process.stdout, {end: false}); }
  finally { await source.close(); }
} else {
  const frames = await import(new URL("./frames.ts", url).href);
  await files.publishTextStreamCopy(process.argv[3], frames.decodeTextFrames(process.stdin, process.argv[4]));
}
`

func fileOperation(t *testing.T, mode, path string, input []byte) ([]byte, error) {
	t.Helper()
	module, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "..", "..", "packages", "clawwright", "runtime", "transport", "remote", "text", "stream", "files.ts"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "--experimental-strip-types", "--input-type=module", "-e", fileBridge, module, mode, path, operation)
	command.Stdin = bytes.NewReader(input)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err = command.Run()
	if ctx.Err() != nil {
		t.Fatal("file operation did not join before its deadline")
	}
	if err != nil && !bytes.Contains(stderr.Bytes(), []byte("SSJACK_TEXT_STREAM_FILE_FAILED")) {
		t.Fatalf("file bridge failed outside the expected refusal: %s", stderr.Bytes())
	}
	return stdout.Bytes(), err
}

func framed(t *testing.T, input []byte, terminal bool) []byte {
	t.Helper()
	var output []byte
	sequence, total := 0, len(input)
	for len(input) != 0 {
		n := min(32768, len(input))
		output = append(output, record(t, map[string]any{"type": "data", "operation_id": operation, "sequence": sequence, "data": base64.StdEncoding.EncodeToString(input[:n])})...)
		input = input[n:]
		sequence++
	}
	if terminal {
		output = append(output, complete(t, total, sequence)...)
	}
	return output
}

func TestStreamFilesLargeExactCopyAndNoOverwrite(t *testing.T) {
	parent := t.TempDir()
	source, destination := filepath.Join(parent, "source"), filepath.Join(parent, "copy")
	input := bytes.Repeat([]byte("synthetic reference-only config\n"), 60000)
	if err := os.WriteFile(source, input, 0600); err != nil {
		t.Fatal(err)
	}
	got, err := fileOperation(t, "read", source, nil)
	if err != nil || len(got) <= 1<<20 || !bytes.Equal(got, join(input, input)) {
		t.Fatal("bounded template read changed a large file")
	}
	if _, err := fileOperation(t, "copy", destination, framed(t, input, true)); err != nil {
		t.Fatal("complete framed copy was not published")
	}
	copied, err := os.ReadFile(destination)
	if err != nil || !bytes.Equal(copied, input) {
		t.Fatal("published stream copy changed the bytes")
	}
	if _, err := fileOperation(t, "copy", destination, framed(t, []byte("replacement"), true)); err == nil {
		t.Fatal("existing output was replaced")
	}
	copied, err = os.ReadFile(destination)
	if err != nil || !bytes.Equal(copied, input) {
		t.Fatal("failed publication modified the existing output")
	}
	original, err := os.ReadFile(source)
	if err != nil || !bytes.Equal(original, input) {
		t.Fatal("copy changed the source")
	}
	assertNoStaging(t, parent)
}

func TestStreamTemplateRefusesNonRegularAndMalformedInput(t *testing.T) {
	parent := t.TempDir()
	if _, err := fileOperation(t, "read", parent, nil); err == nil {
		t.Fatal("template reader accepted a directory")
	}
	for name, value := range map[string][]byte{"nul": {0}, "invalid": {255}, "truncated": {226, 130}} {
		path := filepath.Join(parent, name)
		if err := os.WriteFile(path, value, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := fileOperation(t, "read", path, nil); err == nil {
			t.Fatal("template reader accepted malformed text")
		}
	}
}

func assertNoStaging(t *testing.T, parent string) {
	t.Helper()
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".clawwright-text-") {
			t.Fatal("stream operation left a tentative operator artifact")
		}
	}
}

func TestStreamFilesRejectLateInvalidOrIncompleteCopies(t *testing.T) {
	prefix := bytes.Repeat([]byte("synthetic prefix\n"), 70000)
	for _, test := range []struct {
		name     string
		tail     []byte
		terminal bool
	}{
		{"missing-completion", nil, false},
		{"invalid-utf8", []byte{255}, true},
		{"truncated-utf8", []byte{226, 130}, true},
		{"nul", []byte{0}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			parent := t.TempDir()
			destination := filepath.Join(parent, "copy")
			input := join(prefix, test.tail)
			if _, err := fileOperation(t, "copy", destination, framed(t, input, test.terminal)); err == nil {
				t.Fatal("late failure published a copied file")
			}
			if _, err := os.Lstat(destination); !os.IsNotExist(err) {
				t.Fatal("late refusal left an output")
			}
			assertNoStaging(t, parent)
		})
	}
}
