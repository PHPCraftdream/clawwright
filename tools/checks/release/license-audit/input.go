package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"unicode/utf8"
)

const maxInput = 16 << 20
const maxDepth = 128

type object map[string]json.RawMessage

func readFile(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("input is not a regular file: %s", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("input is not a regular file: %s", path)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxInput+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxInput {
		return nil, fmt.Errorf("input exceeds %d bytes: %s", maxInput, path)
	}
	return data, nil
}

func parseJSON(path string, target any) error {
	data, err := readFile(path)
	if err != nil {
		return err
	}
	if !utf8.Valid(data) {
		return fmt.Errorf("invalid UTF-8: %s", path)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := scanJSON(decoder, 0); err != nil {
		return fmt.Errorf("invalid JSON %s: %w", path, err)
	}
	if _, err := decoder.Token(); err != io.EOF {
		return fmt.Errorf("trailing JSON value: %s", path)
	}
	if err := json.Unmarshal(data, target); err != nil {
		return fmt.Errorf("invalid JSON %s: %w", path, err)
	}
	return nil
}

func scanJSON(decoder *json.Decoder, depth int) error {
	if depth > maxDepth {
		return fmt.Errorf("JSON nesting exceeds %d", maxDepth)
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		return scanObject(decoder, depth)
	case '[':
		return scanArray(decoder, depth)
	default:
		return errors.New("unexpected JSON delimiter")
	}
}

func scanObject(decoder *json.Decoder, depth int) error {
	seen := make(map[string]bool)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		key, ok := token.(string)
		if !ok {
			return errors.New("invalid object key")
		}
		if seen[key] {
			return fmt.Errorf("duplicate JSON key: %s", key)
		}
		seen[key] = true
		if err := scanJSON(decoder, depth+1); err != nil {
			return err
		}
	}
	_, err := decoder.Token()
	return err
}

func scanArray(decoder *json.Decoder, depth int) error {
	for decoder.More() {
		if err := scanJSON(decoder, depth+1); err != nil {
			return err
		}
	}
	_, err := decoder.Token()
	return err
}

func fields(raw json.RawMessage) (object, error) {
	var value object
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, errors.New("expected JSON object")
	}
	return value, nil
}

func stringField(values object, key string) string {
	var value string
	_ = json.Unmarshal(values[key], &value)
	return value
}

func boolField(values object, key string) bool {
	var value bool
	_ = json.Unmarshal(values[key], &value)
	return value
}

func missing(value string) string {
	if value == "" {
		return "(missing)"
	}
	return value
}

func edgeMap(raw json.RawMessage, label string) (map[string]string, error) {
	if len(raw) == 0 {
		return map[string]string{}, nil
	}
	values, err := fields(raw)
	if err != nil {
		return nil, fmt.Errorf("Unsupported dependency metadata: %s", label)
	}
	result := make(map[string]string, len(values))
	for name, rawRange := range values {
		var version string
		if json.Unmarshal(rawRange, &version) != nil || version == "" || unsupportedRange(version) {
			return nil, fmt.Errorf("Unsupported dependency range or alias for %s", name)
		}
		result[name] = version
	}
	return result, nil
}

func unsupportedRange(value string) bool {
	for _, prefix := range []string{"npm:", "file:", "workspace:", "git+", "http", "link:"} {
		if len(value) >= len(prefix) && value[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}

func nonEmptyObject(raw json.RawMessage) (object, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	values, err := fields(raw)
	return values, err
}
