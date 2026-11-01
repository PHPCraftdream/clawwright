"""Root-only launch attestation for the disposable Task 245 lab."""

import hashlib
import os
import pathlib
import stat


_ROOT = pathlib.Path("/")
_LAB = pathlib.Path("/lab")
_SERVICE_DIR = pathlib.Path("/run/task245-services")
_MAX_EXECUTABLE = 64 * 1024 * 1024
_ROLES = {
    "metadata": (pathlib.Path("/lab/bin/native-metadata"),
                 pathlib.Path("/run/task245-metadata.sock")),
    "broker": (pathlib.Path("/lab/bin/native-lab-broker"),
               pathlib.Path("/run/task245-lab/broker.sock")),
}


def _fail(category):
    raise RuntimeError("service attestation: " + category)


def _root():
    if os.geteuid() != 0:
        _fail("root-required")
    if os.environ.get("GITHUB_ACTIONS") != "true":
        _fail("ci-required")
    try:
        marker = os.lstat("/lab/disposable-profile")
    except OSError:
        _fail("profile-marker")
    if not stat.S_ISREG(marker.st_mode) or marker.st_uid != 0 or stat.S_IMODE(marker.st_mode) != 0o444:
        _fail("profile-marker")
    # Do not trust writable ancestors (including /run itself).
    for path in (pathlib.Path("/"), pathlib.Path("/run"), _LAB,
                 _LAB / "bin", pathlib.Path("/run/task245-lab")):
        try:
            info = os.lstat(path)
        except OSError:
            _fail("directory")
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            _fail("directory")
        if path == _LAB / "bin":
            try:
                if not os.statvfs(path).f_flag & getattr(os, "ST_RDONLY", 1):
                    _fail("lab-not-readonly")
            except (OSError, AttributeError):
                _fail("lab-filesystem")


def _digest(fd):
    h = hashlib.sha256()
    total = 0
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            return h.hexdigest()
        total += len(chunk)
        if total > _MAX_EXECUTABLE:
            _fail("executable-size")
        h.update(chunk)


def _open_executable(path):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = -1
    try:
        fd = os.open(path, flags)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
                or info.st_mode & 0o022 or info.st_mode & 0o111 != 0o111
                or info.st_size < 1 or info.st_size > _MAX_EXECUTABLE):
            _fail("executable-file")
        digest = _digest(fd)
        return fd, info, digest
    except OSError:
        if fd >= 0:
            os.close(fd)
        _fail("executable-file")
    except BaseException:
        if fd >= 0:
            os.close(fd)
        raise


def _proc_stat(pid):
    try:
        with open("/proc/%d/stat" % pid, "rb") as stream:
            raw = stream.read(8192)
        # comm may contain spaces and ')' characters; fields after its last ')' are stable.
        fields = raw.rsplit(b")", 1)[1].split()
        return int(fields[19])
    except (OSError, ValueError, IndexError):
        _fail("process-stat")


def _socket_identity(path):
    try:
        info = os.lstat(path)
    except OSError:
        _fail("socket")
    if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0
            or stat.S_IMODE(info.st_mode) != 0o666):
        _fail("socket")
    return info.st_dev, info.st_ino


def _service_owns_listener(pid, socket_path):
    try:
        with open("/proc/net/unix", "rb") as stream:
            raw = stream.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            _fail("listener-table")
        path_bytes = os.fsencode(socket_path)
        inodes = []
        for line in raw.splitlines()[1:]:
            fields = line.split()
            if len(fields) >= 8 and fields[3] == b"00010000" and fields[4] == b"0005" and fields[7] == path_bytes:
                inodes.append(fields[6])
        if len(inodes) != 1:
            _fail("listener")
        entries = os.listdir("/proc/%d/fd" % pid)
        if len(entries) > 4096:
            _fail("process-fds")
        target = b"socket:[" + inodes[0] + b"]"
        for entry in entries:
            link = os.readlink("/proc/%d/fd/%s" % (pid, entry))
            if os.fsencode(link) == target:
                info = os.stat("/proc/%d/fd/%s" % (pid, entry))
                if stat.S_ISSOCK(info.st_mode):
                    return
        _fail("listener-owner")
    except OSError:
        _fail("listener-owner")


def _service_dir(create=False):
    try:
        if create:
            os.mkdir(_SERVICE_DIR, 0o755)
        info = os.lstat(_SERVICE_DIR)
    except FileExistsError:
        try:
            info = os.lstat(_SERVICE_DIR)
        except OSError:
            _fail("attestation-directory")
    except OSError:
        _fail("attestation-directory")
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0
            or stat.S_IMODE(info.st_mode) != 0o755):
        _fail("attestation-directory")


def attest_service(proc, executable, socket_path, role):
    """Publish fixed-role evidence only after verifying the launched service."""
    if role not in _ROLES:
        _fail("role")
    expected_exe, expected_socket = _ROLES[role]
    try:
        if pathlib.Path(executable) != expected_exe or pathlib.Path(socket_path) != expected_socket:
            _fail("role-path")
    except (TypeError, ValueError):
        _fail("role-path")
    _root()
    try:
        if proc.poll() is not None:
            _fail("process-exited")
        pid = int(proc.pid)
    except (AttributeError, TypeError, ValueError):
        _fail("process")
    start = _proc_stat(pid)
    expected_fd, expected_info, expected_hash = _open_executable(expected_exe)
    try:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        try:
            actual_fd = os.open("/proc/%d/exe" % pid, flags)
        except OSError:
            _fail("process-executable")
        try:
            actual_info = os.fstat(actual_fd)
            actual_hash = _digest(actual_fd)
        finally:
            os.close(actual_fd)
        if ((actual_info.st_dev, actual_info.st_ino) != (expected_info.st_dev, expected_info.st_ino)
                or actual_hash != expected_hash):
            _fail("process-executable")
    finally:
        os.close(expected_fd)
    sock_dev, sock_ino = _socket_identity(expected_socket)
    _service_owns_listener(pid, expected_socket)
    _service_dir(create=True)
    if proc.poll() is not None or _proc_stat(pid) != start:
        _fail("process-changed")
    if _socket_identity(expected_socket) != (sock_dev, sock_ino):
        _fail("socket-changed")
    final = _SERVICE_DIR / (role + ".auth")
    temporary = _SERVICE_DIR / (role + ".new")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    values = (pid, start, expected_info.st_dev, expected_info.st_ino, sock_dev, sock_ino)
    payload = ("OCLABAUTH1 " + " ".join(str(v) for v in values) + " " + expected_hash + "\n").encode("ascii")
    try:
        fd = os.open(temporary, flags, 0o644)
        try:
            os.fchown(fd, 0, 0)
            view = memoryview(payload)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    _fail("publish-write")
                view = view[written:]
            os.fsync(fd)
            os.fchmod(fd, 0o444)
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o444:
                _fail("attestation-file")
        finally:
            os.close(fd)
        if proc.poll() is not None or _proc_stat(pid) != start:
            _fail("process-changed")
        if _socket_identity(expected_socket) != (sock_dev, sock_ino):
            _fail("socket-changed")
        _service_owns_listener(pid, expected_socket)
        final = _SERVICE_DIR / (role + ".auth")
        try:
            os.lstat(final)
        except FileNotFoundError:
            pass
        else:
            _fail("attestation-exists")
        os.rename(temporary, final)
    except RuntimeError:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    except OSError:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        _fail("publish")


def remove_attestation(role):
    """Remove only this role's fixed attestation after its child has stopped."""
    if role not in _ROLES:
        _fail("role")
    _root()
    _service_dir()
    try:
        os.unlink(_SERVICE_DIR / (role + ".auth"))
    except FileNotFoundError:
        return
    except OSError:
        _fail("remove")
