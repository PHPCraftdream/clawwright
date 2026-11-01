#!/usr/bin/env python3
"""Root-only acceptance profile. Run only in a freshly created disposable CI container."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import shutil
import re
import signal
import subprocess
import sys
import time
from service import attest_service, remove_attestation; from service_test import check_services

LAB = Path('/lab')
ROOT = Path('/lab/native-root')
CONFIG = Path('/etc/clawwright')
UID = GID = 65534
MS_BIND, MS_REMOUNT, MS_RDONLY = 4096, 32, 1

def need(ok, why):
    if not ok:
        raise RuntimeError(why)

def digest(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()

def bind_ro(p):
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p]

    def mount(flags):
        if libc.mount(os.fsencode(p), os.fsencode(p), None, flags, None):
            raise OSError(ctypes.get_errno(), 'mount failed', str(p))

    mount(MS_BIND)
    mount(MS_BIND | MS_REMOUNT | MS_RDONLY)

def confinement_mode():
    need(sys.platform == 'linux' and os.geteuid() == 0, 'Linux root required')
    need(os.environ.get('GITHUB_ACTIONS') == 'true', 'GITHUB_ACTIONS=true required')
    need(not Path('/lab/disposable-profile').exists(), 'profile must be fresh')
    probe = LAB / 'bin/harness'
    need(probe.is_file(), 'missing staged control probe: /lab/bin/harness')
    bind_ro(LAB / 'bin')
    env = {
        'PATH': '/lab/bin',
        'SSJACK_ENV_TOKEN': 'fixture-bootstrap-token',
        'SSJACK_SESSION': 'fixture-session',
        'SSJACK_ENDPOINT': 'https://127.0.0.1:1',
        'SSJACK_CERTIFICATE_SHA256': '0' * 64,
    }

    def drop_privileges():
        os.setgroups([])
        os.setgid(GID)
        os.setuid(UID)

    result = subprocess.run(
        ['/lab/harness', 'fixture-ref', 'golden'], env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, timeout=60,
        preexec_fn=drop_privileges,
    )
    need(result.returncode == 0, 'control confinement probe returned nonzero')
    need(result.stdout == 'CONTROL_CONFINEMENT_OK\n', 'control confinement probe output mismatch')
    need(result.stderr == '', 'control confinement probe wrote stderr')
    print(json.dumps({
        'status': 'control-confinement-passed',
        'mechanism_only': True,
        'adoption': False,
        'product_base': '2997e692cdc24f5b9a5aa23cadc3b22ab1b32f02',
    }, sort_keys=True, separators=(',', ':')))

def main():
    args = sys.argv[1:]
    scenarios = {'wrong-holder', 'unexpected-exec', 'partial-ack', 'lost-ack', 'cancel'}
    need(args in ([], ['--confinement']) or (len(args) == 2 and args[0] == '--scenario' and args[1] in scenarios), 'invalid arguments')
    if args == ['--confinement']:
        confinement_mode()
        return
    scenario = args[1] if args else ''
    need(sys.platform == 'linux' and os.geteuid() == 0, 'Linux root required')
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_SHA') and os.environ.get('GITHUB_RUN_ID'), 'GitHub CI identity required')
    need(not Path('/lab/disposable-profile').exists(), 'profile must be fresh')
    need(not ROOT.exists(), 'native root must be fresh')
    if not scenario:
        regression = subprocess.run(['/lab/metadata-regression'], env={'GITHUB_ACTIONS': 'true'}, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15)
        need(regression.returncode == 0, 'metadata cancel-ack regression returned nonzero')
        need(regression.stdout == 'metadata cancel-ack regression: PASS\n', 'metadata cancel-ack regression output mismatch')
        need(regression.stderr == '', 'metadata cancel-ack regression wrote stderr')
    if not scenario:
        connected = subprocess.run(['/lab/release-test', '-test.run=^TestConnectedReleaseKernel$', '-test.v'], env={'TASK245_KERNEL': '1', 'TASK245_RELEASE_FIXTURE': '/lab/release-fixture', 'TASK240_STUB': '/lab/native-stub'}, cwd=LAB, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
        if connected.returncode != 0:
            for code in re.findall(r'diagnostic=([a-z_]{1,80})', connected.stdout):
                print('task245-profile: kernel=' + code, file=sys.stderr)
        need(connected.returncode == 0, 'connected release kernel test failed')
    status = Path('/proc/self/status').read_text()
    caps = next((x.split()[1] for x in status.splitlines() if x.startswith('CapEff:')), '')
    bits = int(caps, 16)
    need(bits & (1 << 21) and bits & (1 << 19), 'CAP_SYS_ADMIN and CAP_SYS_PTRACE required')
    need(not Path('/run/task245-lab').exists(), 'broker runtime directory must be absent')
    for name in ('ssjack', 'conductor', 'driver', 'consumer', 'harness', 'native-provider', 'native-init', 'native-stub', 'gateway', 'delivery_pty.py'):
        need((LAB / name).exists(), 'missing staged input: ' + name)
    for name in ('harness', 'native-lab-broker', 'ssjack'):
        need((LAB / 'bin' / name).is_file(), 'missing staged tool: ' + name)
    selected = os.environ.get('OPENCLAW_IMAGE') or 'ghcr.io/openclaw/openclaw:extended-stable'
    (LAB / 'disposable-profile').write_text('task245 synthetic lab\n')
    os.chmod(LAB / 'disposable-profile', 0o444)
    (LAB / 'bin/native-metadata').chmod(0o555)
    bind_ro(LAB / 'bin')
    if not scenario:
        control_digest = digest(LAB / 'control-profile')
        keeper_digest = digest(LAB / 'ssjack')
        product_keeper = LAB / 'ssjack-product'
        need(not product_keeper.exists(), 'ssjack-product fixture already exists')
        shutil.copyfile(LAB / 'ssjack', product_keeper)
        os.chmod(product_keeper, 0o755)
        scenario_file = LAB / 'scenario'
        denied_state = Path('/var/lib/ssjack/synthetic/state.json')
        need(not denied_state.parent.exists(), 'notifier denied-state fixture must be fresh')
        denied_state.parent.mkdir(parents=True, mode=0o700)
        os.chown(denied_state.parent, UID, GID)
        denied_state.write_text('{}'); os.chown(denied_state, UID, GID); os.chmod(denied_state, 0o600)
        try:
            shutil.copyfile(LAB / 'metadata-regression', LAB / 'harness')
            shutil.copyfile(LAB / 'metadata-regression', LAB / 'ssjack')
            os.chmod(LAB / 'harness', 0o755)
            os.chmod(LAB / 'ssjack', 0o755)
            inactive = subprocess.run(['/lab/harness', '--notifier-inactive'], env={'GITHUB_ACTIONS': 'true'}, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20)
            for line in inactive.stderr.splitlines():
                if re.fullmatch(r'metadata-test: [a-z0-9_= -]{1,80}', line):
                    print('task245-profile: ' + line, file=sys.stderr)
            need(inactive.returncode == 0, 'metadata notifier inactive regression returned nonzero')
            need(inactive.stdout == 'metadata notifier inactive: PASS' + chr(10), 'metadata notifier inactive regression output mismatch')
            need(inactive.stderr == '', 'metadata notifier inactive regression wrote stderr')
            need(not scenario_file.exists(), 'notifier scenario must be fresh')
            scenario_file.write_text('cancel')
            os.chown(scenario_file, 0, 0)
            os.chmod(scenario_file, 0o444)
            regression = subprocess.run(['/lab/ssjack', '--notifier'], env={'GITHUB_ACTIONS': 'true'}, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=40)
            for line in regression.stderr.splitlines():
                if re.fullmatch(r'metadata-test: [a-z0-9_= -]{1,80}', line):
                    print('task245-profile: ' + line, file=sys.stderr)
            need(regression.returncode == 0, 'metadata notifier regression returned nonzero')
            need(regression.stdout == 'metadata notifier regression: PASS' + chr(10), 'metadata notifier regression output mismatch')
            need(regression.stderr == '', 'metadata notifier regression wrote stderr')
        finally:
            try:
                shutil.copyfile(product_keeper, LAB / 'ssjack')
                shutil.copyfile(LAB / 'control-profile', LAB / 'harness')
                os.chmod(LAB / 'ssjack', 0o755)
                os.chmod(LAB / 'harness', 0o755)
                need(digest(LAB / 'ssjack') == keeper_digest, 'keeper restoration digest mismatch')
                need(digest(LAB / 'harness') == control_digest, 'control harness restoration digest mismatch')
            finally:
                if scenario_file.exists():
                    scenario_file.unlink()
                if product_keeper.exists():
                    product_keeper.unlink()
                denied_state.unlink()
                denied_state.parent.rmdir()
    bind_ro(LAB / 'ssjack')
    ROOT.mkdir()
    for d in ('usr/bin', 'usr/libexec', 'etc/clawwright', 'proc', 'run'):
        (ROOT / d).mkdir(parents=True, exist_ok=True)
    sources = {'usr/bin/node': 'gateway', 'usr/libexec/clawwright-native-provider': 'native-provider', 'usr/libexec/native-domain-init': 'native-init', 'usr/libexec/native-launch-stub': 'native-stub'}
    hashes = {}
    for dest, src in sources.items():
        p = ROOT / dest
        shutil.copyfile(LAB / src, p)
        os.chown(p, 0, 0)
        os.chmod(p, 0o555)
        hashes[dest] = digest(p)
    rootjson_dir = ROOT / 'etc/clawwright'

    def rootjson(path, obj):
        path.write_text(json.dumps(obj, sort_keys=True, separators=(',', ':')) + '\n')
        os.chown(path, 0, 0)
        os.chmod(path, 0o644)

    provider_config = {'supervisorSHA256': digest(LAB / 'consumer')}
    rootjson(rootjson_dir / 'native-provider.json', provider_config)
    rootjson(rootjson_dir / 'openclaw.json', {'fixture': True, 'metadata': {'image': selected}})
    entries = []
    for p in sorted(ROOT.rglob('*'), key=lambda p: p.relative_to(ROOT).as_posix()):
        rel = p.relative_to(ROOT).as_posix()
        st = p.lstat()
        item = {'path': rel, 'type': 'dir' if p.is_dir() else 'file', 'mode': st.st_mode & 0o777}
        if p.is_file():
            item['sha256'] = digest(p)
        entries.append(item)
    manifest = Path('/lab/native-manifest.json')
    manifest.write_text(json.dumps({'version': 1, 'entries': entries}, sort_keys=True, separators=(',', ':')) + '\n')
    os.chown(manifest, 0, 0)
    os.chmod(manifest, 0o444)
    supervisor = LAB / 'consumer'
    keeper = LAB / 'ssjack'
    broker = LAB / 'bin/native-lab-broker'
    if scenario:
        scenario_file = LAB / 'scenario'
        scenario_file.write_text(scenario)
        os.chown(scenario_file, 0, 0)
        os.chmod(scenario_file, 0o444)
    config = {'RuntimeUID': UID, 'RuntimeGID': GID, 'Supervisor': str(supervisor), 'SupervisorSHA256': digest(supervisor), 'Keeper': str(keeper), 'KeeperSHA256': digest(keeper), 'Init': str(ROOT / 'usr/libexec/native-domain-init'), 'InitSHA256': hashes['usr/libexec/native-domain-init'], 'Root': str(ROOT), 'Manifest': str(manifest), 'ManifestSHA256': digest(manifest), 'Node': str(ROOT / 'usr/bin/node'), 'Stub': str(ROOT / 'usr/libexec/native-launch-stub'), 'Provider': str(ROOT / 'usr/libexec/clawwright-native-provider'), 'ConfigPath': str(ROOT / 'etc/clawwright/openclaw.json'), 'NodeSHA256': hashes['usr/bin/node'], 'StubSHA256': hashes['usr/libexec/native-launch-stub'], 'ProviderSHA256': hashes['usr/libexec/clawwright-native-provider'], 'GatewayArgv': ['/usr/bin/node', 'gateway'], 'BrokerArgv': ['/usr/bin/node', 'broker'], 'Target': 'target', 'Revision': 'synthetic-delivery-v1', 'Purpose': 'synthetic-confidential-delivery', 'CaptureEvidence': '/run/native-capture-ok', 'SelectedImage': selected}
    if scenario:
        config['LabScenario'] = scenario
        broker_config = {'BrokerSHA256': digest(broker), 'LabReceiptPath': '/var/lib/ssjack/synthetic/consumer-receipt', 'Target': 'target', 'Revision': config['Revision'], 'Purpose': config['Purpose'], 'LabScenario': scenario}
        config['GatewayArgv'] += [scenario] if scenario in ('wrong-holder', 'unexpected-exec') else []
        config['BrokerArgv'] += [scenario] if scenario in ('wrong-holder', 'unexpected-exec') else []
    else:
        broker_config = {'BrokerSHA256': digest(broker), 'LabReceiptPath': '/var/lib/ssjack/synthetic/consumer-receipt', 'Target': 'target', 'Revision': config['Revision'], 'Purpose': config['Purpose']}
    CONFIG.mkdir(parents=True, exist_ok=True)
    rootjson(CONFIG / 'native-lab.json', config)
    rootjson(CONFIG / 'native-supervisor.json', {'keeperSHA256': digest(keeper)})
    rootjson(CONFIG / 'native-launch.json', {'BrokerSHA256': digest(broker), 'LabReceiptPath': '/var/lib/ssjack/synthetic/consumer-receipt', 'Target': 'target', 'Revision': config['Revision'], 'Purpose': config['Purpose'], **({'LabScenario': scenario} if scenario else {})})
    bind_ro(ROOT)
    (LAB / 'isolation-ok').write_text('task245\n')
    os.chown(LAB / 'isolation-ok', 0, 0)
    os.chmod(LAB / 'isolation-ok', 0o444)
    check_services()
    proc = subprocess.Popen([str(broker), '--disposable-lab'], env={}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    metadata_proc = None
    try:
        need(proc.poll() is None, 'lab broker failed to start')
        broker_socket = Path('/run/task245-lab/broker.sock')
        deadline = time.monotonic() + 2
        while not broker_socket.exists() and time.monotonic() < deadline:
            need(proc.poll() is None, 'lab broker exited before readiness')
            time.sleep(0.05)
        need(proc.poll() is None and broker_socket.exists(), 'lab broker readiness timed out')
        attest_service(proc, broker, broker_socket, 'broker')
        if scenario:
            metadata_proc = subprocess.Popen(['/lab/bin/native-metadata', '--disposable-lab'], env={}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            metadata_socket = Path('/run/task245-metadata.sock')
            deadline = time.monotonic() + 2
            while not metadata_socket.exists() and time.monotonic() < deadline:
                need(metadata_proc.poll() is None, 'native metadata exited before readiness')
                time.sleep(0.05)
            need(metadata_proc.poll() is None and metadata_socket.exists(), 'native metadata readiness timed out')
            attest_service(metadata_proc, Path('/lab/bin/native-metadata'), metadata_socket, 'metadata')
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'GITHUB_SHA': os.environ['GITHUB_SHA'], 'GITHUB_RUN_ID': os.environ['GITHUB_RUN_ID']}
        result = subprocess.run([str(LAB / 'conductor')], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=600)
        if result.returncode != 0 or result.stderr:
            if metadata_proc is not None and metadata_proc.poll() is not None:
                for line in metadata_proc.stderr.read(256).decode('ascii', 'ignore').splitlines():
                    if re.fullmatch(r'metadata-daemon: stage=[0-6] auth=[0-4] errno=[0-9]{1,4}', line): print('task245-profile: ' + line, file=sys.stderr)
            for line in result.stderr.splitlines():
                if re.fullmatch(r'task245-conductor: [a-z -]{1,100}', line):
                    print('task245-profile: ' + line, file=sys.stderr)
        need(result.returncode == 0 and not result.stderr, 'ordinary conductor acceptance failed')
        rows = result.stdout.splitlines()
        need(len(rows) == 1, 'conductor output not a single JSON record')
        data = json.loads(rows[0])
        if scenario:
            expected_outcome = 'WITHHELD' if scenario in ('wrong-holder', 'unexpected-exec') else 'UNKNOWN'
            need(set(data) == {'result', 'scenario', 'expected_outcome'}, 'unexpected negative evidence schema')
            need(data == {'result': 'task245-negative-complete', 'scenario': scenario, 'expected_outcome': expected_outcome}, 'unexpected negative evidence')
            print(json.dumps({'status': 'task245-negative-complete', 'product_base': '2997e692cdc24f5b9a5aa23cadc3b22ab1b32f02', 'scenario': scenario, 'mechanism_only': True, 'adoption': False, 'binary_sha256': {'consumer': digest(supervisor), 'keeper': digest(keeper), 'broker': digest(broker)}, 'conductor': data}, sort_keys=True, separators=(',', ':')))
            return
        need(set(data) == {'result', 'product_base', 'source_revision', 'run_id', 'binary_sha256'}, 'unexpected product evidence schema')
        need(data.get('result') == 'synthetic-delivery-complete' and data.get('product_base') == '2997e692cdc24f5b9a5aa23cadc3b22ab1b32f02', 'unexpected product evidence')
        need(data.get('source_revision') == os.environ['GITHUB_SHA'] and data.get('run_id') == os.environ['GITHUB_RUN_ID'], 'CI evidence identity mismatch')
        hashes_out = data.get('binary_sha256')
        names = {'ssjack', 'harness', 'driver', 'consumer', 'conductor'}
        need(isinstance(hashes_out, dict) and set(hashes_out) == names, 'unexpected binary hash evidence')
        expected = {'ssjack': LAB / 'ssjack', 'harness': LAB / 'harness', 'driver': LAB / 'driver', 'consumer': LAB / 'consumer', 'conductor': LAB / 'conductor'}
        need(all(hashes_out[k] == digest(v) for k, v in expected.items()), 'staged binary hash mismatch')
        print(json.dumps({'status': 'task245-connected-lab-complete', 'mechanism_only': True, 'adoption': False, 'product_base': '2997e692cdc24f5b9a5aa23cadc3b22ab1b32f02', 'binary_sha256': {'consumer': digest(supervisor), 'keeper': digest(keeper), 'broker': digest(broker)}, 'conductor': data}, sort_keys=True, separators=(',', ':')))
    finally:
        for child in (metadata_proc, proc):
            if child is not None and child.poll() is None:
                child.send_signal(signal.SIGTERM)
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=2)
        if Path('/run/task245-services').is_dir():
            for role in ('metadata', 'broker'):
                remove_attestation(role)

if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        print('task245-profile: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        frame = error.__traceback__
        while frame.tb_next is not None:
            frame = frame.tb_next
        print(f'task245-profile: exception={type(error).__name__} line={frame.tb_lineno} errno={getattr(error, "errno", None)}', file=sys.stderr)
        raise SystemExit(1)
