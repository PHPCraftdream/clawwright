#!/usr/bin/env python3
"""Build pinned Task 245 inputs and run them only in a disposable Linux CI container."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[3]
NATIVE = ROOT / "tools" / "native"
SHA = "ca7ce8023f3fb1a3498d801eda29aa3614961a79"
BASE = "2997e692cdc24f5b9a5aa23cadc3b22ab1b32f02"
PRODUCT = Path(os.environ.get("TASK245_PRODUCT_CHECKOUT", ""))
CAPS = {"CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID", "KILL", "SYS_ADMIN", "SYS_PTRACE", "SYS_CHROOT"}
PHASE = "inputs"

def invoke(argv, *, cwd=None, env=None, check=True, capture=True, stdin=None):
    return subprocess.run(argv, cwd=cwd, env=env, check=check, text=True, stdin=stdin,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None)

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()

def build_go(root, package, output, env, *, product=False):
    args = ["go", "build", "-mod=readonly", "-trimpath", "-buildmode=exe"]
    if product and package == "./cmd/ssjack":
        args += ["-ldflags", "-X github.com/PHPCraftdream/ssjack/internal/buildinfo.Commit=" + SHA]
    args += ["-o", str(output), package]
    invoke(args, cwd=root, env=env)
    output.chmod(0o755)
    if product and package.endswith("syntheticdriver"):
        with output.open("r+b") as image:
            image.seek(40); image.write(bytes(8)); image.seek(58); image.write(bytes(6))

def main():
    global PHASE
    lab_case = os.environ.get("TASK245_LAB_CASE", "connected")
    require = lambda ok, why: (_ for _ in ()).throw(RuntimeError(why)) if not ok else None
    require(lab_case in ("connected", "confinement", "wrong-holder", "unexpected-exec", "partial-ack", "lost-ack", "cancel"), "invalid TASK245_LAB_CASE")
    require(sys.platform == "linux", "Linux CI only")
    require(os.environ.get("CI") == "true" and os.environ.get("GITHUB_ACTIONS") == "true", "CI only")
    require(PRODUCT.is_dir() and PRODUCT.resolve() != ROOT.resolve(), "separate pinned product checkout required")
    require(os.environ.get("TASK245_PRODUCT_COMMIT") == SHA, "full product commit pin required")
    require(os.environ.get("TASK245_PRODUCT_BASE") == BASE, "full product base pin required")
    require(not os.environ.get("TASK245_PRODUCT_TAG"), "mutable tag forbidden")
    require(os.environ.get("TASK245_IMAGE") == "python:3.13-slim", "unexpected lab image")
    temp = Path(os.environ.get("RUNNER_TEMP", ""))
    require(temp.is_absolute() and str(temp) != "/", "RUNNER_TEMP required")
    require(re.fullmatch(r"[a-f0-9]{40}", os.environ.get("GITHUB_SHA", "")) and os.environ.get("GITHUB_RUN_ID", "").isdigit(), "CI identity missing")
    require(invoke(["git", "rev-parse", "HEAD"], cwd=PRODUCT).stdout.strip() == SHA, "product checkout SHA mismatch")
    parent = Path(tempfile.mkdtemp(prefix="task245-acceptance-", dir=temp))
    parent.chmod(0o700)
    stage = parent / "lab"; stage.mkdir(mode=0o755)
    container = "task245-acceptance-" + str(os.getpid()); created = False
    try:
        PHASE = "build-product"
        p_env = dict(os.environ, GOTOOLCHAIN="local", CGO_ENABLED="0", GOPROXY=os.environ.get("GOPROXY", "https://proxy.golang.org,direct"), GOMODCACHE=str(parent / "gomodcache"), GOCACHE=str(parent / "gocache"))
        packages = {"ssjack":"./cmd/ssjack", "conductor":"./cmd/ssjack-lab", "driver":"./internal/declarativeslice/tests/fixtures/syntheticdriver", "harness":"./internal/declarativeslice/tests/fixtures/secretharness"}
        hashes = {}
        for name, package in packages.items():
            PHASE = "build-" + name
            if name == "conductor" and lab_case not in ("connected", "confinement"):
                overlay = {
                    "Replace": {
                        str(PRODUCT / "cmd/ssjack-lab/main_linux.go"): str(NATIVE / "task245-composed-lab/main_linux.go"),
                        str(PRODUCT / "cmd/ssjack-lab/task245_negative_linux.go"): str(NATIVE / "task245-composed-lab/negative_linux.go"),
                        str(PRODUCT / "cmd/ssjack-lab/task245_cancel_check_linux.go"): str(NATIVE / "task245-composed-lab/cancel_check_linux.go"),
                    }
                }
                overlay_path = parent / "task245-overlay.json"
                overlay_path.write_text(json.dumps(overlay, sort_keys=True, separators=(",", ":")) + "\n")
                args = ["go", "build", "-tags", "task245lab", "-overlay", str(overlay_path), "-mod=readonly", "-trimpath", "-buildmode=exe", "-o", str(stage / "conductor"), "./cmd/ssjack-lab"]
                invoke(args, cwd=PRODUCT, env=p_env)
                (stage / "conductor").chmod(0o755)
            else:
                build_go(PRODUCT, package, stage / name, p_env, product=True)
            hashes[name] = digest(stage / name)
        PHASE = "build-native"
        n_env = dict(os.environ, GOTOOLCHAIN="local", CGO_ENABLED="0", GOPROXY="off", GOMODCACHE=str(parent / "gomodcache"), GOCACHE=str(parent / "gocache"))
        for name, package in (("consumer", "./task245-native-supervisor"), ("native-provider", "./task240-native-provider"), ("native-lab-broker", "./task245-lab-broker")):
            PHASE = "build-" + name
            build_go(NATIVE, package, stage / name, n_env)
        PHASE = "build-release-test"
        invoke(["go", "test", "-c", "-o", str(stage / "release-test"), "./task245-native-supervisor"], cwd=NATIVE, env=n_env)
        (stage / "release-test").chmod(0o755)
        for source, output in (("task245-domain-init/main.rs", "native-init"), ("task240-launch-stub/main.rs", "native-stub")):
            PHASE = "compile-" + output
            invoke(["rustc", "--edition=2021", "--target=x86_64-unknown-linux-gnu", "-C", "opt-level=2", "-C", "panic=abort", "-C", "target-feature=+crt-static", "-o", str(stage/output), str(NATIVE/source)])
            (stage/output).chmod(0o755)
        for source, output in (("task245-control-profile/control-profile.c","control-profile"),("task245-control-profile/probe.c","probe"),("task245-control-profile/metadata.c","native-metadata"),("task245-control-profile/metadata_test.c","metadata-regression"),("task245-acceptance/gateway.c","gateway"),("task245-acceptance/release_fixture.c","release-fixture")):
            PHASE = "compile-" + output
            invoke(["cc","-std=c11","-O2","-static","-Werror=implicit-function-declaration","-o",str(stage/output),str(NATIVE/source),*([str(NATIVE/'task245-control-profile/metadata_client.c')] if output=='control-profile' else [])])
            (stage/output).chmod(0o555 if output == "native-metadata" else 0o755)
        shutil.copyfile(NATIVE / "task245-acceptance/profile.py", stage / "profile.py")
        shutil.copyfile(NATIVE / "task245-acceptance/service.py", stage / "service.py")
        shutil.copyfile(NATIVE / "task245-acceptance/service_test.py", stage / "service_test.py")
        delivery = PRODUCT / "scripts/lab/delivery_pty.py"
        require(delivery.is_file(), "pinned delivery_pty.py missing")
        shutil.copyfile(delivery, stage / "delivery_pty.py")
        # Install named executable layout required by the authored profile.
        (stage / "bin").mkdir()
        for source, target in (("harness","harness"),("native-lab-broker","native-lab-broker"),("native-metadata","native-metadata"),("ssjack","ssjack")):
            shutil.copyfile(stage/source, stage/"bin"/target); (stage/"bin"/target).chmod(0o555 if target == "native-metadata" else 0o755)
        shutil.copyfile(stage/"control-profile", stage/"harness"); (stage/"harness").chmod(0o755)
        # The metadata child is a regression fixture, separate from the real bin/harness.
        shutil.copyfile(stage/"metadata-regression", stage/"bin/metadata-child"); (stage/"bin/metadata-child").chmod(0o755)
        # Preserve ordinary product ssjack as /lab/ssjack; driver is input only.
        (stage/"bin/ssjack").chmod(0o755)
        if lab_case == "confinement":
            shutil.copyfile(stage / "probe", stage / "bin/harness")
            (stage / "bin/harness").chmod(0o755)
        hashes={name:digest(stage/name) for name in ('ssjack','conductor','driver','harness','consumer','native-provider','native-lab-broker','release-test','release-fixture','native-stub','native-init','native-metadata','metadata-regression','gateway','control-profile','probe')}
        PHASE = "container-create"
        image = "python:3.13-slim"
        invoke(["docker","pull",image])
        envs = ("PATH=/usr/local/bin:/usr/bin:/bin","LANG=C.UTF-8","LC_ALL=C.UTF-8","GITHUB_ACTIONS=true","GITHUB_SHA="+os.environ["GITHUB_SHA"],"GITHUB_RUN_ID="+os.environ["GITHUB_RUN_ID"])
        args=["docker","create","--name",container,"--network=none","--cap-drop=ALL"]
        for cap in sorted(CAPS): args += ["--cap-add="+cap]
        args += ["--security-opt=no-new-privileges","--security-opt=apparmor=unconfined","--pids-limit=256","--memory=4g","--memory-swap=4g","--ulimit","core=0","--tmpfs","/tmp:rw,nosuid,nodev,noexec,size=256m"]
        for item in envs: args += ["--env",item]
        args += ["--entrypoint","/usr/bin/env",image,"-i",*envs,"/usr/local/bin/python3","/lab/profile.py",*( ["--confinement"] if lab_case == "confinement" else ["--scenario",lab_case] if lab_case != "connected" else [])]
        invoke(args); created=True
        PHASE = "stage-container"
        tarpath=parent/"artifacts.tar"
        with tarfile.open(tarpath,"w") as archive:
            info=tarfile.TarInfo("lab"); info.type=tarfile.DIRTYPE; info.mode=0o755; info.uid=info.gid=0; archive.addfile(info)
            for path in sorted(stage.rglob("*")):
                if path.is_dir():
                    entry=tarfile.TarInfo("lab/"+str(path.relative_to(stage))); entry.type=tarfile.DIRTYPE; entry.mode=0o755; entry.uid=entry.gid=0; archive.addfile(entry); continue
                entry=archive.gettarinfo(str(path),"lab/"+str(path.relative_to(stage)))
                if not entry.isfile(): raise RuntimeError("nonregular staged input")
                entry.uid=entry.gid=0; entry.mode=0o755
                with path.open("rb") as stream: archive.addfile(entry,stream)
        with tarpath.open("rb") as stream: invoke(["docker","cp","-",container+":/"],stdin=stream)
        PHASE="inspect-policy"
        info=json.loads(invoke(["docker","inspect",container]).stdout)[0]; host=info["HostConfig"]
        checks=(not host["Privileged"] and not host["Binds"] and host["NetworkMode"]=="none" and not host["PidMode"] and host["CapDrop"]==["ALL"] and set(host["CapAdd"] or [])=={"CAP_"+x for x in CAPS} and set(host["SecurityOpt"] or []) == {"no-new-privileges", "apparmor=unconfined"} and host["Memory"]==4*1024**3 and host["MemorySwap"]==host["Memory"])
        require(checks,"container security policy mismatch")
        PHASE="application"
        result=invoke(["docker","start","-a","-i",container],check=False)
        state=json.loads(invoke(["docker","inspect",container]).stdout)[0]["State"]
        if result.returncode != 0 or state.get("ExitCode") != 0 or result.stderr:
            print(f"task245-container: command_exit={result.returncode} container_exit={state.get('ExitCode')}", file=sys.stderr)
            for line in result.stderr.splitlines():
                if re.fullmatch(r'task245-profile: [A-Za-z0-9 ._:/=\-]{1,200}', line):
                    print(line, file=sys.stderr)
        require(result.returncode==0 and state.get("ExitCode")==0 and not result.stderr,"isolated acceptance failed")
        require(len(result.stdout.encode())<=16384,"result too large")
        rows=[x for x in result.stdout.splitlines() if x]; require(len(rows)==1,"invalid result framing")
        evidence=json.loads(rows[0])
        expected_status = "control-confinement-passed" if lab_case == "confinement" else "task245-connected-lab-complete" if lab_case == "connected" else "task245-negative-complete"
        require(evidence.get("status")==expected_status and evidence.get("product_base")==BASE and evidence.get("mechanism_only") is True and evidence.get("adoption") is False,"unexpected profile evidence")
        if lab_case not in ("connected", "confinement"):
            require(evidence.get("scenario")==lab_case,"unexpected negative scenario evidence")
        print(json.dumps({"status":expected_status,"mechanism_only":True,"adoption":False,"product_base":BASE,"product_source_revision":SHA,"bridge_source_revision":os.environ["GITHUB_SHA"],"run_id":os.environ["GITHUB_RUN_ID"],"image_id":info["Image"],"binary_sha256":hashes,"profile_evidence":evidence},sort_keys=True,separators=(",",":")))
    finally:
        if created: subprocess.run(["docker","rm","-f",container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        shutil.rmtree(parent,ignore_errors=True)

if __name__ == "__main__":
    try: main()
    except Exception as error:
        code=error.returncode if isinstance(error,subprocess.CalledProcessError) else None
        print(f"task245-acceptance: failed stage={PHASE} exit={code}",file=sys.stderr)
        raise SystemExit(1)
