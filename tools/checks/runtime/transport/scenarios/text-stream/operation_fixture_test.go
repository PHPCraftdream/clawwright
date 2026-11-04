package textstreamchecks

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const operationBridge = `
import {pathToFileURL} from "node:url";
const module = await import(pathToFileURL(process.argv[1]).href);
const pieces = []; for await (const piece of process.stdin) pieces.push(piece);
const input = JSON.parse(Buffer.concat(pieces).toString("utf8"));
const client = new module.SsjackTextStreamClient(input.bootstrap, input.capability);
const status = await client[input.action](input.selection, {timeoutMs: 30000});
process.stdout.write(JSON.stringify({status}));
`

func canonicalReference() string {
	return `{"$ssjack":{"format":"ssjack-secret-ref-v1","object_id":"` + strings.Repeat("1", 32) + `","snapshot_id":"` + strings.Repeat("2", 32) + `","store_id":"` + strings.Repeat("3", 32) + `","version_id":"` + strings.Repeat("4", 32) + `"}}`
}

type operationFixture struct {
	server            *httptest.Server
	prepare, execute  atomic.Int32
	reverse, requests atomic.Int32
}

func newOperationFixture(t *testing.T, action, mode, template string, original []byte) *operationFixture {
	t.Helper()
	fixture := &operationFixture{}
	fixture.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.requests.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("a", 64) {
			t.Error("missing exact bearer")
			w.WriteHeader(403)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/mcp" {
			var rpc struct {
				ID     any            `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if json.NewDecoder(r.Body).Decode(&rpc) != nil {
				t.Error("invalid MCP request")
				w.WriteHeader(400)
				return
			}
			if rpc.Method == "notifications/initialized" {
				w.WriteHeader(202)
				return
			}
			var result any = map[string]any{"protocolVersion": "2025-06-18"}
			if rpc.Method == "tools/call" {
				if rpc.Params["name"] != "transport_info" {
					t.Error("raw RPC requested")
				}
				capability := "text_hydrate_stream_v2"
				if action == "backup" {
					capability = "text_reverse_copy_stream_v2"
				}
				result = map[string]any{"structuredContent": map[string]any{"protocol": 2, "profile": "selected", "commit": "fixture", "chunk_size": 32768, "cancellation": "connection-only", "capabilities": []string{capability}}}
			}
			json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": rpc.ID, "result": result})
			return
		}
		decoder := json.NewDecoder(r.Body)
		var header struct {
			Operation  string   `json:"operation_id"`
			File       string   `json:"file"`
			Profile    string   `json:"profile"`
			References []string `json:"references"`
			Ticket     string   `json:"ticket"`
		}
		if decoder.Decode(&header) != nil || header.Profile != "selected" || header.File != "/approved/config" || len(header.References) != 1 || header.References[0] != canonicalReference() {
			t.Error("operation scope changed")
			w.WriteHeader(403)
			return
		}
		reply := func(status string) {
			json.NewEncoder(w).Encode(map[string]any{"format": "ssjack-text-stream-v2", "operation_id": header.Operation, "status": status})
		}
		if r.URL.Path == "/text-stream-v2/reverse-copy" {
			fixture.reverse.Add(1)
			if decoder.Decode(new(any)) != io.EOF {
				t.Error("reverse request had a data body")
			}
			if mode == "withheld" {
				reply("withheld")
				return
			}
			w.Header().Set("Content-Type", "application/x-ndjson")
			payload := original
			if mode == "late-nul" {
				payload = join(original, []byte{0})
			}
			wire := framed(t, payload, mode != "lost-completion")
			id := header.Operation
			if mode == "wrong-operation" {
				if id[0] == 'A' {
					id = "B" + id[1:]
				} else {
					id = "A" + id[1:]
				}
			}
			w.Write(bytes.ReplaceAll(wire, []byte(operation), []byte(id)))
			return
		}
		var source bytes.Buffer
		frames := 0
		for {
			var frame struct {
				Type      string `json:"type"`
				Data      []byte `json:"data"`
				Operation string `json:"operation_id"`
				Sequence  int    `json:"sequence"`
				Bytes     int    `json:"bytes"`
				Frames    int    `json:"frames"`
			}
			if decoder.Decode(&frame) != nil {
				t.Error("incomplete producer input")
				reply("unknown")
				return
			}
			if frame.Operation != header.Operation || frame.Sequence != frames {
				t.Error("uncorrelated input")
			}
			if frame.Type == "complete" {
				if frame.Bytes != source.Len() || frame.Frames != frames || decoder.Decode(new(any)) != io.EOF {
					t.Error("incomplete producer terminal")
				}
				break
			}
			if frame.Type != "data" || len(frame.Data) < 1 || len(frame.Data) > 32768 {
				t.Error("invalid input frame")
				reply("unknown")
				return
			}
			source.Write(frame.Data)
			frames++
		}
		if r.URL.Path == "/text-stream-v2/prepare" {
			fixture.prepare.Add(1)
			if !bytes.Equal(source.Bytes(), original) {
				t.Error("first pass changed")
			}
			if mode == "withheld" {
				reply("withheld")
				return
			}
			if mode == "malformed-prepare" {
				w.Write([]byte(`{"status":"prepared"}`))
				return
			}
			if mode == "duplicate-prepare" {
				io.WriteString(w, `{"format":"ssjack-text-stream-v2","operation_id":"`+header.Operation+`","status":"prepared","ticket":"`+operation+`","ticket":"`+operation+`"}`)
				return
			}
			if mode == "changed-source" {
				changed := append([]byte(nil), original...)
				changed[0] = 'L'
				if err := os.WriteFile(template, changed, 0600); err != nil {
					t.Error(err)
				}
			}
			json.NewEncoder(w).Encode(map[string]any{"format": "ssjack-text-stream-v2", "operation_id": header.Operation, "status": "prepared", "ticket": operation, "bytes": source.Len()})
			return
		}
		if r.URL.Path != "/text-stream-v2/execute" {
			t.Error("unknown operation path")
			w.WriteHeader(403)
			return
		}
		fixture.execute.Add(1)
		if header.Ticket != operation {
			t.Error("execute lost its prepared ticket")
		}
		if mode == "lost-reply" {
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			connection.Close()
			return
		}
		if !bytes.Equal(source.Bytes(), original) {
			reply("unknown")
			return
		}
		if mode == "duplicate-execute" {
			io.WriteString(w, `{"format":"ssjack-text-stream-v2","operation_id":"`+header.Operation+`","status":"unknown","status":"received"}`)
			return
		}
		reply("received")
	}))
	fixture.server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	fixture.server.StartTLS()
	t.Cleanup(fixture.server.Close)
	return fixture
}

func runOperationClient(t *testing.T, fixture *operationFixture, action string, selection map[string]any) (string, error) {
	t.Helper()
	digest := sha256.Sum256(fixture.server.Certificate().Raw)
	capability := "text_hydrate_stream_v2"
	if action == "backup" {
		capability = "text_reverse_copy_stream_v2"
	}
	input, err := json.Marshal(map[string]any{"bootstrap": map[string]string{"endpoint": fixture.server.URL + "/mcp", "token": strings.Repeat("a", 64), "pin": hex.EncodeToString(digest[:]), "profile": "selected"}, "capability": capability, "selection": selection, "action": action})
	if err != nil {
		t.Fatal(err)
	}
	module, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "..", "..", "packages", "clawwright", "runtime", "transport", "remote", "text", "stream", "client.ts"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "--experimental-strip-types", "--input-type=module", "-e", operationBridge, module)
	command.Stdin = bytes.NewReader(input)
	var output, diagnostics bytes.Buffer
	command.Stdout, command.Stderr = &output, &diagnostics
	err = command.Run()
	if ctx.Err() != nil {
		t.Fatal("operation client did not join before deadline")
	}
	if err != nil && !bytes.Contains(diagnostics.Bytes(), []byte("SSJACK_TEXT_STREAM_OPERATION_FAILED")) {
		t.Fatalf("client failed outside expected boundary: %s", diagnostics.Bytes())
	}
	if err != nil {
		return "", err
	}
	var result struct {
		Status string `json:"status"`
	}
	if json.Unmarshal(output.Bytes(), &result) != nil {
		t.Fatal("client did not return bounded status metadata")
	}
	return result.Status, nil
}
