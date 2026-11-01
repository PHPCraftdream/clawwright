//go:build linux && amd64

package metadata

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

func ioctl(fd int, request uintptr, pointer unsafe.Pointer) (uintptr, error) {
	value, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), request, uintptr(pointer))
	if errno != 0 {
		return value, errno
	}
	return value, nil
}

func validID(fd int, id uint64) bool {
	_, err := ioctl(fd, ioctlValid, unsafe.Pointer(&id))
	return err == nil
}

func readRemotePartial(pid int, address uint64, size int) ([]byte, error) {
	if size < 1 || size > 4096 {
		return nil, syscall.EINVAL
	}

	data := make([]byte, size)
	local := iovec{
		Base:   uintptr(unsafe.Pointer(&data[0])),
		Length: uintptr(size),
	}
	remote := iovec{
		Base:   uintptr(address),
		Length: uintptr(size),
	}
	read, _, errno := syscall.Syscall6(
		processVMReadv,
		uintptr(pid),
		uintptr(unsafe.Pointer(&local)),
		1,
		uintptr(unsafe.Pointer(&remote)),
		1,
		0,
	)
	runtime.KeepAlive(data)
	runtime.KeepAlive(local)
	if errno != 0 {
		return nil, errno
	}
	if read == 0 {
		return nil, syscall.EFAULT
	}
	return data[:int(read)], nil
}

func readRemote(pid int, address uint64, size int) ([]byte, error) {
	data, err := readRemotePartial(pid, address, size)
	if err != nil {
		return nil, err
	}
	if len(data) != size {
		return nil, syscall.EFAULT
	}
	return data, nil
}

func copyPath(pid int, address uint64) (string, error) {
	data, err := readRemotePartial(pid, address, 512)
	if err != nil {
		return "", err
	}
	for index, value := range data {
		if value == 0 {
			if index == 0 {
				return "", syscall.EFAULT
			}
			return string(data[:index]), nil
		}
	}
	return "", syscall.ENAMETOOLONG
}

func openMetadataRoot() (int, error) {
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return -1, err
	}

	for _, part := range []string{"var", "lib", "ssjack"} {
		next, openErr := syscall.Openat(fd, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		_ = syscall.Close(fd)
		if openErr != nil {
			return -1, openErr
		}

		var st syscall.Stat_t
		if err = syscall.Fstat(next, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Uid != 0 || st.Mode&0022 != 0 {
			_ = syscall.Close(next)
			if err != nil {
				return -1, err
			}
			return -1, syscall.EACCES
		}
		fd = next
	}

	root, err := syscall.Openat(fd, "synthetic", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	_ = syscall.Close(fd)
	if err != nil {
		return -1, err
	}

	var st syscall.Stat_t
	if err = syscall.Fstat(root, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Uid != 65534 || st.Nlink < 2 || st.Mode&07777 != 0700 {
		_ = syscall.Close(root)
		if err != nil {
			return -1, err
		}
		return -1, syscall.EACCES
	}
	return root, nil
}

func boundedFile(root int, name string, receipt bool) ([]byte, error) {
	limit := maxState
	if receipt {
		limit = 48
	}
	fd, err := syscall.Openat(root, name, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer syscall.Close(fd)

	var before, after syscall.Stat_t
	if err = syscall.Fstat(fd, &before); err != nil {
		return nil, syscall.EACCES
	}
	if before.Mode&syscall.S_IFMT != syscall.S_IFREG || before.Uid != 65534 || before.Nlink != 1 || before.Mode&07777 != 0600 || before.Size < 1 || before.Size > int64(limit) || (receipt && before.Size != 48) {
		return nil, syscall.EACCES
	}

	data := make([]byte, int(before.Size))
	count, err := syscall.Pread(fd, data, 0)
	if err != nil {
		return nil, syscall.EACCES
	}
	if count != len(data) {
		return nil, syscall.EACCES
	}
	if err = syscall.Fstat(fd, &after); err != nil {
		return nil, syscall.EACCES
	}
	if before.Dev != after.Dev || before.Ino != after.Ino || before.Size != after.Size {
		return nil, syscall.EACCES
	}
	return data, nil
}

func memfd(name string) (int, error) {
	namePointer, err := syscall.BytePtrFromString(name)
	if err != nil {
		return -1, err
	}
	fd, _, errno := syscall.Syscall(memfdCreate, uintptr(unsafe.Pointer(namePointer)), 3, 0)
	if errno != 0 {
		return -1, errno
	}
	return int(fd), nil
}

func addMemfd(listener int, id uint64, name string, data []byte) (int, error) {
	fd, err := memfd(name)
	if err != nil {
		return -1, err
	}
	defer syscall.Close(fd)

	count, err := syscall.Write(fd, data)
	if err != nil {
		return -1, err
	}
	if count != len(data) {
		return -1, syscall.EIO
	}
	_, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), fcntlAddSeals, sealAll)
	if errno != 0 {
		return -1, errno
	}
	if _, err = syscall.Seek(fd, 0, 0); err != nil {
		return -1, err
	}
	if !validID(listener, id) {
		return -1, syscall.ENOENT
	}
	request := addFD{
		ID:       id,
		Source:   uint32(fd),
		NewFlags: syscall.O_CLOEXEC,
	}
	result, err := ioctl(listener, ioctlAddFD, unsafe.Pointer(&request))
	if err != nil {
		return -1, err
	}
	return int(result), nil
}

func pathError(operation string, err error) error {
	return fmt.Errorf("%s: %w", operation, err)
}

func requireRoot() error {
	if os.Geteuid() != 0 {
		return errors.New("metadata daemon requires root")
	}
	return nil
}
