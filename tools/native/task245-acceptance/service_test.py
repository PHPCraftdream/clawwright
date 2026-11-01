"""Disposable-root service-authentication acceptance preflight.

Called by the root profile after the isolation marker is installed and before
starting the real broker. Probes use the staged native binaries and fixed paths.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import signal
import shutil
import stat
import subprocess
import time

from service import attest_service, remove_attestation

LAB = Path('/lab')
RUNTIME = Path('/run/task245-lab')
AUTH = Path('/run/task245-services')
METADATA = Path('/lab/bin/native-metadata')
BROKER = Path('/lab/bin/native-lab-broker')
META_SOCKET = Path('/run/task245-metadata.sock')
BROKER_SOCKET = RUNTIME / 'broker.sock'
CONTROL_PROFILE = LAB / 'control-profile'
HARNESS = LAB / 'harness'
METADATA_REGRESSION = LAB / 'metadata-regression'
SYNTHETIC_ROOT = Path('/var/lib/ssjack')
SYNTHETIC = SYNTHETIC_ROOT / 'synthetic'
UID = GID = 65534
MAX_WRAPPER_SIZE = 64 * 1024 * 1024


def _need(condition: bool, reason: str) -> None:
    if not condition:
        raise RuntimeError('service acceptance: ' + reason)


def _drop() -> None:
    os.setgroups([])
    os.setgid(GID)
    os.setuid(UID)


def _probe(role: str, expect: bool, broker_hash: str) -> None:
    if role == 'metadata':
        argv = ['/lab/harness', '--service-peer']
        env = {'GITHUB_ACTIONS': 'true'}
        preexec = None
    else:
        argv = ['/lab/release-test', '-test.run=^TestLabServicePeerKernel$']
        env = {'TASK245_SERVICE_PEER': '1', 'TASK245_BROKER_HASH': broker_hash}
        preexec = _drop
    try:
        result = subprocess.run(argv, cwd=LAB, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=5, preexec_fn=preexec)
    except subprocess.TimeoutExpired:
        raise RuntimeError('service acceptance: probe timeout') from None
    _need(result.returncode == (0 if expect else 1), 'probe status mismatch')


def _wait_socket(proc: subprocess.Popen[bytes], path: Path) -> None:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        _need(proc.poll() is None, 'daemon exited')
        try:
            if stat.S_ISSOCK(path.lstat().st_mode):
                return
        except FileNotFoundError:
            pass
        time.sleep(0.025)
    raise RuntimeError('service acceptance: readiness timeout')


def _serve(role: str, case: str, broker_hash: str) -> None:
    executable, endpoint = ((METADATA, META_SOCKET) if role == 'metadata'
                            else (BROKER, BROKER_SOCKET))
    proc = subprocess.Popen([str(executable), '--disposable-lab'], env={},
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    try:
        _wait_socket(proc, endpoint)
        if case == 'wrong_service':
            other_executable = BROKER if role == 'metadata' else METADATA
            other_role = 'broker' if role == 'metadata' else 'metadata'
            try:
                attest_service(proc, other_executable,
                               BROKER_SOCKET if other_role == 'broker' else META_SOCKET,
                               other_role)
            except RuntimeError:
                pass
            else:
                raise RuntimeError('service acceptance: wrong executable accepted')
            other_record = AUTH / (other_role + '.auth')
            _need(not other_record.exists(), 'wrong-role attestation published')
            return
        attest_service(proc, executable, endpoint, role)
        record = AUTH / (role + '.auth')
        original = record.read_bytes()
        _need(len(original.split()) == 8 and original.endswith(b'\n'), 'bad record fixture')
        if case != 'good':
            if case == 'unprivileged_socket':
                os.chown(endpoint, UID, GID)
            else:
                fields = original.split()
                if case == 'bad_pid':
                    fields[1] = b'99999999'
                elif case == 'bad_start':
                    fields[2] = b'1'
                elif case == 'bad_exe_inode':
                    fields[4] = str(int(fields[4]) + 1).encode()
                elif case == 'bad_socket_inode':
                    fields[6] = str(int(fields[6]) + 1).encode()
                elif case == 'malformed_hash':
                    fields[7] = b'x' * 64
                payload = (b'OCLABAUTH1 broken\n' if case == 'malformed_record'
                           else b' '.join(fields) + b'\n')
                temporary = record.with_suffix('.test')
                temporary.write_bytes(payload)
                os.chown(temporary, 0, 0)
                os.chmod(temporary, 0o444)
                os.replace(temporary, record)
                if case == 'unprivileged_record':
                    os.chown(record, UID, GID)
        _probe(role, case == 'good', broker_hash)
        if role == 'metadata' and case == 'good':
            _need(proc.wait(timeout=2) == 1, 'forged listener handoff accepted')
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)
        remove_attestation(role)
        if case == 'wrong_service':
            other_role = 'broker' if role == 'metadata' else 'metadata'
            remove_attestation(other_role)
        try:
            endpoint.unlink()
        except FileNotFoundError:
            pass
        if RUNTIME.is_dir():
            try:
                RUNTIME.rmdir()
            except OSError:
                pass


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    size = 0
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            _need(size <= MAX_WRAPPER_SIZE, 'wrapper file too large')
            digest.update(chunk)
    return digest.hexdigest()


def check_services() -> None:
    """Exercise both production publishers and their actual authenticated peers."""
    _need(os.geteuid() == 0 and os.environ.get('GITHUB_ACTIONS') == 'true',
          'fresh root CI required')
    _need((LAB / 'disposable-profile').is_file(), 'profile marker missing')
    _need(not AUTH.exists(), 'attestation directory must be fresh')
    _need(not META_SOCKET.exists(), 'metadata socket must be fresh')
    _need(not RUNTIME.exists(), 'broker directory must be fresh')
    created_paths: list[Path] = []
    try:
        root_parent = Path('/var')
        lib_parent = Path('/var/lib')
        for parent in (root_parent, lib_parent):
            info = parent.lstat()
            _need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                  and stat.S_IMODE(info.st_mode) & 0o022 == 0,
                  'synthetic metadata parent must be root-owned and not group/other writable')
        if not SYNTHETIC_ROOT.exists():
            SYNTHETIC_ROOT.mkdir(mode=0o755)
            created_paths.append(SYNTHETIC_ROOT)
            os.chown(SYNTHETIC_ROOT, 0, 0)
            os.chmod(SYNTHETIC_ROOT, 0o755)
        root_info = SYNTHETIC_ROOT.lstat()
        _need(stat.S_ISDIR(root_info.st_mode) and root_info.st_uid == 0
              and stat.S_IMODE(root_info.st_mode) & 0o022 == 0,
              'synthetic metadata root must be root-owned and not group/other writable')
        if not SYNTHETIC.exists():
            SYNTHETIC.mkdir(mode=0o700)
            created_paths.append(SYNTHETIC)
            os.chown(SYNTHETIC, UID, GID)
            os.chmod(SYNTHETIC, 0o700)
        synthetic_stat = SYNTHETIC.lstat()
        _need(stat.S_ISDIR(synthetic_stat.st_mode)
              and (synthetic_stat.st_uid, synthetic_stat.st_gid) == (UID, GID)
              and stat.S_IMODE(synthetic_stat.st_mode) == 0o700,
              'synthetic metadata directory has unsafe owner or mode')
    except BaseException:
        for path in reversed(created_paths):
            try:
                path.rmdir()
            except OSError:
                pass
        raise
    control_hash = None
    original_harness_hash = None
    created_scenario = not (LAB / 'scenario').exists()
    try:
        digest = hashlib.sha256()
        size = 0
        with BROKER.open('rb') as stream:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                _need(size <= 64 * 1024 * 1024, 'broker binary too large')
                digest.update(chunk)
        broker_hash = digest.hexdigest()
        control_hash = _hash_file(CONTROL_PROFILE)
        original_harness_hash = _hash_file(HARNESS)
        _need(original_harness_hash == control_hash, 'control harness hash mismatch')
        _hash_file(METADATA_REGRESSION)
        shutil.copyfile(METADATA_REGRESSION, HARNESS)
        os.chmod(HARNESS, 0o755)
        if created_scenario:
            (LAB / 'scenario').write_text('cancel')
            os.chown(LAB / 'scenario', 0, 0)
            os.chmod(LAB / 'scenario', 0o444)
        cases = ('good', 'bad_pid', 'bad_start', 'bad_exe_inode', 'bad_socket_inode',
                 'malformed_hash', 'malformed_record', 'unprivileged_record',
                 'unprivileged_socket', 'wrong_service')
        for role in ('metadata', 'broker'):
            for case in cases:
                if role == 'metadata':
                    RUNTIME.mkdir(mode=0o755)
                    os.chown(RUNTIME, 0, 0)
                    os.chmod(RUNTIME, 0o755)
                _serve(role, case, broker_hash)
    finally:
        if created_scenario and (LAB / 'scenario').exists():
            (LAB / 'scenario').unlink()
        if RUNTIME.is_dir():
            try:
                RUNTIME.rmdir()
            except OSError:
                pass
        if AUTH.is_dir():
            try:
                AUTH.rmdir()
            except OSError:
                pass
        if control_hash is not None and original_harness_hash is not None:
            shutil.copyfile(CONTROL_PROFILE, HARNESS)
            os.chmod(HARNESS, 0o755)
            _need(_hash_file(HARNESS) == control_hash == original_harness_hash,
                  'control harness restore hash mismatch')
        for path in reversed(created_paths):
            try:
                path.rmdir()
            except OSError:
                pass
