package main

import (
	"bytes"
	"fmt"
)

// approvedTask251 is a fixed allowlist of reviewed exact non-Go blob transitions. A
// transition is enabled only when the immutable baseline inventory has the stated
// baseline blob at that exact path; evaluation later requires the exact current blob.
type task251Transition struct { baseline, current string }

func task251Transitions() map[string]task251Transition {
	transitions := map[string]task251Transition{
		"tools/checks/foundation/core/command/spec/binder.check.ts": {"785e309581aefb7163480b606808d174bb887a25", "b9192ede233b31d0b4f4fa7653defab92dfb2101"},
		"tools/checks/foundation/core/command/spec/call.check.ts": {"4078662e8904ad0e5814beda900a6dca2525736c", "27eb2dc1ed5dce5d8aedeca0f197b8d644f4839f"},
		"tools/checks/foundation/packaging/stale-dist.check.ts": {"889a687a2461e661533fa01cd9d888de6d60722f", "3cc53408b1866ab9250424fa9fb04d9acba134be"},
		"tools/checks/integration/apps/app-hooks.check.ts": {"9961f5c4227f599789a53e8b99fb4cde9c7ed45c", "961908f1c39f20f82fae58b23fac8cb89fce303b"},
		"tools/checks/integration/apps/app-recipes-dir.check.ts": {"3399a563a6525b78501aa428117f5bbf5b2a7528", "cf89055323f629e77f76e8bbbe25041e150822d2"},
		"tools/checks/integration/mcp/dispatch/gate-confirm.check.ts": {"ff1e3825389ecba0eb1a212c4bd4ea2ef80000e0", "aac3930f2f1efd104562934562a082e796507d22"},
		"tools/checks/integration/mcp/dispatch/mcp-server.check.ts": {"bd12b208ef21ed6ad8152df5b8107f7c18cd40d2", "93c8a0bde71e630401e0757a652d5325ebaff10b"},
		"tools/checks/integration/mcp/dispatch/trial-run.check.ts": {"45b30519496b38cf99f79d914008244be50b9ddc", "4bccf3d2b155a23c0b021c2128c04a29b2292e12"},
		"tools/checks/integration/mcp/progress/mcp-apply-report.check.ts": {"381d8bb5450951f591d28a7dc6187adf3ed96c47", "18270eb2e8e92a93aa81cca50ca22cc7934d8fbe"},
		"tools/checks/integration/mcp/progress/mcp-structured-progress.check.ts": {"6d4ef6d0be43f3c0a5e529feada5f3cbf63bbdd2", "6dd6232e506d407ceb683a05e10532ef36f3aefc"},
		"tools/checks/integration/mcp-safety-policy.check.ts": {"0f617b3656352dfe63c09c3a4867433e746e7e26", "95d888438532bcaf9c3b4f2cd9eaabbc616f9697"},
		"tools/checks/integration/recipe/hooks/recipe-kit/surface.check.ts": {"8ed02a9394da8774bca1369325d49c4c9bf65109", "b0349cae21549fea6b766a2245b30a128247bb06"},
		"tools/checks/runtime/connection-facts/recover-env-dispatch.check.ts": {"8903869fa6ba085adf56e3316a3ba8f84caa42a3", "347eb6eba7e95f03c428b97e1ff7ee45d4b6c37e"},
		"tools/checks/runtime/convergence/apply-config.check.ts": {"04120078ee938d6add7718d846a7523ec68e0714", "d9a1b1c725ed17ec5d939ebbcc5afd42723e31e6"},
		"tools/checks/sets/lifecycle/set-try.check.ts": {"ea5ac7d4101e4ad165020c8be5e5d7cd85a6fc0b", "eb0d55543ba9688e1b58b4066ac6ec4b6771bd86"},
		"tools/clawwright.ts": {"56830b8d4168ada3126c8978984282dd8a605d9f", "742adfaa806a8d165d62cf9689d49feb9e7c185e"},
		"tools/build-framework-package.ts": {"5164363d0dbd927b5a26f99fc42dec953011a15e", "cc748708c71c92356f6331d00fd293fcb2700bb1"},
		"tools/checks/architecture/architecture.check.ts": {"bb156e30699e613fc717d20179fe7eecadcf4572", "dbb46261b73b37cf49bae08ce12932aa42759cbc"},
		"tools/checks/architecture/command-layer/grammar-in-run.ts": {"e420fe35d228f49e05ae32ef86a6db39e774993a", "ca8a5086ff9ef31c23a5f401e228647501ced513"},
		"tools/checks/architecture/command-layer/kind-casts.ts": {"2af4c675f46b5bf6a80dfcc1e75eeefd70086fe2", "b71b1facf6825ce17b42bb759581174f17ec692c"},
		"tools/checks/architecture/frame-ratchets.ts": {"b04326fdbdd54002d8613b2e721f2c2fa3cb22af", "fd8e7c812ffd2e81e1f6d0a46409751f7bf4e507"},
		"tools/checks/controls/controls.ts": {"1364f51cb87e1ee36999790cbff3267009ff64f6", "cb6c655e1b1ca5380e9f079cdd6e5a0b12def79a"},
		"tools/checks/controls/stage7-accept.ts": {"576245cbaf34c6373bd3dccf047ec0fd753a079e", "b58322c46c4105d4bc7f8902919dd6c488dffa3c"},
		"tools/checks/controls/stage7.ts": {"da4dbe943bb257c56e117f26f3d5273a84b123ff", "5fe6bb42526ef8f4c744a0b86f3f13432ec6d1f5"},
		"tools/checks/entry/linked-launch.check.ts": {"16d20f8d65923245eb3578e985c2f2dc8469cb88", "0a5c0a84a262ca50d0fa2ee0492a8af4ad5716e5"},
		"tools/checks/foundation/cli/cli-help.check.ts": {"6a073f7a467c604817f15cf2af77c78e0a67cd4a", "31b14a46383bafe3527e233e0fe77b39364d7dc8"},
		"tools/checks/foundation/core/command/needs.check.ts": {"58bb72512f77f0162b44b71fa72fb4898ad1d05b", "97e53bf6f30c9c10687382f22c97b461549d962b"},
		"tools/checks/foundation/core/deployment-names.check.ts": {"e34976b0e6656bfd62aecb82f78cca8716f3a541", "97a653ef758e95bcbea4ee8fa65710cf52ca8d30"},
		"tools/checks/foundation/core/env.check.ts": {"7284faf24e2c70914aaef6e3a945e0f7350a6b3b", "e5d40f6d9a428af97d333bf257a7ccad63ec008e"},
		"tools/checks/foundation/hygiene/check-linux.check.ts": {"5b2c41fa94aa3e2ed51fe35dca7f6ec08dcbbfee", "a65723de69cd492b54360a9fabf11c1768c8b87f"},
		"tools/checks/foundation/hygiene/static/import-style.check.ts": {"1d4cc6713dd8b1558a5703768c42fafc0a2f92fc", "43985cf6b980bf9d981ee3b448fa5cee63210f5d"},
		"tools/checks/foundation/hygiene/static/local-tar-owner.check.ts": {"f7a7d1e4b922376c0ec2ea798624656c283f3271", "a1275b2911ec29bee89b7b9a6e7e80e1c9665233"},
		"tools/checks/foundation/hygiene/static/local-tar-rules.ts": {"fe31266ce179f7166ae8090e3dd4f8b21e82d0fb", "854793243606312fd7f53efa87ead3f397a3d1f5"},
		"tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts": {"066d61738ebdee63ab28f65c43ac5f1f5377d0be", "e3bdfbe8c1da0c8aa31856a3e1a30113dc904405"},
		"tools/checks/foundation/invocation/frame.check.ts": {"74d7e27366dc8897e99c4f2ac7da2ef6c9a5a80d", "94f57ce5968ef107573685de63742a66f8fe2b0c"},
		"tools/checks/foundation/layout.check.ts": {"4985b5e67d11b1e5ae02da49d3385f130bd39cbf", "c01e2982e4e353f08b1bf52a9d1bc324dc8324c7"},
		"tools/checks/foundation/packaging/build-output.check.ts": {"1c5015bc4c6afac4744138357cffbf72376faafc", "b02b44dd086bedc632692317d6319c7605f3db0b"},
		"tools/checks/golden/durable-frame.check.ts": {"7d46c763bd7df4df7e633320eee291fa29f47185", "70d8abadac3c46947e908f464ad3678cab478a79"},
		"tools/checks/golden/frames.ts": {"b3b170b7ea1275af429c9043521206cdedd09ba8", "07bd3a9586f196c78af9d2663f86b52c59025167"},
		"tools/checks/golden/matrix.ts": {"f44d94e47f3bcc4fbe564cd379e22bcfc970354f", "4da3658a9401ee5669d066f200d9b416110f2964"},
		"tools/checks/golden/render.ts": {"38e26cc1b1e8bd15fce99cc1b54e55be8e3a1076", "563ab412a17939bef11c174910b99612907c07c8"},
		"tools/checks/integration/agent/recipe-hook-freshness/hook-framework-import.check.ts": {"9234b22578b82252ac0fc643308e1db60ef3ed42", "d491a677a42682b6654d17bc56316c27117e527a"},
		"tools/checks/integration/apps/init-messages.check.ts": {"921c9a1d9e84e2f84dd051498de31fb0854a21cb", "c3523e9b28e4b2e6b570b9d5ef9cd7ebff74f962"},
		"tools/checks/integration/apps/invocation-hints-rooted.check.ts": {"fcd2c82f432225671365e95b9d98d6691a035642", "110a09d0d8e64e8242d4f58f4f02ac3b7f31b21f"},
		"tools/checks/integration/apps/invocation-hints.check.ts": {"08876b36a1d87323fa3dad07366703962a15a036", "9dcba0c8ac2e8267629012b57150746c6d6fd0f2"},
		"tools/checks/integration/apps/remove-app.check.ts": {"c977a27999a531c51d75f4bc8dfcff47ac385e18", "823c79544b2d243f6dbda410f9c95dbec758b93f"},
		"tools/checks/integration/init.check.ts": {"42ab892bfdb95c33b16fd6e245cfd16f06e716f2", "58716407887eba2a592d944e742092d512850f18"},
		"tools/checks/integration/list.check.ts": {"f1a22f428ac2767630fd2523cbce1dce73a3e5e7", "bba55a21514cf3035a7debd150b2ebb644123f49"},
		"tools/checks/integration/mcp/dispatch/changed-inventory.ts": {"6b90126615214f4827076ff25f66946a8e42b5dd", "80754014c97930fca132088c8cac452f02c2d0a7"},
		"tools/checks/integration/mcp/dispatch/mcp-changed.check.ts": {"81ec0186e522273bbb12e90e82b3023afce91c4c", "7dd79b3d87797043fa960aa5992a550f19fcbaee"},
		"tools/checks/integration/mcp/transport-listing.check.ts": {"dc5ef26a08f7c474277722022a0891d1ed505afe", "7791964f33a91f8e84f44a74a4e534e305dce6dc"},
		"tools/checks/kit/capabilities/run-guard.check.ts": {"d86a92884ace027d02a1f31beadb42c69167261f", "f0f0f2dcafff70eb75882e08f8c289fd62a80d9d"},
		"tools/checks/kit/deployment-fixture.ts": {"8f94d6c69be3daba0fc0e42dcf9df064bf9f988e", "8245038ee135a7d6b430ec20d482394b2d34ab6f"},
		"tools/checks/kit/run.ts": {"a37c6ba4ea26ed59e17a01edb9e0228e3de04626", "7c9ff07c44251b7eff094171d3eaa8dc1a2f24af"},
		"tools/checks/kit/selection/import-graph.check.ts": {"cf633a786545fe2772c9a9d6a2e484c6544854d7", "0459785d5b2ad50a8c072acb2f5eca9dbdc00eb1"},
		"tools/checks/kit/selection/import-graph.ts": {"158879d72d42d36803516451cc35949f7b6b320a", "c82ff4354998e015b701c9d4465140af7258c017"},
		"tools/checks/kit/selection/rules.ts": {"e24d463345f84ce455cded12efab52118aae0373", "e8549159c7e4f9e6bd29789c8a80839fd3bd12ec"},
		"tools/checks/kit/selection/selection.check.ts": {"6e6a08daa9d6b4f3fd024a35b121d8f17e9f23bb", "0e8b367ee8200f76cd4c09d7a7ecf70e381a23fa"},
		"tools/checks/kit/self/deployment-fixture.check.ts": {"133629e3e50aaf6119c9c3dd1e7b3b8f2be6bb94", "10634f7d6a94c448bf27e389e6f0f734e88215fa"},
		"tools/checks/kit/self/shells.check.ts": {"7d91160e258b3d8dee57cc79c06baeca15165c06", "3a2458e90e3b0468e736b0ab8ae82e07007641ff"},
		"tools/checks/release/release/installed-consumer.check.ts": {"f3e18e2900f0353fe43a3b3e31582a46475bc09b", "e4669133876511d3429df20e314290354a2739f3"},
		"tools/checks/release/release/package-release.check.ts": {"d82ca05eaf31be9834efebc1e1c0ade943fd95bc", "119bc5d58acf370c05220f9d7a89ac35022c3053"},
		"tools/checks/release/release/system-command-units.check.ts": {"48906a8ec4b11fea2a62826979a0e2253b2086b3", "45fa96b443c4b2b2d9a96621d5448a2cba974bea"},
		"tools/checks/release/release/system-install.check.ts": {"138fcb424e78ddec393e5ffa91e9555d6bfeb46c", "ef832a65ebc0581d75cf72d76107f175b79cdc0e"},
		"tools/checks/runtime/lifecycle/bootstrap/bootstrap-provider-order.check.ts": {"f650205069eec0928bab8c6829faa3e46710469f", "21343327210ba5135b1ba8ce50d5c2413ce9478e"},
		"tools/checks/runtime/schedule/schedule.check.ts": {"6135f7f11b23aab305bf9e9cd6cec8b9cf5fb668", "bf038dbe369539a29ed9b042154d5f0148f52c5e"},
		"tools/checks/runtime/service/deploy/checkout-policy/sensitive-names.check.ts": {"6d693579204c5d6cc224a634b779993defcec2e4", "b84ea028d83f47e5ea3e327aaf4abde0e7f27a09"},
		"tools/checks/runtime/service/deploy/rsync-file-list.check.ts": {"6eaf0e4be84c20b35c49c867fb9dfd3c944a70c6", "051b70e428e28bb67a3085ada3a0ac89f8056d52"},
		"tools/checks/runtime/transport/scenarios/contract.ts": {"925587012b76fb5b6fccf78c231cc14a25ff54a1", "d6daff6f0c1e28f9057781b586093099bbef6bd9"},
		"tools/checks/security/expose/no-serve-reset.check.ts": {"9d2feaf809a2434dd0009450b4ed65ee01269047", "d71e410de77805e65fa541ee8b0f345f379241e1"},
		"tools/checks/sets/lifecycle/set-module-load.check.ts": {"203a664cad9743f22fece9f98f7597280ac42d75", "37cf6eff4b0191d13f145079ef9ec65ad3bfcb33"},
		"tools/checks/sets/tar/local-tar-owner.check.ts": {"1031d2c6e2790c6c342151fee98a313428a14e88", "d5e7b404c0d1dd1615888d7060acc45c36645f10"},
		"tools/checks/surfaces/advice/checkout-paste.check.ts": {"658abc76d4fbd2e7b196ac10506190d526b2bb37", "fb97fc8656a5b10e6474addf2c818668b0f74df1"},
		"tools/checks/surfaces/frame-law-counter.ts": {"17f3714fa5ba1806b1566d33fe4669645bc97836", "2d2cb62c2014e1b056ebb558afebe06229acf220"},
		"tools/checks/surfaces/help-prose.check.ts": {"79b0add6d60453483fed05ae01462e23f91181de", "8dfc16071398026f40b15c07e4a42a7d8eeb668c"},
		"tools/checks/surfaces/top-level-advice.check.ts": {"48430a30b379288398868120236767df98121aa5", "2a1022c8fd2386eeda4349b53e8c95db1eefe5dd"},
		"tools/dev/check-linux-argv.ts": {"6c62c795f170b542007df40e5e3326fed7c44ac9", "f5e3fdb2fbb4ae885fb192431b53f52f92ea8ca9"},
		"tools/dev/install-system.ts": {"7df84ae508caff784984ab4bb8231b3e952c279c", "0effe0947574295c07a7fb554883949db1886257"},
		"tools/dev/worktree.ts": {"ad890b1cccd2213a7a66bd407c7a5b527cca780b", "4151d4d082c7c8c3f74e0830d91e552cec1cbfc5"},
	}
	return transitions
}

func approvedTask251(legacy map[string]inventory) map[string]string {
	transitions := task251Transitions()
	approved := make(map[string]string, len(transitions))
	for path, pair := range transitions {
		if old, exists := legacy[path]; exists && old.blob == pair.baseline {
			approved[path] = pair.current
		}
	}
	return approved
}

func approvedControlProfile(b []byte) ([]byte, error) {
	pairs := [][2]string{
		{`    mount(MS_BIND | MS_REMOUNT | MS_RDONLY)

def confinement_mode():`, `    mount(MS_BIND | MS_REMOUNT | MS_RDONLY)

def unbind(p):
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    libc.umount2.argtypes = [ctypes.c_char_p, ctypes.c_int]
    if libc.umount2(os.fsencode(p), 0):
        raise OSError(ctypes.get_errno(), 'umount2 failed', str(p))

def confinement_mode():`},
		{`    (LAB / 'bin/native-metadata').chmod(0o555)
    bind_ro(LAB / 'bin')
    if not scenario:`, `    if not scenario:`},
		{`        product_keeper = LAB / 'ssjack-product'
        need(not product_keeper.exists(), 'ssjack-product fixture already exists')
        shutil.copyfile(LAB / 'ssjack', product_keeper)
        os.chmod(product_keeper, 0o755)`, `        product_keeper = LAB / 'ssjack-product'
        harness_keeper = LAB / 'harness-product-backup'
        need(not product_keeper.exists(), 'ssjack-product fixture already exists')
        need(not harness_keeper.exists(), 'harness product backup fixture already exists')
        shutil.copyfile(LAB / 'ssjack', product_keeper)
        shutil.copyfile(LAB / 'bin/harness', harness_keeper)
        product_harness_digest = digest(harness_keeper)
        os.chmod(product_keeper, 0o755)`},
		{`        denied_state.write_text('{}'); os.chown(denied_state, UID, GID); os.chmod(denied_state, 0o600)
        try:`, `        denied_state.write_text('{}'); os.chown(denied_state, UID, GID); os.chmod(denied_state, 0o600)
        receipt = denied_state.parent / 'consumer-receipt'
        fault = denied_state.parent / 'native-fault-reached'
        for fixture, content in ((receipt, bytes([0x5a]) * 48), (fault, b'cancel')):
            fixture.write_bytes(content)
            os.chown(fixture, UID, GID)
            os.chmod(fixture, 0o600)
        bin_bound = False
        try:`},
		{`        try:
            shutil.copyfile(LAB / 'metadata-regression', LAB / 'harness')
            shutil.copyfile(LAB / 'metadata-regression', LAB / 'ssjack')
            os.chmod(LAB / 'harness', 0o755)
            os.chmod(LAB / 'ssjack', 0o755)
            inactive = subprocess.run`, `        try:
            shutil.copyfile(LAB / 'metadata-regression', LAB / 'bin/harness')
            shutil.copyfile(LAB / 'metadata-regression', LAB / 'harness')
            shutil.copyfile(LAB / 'metadata-regression', LAB / 'ssjack')
            os.chmod(LAB / 'bin/harness', 0o755)
            os.chmod(LAB / 'harness', 0o755)
            os.chmod(LAB / 'ssjack', 0o755)
            need(not scenario_file.exists(), 'notifier scenario must be fresh')
            scenario_file.write_text('cancel')
            os.chown(scenario_file, 0, 0)
            os.chmod(scenario_file, 0o444)
            bind_ro(LAB / 'bin')
            bin_bound = True
            inactive = subprocess.run`},
		{`            need(inactive.stderr == '', 'metadata notifier inactive regression wrote stderr')
            need(not scenario_file.exists(), 'notifier scenario must be fresh')
            scenario_file.write_text('cancel')
            os.chown(scenario_file, 0, 0)
            os.chmod(scenario_file, 0o444)
            regression = subprocess.run`, `            need(inactive.stderr == '', 'metadata notifier inactive regression wrote stderr')
            regression = subprocess.run`},
		{`        finally:
            try:
                shutil.copyfile(product_keeper, LAB / 'ssjack')
                shutil.copyfile(LAB / 'control-profile', LAB / 'harness')
                os.chmod(LAB / 'ssjack', 0o755)
                os.chmod(LAB / 'harness', 0o755)
                need(digest(LAB / 'ssjack') == keeper_digest, 'keeper restoration digest mismatch')
                need(digest(LAB / 'harness') == control_digest, 'control harness restoration digest mismatch')`, `        finally:
            try:
                if bin_bound:
                    unbind(LAB / 'bin')
                shutil.copyfile(product_keeper, LAB / 'ssjack')
                shutil.copyfile(LAB / 'control-profile', LAB / 'harness')
                shutil.copyfile(harness_keeper, LAB / 'bin/harness')
                os.chmod(LAB / 'ssjack', 0o755)
                os.chmod(LAB / 'harness', 0o755)
                os.chmod(LAB / 'bin/harness', 0o555)
                need(digest(LAB / 'ssjack') == keeper_digest, 'keeper restoration digest mismatch')
                need(digest(LAB / 'harness') == control_digest, 'control harness restoration digest mismatch')
                need(digest(LAB / 'bin/harness') == product_harness_digest, 'product harness restoration digest mismatch')`},
		{`                if product_keeper.exists():
                    product_keeper.unlink()
                denied_state.unlink()
                denied_state.parent.rmdir()
    bind_ro(LAB / 'ssjack')`, `                if product_keeper.exists():
                    product_keeper.unlink()
                if harness_keeper.exists():
                    harness_keeper.unlink()
                denied_state.unlink()
                for fixture in (receipt, fault):
                    if fixture.exists():
                        fixture.unlink()
                denied_state.parent.rmdir()
    (LAB / 'bin/native-metadata').chmod(0o555)
    bind_ro(LAB / 'bin')
    bind_ro(LAB / 'ssjack')`},
	}
	for i, pair := range pairs {
		old, replacement := []byte(pair[0]), []byte(pair[1])
		if bytes.Count(b, old) != 1 {
			return nil, fmt.Errorf("control profile anchor %d must occur exactly once", i+1)
		}
		b = bytes.Replace(b, old, replacement, 1)
	}
	return b, nil
}

func approvedControlRunner(b []byte) ([]byte, error) {
	pairs := [][2]string{
		{`        for source, output in (("task245-domain-init/main.rs", "native-init"), ("task240-launch-stub/main.rs", "native-stub")):
`, `        for source, output in (("task245-domain-init/main.rs", "native-init"), ("task240-launch-stub/main.rs", "native-stub"), ("task245-control-profile/installer/main.rs", "control-installer")):
`},
		{`            (stage/output).chmod(0o755)
        for source, output in (("task245-control-profile/control-profile.c","control-profile"),("task245-control-profile/probe.c","probe"),("task245-control-profile/metadata.c","native-metadata"),("task245-control-profile/metadata_test.c","metadata-regression"),("task245-acceptance/gateway.c","gateway"),("task245-acceptance/release_fixture.c","release-fixture")):
            PHASE = "compile-" + output
            invoke(["cc","-std=c11","-O2","-static","-Werror=implicit-function-declaration","-o",str(stage/output),str(NATIVE/source),*([str(NATIVE/'task245-control-profile/metadata_client.c')] if output=='control-profile' else [])])
            (stage/output).chmod(0o555 if output == "native-metadata" else 0o755)
`, `            (stage/output).chmod(0o555 if output == "control-installer" else 0o755)
        for source, output in (("task245-control-profile/probe.c", "probe"), ("task245-acceptance/gateway.c", "gateway"), ("task245-acceptance/release_fixture.c", "release-fixture")):
            PHASE = "compile-" + output
            invoke(["cc", "-std=c11", "-O2", "-static", "-Werror=implicit-function-declaration", "-o", str(stage/output), str(NATIVE/source)])
            (stage/output).chmod(0o755)
        for output, package in (("control-profile", "./task245-control-profile/cmd/control-profile"), ("native-metadata", "./task245-control-profile/cmd/native-metadata"), ("metadata-regression", "./task245-control-profile/cmd/metadata-regression")):
            PHASE = "build-" + output
            build_go(NATIVE, package, stage / output, n_env)
            (stage/output).chmod(0o555 if output == "native-metadata" else 0o755)
`},
		{`        for source, target in (("harness","harness"),("native-lab-broker","native-lab-broker"),("native-metadata","native-metadata"),("ssjack","ssjack")):
`, `        for source, target in (("harness","harness"),("native-lab-broker","native-lab-broker"),("native-metadata","native-metadata"),("control-installer","control-installer"),("ssjack","ssjack")):
`},
		{`        hashes={name:digest(stage/name) for name in ('ssjack','conductor','driver','harness','consumer','native-provider','native-lab-broker','release-test','release-fixture','native-stub','native-init','native-metadata','metadata-regression','gateway','control-profile','probe')}
`, `        hashes={name:digest(stage/name) for name in ('ssjack','conductor','driver','harness','consumer','native-provider','native-lab-broker','release-test','release-fixture','native-stub','native-init','control-installer','native-metadata','metadata-regression','gateway','control-profile','probe')}
`},
		{`                entry.uid=entry.gid=0; entry.mode=0o755
`, `                entry.uid=entry.gid=0; entry.mode=0o555 if path.relative_to(stage).as_posix() in ("native-metadata", "bin/native-metadata") else 0o755
`},
	}
	for i, pair := range pairs {
		old := []byte(pair[0])
		if bytes.Count(b, old) != 1 {
			return nil, fmt.Errorf("control runner anchor %d must occur exactly once", i+1)
		}
		b = bytes.Replace(b, old, []byte(pair[1]), 1)
	}
	return b, nil
}
