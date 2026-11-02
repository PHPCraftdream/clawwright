package runner

import (
	"bytes"
	"crypto/sha256"
	"debug/elf"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const ProductCommit = "ca7ce8023f3fb1a3498d801eda29aa3614961a79"
const ProductBase = "2997e692cdc24f5b9a5aa23cadc3b22ab1b32f02"
const Image = "python:3.13-slim"

var cases = map[string]bool{"connected": true, "confinement": true, "wrong-holder": true, "unexpected-exec": true, "partial-ack": true, "lost-ack": true, "cancel": true}
var ciHash = regexp.MustCompile(`^[a-f0-9]{40}$`)

// SafeError intentionally drops command output, arguments, paths, and subprocess diagnostics.
func SafeError(err error) string {
	var failure *Failure
	if errors.As(err, &failure) {
		return fmt.Sprintf("task245-acceptance: failed stage=%s exit=%d", failure.Phase, failure.Exit)
	}
	return "task245-acceptance: failed stage=inputs exit=unknown"
}

type Failure struct {
	Phase string
	Exit  int
}

func (f *Failure) Error() string { return "acceptance failed" }
func fail(phase string) error    { return &Failure{Phase: phase, Exit: -1} }

type Env map[string]string

func Environment(items []string) Env {
	e := Env{}
	for _, v := range items {
		if i := strings.IndexByte(v, '='); i > 0 {
			e[v[:i]] = v[i+1:]
		}
	}
	return e
}

func (e Env) Get(k string) string { return e[k] }

func ValidateInputs(e Env, linux bool, root, cwd string) (string, error) {
	c := e.Get("TASK245_LAB_CASE")
	if c == "" {
		c = "connected"
	}
	if !cases[c] {
		return "", fail("inputs")
	}
	if !linux || e.Get("CI") != "true" || e.Get("GITHUB_ACTIONS") != "true" {
		return "", fail("inputs")
	}
	product := e.Get("TASK245_PRODUCT_CHECKOUT")
	if product == "" {
		return "", fail("inputs")
	}
	pr, err := filepath.Abs(product)
	if err != nil {
		return "", fail("inputs")
	}
	rr, err := filepath.Abs(root)
	if err != nil {
		return "", fail("inputs")
	}
	cr, err := filepath.Abs(cwd)
	if err != nil {
		return "", fail("inputs")
	}
	if samePath(pr, rr) || samePath(pr, cr) || e.Get("TASK245_PRODUCT_COMMIT") != ProductCommit || e.Get("TASK245_PRODUCT_BASE") != ProductBase || e.Get("TASK245_PRODUCT_TAG") != "" || e.Get("TASK245_IMAGE") != Image {
		return "", fail("inputs")
	}
	t := e.Get("RUNNER_TEMP")
	if !filepath.IsAbs(t) || filepath.Clean(t) == string(filepath.Separator) {
		return "", fail("inputs")
	}
	if !ciHash.MatchString(e.Get("GITHUB_SHA")) || !digits(e.Get("GITHUB_RUN_ID")) {
		return "", fail("inputs")
	}
	return c, nil
}

func samePath(a, b string) bool {
	x, e := filepath.EvalSymlinks(a)
	if e == nil {
		a = x
	}
	x, e = filepath.EvalSymlinks(b)
	if e == nil {
		b = x
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

func digits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func HashFile(path string) (string, error) {
	f, e := os.Open(path)
	if e != nil {
		return "", e
	}
	defer f.Close()
	h := sha256.New()
	if _, e = io.Copy(h, f); e != nil {
		return "", e
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func JSONLine(w io.Writer, value any) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	return enc.Encode(value)
}

// PatchSyntheticDriver modifies only the two historical ELF header ranges.
func PatchSyntheticDriver(path string) error {
	original, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err = ValidateSyntheticELF(original); err != nil {
		return err
	}
	patched := append([]byte(nil), original...)
	clear(patched[40:48])
	clear(patched[58:64])
	for i := range original {
		if inPatch(i) {
			continue
		}
		if original[i] != patched[i] {
			return fmt.Errorf("unexpected ELF mutation")
		}
	}
	return os.WriteFile(path, patched, 0755)
}

func inPatch(i int) bool { return i >= 40 && i < 48 || i >= 58 && i < 64 }

func ValidateSyntheticELF(b []byte) error {
	if len(b) < 64 || !bytes.Equal(b[:4], []byte{0x7f, 'E', 'L', 'F'}) || b[4] != 2 || b[5] != 1 || b[6] != 1 {
		return fmt.Errorf("invalid ELF64LE header")
	}
	if binary.LittleEndian.Uint16(b[16:18]) != 2 || binary.LittleEndian.Uint16(b[18:20]) != 62 {
		return fmt.Errorf("unexpected ELF type or machine")
	}
	if binary.LittleEndian.Uint16(b[52:54]) != 64 {
		return fmt.Errorf("unexpected ELF header length")
	}
	// Parse as an independent structural check before allowing the narrowly-scoped header edit.
	f, err := elf.NewFile(bytes.NewReader(b))
	if err != nil {
		return err
	}
	defer f.Close()
	if f.Class != elf.ELFCLASS64 || f.Data != elf.ELFDATA2LSB || f.Type != elf.ET_EXEC || f.Machine != elf.EM_X86_64 {
		return fmt.Errorf("unexpected ELF executable")
	}
	return nil
}

func WriteCheckedPatch(src, dst string) error {
	in, e := os.Open(src)
	if e != nil {
		return e
	}
	defer in.Close()
	data, e := io.ReadAll(in)
	if e != nil {
		return e
	}
	if e = ValidateSyntheticELF(data); e != nil {
		return e
	}
	before := append([]byte(nil), data...)
	clear(data[40:48])
	clear(data[58:64])
	for i := range data {
		if !inPatch(i) && data[i] != before[i] {
			return fmt.Errorf("ELF bytes outside allowed offsets changed")
		}
	}
	return os.WriteFile(dst, data, 0755)
}

type Evidence struct {
	Status                string          `json:"status"`
	MechanismOnly         bool            `json:"mechanism_only"`
	Adoption              bool            `json:"adoption"`
	ProductBase           string          `json:"product_base"`
	Scenario              string          `json:"scenario,omitempty"`
	ProductSourceRevision string          `json:"product_source_revision,omitempty"`
	BridgeSourceRevision  string          `json:"bridge_source_revision,omitempty"`
	RunID                 string          `json:"run_id,omitempty"`
	ImageID               string          `json:"image_id,omitempty"`
	BinarySHA256          map[string]string `json:"binary_sha256,omitempty"`
	ProfileEvidence       json.RawMessage `json:"profile_evidence"`
}

func validateProfileOutput(data []byte, scenario string) (json.RawMessage, string, error) {
	if len(data) > 16384 {
		return nil, "", fmt.Errorf("oversize profile output")
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 1 || lines[0] == "" {
		return nil, "", fmt.Errorf("invalid profile framing")
	}
	var m map[string]any
	if json.Unmarshal([]byte(lines[0]), &m) != nil {
		return nil, "", fmt.Errorf("invalid profile JSON")
	}
	status, ok := m["status"].(string)
	if !ok || m["product_base"] != ProductBase || m["mechanism_only"] != true || m["adoption"] != false {
		return nil, "", fmt.Errorf("unexpected profile evidence")
	}
	expected := "task245-connected-lab-complete"
	if scenario == "confinement" {
		expected = "control-confinement-passed"
	} else if scenario != "connected" {
		expected = "task245-negative-complete"
		if m["scenario"] != scenario {
			return nil, "", fmt.Errorf("unexpected scenario evidence")
		}
	}
	if status != expected {
		return nil, "", fmt.Errorf("unexpected status")
	}
	return json.RawMessage(lines[0]), expected, nil
}

func outputJSON(v any) ([]byte, error) { return json.Marshal(v) }
