package runner

import (
	"archive/tar"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type archiveItem struct {
	name string
	path string
	dir  bool
}

var tarEpoch = time.Unix(0, 0).UTC()

func BuildArchive(root string) ([]byte, error) {
	var items []archiveItem
	var total int64

	err := filepath.WalkDir(root, func(p string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if p == root {
			return nil
		}
		if len(items) >= 128 {
			return fmt.Errorf("staged input inventory exceeds limit")
		}
		rel, e := filepath.Rel(root, p)
		if e != nil {
			return e
		}
		name := filepath.ToSlash(filepath.Join("lab", rel))
		if d.IsDir() {
			items = append(items, archiveItem{name: name, path: p, dir: true})
			return nil
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("nonregular staged input")
		}
		if info.Size() > 128<<20 {
			return fmt.Errorf("staged input exceeds per-file limit")
		}
		total += info.Size()
		if total > 512<<20 {
			return fmt.Errorf("staged input exceeds total limit")
		}
		items = append(items, archiveItem{name: name, path: p})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(items, func(i, j int) bool { return items[i].name < items[j].name })
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	writeDir := func(name string) error {
		return tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeDir, Mode: 0755, Uid: 0, Gid: 0, ModTime: tarEpoch, Format: tar.FormatUSTAR})
	}
	if err = writeDir("lab"); err != nil {
		return nil, err
	}
	for _, it := range items {
		if it.dir {
			err = writeDir(it.name)
		} else {
			var f *os.File
			f, err = os.Open(it.path)
			if err == nil {
				var st os.FileInfo
				st, err = f.Stat()
				if err == nil && st.Size() > 128<<20 {
					err = fmt.Errorf("staged input exceeds per-file limit")
				}
				if err == nil {
					mode := int64(0755)
					if filepath.Base(it.path) == "native-metadata" {
						mode = 0555
					}
					h := &tar.Header{Name: it.name, Mode: mode, Size: st.Size(), Uid: 0, Gid: 0, ModTime: tarEpoch, Format: tar.FormatUSTAR}
					err = tw.WriteHeader(h)
					if err == nil {
						_, err = io.Copy(tw, f)
					}
				}
				f.Close()
			}
		}
		if err != nil {
			tw.Close()
			return nil, err
		}
	}
	if err = tw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
