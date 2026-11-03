package runner

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Run performs the complete OUTER build, staging, policy check, and disposable execution.
func Run(args, environ []string) error {
	if len(args) != 0 {
		return fail("inputs")
	}
	e := Environment(environ)
	root := e.Get("GITHUB_WORKSPACE")
	if root == "" {
		return fail("inputs")
	}
	cwd, err := os.Getwd()
	if err != nil {
		return fail("inputs")
	}
	scenario, err := ValidateInputs(e, runtime.GOOS == "linux", root, cwd)
	if err != nil {
		return err
	}
	product := e.Get("TASK245_PRODUCT_CHECKOUT")
	rev, err := gitRevision(OSExecutor{}, product, sanitizedEnv(e, nil))
	if err != nil {
		return err
	}
	_ = rev
	parent, err := os.MkdirTemp(e.Get("RUNNER_TEMP"), "task245-acceptance-")
	if err != nil {
		return fail("inputs")
	}
	defer os.RemoveAll(parent)
	if err = os.Chmod(parent, 0700); err != nil {
		return fail("inputs")
	}
	stage := filepath.Join(parent, "lab")
	if err = os.Mkdir(stage, 0755); err != nil {
		return fail("inputs")
	}
	native, ex := filepath.Join(root, "tools", "native"), OSExecutor{}
	productBuilds := []struct {
		name    string
		pkg     string
		product bool
	}{
		{"ssjack", "./cmd/ssjack", true},
		{"conductor", "./cmd/ssjack-lab", true},
		{"driver", "./internal/declarativeslice/tests/fixtures/syntheticdriver", true},
		{"harness", "./internal/declarativeslice/tests/fixtures/secretharness", true},
	}
	for _, b := range productBuilds {
		overlay := ""
		if b.name == "conductor" && scenario != "connected" && scenario != "confinement" {
			overlay = filepath.Join(parent, "task245-overlay.json")
			replacements := map[string]string{
				filepath.Join(product, "cmd", "ssjack-lab", "main_linux.go"): filepath.Join(native, "task245-composed-lab", "main_linux.go"),
				filepath.Join(product, "cmd", "ssjack-lab", "task245_negative_linux.go"): filepath.Join(native, "task245-composed-lab", "negative_linux.go"),
				filepath.Join(product, "cmd", "ssjack-lab", "task245_cancel_check_linux.go"): filepath.Join(native, "task245-composed-lab", "cancel_check_linux.go"),
			}
			data, marshalErr := json.Marshal(struct {
				Replace map[string]string `json:"Replace"`
			}{replacements})
			if marshalErr != nil {
				return fail("build-conductor")
			}
			if err := os.WriteFile(overlay, append(data, '\n'), 0600); err != nil {
				return fail("build-conductor")
			}
		}
		dest := filepath.Join(stage, b.name)
		if err = buildGo(ex, "build-"+b.name, product, parent, dest, b.pkg, e, b.product, overlay); err != nil {
			return err
		}
		if b.name == "driver" {
			if err = PatchSyntheticDriver(dest); err != nil {
				return fail("build-driver")
			}
		}
	}
	nativeBuilds := []struct {
		name string
		pkg  string
	}{
		{"consumer", "./task245-native-supervisor"},
		{"native-provider", "./task240-native-provider"},
		{"native-lab-broker", "./task245-lab-broker"},
		{"gateway", "./task245-acceptance/fixtures/gateway"},
		{"release-fixture", "./task245-acceptance/fixtures/release"},
		{"probe", "./task245-control-profile/cmd/control-probe"},
		{"profile", "./task245-acceptance/cmd/profile"},
		{"control-profile", "./task245-control-profile/cmd/control-profile"},
		{"native-metadata", "./task245-control-profile/cmd/native-metadata"},
		{"metadata-regression", "./task245-control-profile/cmd/metadata-regression"},
	}
	for _, b := range nativeBuilds {
		dest := filepath.Join(stage, b.name)
		if err = buildGo(ex, "build-"+b.name, native, parent, dest, b.pkg, e, false, ""); err != nil {
			return err
		}
		if b.name == "native-metadata" {
			if err = os.Chmod(dest, 0555); err != nil {
				return fail("build-native-metadata")
			}
		}
	}
	if err = compileGoTest(ex, native, parent, stage); err != nil {
		return err
	}
	rustBuilds := []struct {
		src string
		out string
	}{
		{"task245-domain-init/main.rs", "native-init"},
		{"task240-launch-stub/main.rs", "native-stub"},
		{"task245-control-profile/installer/main.rs", "control-installer"},
	}
	for _, v := range rustBuilds {
		if err = compileRust(ex, "compile-"+v.out, filepath.Join(native, filepath.FromSlash(v.src)), filepath.Join(stage, v.out)); err != nil {
			return err
		}
	}
	if err = stageLayout(stage, product, native, scenario); err != nil {
		return fail("stage")
	}
	hashes, err := hashBinaries(stage)
	if err != nil {
		return fail("stage")
	}
	imageInfo, profile, err := containerRun(ex, parent, stage, e, scenario)
	if err != nil {
		return err
	}
	raw, status, err := validateProfileOutput(profile, scenario)
	if err != nil {
		return fail("evidence")
	}
	ev := Evidence{
		Status:                 status,
		MechanismOnly:          true,
		Adoption:               false,
		ProductBase:            ProductBase,
		ProductSourceRevision:  ProductCommit,
		BridgeSourceRevision:   e.Get("GITHUB_SHA"),
		RunID:                  e.Get("GITHUB_RUN_ID"),
		ImageID:                imageInfo,
		BinarySHA256:           hashes,
		ProfileEvidence:        raw,
	}
	if scenario != "connected" && scenario != "confinement" {
		ev.Scenario = scenario
	}
	if err = JSONLine(os.Stdout, ev); err != nil {
		return fail("evidence")
	}
	return nil
}

func compileGoTest(ex Executor, root, cache, stage string) error {
	env := sanitizedEnv(Environment(os.Environ()), map[string]string{
		"GOTOOLCHAIN": "local",
		"CGO_ENABLED": "0",
		"GOPROXY":    "off",
		"GOMODCACHE": filepath.Join(cache, "gomodcache"),
		"GOCACHE":    filepath.Join(cache, "gocache"),
	})
	_, err := run(ex, "build-release-test", Command{
		Path: "go",
		Args: []string{
			"test", "-c", "-o", filepath.Join(stage, "release-test"), "./task245-native-supervisor",
		},
		Dir:   root,
		Env:   env,
		Limit: 1 << 20,
	})
	if err == nil {
		err = os.Chmod(filepath.Join(stage, "release-test"), 0755)
	}
	return err
}

func stageLayout(stage, product, native, scenario string) error {
	bin := filepath.Join(stage, "bin")
	if err := os.Mkdir(bin, 0755); err != nil {
		return err
	}
	files := []struct {
		src  string
		dst  string
		mode os.FileMode
	}{
		{"harness", "harness", 0755},
		{"native-lab-broker", "native-lab-broker", 0755},
		{"native-metadata", "native-metadata", 0555},
		{"control-installer", "control-installer", 0555},
		{"ssjack", "ssjack", 0755},
	}
	for _, v := range files {
		if err := copyFile(filepath.Join(stage, v.src), filepath.Join(bin, v.dst), v.mode); err != nil {
			return err
		}
	}
	if err := copyFile(filepath.Join(stage, "control-profile"), filepath.Join(stage, "harness"), 0755); err != nil {
		return err
	}
	if err := copyFile(filepath.Join(stage, "metadata-regression"), filepath.Join(bin, "metadata-child"), 0755); err != nil {
		return err
	}
	if scenario == "confinement" {
		if err := copyFile(filepath.Join(stage, "probe"), filepath.Join(bin, "harness"), 0755); err != nil {
			return err
		}
	}
	delivery := filepath.Join(product, "scripts", "lab", "delivery_pty.py")
	st, err := os.Stat(delivery)
	if err != nil || !st.Mode().IsRegular() {
		return fmt.Errorf("pinned helper unavailable")
	}
	return copyFile(delivery, filepath.Join(stage, "delivery_pty.py"), 0755)
}

func hashBinaries(stage string) (map[string]string, error) {
	names := []string{
		"ssjack",
		"conductor",
		"driver",
		"harness",
		"consumer",
		"native-provider",
		"native-lab-broker",
		"release-test",
		"release-fixture",
		"native-stub",
		"native-init",
		"control-installer",
		"native-metadata",
		"metadata-regression",
		"gateway",
		"control-profile",
		"probe",
	}
	hashes := map[string]string{}
	for _, name := range names {
		hash, err := HashFile(filepath.Join(stage, name))
		if err != nil {
			return nil, err
		}
		hashes[name] = hash
	}
	return hashes, nil
}
