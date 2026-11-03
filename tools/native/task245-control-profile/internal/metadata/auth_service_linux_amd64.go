//go:build linux && amd64

package metadata

import (
	"errors"
	"os"
	"syscall"
	"time"
	"unsafe"
)

type service struct {
	deadline    time.Time
	listener    int
	root        int
	peer        processIdentity
	installer   inode
	harnesses   []inode
	slot        int
	active      bool
	owner       processIdentity
	ownerParent int
	ownerSet    bool
	haveReceipt bool
	lastReceipt [48]byte
	ackWrite    func(int, []byte) (int, error)
	ackSync     func(int) error
	ackClose    func(int) error
	beforeReceive func() error
	canceledReceives int
}

func (s *service) writeACK(fd int, data []byte) (int, error) {
	if s.ackWrite != nil {
		return s.ackWrite(fd, data)
	}
	return syscall.Write(fd, data)
}

func (s *service) syncACK(fd int) error {
	if s.ackSync != nil {
		return s.ackSync(fd)
	}
	return syscall.Fsync(fd)
}

func (s *service) closeACK(fd int) error {
	if s.ackClose != nil {
		return s.ackClose(fd)
	}
	return syscall.Close(fd)
}

func (s *service) authorized(tid int) bool {
	tgid, err := processTGID(tid)
	if err != nil || tgid != s.peer.PID {
		return false
	}
	start, err := startTime(tgid)
	if err != nil || start != s.peer.Start {
		return false
	}
	actual, err := statPath("/proc/" + itoa(tid) + "/exe")
	if err != nil || actual.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return false
	}
	candidate := inode{Device: uint64(actual.Dev), Number: actual.Ino}
	for _, path := range []string{"/lab/harness", "/lab/bin/harness"} {
		expected, artifactErr := artifact(path)
		if artifactErr == nil && candidate == expected {
			return true
		}
	}
	return false
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var buffer [24]byte
	index := len(buffer)
	for value > 0 {
		index--
		buffer[index] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		index--
		buffer[index] = '-'
	}
	return string(buffer[index:])
}

func (s *service) send(result response) {
	if !validID(s.listener, result.ID) {
		return
	}
	_, _ = ioctl(s.listener, ioctlSend, unsafe.Pointer(&result))
}

func runNotifierLifecycleErrors() error {
	// Keep the pipe's write end open until loop has observed POLLNVAL; no
	// descriptor-opening operation may reuse closedFD in between.
	var closedPipe [2]int
	if err := syscall.Pipe(closedPipe[:]); err != nil {
		return err
	}
	closedFD, writeFD := closedPipe[0], closedPipe[1]
	if err := syscall.Close(closedFD); err != nil {
		_ = syscall.Close(writeFD)
		return err
	}
	loopErr := (&service{listener: closedFD}).loop()
	_ = syscall.Close(writeFD)
	if !errors.Is(loopErr, syscall.EBADF) {
		return syscall.EIO
	}

	// An idle, open pipe exercises the service loop's owning deadline.
	var idlePipe [2]int
	if err := syscall.Pipe(idlePipe[:]); err != nil {
		return err
	}
	idleErr := (&service{listener: idlePipe[0], deadline: time.Now().Add(20 * time.Millisecond)}).loop()
	_ = syscall.Close(idlePipe[0])
	_ = syscall.Close(idlePipe[1])
	if !errors.Is(idleErr, errDaemonTimeout) {
		return syscall.EIO
	}

	// An already-expired deadline must win over POLLHUP.
	var expiredPipe [2]int
	if err := syscall.Pipe(expiredPipe[:]); err != nil {
		return err
	}
	if err := syscall.Close(expiredPipe[1]); err != nil {
		_ = syscall.Close(expiredPipe[0])
		return err
	}
	expiredErr := (&service{listener: expiredPipe[0], deadline: time.Now().Add(-time.Millisecond)}).loop()
	_ = syscall.Close(expiredPipe[0])
	if !errors.Is(expiredErr, errDaemonTimeout) {
		return syscall.EIO
	}

	// Socket wait expiry is distinct from an invalid descriptor's EBADF.
	var socketWaitPipe [2]int
	if err := syscall.Pipe(socketWaitPipe[:]); err != nil {
		return err
	}
	socketWaitErr := waitSocketUntil(socketWaitPipe[0], time.Now().Add(20*time.Millisecond))
	_ = syscall.Close(socketWaitPipe[0])
	_ = syscall.Close(socketWaitPipe[1])
	if !errors.Is(socketWaitErr, errDaemonTimeout) {
		return syscall.EIO
	}
	if err := waitSocketUntil(closedFD, time.Now().Add(time.Second)); !errors.Is(err, syscall.EBADF) || errors.Is(err, errDaemonTimeout) {
		return syscall.EIO
	}

	// A ready pipe reaches the real NOTIF_RECV ioctl, which must expose ENOTTY.
	var readyPipe [2]int
	if err := syscall.Pipe(readyPipe[:]); err != nil {
		return err
	}
	defer syscall.Close(readyPipe[0])
	defer syscall.Close(readyPipe[1])
	if n, err := syscall.Write(readyPipe[1], []byte{1}); err != nil || n != 1 {
		if err != nil {
			return err
		}
		return syscall.EIO
	}
	if err := (&service{listener: readyPipe[0]}).loop(); !errors.Is(err, syscall.ENOTTY) {
		return syscall.EIO
	}

	// POLLHUP on an ordinary pipe is a normal, non-ready notifier result.
	var hupPipe [2]int
	if err := syscall.Pipe(hupPipe[:]); err != nil {
		return err
	}
	defer syscall.Close(hupPipe[0])
	if err := syscall.Close(hupPipe[1]); err != nil {
		return err
	}
	ready, err := waitNotifier(hupPipe[0])
	if err != nil || ready {
		return syscall.EIO
	}
	return nil
}

func RunACKRegression() error {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return syscall.EPERM
	}
	if err := runNotifierLifecycleErrors(); err != nil {
		return err
	}
	var lab syscall.Stat_t
	if err := syscall.Stat("/lab", &lab); err != nil {
		return err
	}
	if lab.Uid != 0 || lab.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return syscall.EACCES
	}
	root, err := os.MkdirTemp("/lab", "ack-regression-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(root)
	if err = os.Chmod(root, 0700); err != nil {
		return err
	}
	if err = os.Chown(root, 65534, 65534); err != nil {
		return err
	}
	dir, err := syscall.Open(root, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(dir)
	negatives := []struct {
		name   string
		mutate func(*service, int) error
		keepACK bool
	}{
		{name: "badreceipt", mutate: func(s *service, _ int) error {
			s.lastReceipt[0] ^= 1
			return nil
		}},
		{name: "fifoReceipt", mutate: func(_ *service, dir int) error {
			if err := syscall.Unlinkat(dir, receiptName); err != nil {
				return err
			}
			if err := syscall.Mknodat(dir, receiptName, syscall.S_IFIFO|0600, 0); err != nil {
				return err
			}
			return syscall.Fchownat(dir, receiptName, 65534, 65534, 0)
		}},
		{name: "invalidpayload", mutate: func(s *service, _ int) error {
			return syscall.Ftruncate(s.slot, 0)
		}},
		{name: "missingfault", mutate: func(_ *service, dir int) error {
			return syscall.Unlinkat(dir, faultReachedName)
		}},
		{name: "wrongfault", mutate: func(_ *service, dir int) error {
			return regressionFile(dir, faultReachedName, []byte("wrong!"))
		}},
		{name: "wrongownerparent", mutate: func(s *service, _ int) error {
			s.ownerParent++
			return nil
		}},
		{name: "preexistingACKkeep", mutate: func(_ *service, dir int) error {
			return regressionFile(dir, cancelAckName, []byte("keep"))
		}, keepACK: true},
		{name: "missingreceiptbinding", mutate: func(s *service, _ int) error {
			s.haveReceipt = false
			return nil
		}},
	}
	for _, negative := range negatives {
		s, err := freshFixture(dir)
		if err != nil {
			return err
		}
		if err = negative.mutate(s, dir); err != nil {
			syscall.Close(s.slot)
			return err
		}
		if s.releaseACK() {
			syscall.Close(s.slot)
			return syscall.EIO
		}
		if s.ownerParent != os.Getppid() {
			s.ownerParent = os.Getppid()
		}
		alive, aliveErr := s.ownerAlive()
		if aliveErr != nil || !alive {
			syscall.Close(s.slot)
			return syscall.EIO
		}
		fd, openErr := syscall.Openat(dir, cancelAckName, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		if negative.keepACK {
			if openErr != nil {
				syscall.Close(s.slot)
				return syscall.EIO
			}
			data := make([]byte, 4)
			n, readErr := syscall.Read(fd, data)
			syscall.Close(fd)
			if readErr != nil || n != 4 || string(data) != "keep" {
				syscall.Close(s.slot)
				return syscall.EIO
			}
		} else {
			if openErr == nil {
				syscall.Close(fd)
				syscall.Close(s.slot)
				return syscall.EIO
			}
			if !errors.Is(openErr, syscall.ENOENT) {
				syscall.Close(s.slot)
				return syscall.EIO
			}
		}
		syscall.Close(s.slot)
		if negative.name == "fifoReceipt" {
			if err := syscall.Unlinkat(dir, receiptName); err != nil {
				return err
			}
		}
	}
	for _, phase := range []string{"write", "sync", "close"} {
		for _, removeBeforeFailure := range []bool{false, true} {
			s, err := freshFixture(dir)
			if err != nil {
				return err
			}
			calls := 0
			removed := false
			var observed error
			fail := func(fd int) error {
				if removeBeforeFailure {
					var st syscall.Stat_t
					if err := syscall.Fstat(fd, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Uid != 65534 || st.Mode&07777 != 0600 || st.Nlink != 1 {
						return syscall.EIO
					}
					want := ""
					if phase != "write" {
						want = "release"
					}
					rd, err := syscall.Openat(dir, cancelAckName, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
					if err != nil {
						return err
					}
					var readStat syscall.Stat_t
					statErr := syscall.Fstat(rd, &readStat)
					data := make([]byte, 8)
					n, readErr := syscall.Pread(rd, data, 0)
					closeErr := syscall.Close(rd)
					if statErr != nil || readStat.Dev != st.Dev || readStat.Ino != st.Ino || readErr != nil || closeErr != nil || n != len(want) || string(data[:n]) != want || st.Size != int64(len(want)) {
						return syscall.EIO
					}
					if err := syscall.Unlinkat(dir, cancelAckName); err != nil {
						return err
					}
					removed = true
				}
				if err := syscall.Close(fd); err != nil {
					return err
				}
				calls++
				return nil
			}
			if phase == "write" {
				s.ackWrite = func(fd int, data []byte) (int, error) {
					if err := fail(fd); err != nil {
						return 0, err
					}
					_, observed = syscall.Write(fd, data)
					return 0, observed
				}
			} else if phase == "sync" {
				s.ackSync = func(fd int) error {
					if err := fail(fd); err != nil {
						return err
					}
					observed = syscall.Fsync(fd)
					return observed
				}
			} else {
				s.ackClose = func(fd int) error {
					if err := fail(fd); err != nil {
						return err
					}
					observed = syscall.Close(fd)
					return observed
				}
			}
			if s.releaseACK() || calls != 1 || !errors.Is(observed, syscall.EBADF) || removed != removeBeforeFailure {
				syscall.Close(s.slot)
				return syscall.EIO
			}
			alive, aliveErr := s.ownerAlive()
			if aliveErr != nil || !alive {
				syscall.Close(s.slot)
				return syscall.EIO
			}
			if _, err = syscall.Openat(dir, cancelAckName, syscall.O_RDONLY|syscall.O_CLOEXEC, 0); !errors.Is(err, syscall.ENOENT) {
				syscall.Close(s.slot)
				return syscall.EIO
			}
			syscall.Close(s.slot)
		}
	}
	s, err := freshFixture(dir)
	if err != nil {
		return err
	}
	result := make(chan error, 1)
	go func() {
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			fd, e := syscall.Openat(dir, cancelAckName, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
			if e == nil {
				var st syscall.Stat_t
				data := make([]byte, 7)
				n, re := syscall.Read(fd, data)
				fe := syscall.Fstat(fd, &st)
				syscall.Close(fd)
				if re == nil && fe == nil && n == 7 && string(data) == "release" && st.Uid == 65534 && st.Size == 7 {
					result <- syscall.Unlinkat(dir, cancelAckName)
					return
				}
			}
			time.Sleep(time.Millisecond)
		}
		result <- syscall.ETIMEDOUT
	}()
	released := s.releaseACK()
	waitErr := <-result
	syscall.Close(s.slot)
	if !released {
		return syscall.EIO
	}
	return waitErr
}

func freshFixture(dir int) (*service, error) {
	_ = syscall.Unlinkat(dir, cancelAckName)
	if err := regressionFile(dir, receiptName, bytesRepeat(0x5a, 48)); err != nil {
		return nil, err
	}
	if err := regressionFile(dir, faultReachedName, []byte("cancel")); err != nil {
		return nil, err
	}
	slot, err := memfd("release")
	if err != nil {
		return nil, err
	}
	if n, writeErr := syscall.Write(slot, []byte("release")); writeErr != nil || n != len("release") {
		syscall.Close(slot)
		if writeErr != nil {
			return nil, writeErr
		}
		return nil, syscall.EIO
	}
	start, err := startTime(os.Getpid())
	if err != nil {
		syscall.Close(slot)
		return nil, err
	}
	s := &service{root: dir, slot: slot, active: true, owner: processIdentity{PID: os.Getpid(), Start: start}, ownerParent: os.Getppid(), ownerSet: true, haveReceipt: true}
	copy(s.lastReceipt[:], bytesRepeat(0x5a, len(s.lastReceipt)))
	return s, nil
}

func bytesRepeat(value byte, n int) []byte {
	data := make([]byte, n)
	for i := range data {
		data[i] = value
	}
	return data
}

func regressionFile(dir int, name string, data []byte) error {
	fd, err := syscall.Openat(dir, name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_TRUNC|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	written, err := syscall.Write(fd, data)
	if err == nil && written != len(data) {
		err = syscall.EIO
	}
	if err == nil {
		err = syscall.Fchown(fd, 65534, 65534)
	}
	closeErr := syscall.Close(fd)
	if err != nil {
		return err
	}
	return closeErr
}
