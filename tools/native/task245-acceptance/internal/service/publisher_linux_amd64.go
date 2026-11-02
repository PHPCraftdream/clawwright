//go:build linux && amd64

package service

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func checkPublisherModes(child *Child, role string) (result error) {
	authPath := filepath.Join(authDir, role+".auth")
	newPath := filepath.Join(authDir, role+".new")
	if _, err := os.Lstat(authPath); !os.IsNotExist(err) {
		return fmt.Errorf("publisher fixture auth path is not absent: %w", err)
	}
	if _, err := os.Lstat(newPath); !os.IsNotExist(err) {
		return fmt.Errorf("publisher fixture temporary path is not absent: %w", err)
	}
	if err := os.Mkdir(authDir, 0755); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("create publisher auth directory: %w", err)
	}
	authInfo, err := os.Lstat(authDir)
	if err != nil {
		return fmt.Errorf("stat publisher auth directory: %w", err)
	}
	authStat, ok := authInfo.Sys().(*syscall.Stat_t)
	if !ok || !authInfo.IsDir() || authStat.Uid != 0 || authStat.Mode&07777 != 0755 {
		return fmt.Errorf("publisher auth directory fixture is not root-owned mode 0755")
	}

	runtimePath := runtimeDir
	markerPath := "/lab/disposable-profile"
	socketPath := roles[role].socket
	cases := []struct {
		name  string
		path  string
		mode  uint32
		uid   uint32
		want  string
		chown bool
	}{
		{name: "runtime-mode", path: runtimePath, mode: 0777, uid: 0, want: "directory"},
		{name: "runtime-owner", path: runtimePath, mode: 0755, uid: 65534, want: "directory", chown: true},
		{name: "marker-mode", path: markerPath, mode: 0444 | 04000, uid: 0, want: "profile-marker"},
		{name: "marker-setgid", path: markerPath, mode: 02444, uid: 0, want: "profile-marker"},
		{name: "marker-sticky", path: markerPath, mode: 01444, uid: 0, want: "profile-marker"},
		{name: "socket-mode", path: socketPath, mode: 0666 | 02000, uid: 0, want: "socket"},
		{name: "socket-setuid", path: socketPath, mode: 04666, uid: 0, want: "socket"},
		{name: "socket-sticky", path: socketPath, mode: 01666, uid: 0, want: "socket"},
		{name: "auth-sticky", path: authDir, mode: 0755 | 01000, uid: 0, want: "attestation-directory"},
		{name: "auth-setuid", path: authDir, mode: 0755 | 04000, uid: 0, want: "attestation-directory"},
		{name: "auth-setgid", path: authDir, mode: 0755 | 02000, uid: 0, want: "attestation-directory"},
	}
	for _, tc := range cases {
		if err := withPublisherMutation(child, role, tc.name, tc.path, tc.mode, tc.uid, tc.want, tc.chown, false); err != nil {
			return err
		}
	}
	if err := Attest(child, roles[role].executable, roles[role].socket, role); err != nil {
		return fmt.Errorf("publisher positive attestation: %w", err)
	}
	proof, err := os.Lstat(authPath)
	if err != nil {
		return fmt.Errorf("stat published proof: %w", err)
	}
	proofStat, ok := proof.Sys().(*syscall.Stat_t)
	if !ok || !proof.Mode().IsRegular() || proofStat.Uid != 0 || proofStat.Nlink != 1 || proofStat.Mode&07777 != 0444 {
		return fmt.Errorf("published proof has unexpected type, owner, link count, or mode")
	}
	for _, mode := range []uint32{01755, 02755, 04755} {
		if err := withPublisherMutation(child, role, "remove-auth-mode", authDir, mode, 0, "attestation-directory", false, true); err != nil {
			return err
		}
	}
	if err := Remove(role); err != nil {
		return fmt.Errorf("remove published proof: %w", err)
	}
	if _, err := os.Lstat(authPath); !os.IsNotExist(err) {
		return fmt.Errorf("published proof remains after removal: %w", err)
	}
	if _, err := os.Lstat(newPath); !os.IsNotExist(err) {
		return fmt.Errorf("temporary proof remains after publication: %w", err)
	}
	return nil
}

func withPublisherMutation(child *Child, role, name, path string, mode, uid uint32, want string, chown, removal bool) (result error) {
	before, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("%s capture fixture: %w", name, err)
	}
	beforeStat, ok := before.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("%s fixture lacks syscall stat data", name)
	}
	var expectedType uint32
	var expectedMode uint32
	switch path {
	case runtimeDir, authDir:
		expectedType, expectedMode = syscall.S_IFDIR, 0755
	case "/lab/disposable-profile":
		expectedType, expectedMode = syscall.S_IFREG, 0444
	case roles[role].socket:
		expectedType, expectedMode = syscall.S_IFSOCK, 0666
	default:
		return fmt.Errorf("%s fixture path is unknown: %s", name, path)
	}
	if beforeStat.Mode&syscall.S_IFMT != expectedType || beforeStat.Mode&07777 != expectedMode || beforeStat.Uid != 0 {
		return fmt.Errorf("%s fixture has unexpected type, owner, or mode", name)
	}
	var proofBefore os.FileInfo
	var proofBeforeStat *syscall.Stat_t
	if removal {
		proofPath := filepath.Join(authDir, role+".auth")
		proofBefore, err = os.Lstat(proofPath)
		if err != nil {
			return fmt.Errorf("%s capture published proof: %w", name, err)
		}
		proofBeforeStat, ok = proofBefore.Sys().(*syscall.Stat_t)
		if !ok || !proofBefore.Mode().IsRegular() || proofBeforeStat.Uid != 0 || proofBeforeStat.Nlink != 1 || proofBeforeStat.Mode&07777 != 0444 {
			return fmt.Errorf("%s published proof has unexpected type, owner, link count, or mode", name)
		}
	}
	originalMode := beforeStat.Mode & 07777
	originalUID, originalGID := beforeStat.Uid, beforeStat.Gid
	if chown {
		if err := syscall.Chown(path, int(uid), int(originalGID)); err != nil {
			return fmt.Errorf("%s mutate owner: %w", name, err)
		}
	} else if err := syscall.Chmod(path, mode); err != nil {
		return fmt.Errorf("%s mutate mode: %w", name, err)
	}
	defer func() {
		restored, statErr := os.Lstat(path)
		if statErr == nil {
			restoredStat, valid := restored.Sys().(*syscall.Stat_t)
			if !valid || restoredStat.Dev != beforeStat.Dev || restoredStat.Ino != beforeStat.Ino {
				statErr = fmt.Errorf("%s restore refused: inode changed", name)
			} else {
				if err := syscall.Chown(path, int(originalUID), int(originalGID)); err != nil {
					statErr = fmt.Errorf("%s restore owner: %w", name, err)
				} else if err := syscall.Chmod(path, originalMode); err != nil {
					statErr = fmt.Errorf("%s restore mode: %w", name, err)
				} else if restored, err := os.Lstat(path); err != nil {
					statErr = fmt.Errorf("%s verify restoration: %w", name, err)
				} else if restoredStat, valid := restored.Sys().(*syscall.Stat_t); !valid || restoredStat.Dev != beforeStat.Dev || restoredStat.Ino != beforeStat.Ino || restoredStat.Uid != originalUID || restoredStat.Gid != originalGID || restoredStat.Mode&07777 != originalMode {
					statErr = fmt.Errorf("%s restoration did not preserve inode, owner, and mode", name)
				}
			}
		}
		if statErr != nil {
			result = errors.Join(result, statErr)
		}
	}()
	after, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("%s verify mutation: %w", name, err)
	}
	afterStat, ok := after.Sys().(*syscall.Stat_t)
	if !ok || afterStat.Dev != beforeStat.Dev || afterStat.Ino != beforeStat.Ino {
		return fmt.Errorf("%s mutation changed fixture inode", name)
	}
	if chown {
		if afterStat.Uid != uid || afterStat.Mode&07777 != originalMode {
			return fmt.Errorf("%s mutation did not set requested owner and preserve mode", name)
		}
	} else if afterStat.Uid != originalUID || afterStat.Mode&07777 != mode {
		return fmt.Errorf("%s mutation did not set requested mode and preserve owner", name)
	}
	if removal {
		removeErr := Remove(role)
		var remove *Error
		if !errors.As(removeErr, &remove) || remove.Code != want {
			return fmt.Errorf("%s expected removal refusal %q, got %v", name, want, removeErr)
		}
		proofAfter, statErr := os.Lstat(filepath.Join(authDir, role+".auth"))
		if statErr != nil {
			return fmt.Errorf("%s stat preserved published proof: %w", name, statErr)
		}
		proofAfterStat, valid := proofAfter.Sys().(*syscall.Stat_t)
		if !valid || proofAfterStat.Dev != proofBeforeStat.Dev || proofAfterStat.Ino != proofBeforeStat.Ino || !proofAfter.Mode().IsRegular() || proofAfterStat.Uid != 0 || proofAfterStat.Nlink != 1 || proofAfterStat.Mode&07777 != 0444 {
			return fmt.Errorf("%s removal changed published proof", name)
		}
		if _, statErr := os.Lstat(filepath.Join(authDir, role+".new")); !os.IsNotExist(statErr) {
			return fmt.Errorf("%s left temporary proof path: %w", name, statErr)
		}
		return nil
	}
	attestErr := Attest(child, roles[role].executable, roles[role].socket, role)
	var attest *Error
	if !errors.As(attestErr, &attest) || attest.Code != want {
		return fmt.Errorf("%s expected attestation refusal %q, got %v", name, want, attestErr)
	}
	for _, proofPath := range []string{filepath.Join(authDir, role+".auth"), filepath.Join(authDir, role+".new")} {
		if _, err := os.Lstat(proofPath); !os.IsNotExist(err) {
			return fmt.Errorf("%s left proof path %s: %w", name, proofPath, err)
		}
	}
	return nil
}
