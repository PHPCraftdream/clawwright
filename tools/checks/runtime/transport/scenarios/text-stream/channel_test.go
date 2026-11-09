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
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

const channelBridge = `
import {pathToFileURL} from "node:url";
const url = pathToFileURL(process.argv[1]);
const channelModule = await import(url.href);
const frames = await import(new URL("./frames.ts", url).href);
const pieces = []; for await (const piece of process.stdin) pieces.push(piece);
const input = JSON.parse(Buffer.concat(pieces).toString("utf8"));
const channel = new channelModule.TextStreamChannel(input.bootstrap, input.capability);
const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 30000);
if (input.cancelled) abort.abort();
async function* source() { yield Buffer.from(input.text); }
try {
  await channel.open(abort.signal);
  const response = await channel.post("prepare", input.header, frames.encodeTextFrames(source(), input.header.operation_id), abort.signal);
  process.stdout.write(JSON.stringify(await channelModule.textStreamJSON(response)));
} finally { clearTimeout(timer); channel.close(); }
`

func TestPinnedStreamChannelNegotiatesBeforeLargeUpload(t *testing.T) {
	for _, mode := range []string{"success", "wrong-pin", "incompatible", "pre-cancelled", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			var requests, operations atomic.Int32
			var received atomic.Int64
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Header.Get("Authorization") != "Bearer "+string(bytes.Repeat([]byte("a"), 64)) {
					t.Error("request omitted the exact synthetic bearer")
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
					if json.NewDecoder(io.LimitReader(r.Body, 16385)).Decode(&rpc) != nil {
						t.Error("invalid negotiation body")
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
							t.Error("channel requested a raw tool")
						}
						protocol := 2
						if mode == "incompatible" {
							protocol = 1
						}
						result = map[string]any{"structuredContent": map[string]any{"protocol": protocol, "profile": "selected", "commit": "fixture", "chunk_size": 32768, "capabilities": []string{"text_hydrate_stream_v2"}, "cancellation": "connection-only"}}
					}
					json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": rpc.ID, "result": result})
					return
				}
				operations.Add(1)
				if r.URL.Path != "/text-stream-v2/prepare" || r.Header.Get("Content-Type") != "application/x-ndjson" {
					t.Error("channel used another operation route")
				}
				if mode == "redirect" {
					w.Header().Set("Location", "https://example.invalid/")
					w.WriteHeader(302)
					return
				}
				decoder := json.NewDecoder(r.Body)
				var header map[string]any
				if decoder.Decode(&header) != nil || header["profile"] != "selected" || header["operation_id"] != operation {
					t.Error("operation header changed")
				}
				var total int64
				frames := 0
				for {
					var frame struct {
						Type      string `json:"type"`
						Data      []byte `json:"data"`
						Operation string `json:"operation_id"`
						Sequence  int    `json:"sequence"`
						Bytes     int64  `json:"bytes"`
						Frames    int    `json:"frames"`
					}
					if err := decoder.Decode(&frame); err != nil {
						t.Error("incomplete upload")
						break
					}
					if frame.Operation != operation || frame.Sequence != frames {
						t.Error("uncorrelated upload")
					}
					if frame.Type == "complete" {
						if frame.Bytes != total || frame.Frames != frames || decoder.Decode(new(any)) != io.EOF {
							t.Error("upload did not have exact terminal EOF")
						}
						break
					}
					if frame.Type != "data" || len(frame.Data) < 1 || len(frame.Data) > 32768 {
						t.Error("unbounded upload frame")
						break
					}
					total += int64(len(frame.Data))
					frames++
				}
				received.Store(total)
				json.NewEncoder(w).Encode(map[string]any{"format": "ssjack-text-stream-v2", "operation_id": operation, "status": "prepared", "ticket": operation, "bytes": total})
			}))
			server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
			server.StartTLS()
			defer server.Close()
			digest := sha256.Sum256(server.Certificate().Raw)
			pin := hex.EncodeToString(digest[:])
			if mode == "wrong-pin" {
				pin = string(bytes.Repeat([]byte("b"), 64))
			}
			text := bytes.Repeat([]byte("large synthetic reference config\n"), 50000)
			input, err := json.Marshal(map[string]any{"bootstrap": map[string]string{"endpoint": server.URL + "/mcp", "token": string(bytes.Repeat([]byte("a"), 64)), "pin": pin, "profile": "selected"}, "capability": "text_hydrate_stream_v2", "header": map[string]any{"format": "ssjack-text-stream-v2", "operation_id": operation, "profile": "selected", "file": "/approved/config", "references": []string{"selected-ref"}}, "text": string(text), "cancelled": mode == "pre-cancelled"})
			if err != nil {
				t.Fatal(err)
			}
			module, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "..", "..", "packages", "clawwright", "runtime", "transport", "remote", "text", "stream", "channel.ts"))
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, "node", "--experimental-strip-types", "--input-type=module", "-e", channelBridge, module)
			command.Stdin = bytes.NewReader(input)
			var output, diagnostics bytes.Buffer
			command.Stdout, command.Stderr = &output, &diagnostics
			err = command.Run()
			if ctx.Err() != nil {
				t.Fatal("pinned channel did not join before deadline")
			}
			if mode == "success" {
				var result map[string]any
				if err != nil || json.Unmarshal(output.Bytes(), &result) != nil || result["status"] != "prepared" || operations.Load() != 1 || received.Load() != int64(len(text)) {
					t.Fatalf("pinned large upload failed: %s", diagnostics.Bytes())
				}
			} else {
				if err == nil || !bytes.Contains(diagnostics.Bytes(), []byte("SSJACK_TEXT_STREAM_HTTP_FAILED")) {
					t.Fatalf("negative channel failed outside expected boundary: %s", diagnostics.Bytes())
				}
				if (mode == "wrong-pin" || mode == "pre-cancelled") && requests.Load() != 0 {
					t.Fatal("bearer or HTTP sent before certificate pin validation")
				}
				if mode == "incompatible" && operations.Load() != 0 {
					t.Fatal("incompatible negotiation dispatched a text operation")
				}
				if mode == "redirect" && operations.Load() != 1 {
					t.Fatal("redirect caused unexpected operation dispatch")
				}
			}
		})
	}
}
