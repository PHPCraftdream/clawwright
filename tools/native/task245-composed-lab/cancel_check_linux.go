//go:build task245lab && linux && amd64

package main

import (
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"
)

func verifyCancelledConsumer(path string) error {
	bad := errors.New("invalid cancel owner evidence")
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil { return bad }
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() < 1 || st.Size() > 96 { return bad }
	s, ok := st.Sys().(*syscall.Stat_t)
	if !ok || s.Uid != 65534 || s.Nlink != 1 || st.Mode().Perm() != 0600 { return bad }
	b, err := io.ReadAll(io.LimitReader(f, 97))
	if err != nil || len(b) < 1 || len(b) > 96 { clear(b); return bad }
	fields := strings.Fields(string(b)); clear(b)
	if len(fields) != 3 { return bad }
	pid, e1 := strconv.Atoi(fields[0]); start, e2 := strconv.ParseUint(fields[1], 10, 64); _, e3 := strconv.Atoi(fields[2])
	if e1 != nil || e2 != nil || e3 != nil || pid <= 1 || start == 0 { return bad }
	stat, err := os.ReadFile("/proc/"+strconv.Itoa(pid)+"/stat")
	if errors.Is(err, os.ErrNotExist) { return nil }
	if err != nil { return bad }
	close := strings.LastIndexByte(string(stat), ')')
	if close < 0 { clear(stat); return bad }
	rest := strings.Fields(string(stat[close+1:])); clear(stat)
	if len(rest) <= 19 { return bad }
	current, err := strconv.ParseUint(rest[19], 10, 64)
	if err != nil || current == start { return bad }
	return nil
}
