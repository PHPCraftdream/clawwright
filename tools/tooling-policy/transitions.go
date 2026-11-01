package main

import (
	"bytes"
	"fmt"
)

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
