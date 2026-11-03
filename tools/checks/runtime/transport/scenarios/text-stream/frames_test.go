package textstreamchecks

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

const operation = "AAECAwQFBgcICQoLDA0ODw"

// The bridge only adapts byte streams to the actual TypeScript generator.
const bridge = `
import {pathToFileURL} from "node:url";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";
const module = await import(pathToFileURL(process.argv[1]).href);
const step = Number(process.argv[3]);
async function* input() {
  for await (const chunk of process.stdin) {
    for (let at = 0; at < chunk.length; at += step) yield chunk.subarray(at, at + step);
  }
}
await pipeline(Readable.from(module[process.argv[2]](input(), process.argv[4])), process.stdout);
`

func transform(t *testing.T, method string, input []byte, step int) ([]byte, error) {
	t.Helper()
	module, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "..", "..", "packages", "clawwright", "runtime", "transport", "remote", "text", "stream", "frames.ts"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "--experimental-strip-types", "--input-type=module", "-e", bridge, module, method, strconv.Itoa(step), operation)
	command.Stdin = bytes.NewReader(input)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err = command.Run()
	if ctx.Err() != nil {
		t.Fatal("TypeScript stream did not finish before its deadline")
	}
	if err != nil && !bytes.Contains(stderr.Bytes(), []byte("SSJACK_TEXT_STREAM_INVALID")) {
		t.Fatalf("TypeScript bridge failed outside the expected refusal: %s", stderr.Bytes())
	}
	return stdout.Bytes(), err
}

func record(t *testing.T, value map[string]any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return append(encoded, '\n')
}

func data(t *testing.T, value string) []byte {
	return record(t, map[string]any{"type": "data", "operation_id": operation, "sequence": 0, "data": value})
}

func complete(t *testing.T, size, frames int) []byte {
	return record(t, map[string]any{"type": "complete", "operation_id": operation, "sequence": frames, "bytes": size, "frames": frames})
}

func join(parts ...[]byte) []byte { return bytes.Join(parts, nil) }

func TestFramesLargeRoundTrip(t *testing.T) {
	input := bytes.Repeat([]byte("synthetic large config\n"), 100000)
	encoded, err := transform(t, "encodeTextFrames", input, 137)
	if err != nil {
		t.Fatal("large encoding failed")
	}
	decoded, err := transform(t, "decodeTextFrames", encoded, 113)
	if err != nil || len(decoded) <= 1<<20 || !bytes.Equal(decoded, input) {
		t.Fatal("large framed round trip changed or truncated the document")
	}
	decoded, err = transform(t, "decodeTextFrames", join(data(t, "YQ=="), complete(t, 1, 1)), 1)
	if err != nil || !bytes.Equal(decoded, []byte("a")) {
		t.Fatal("one-byte frame boundaries failed")
	}
}

func TestFramesEmptyRoundTrip(t *testing.T) {
	encoded, err := transform(t, "encodeTextFrames", nil, 32)
	if err != nil {
		t.Fatal("empty encoding failed")
	}
	decoded, err := transform(t, "decodeTextFrames", encoded, 1)
	if err != nil || len(decoded) != 0 || !bytes.Contains(encoded, []byte(`"complete"`)) {
		t.Fatal("empty framed document was not completed")
	}
}

func TestFramesRefuseMalformedOtherwiseCompleteInput(t *testing.T) {
	for _, test := range []struct {
		name string
		body []byte
	}{
		{"missing-completion", data(t, "YQ==")},
		{"trailing-byte", join(data(t, "YQ=="), complete(t, 1, 1), []byte("x"))},
		{"trailing-frame", join(data(t, "YQ=="), complete(t, 1, 1), data(t, "YQ=="))},
		{"wrong-count", join(data(t, "YQ=="), complete(t, 2, 1))},
		{"wrong-operation", join(bytes.Replace(data(t, "YQ=="), []byte(operation), []byte("another"), 1), complete(t, 1, 1))},
		{"wrong-sequence", join(bytes.Replace(data(t, "YQ=="), []byte(`"sequence":0`), []byte(`"sequence":1`), 1), complete(t, 1, 1))},
		{"null-sequence", join(bytes.Replace(data(t, "YQ=="), []byte(`"sequence":0`), []byte(`"sequence":null`), 1), complete(t, 1, 1))},
		{"unknown-field", join(record(t, map[string]any{"type": "data", "operation_id": operation, "sequence": 0, "data": "YQ==", "extra": 0}), complete(t, 1, 1))},
		{"duplicate-field", join([]byte(`{"type":"data","operation_id":"`+operation+`","sequence":0,"data":"Yg==","data":"YQ=="}`+"\n"), complete(t, 1, 1))},
		{"noncanonical-base64", join(data(t, "YR=="), complete(t, 1, 1))},
		{"missing-padding", join(data(t, "YQ"), complete(t, 1, 1))},
		{"empty-data", join(data(t, ""), complete(t, 0, 1))},
		{"oversized-data", join(data(t, base64.StdEncoding.EncodeToString(make([]byte, 32769))), complete(t, 32769, 1))},
		{"oversized-record", bytes.Repeat([]byte("x"), 49153)},
		{"invalid-utf8", join([]byte{255, 10}, complete(t, 0, 0))},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := transform(t, "decodeTextFrames", test.body, 16384); err == nil {
				t.Fatal("malformed framed document was accepted")
			}
		})
	}
}
