//go:build linux

package content

import "testing"

const mounts = "1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:2 / /srv/content ro - ext4 /dev/content ro\n"

func TestSelectMountRequiresReadOnlyAndRejectsNested(t *testing.T) {
 if _, err := selectMount("1 0 8:1 / / rw - ext4 /dev/root rw\n", "/srv/content"); err == nil { t.Fatal("accepted writable mount") }
 if _, err := selectMount(mounts+"3 2 8:3 / /srv/content/sub ro - ext4 /dev/sub ro\n", "/srv/content"); err == nil { t.Fatal("accepted nested mount") }
}

func TestSelectMountChoosesDeepestReadOnly(t *testing.T) {
 data := "1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:2 / /srv ro - ext4 /dev/parent ro\n3 2 8:3 / /srv/content ro - ext4 /dev/content ro\n"
 id, err := selectMount(data, "/srv/content")
 if err != nil || id != "3" { t.Fatalf("selectMount = %q, %v", id, err) }
}

func TestValidPathRejectsTraversal(t *testing.T) {
 for _, p := range []string{"..", "../x", "a/../x", "/x"} { if validPath(p) { t.Errorf("accepted %q", p) } }
}

func TestRejectDuplicateKeysNested(t *testing.T) {
 if rejectDuplicateKeys([]byte(`{"outer":{"x":1,"x":2}}`)) == nil { t.Fatal("accepted nested duplicate key") }
}

func TestValidateLinksRejectsEscapeAndCycle(t *testing.T) {
 if validateLinks(map[string]entry{"a": {Path:"a", Type:"symlink", Target:"../../escape"}}) == nil { t.Fatal("accepted escape") }
 es := map[string]entry{"a": {Path:"a", Type:"symlink", Target:"b"}, "b": {Path:"b", Type:"symlink", Target:"a"}}
 if validateLinks(es) == nil { t.Fatal("accepted cycle") }
}
