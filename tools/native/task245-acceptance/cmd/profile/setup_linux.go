//go:build linux && amd64

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"clawforge/tools/native/task240-native/task245-acceptance/internal/service"
)

const nativeRoot = "/lab/native-root"
const profileConfig = "/etc/clawwright"
const profileManifest = "/lab/native-manifest.json"

func profileHash(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("staged input unavailable")
	}

	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func profileWrite(path string, data []byte, mode os.FileMode) error {
	if err := os.WriteFile(path, data, mode); err != nil {
		return errors.New("profile file creation failed")
	}
	if err := os.Chown(path, 0, 0); err != nil {
		return errors.New("profile ownership failed")
	}
	if err := os.Chmod(path, mode); err != nil {
		return errors.New("profile permissions failed")
	}
	return nil
}

func profileJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return errors.New("profile configuration encoding failed")
	}
	return profileWrite(path, append(data, '\n'), 0644)
}

func profileExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func profileCopy(src, dst string, mode os.FileMode) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return errors.New("staged input unavailable")
	}
	if err = os.WriteFile(dst, data, mode); err != nil {
		return errors.New("profile copy failed")
	}
	if err = os.Chown(dst, 0, 0); err != nil {
		return errors.New("profile ownership failed")
	}
	if err = os.Chmod(dst, mode); err != nil {
		return errors.New("profile permissions failed")
	}
	return nil
}

// runProfile prepares the disposable, immutable native root; the next ceremony
// stage owns broker startup and all resulting acceptance evidence.
func runProfile(scenario string) (result error) {
	stage := "identity"
	defer func() { result = atProfileStage(stage, result) }()
	if os.Geteuid() != 0 ||
		os.Getenv("GITHUB_ACTIONS") != "true" ||
		os.Getenv("GITHUB_SHA") == "" ||
		os.Getenv("GITHUB_RUN_ID") == "" {
		return errors.New("Linux root and GitHub CI identity required")
	}

	stage = "capabilities"
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return errors.New("process capabilities unavailable")
	}
	var capEff string
	for _, line := range strings.Split(string(status), "\n") {
		if !strings.HasPrefix(line, "CapEff:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 2 {
			capEff = fields[1]
		}
		break
	}
	bits, err := strconv.ParseUint(capEff, 16, 64)
	if err != nil || bits&(1<<21) == 0 || bits&(1<<19) == 0 {
		return errors.New("CAP_SYS_ADMIN and CAP_SYS_PTRACE required")
	}

	stage = "freshness"
	for _, path := range []string{lab + "/disposable-profile", nativeRoot, "/run/task245-lab"} {
		if profileExists(path) {
			return errors.New("profile must be fresh")
		}
	}
	stage = "inventory"
	for _, name := range []string{
		"ssjack", "conductor", "driver", "consumer", "harness", "native-provider",
		"native-init", "native-stub", "gateway", "delivery_pty.py", "control-profile",
		"metadata-regression",
	} {
		if !profileExists(filepath.Join(lab, name)) {
			return errors.New("missing staged input")
		}
	}
	for _, name := range []string{"harness", "native-lab-broker", "ssjack", "native-metadata"} {
		info, statErr := os.Stat(filepath.Join(lab, "bin", name))
		if statErr != nil || !info.Mode().IsRegular() {
			return errors.New("missing staged tool")
		}
	}

	selected := os.Getenv("OPENCLAW_IMAGE")
	if selected == "" {
		selected = "ghcr.io/openclaw/openclaw:extended-stable"
	}
	if strings.TrimSpace(selected) != selected || selected == "" {
		return errors.New("invalid selected image")
	}
	if err = profileWrite(lab+"/disposable-profile", []byte("task245 synthetic lab\n"), 0444); err != nil {
		return err
	}

	if scenario == "" {
		stage = "metadata_preflight"
		owner, ownerErr := ownedProfileFixture()
		if ownerErr != nil {
			return ownerErr
		}
		if err = owner.run(profilePreflightMetadata); err != nil {
			return err
		}
	}
	stage = "tool_bind"
	if err = os.Chmod(lab+"/bin/native-metadata", 0555); err != nil {
		return errors.New("metadata tool permissions failed")
	}
	if err = bindRO(lab + "/bin"); err != nil {
		return errors.New("tool directory read-only bind failed")
	}
	binBound := true
	defer func() {
		if binBound {
			_ = unbind(lab + "/bin")
		}
	}()
	if err = bindRO(lab + "/ssjack"); err != nil {
		return errors.New("keeper read-only bind failed")
	}
	keeperBound := true
	defer func() {
		if keeperBound {
			_ = unbind(lab + "/ssjack")
		}
	}()

	stage = "native_setup"
	if err = os.Mkdir(nativeRoot, 0755); err != nil {
		return errors.New("native root creation failed")
	}
	for _, dir := range []string{"usr/bin", "usr/libexec", "etc/clawwright", "proc", "run"} {
		if err = os.MkdirAll(filepath.Join(nativeRoot, dir), 0755); err != nil {
			return errors.New("native root directory creation failed")
		}
	}
	sources := []struct {
		dest string
		src  string
	}{
		{"usr/bin/node", "gateway"},
		{"usr/libexec/clawwright-native-provider", "native-provider"},
		{"usr/libexec/native-domain-init", "native-init"},
		{"usr/libexec/native-launch-stub", "native-stub"},
	}
	hashes := map[string]string{}
	for _, item := range sources {
		dest := filepath.Join(nativeRoot, item.dest)
		if err = profileCopy(filepath.Join(lab, item.src), dest, 0555); err != nil {
			return err
		}
		hashes[item.dest], err = profileHash(dest)
		if err != nil {
			return err
		}
	}

	supervisor := lab + "/consumer"
	keeper := lab + "/ssjack"
	broker := lab + "/bin/native-lab-broker"
	supervisorHash, err := profileHash(supervisor)
	if err != nil {
		return err
	}
	keeperHash, err := profileHash(keeper)
	if err != nil {
		return err
	}
	brokerHash, err := profileHash(broker)
	if err != nil {
		return err
	}
	providerConfig := map[string]any{"supervisorSHA256": supervisorHash}
	if err = profileJSON(filepath.Join(nativeRoot, "etc/clawwright/native-provider.json"), providerConfig); err != nil {
		return err
	}
	openclawConfig := map[string]any{
		"fixture":  true,
		"metadata": map[string]string{"image": selected},
	}
	if err = profileJSON(filepath.Join(nativeRoot, "etc/clawwright/openclaw.json"), openclawConfig); err != nil {
		return err
	}
	manifest, err := profileBuildManifest(nativeRoot)
	if err != nil {
		return err
	}
	manifestBytes, err := json.Marshal(map[string]any{"version": 1, "entries": manifest})
	if err != nil {
		return errors.New("manifest encoding failed")
	}
	if err = profileWrite(profileManifest, append(manifestBytes, '\n'), 0444); err != nil {
		return err
	}
	manifestHash, err := profileHash(profileManifest)
	if err != nil {
		return err
	}

	initPath := nativeRoot + "/usr/libexec/native-domain-init"
	stubPath := nativeRoot + "/usr/libexec/native-launch-stub"
	providerPath := nativeRoot + "/usr/libexec/clawwright-native-provider"
	nodePath := nativeRoot + "/usr/bin/node"
	config := map[string]any{
		"RuntimeUID":       65534,
		"RuntimeGID":       65534,
		"Supervisor":       supervisor,
		"SupervisorSHA256": supervisorHash,
		"Keeper":           keeper,
		"KeeperSHA256":     keeperHash,
		"Init":             initPath,
		"InitSHA256":       hashes["usr/libexec/native-domain-init"],
		"Root":             nativeRoot,
		"Manifest":         profileManifest,
		"ManifestSHA256":   manifestHash,
		"Node":             nodePath,
		"Stub":             stubPath,
		"Provider":         providerPath,
		"ConfigPath":       nativeRoot + "/etc/clawwright/openclaw.json",
		"NodeSHA256":       hashes["usr/bin/node"],
		"StubSHA256":       hashes["usr/libexec/native-launch-stub"],
		"ProviderSHA256":   hashes["usr/libexec/clawwright-native-provider"],
		"GatewayArgv":      []string{"/usr/bin/node", "gateway"},
		"BrokerArgv":       []string{"/usr/bin/node", "broker"},
		"Target":           "target",
		"Revision":         "synthetic-delivery-v1",
		"Purpose":          "synthetic-confidential-delivery",
		"CaptureEvidence":  "/run/native-capture-ok",
		"SelectedImage":    selected,
	}
	launch := map[string]any{
		"BrokerSHA256":    brokerHash,
		"LabReceiptPath":  "/var/lib/ssjack/synthetic/consumer-receipt",
		"Target":          "target",
		"Revision":        "synthetic-delivery-v1",
		"Purpose":         "synthetic-confidential-delivery",
	}
	if scenario != "" {
		config["LabScenario"] = scenario
		launch["LabScenario"] = scenario
		if scenario == "wrong-holder" || scenario == "unexpected-exec" {
			config["GatewayArgv"] = []string{"/usr/bin/node", "gateway", scenario}
			config["BrokerArgv"] = []string{"/usr/bin/node", "broker", scenario}
		}
		if err = profileWrite(lab+"/scenario", []byte(scenario), 0444); err != nil {
			return err
		}
	}
	if err = os.MkdirAll(profileConfig, 0755); err != nil {
		return errors.New("configuration directory creation failed")
	}
	if err = profileJSON(profileConfig+"/native-lab.json", config); err != nil {
		return err
	}
	if err = profileJSON(profileConfig+"/native-supervisor.json", map[string]string{"keeperSHA256": keeperHash}); err != nil {
		return err
	}
	if err = profileJSON(profileConfig+"/native-launch.json", launch); err != nil {
		return err
	}
	if err = bindRO(nativeRoot); err != nil {
		return errors.New("native root read-only bind failed")
	}
	rootBound := true
	defer func() {
		if rootBound {
			_ = unbind(nativeRoot)
		}
	}()
	if err = profileWrite(lab+"/isolation-ok", []byte("task245\n"), 0444); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stage = "service_preflight"
	if err = service.CheckServices(ctx); err != nil {
		return err
	}
	stage = "ceremony"
	return runCeremony(scenario, supervisor, keeper, broker)
}

func profilePreflightMetadata() (result error) {
	controlHash, err := profileHash(lab + "/control-profile")
	if err != nil {
		return err
	}
	keeperHash, err := profileHash(lab + "/ssjack")
	if err != nil {
		return err
	}
	productKeeper := lab + "/ssjack-product"
	harnessKeeper := lab + "/harness-product-backup"
	if profileExists(productKeeper) || profileExists(harnessKeeper) {
		return errors.New("metadata backup fixture must be fresh")
	}
	if profileExists(lab+"/scenario") || profileExists("/var/lib/ssjack/synthetic") {
		return errors.New("notifier fixture must be fresh")
	}
	if err = profileCopy(lab+"/ssjack", productKeeper, 0755); err != nil {
		return err
	}
	if err = profileCopy(lab+"/bin/harness", harnessKeeper, 0755); err != nil {
		_ = os.Remove(productKeeper)
		return err
	}
	productHarnessHash, err := profileHash(harnessKeeper)
	if err != nil {
		_ = os.Remove(productKeeper)
		_ = os.Remove(harnessKeeper)
		return err
	}
	stateDir := "/var/lib/ssjack/synthetic"
	stateParent := "/var/lib/ssjack"
	if err = os.MkdirAll(stateParent, 0755); err != nil {
		_ = os.Remove(productKeeper)
		_ = os.Remove(harnessKeeper)
		return errors.New("notifier fixture parent creation failed")
	}
	parentInfo, parentErr := os.Lstat(stateParent)
	if parentErr != nil || !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 || parentInfo.Mode().Perm()&0022 != 0 || parentInfo.Mode().Perm()&0001 == 0 {
		_ = os.Remove(productKeeper)
		_ = os.Remove(harnessKeeper)
		return errors.New("notifier fixture parent unsafe")
	}
	parentStat, ok := parentInfo.Sys().(*syscall.Stat_t)
	if !ok || parentStat.Uid != 0 {
		_ = os.Remove(productKeeper)
		_ = os.Remove(harnessKeeper)
		return errors.New("notifier fixture parent unsafe")
	}
	if err = os.Mkdir(stateDir, 0700); err != nil {
		_ = os.Remove(productKeeper)
		_ = os.Remove(harnessKeeper)
		return errors.New("notifier fixture creation failed")
	}
	state := stateDir + "/state.json"
	receipt := stateDir + "/consumer-receipt"
	fault := stateDir + "/native-fault-reached"
	scenario := lab + "/scenario"
	bound := false
	restored := false
	cleanup := func() error {
		var first error
		if bound {
			if e := unbind(lab + "/bin"); e != nil {
				first = errors.New("metadata preflight unbind failed")
			} else {
				bound = false
			}
		}
		if !restored {
			var restoreErr error
			if e := profileCopy(productKeeper, lab+"/ssjack", 0755); e != nil {
				restoreErr = e
			}
			if e := profileCopy(lab+"/control-profile", lab+"/harness", 0755); e != nil && restoreErr == nil {
				restoreErr = e
			}
			if e := profileCopy(harnessKeeper, lab+"/bin/harness", 0555); e != nil && restoreErr == nil {
				restoreErr = e
			}
			expectedHashes := map[string]string{
				lab + "/ssjack":      keeperHash,
				lab + "/harness":    controlHash,
				lab + "/bin/harness": productHarnessHash,
			}
			for path, expected := range expectedHashes {
				actual, hashErr := profileHash(path)
				if (hashErr != nil || actual != expected) && restoreErr == nil {
					restoreErr = errors.New("metadata restoration digest mismatch")
				}
			}
			if restoreErr != nil && first == nil {
				first = restoreErr
			}
			restored = restoreErr == nil
		}
		for _, path := range []string{state, receipt, fault, scenario} {
			if e := os.Remove(path); e != nil && !os.IsNotExist(e) && first == nil {
				first = errors.New("notifier fixture cleanup failed")
			}
		}
		if e := os.Remove(stateDir); e != nil && first == nil {
			first = errors.New("notifier fixture cleanup failed")
		}
		if e := os.Remove(productKeeper); e != nil && first == nil {
			first = errors.New("metadata backup cleanup failed")
		}
		if e := os.Remove(harnessKeeper); e != nil && first == nil {
			first = errors.New("metadata backup cleanup failed")
		}
		return first
	}
	defer func() {
		if e := cleanup(); e != nil {
			result = e
		}
	}()

	if err = os.Chown(stateDir, 65534, 65534); err != nil {
		return errors.New("notifier fixture ownership failed")
	}
	fixtureFiles := map[string][]byte{
		state:   []byte("{}"),
		receipt: bytesRepeat(0x5a, 48),
		fault:   []byte("cancel"),
	}
	for path, data := range fixtureFiles {
		if err = profileWrite(path, data, 0600); err != nil {
			return err
		}
		if err = os.Chown(path, 65534, 65534); err != nil {
			return errors.New("notifier fixture ownership failed")
		}
	}
	if err = profileWrite(scenario, []byte("cancel"), 0444); err != nil {
		return err
	}
	for _, item := range []struct {
		src string
		dst string
	}{
		{lab + "/metadata-regression", lab + "/bin/harness"},
		{lab + "/metadata-regression", lab + "/harness"},
		{lab + "/metadata-regression", lab + "/ssjack"},
	} {
		if err = profileCopy(item.src, item.dst, 0755); err != nil {
			return err
		}
	}
	if err = bindRO(lab + "/bin"); err != nil {
		return errors.New("metadata preflight bind failed")
	}
	bound = true
	inactiveOut, inactiveErr, runErr := command(
		lab+"/harness",
		[]string{"--notifier-inactive"},
		[]string{"GITHUB_ACTIONS=true"},
		20*time.Second,
		false,
	)
	if runErr != nil || string(inactiveOut) != "metadata notifier inactive: PASS\n" || len(inactiveErr) != 0 {
		return errors.New("metadata notifier inactive regression failed")
	}
	out, stderr, runErr := command(
		lab+"/ssjack",
		[]string{"--notifier"},
		[]string{"GITHUB_ACTIONS=true"},
		40*time.Second,
		false,
	)
	if runErr != nil || string(out) != "metadata notifier regression: PASS\n" || len(stderr) != 0 {
		return errors.New("metadata notifier regression failed")
	}
	return nil
}

func profileBuildManifest(root string) ([]map[string]any, error) {
	paths := []string{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return errors.New("native manifest walk failed")
		}
		if path != root {
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			paths = append(paths, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)
	entries := make([]map[string]any, 0, len(paths))
	for _, rel := range paths {
		path := filepath.Join(root, filepath.FromSlash(rel))
		info, err := os.Lstat(path)
		if err != nil {
			return nil, errors.New("native manifest entry unavailable")
		}
		item := map[string]any{"path": rel, "mode": uint32(info.Mode().Perm())}
		if info.IsDir() {
			item["type"] = "dir"
		} else if info.Mode().IsRegular() {
			item["type"] = "file"
			hash, err := profileHash(path)
			if err != nil {
				return nil, err
			}
			item["sha256"] = hash
		} else {
			return nil, errors.New("unsupported native root entry")
		}
		entries = append(entries, item)
	}
	return entries, nil
}

func bytesRepeat(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}
