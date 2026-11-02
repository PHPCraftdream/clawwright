package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"
)

const successFormat = "License audit passed for %d exact-version reviewed production dependency entries; LICENSE/NOTICE copies match.\n"
const reviewedGitHead = "c3a75242772a5026a49c4017a16d9b3543b62776"

type review struct{ version, license, gitHead, integrity, resolved string }

var reviewed = map[string]review{"json5": {
	version: "2.2.3", license: "MIT", gitHead: reviewedGitHead,
	integrity: "sha512-XmOWe7eyHYH14cLdVPoyg+GOH3rYX++KpzrylJwSW98t3Nk+U8XOl8FWKOgwtzdb8lXGf6zYwDUzeHMWfxasyg==",
	resolved: "https://registry.npmjs.org/json5/-/json5-2.2.3.tgz",
}}

func audit(root, packageDir string, stdout io.Writer) error {
	manifest, packages, rootEntry, err := loadInventory(root, packageDir)
	if err != nil {
		return err
	}
	dependencies, optional, err := validateManifest(manifest)
	if err != nil {
		return err
	}
	if err := validateRootEdges(rootEntry, dependencies, optional, len(manifest["optionalDependencies"]) > 0); err != nil {
		return err
	}
	queue, err := rootQueue(packages, manifest, dependencies, optional)
	if err != nil {
		return err
	}
	visited, err := walkPackages(packages, queue)
	if err != nil {
		return err
	}
	if err := compareNotices(root, packageDir); err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, successFormat, len(visited))
	return err
}

func loadInventory(root, packageDir string) (object, object, object, error) {
	var lock, manifest object
	if err := parseJSON(filepath.Join(root, "package-lock.json"), &lock); err != nil {
		return nil, nil, nil, err
	}
	if err := parseJSON(filepath.Join(packageDir, "package.json"), &manifest); err != nil {
		return nil, nil, nil, err
	}
	var version int
	var requires bool
	if json.Unmarshal(lock["lockfileVersion"], &version) != nil || version != 3 || json.Unmarshal(lock["requires"], &requires) != nil || !requires {
		return nil, nil, nil, errors.New("Unsupported or incomplete npm lockfile")
	}
	packages, err := fields(lock["packages"])
	if err != nil {
		return nil, nil, nil, errors.New("Unsupported or incomplete npm lockfile")
	}
	rootEntry, err := fields(packages[""])
	if err != nil {
		return nil, nil, nil, errors.New("Unsupported or incomplete npm lockfile")
	}
	for path, raw := range packages {
		entry, entryErr := fields(raw)
		if entryErr == nil && boolField(entry, "inBundle") {
			return nil, nil, nil, fmt.Errorf("Bundled lock entry unsupported: %s", path)
		}
	}
	return manifest, packages, rootEntry, nil
}

func validateManifest(manifest object) (map[string]string, map[string]string, error) {
	if stringField(manifest, "name") == "" || stringField(manifest, "version") == "" || len(manifest["dependencies"]) == 0 || string(bytes.TrimSpace(manifest["dependencies"])) == "null" {
		return nil, nil, errors.New("Published manifest lacks auditable production metadata")
	}
	if _, err := fields(manifest["dependencies"]); err != nil {
		return nil, nil, errors.New("Published manifest lacks auditable production metadata")
	}
	dependencies, err := edgeMap(manifest["dependencies"], "published dependencies")
	if err != nil {
		return nil, nil, err
	}
	var optional map[string]string
	if len(manifest["optionalDependencies"]) > 0 {
		if _, err := fields(manifest["optionalDependencies"]); err != nil {
			return nil, nil, errors.New("Unsupported published optionalDependencies metadata")
		}
		optional, err = edgeMap(manifest["optionalDependencies"], "published optionalDependencies")
		if err != nil {
			return nil, nil, err
		}
	} else {
		optional = map[string]string{}
	}
	for _, field := range []string{"peerDependencies", "peerDependenciesMeta"} {
		values, fieldErr := nonEmptyObject(manifest[field])
		if fieldErr != nil || len(values) > 0 {
			return nil, nil, fmt.Errorf("Published %s are unsupported until explicitly audited", field)
		}
	}
	for _, field := range []string{"bundleDependencies", "bundledDependencies"} {
		if len(manifest[field]) == 0 {
			continue
		}
		var values []json.RawMessage
		if json.Unmarshal(manifest[field], &values) != nil || values == nil || len(values) > 0 {
			return nil, nil, errors.New("Published bundled dependencies are unsupported until explicitly audited")
		}
	}
	for name := range dependencies {
		if _, exists := optional[name]; exists {
			return nil, nil, errors.New("Dependency declared in both required and optional sections")
		}
	}
	return dependencies, optional, nil
}

func validateRootEdges(rootEntry object, dependencies, optional map[string]string, optionalDeclared bool) error {
	if len(rootEntry["dependencies"]) == 0 || string(bytes.TrimSpace(rootEntry["dependencies"])) == "null" {
		return errors.New("Root lock dependencies are missing")
	}
	locked, err := edgeMap(rootEntry["dependencies"], "root dependencies")
	if err != nil {
		return errors.New("Root lock dependencies are missing")
	}
	lockedOptional, err := edgeMap(rootEntry["optionalDependencies"], "root optionalDependencies")
	if err != nil {
		return err
	}
	if optionalDeclared && len(rootEntry["optionalDependencies"]) == 0 {
		return errors.New("Root lock optionalDependencies are missing")
	}
	if err := matchEdges(dependencies, locked); err != nil {
		return err
	}
	return matchEdges(optional, lockedOptional)
}

func matchEdges(expected, actual map[string]string) error {
	for name, version := range expected {
		if actual[name] != version {
			return fmt.Errorf("Manifest/lock range mismatch for %s: %s vs %s", name, version, missing(actual[name]))
		}
	}
	return nil
}

func rootQueue(packages object, manifest object, dependencies, optional map[string]string) ([]dependencyEntry, error) {
	names := make([]string, 0, len(dependencies)+len(optional))
	for name := range dependencies {
		names = append(names, name)
	}
	for name := range optional {
		names = append(names, name)
	}
	sort.Strings(names)
	queue := make([]dependencyEntry, 0, len(names))
	for _, name := range names {
		if !validDependencyName(name) {
			return nil, fmt.Errorf("Unsupported dependency name: %s", name)
		}
		path, ok := resolveLock(packages, "", name)
		if !ok {
			return nil, fmt.Errorf("Dependency missing from lockfile: %s -> %s", stringField(manifest, "name"), name)
		}
		queue = append(queue, dependencyEntry{name: name, path: path})
	}
	return queue, nil
}

type dependencyEntry struct{ name, path string }

func validDependencyName(name string) bool {
	if name == "" || strings.ContainsAny(name, "\\\\% \t\r\n\v\f:") {
		return false
	}
	parts := strings.Split(name, "/")
	if strings.HasPrefix(name, "@") {
		if len(parts) != 2 || len(parts[0]) < 2 {
			return false
		}
		parts[0] = parts[0][1:]
	} else if len(parts) != 1 {
		return false
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return false
		}
		for _, r := range part {
			if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.') {
				return false
			}
		}
	}
	return true
}

func walkPackages(packages object, queue []dependencyEntry) (map[string]bool, error) {
	visited := make(map[string]bool)
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		path := current.path
		if packageName(path) != current.name {
			return nil, fmt.Errorf("Unsupported or incomplete resolved/integrity lock metadata: %s", path)
		}
		if visited[path] {
			continue
		}
		visited[path] = true
		entry, err := fields(packages[path])
		if err != nil {
			return nil, fmt.Errorf("Unsupported or incomplete resolved/integrity lock metadata: %s", path)
		}
		if err := validateResolved(entry, path); err != nil {
			return nil, err
		}
		if err := validatePeerMetadata(entry, path); err != nil {
			return nil, err
		}
		if err := validateReview(entry, current.name, path); err != nil {
			return nil, err
		}
		children, err := childPackages(packages, entry, path)
		if err != nil {
			return nil, err
		}
		queue = append(queue, children...)
	}
	return visited, nil
}

func validateResolved(entry object, path string) error {
	resolved, integrity := stringField(entry, "resolved"), stringField(entry, "integrity")
	if !strings.HasPrefix(resolved, "https://") || !validIntegrity(integrity) {
		return fmt.Errorf("Unsupported or incomplete resolved/integrity lock metadata: %s", path)
	}
	return nil
}

func validatePeerMetadata(entry object, path string) error {
	peer, err := nonEmptyObject(entry["peerDependencies"])
	if err != nil {
		return fmt.Errorf("Unsupported peerDependencies metadata: %s", path)
	}
	if len(peer) > 0 {
		return fmt.Errorf("Transitive peerDependencies are unsupported until explicitly audited: %s", path)
	}
	return nil
}

func validateReview(entry object, name, path string) error {
	version, license := stringField(entry, "version"), stringField(entry, "license")
	if version == "" || strings.TrimSpace(license) == "" {
		return fmt.Errorf("Missing version/license metadata: %s", path)
	}
	evidence, ok := reviewed[name]
	if !ok || evidence.version != version || evidence.license != license {
		return fmt.Errorf("No exact-version reviewed provenance for %s@%s (lock license: %s)", name, version, license)
	}
	if name == "json5" {
		if evidence.gitHead != reviewedGitHead {
			return errors.New("json5 reviewed source provenance mismatch")
		}
		if stringField(entry, "integrity") != evidence.integrity || stringField(entry, "resolved") != evidence.resolved {
			return errors.New("json5 lock metadata differs from the registry evidence reviewed for 2.2.3")
		}
	}
	return nil
}

func childPackages(packages object, entry object, parent string) ([]dependencyEntry, error) {
	var result []dependencyEntry
	for _, field := range []string{"dependencies", "optionalDependencies"} {
		edges, err := edgeMap(entry[field], field+": "+parent)
		if err != nil {
			return nil, err
		}
		children := make([]string, 0, len(edges))
		for child := range edges {
			children = append(children, child)
		}
		sort.Strings(children)
		for _, child := range children {
			if !validDependencyName(child) {
				return nil, fmt.Errorf("Unsupported dependency name: %s", child)
			}
			childPath, ok := resolveLock(packages, parent, child)
			if !ok {
				return nil, fmt.Errorf("Dependency missing from lockfile: %s -> %s", parent, child)
			}
			childEntry, err := fields(packages[childPath])
			if err != nil {
				return nil, fmt.Errorf("Dependency missing from lockfile: %s -> %s", parent, child)
			}
			if stringField(childEntry, "version") != edges[child] {
				return nil, fmt.Errorf("Dependency range/version mismatch for %s: %s vs %s", child, edges[child], missing(stringField(childEntry, "version")))
			}
			result = append(result, dependencyEntry{name: child, path: childPath})
		}
	}
	return result, nil
}

func compareNotices(root, packageDir string) error {
	for _, name := range []string{"LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "NOTICE"} {
		repository, err := readFile(filepath.Join(root, name))
		if err != nil {
			return err
		}
		packaged, err := readFile(filepath.Join(packageDir, name))
		if err != nil {
			return err
		}
		if !bytes.Equal(repository, packaged) {
			return fmt.Errorf("Repository/framework notice mismatch: %s", name)
		}
	}
	return nil
}

func validIntegrity(value string) bool {
	for _, prefix := range []string{"sha1-", "sha256-", "sha384-", "sha512-"} {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	return false
}

func packageName(path string) string {
	installed := path
	if index := strings.LastIndex(path, "/node_modules/"); index >= 0 {
		installed = path[index+len("/node_modules/"):]
	} else {
		installed = strings.TrimPrefix(path, "node_modules/")
	}
	segments := strings.Split(installed, "/")
	if strings.HasPrefix(installed, "@") && len(segments) > 1 {
		return strings.Join(segments[:2], "/")
	}
	return segments[0]
}

func resolveLock(packages object, parent, name string) (string, bool) {
	for path := parent; ; {
		candidate := strings.TrimSuffix(path, "/")
		if candidate != "" {
			candidate += "/"
		}
		candidate += "node_modules/" + name
		if _, ok := packages[candidate]; ok {
			return candidate, true
		}
		if index := strings.LastIndex(path, "/node_modules/"); index >= 0 {
			path = path[:index]
		} else if strings.HasPrefix(path, "node_modules/") {
			path = ""
		} else {
			break
		}
	}
	candidate := "node_modules/" + name
	_, ok := packages[candidate]
	return candidate, ok
}
