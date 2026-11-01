// Package policy parses bounded, closed admission-policy data. Parsing is not
// approval: supervisors must independently verify image provenance, own fresh
// isolation domains and roots, and consume real root file descriptors.
package policy

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

const maxPolicyBytes = 64 << 10

type Root struct {
	Path string `json:"path"`
	ManifestSHA256 string `json:"manifestSHA256"`
	MountID string `json:"mountID"`
}
type Policy struct {
	Format string `json:"format"`
	SelectedImage string `json:"selectedImage"`
	IndexDigest string `json:"indexDigest"`
	PlatformDigest string `json:"platformDigest"`
	ConfigDigest string `json:"configDigest"`
	SourceCommit string `json:"sourceCommit"`
	Roots []Root `json:"roots"`
	GatewayArgv []string `json:"gatewayArgv"`
	ConfigSHA256 string `json:"configSHA256"`
	ProviderSHA256 string `json:"providerSHA256"`
	StubSHA256 string `json:"stubSHA256"`
	Purpose string `json:"purpose"`
	NativeProvider string `json:"nativeProvider"`
	NativeID string `json:"nativeID"`
}

func ParsePolicy(raw []byte, resolvedConfiguredImage string) (Policy, error) {
	var p Policy
	if len(raw) == 0 || len(raw) > maxPolicyBytes || !utf8.Valid(raw) || bytes.IndexByte(raw, 0) >= 0 { return p, errors.New("invalid policy size or encoding") }
	if err := checkJSON(raw); err != nil { return p, err }
	d := json.NewDecoder(bytes.NewReader(raw)); d.DisallowUnknownFields()
	if err := d.Decode(&p); err != nil { return p, errors.New("invalid policy JSON") }
	if err := d.Decode(new(any)); err != io.EOF { return p, errors.New("trailing policy data") }
	if p.Format != "clawwright-native-initial-v1" || resolvedConfiguredImage == "" || p.SelectedImage != resolvedConfiguredImage { return p, errors.New("policy selection mismatch") }
	if !digest(p.IndexDigest) || !digest(p.PlatformDigest) || !digest(p.ConfigDigest) || !digest(p.ConfigSHA256) || !digest(p.ProviderSHA256) || !digest(p.StubSHA256) || !hex(p.SourceCommit, 40) { return p, errors.New("invalid identity digest") }
	if p.Purpose != "gateway.auth.token" || p.NativeProvider != "clawwright-ssjack" || p.NativeID != "gateway-token" { return p, errors.New("invalid native binding") }
	if len(p.Roots) == 0 || len(p.Roots) > 8 || len(p.GatewayArgv) == 0 || len(p.GatewayArgv) > 16 { return p, errors.New("policy bounds exceeded") }
	seen := map[string]bool{}
	for _, r := range p.Roots { if !absolute(r.Path) || seen[r.Path] || !digest(r.ManifestSHA256) || r.MountID == "" || strings.ContainsAny(r.MountID, "\x00/\\") { return p, errors.New("invalid root") }; seen[r.Path] = true }
	for _, a := range p.GatewayArgv { if a == "" || strings.ContainsRune(a, 0) { return p, errors.New("invalid gateway argv") } }
	return p, nil
}
func digest(s string) bool { return len(s)==71 && strings.HasPrefix(s,"sha256:") && hex(s[7:],64) }
func hex(s string,n int) bool { if len(s)!=n{return false}; for _,c:=range s { if !(c>='0'&&c<='9'||c>='a'&&c<='f'){return false} }; return true }
func absolute(s string) bool { return strings.HasPrefix(s,"/") && s!="/" && !strings.ContainsAny(s,"\\\x00") && !strings.Contains(s,"//") && !strings.Contains(s,"/../") && !strings.HasSuffix(s,"/..") && !strings.Contains(s,"/./") && !strings.HasSuffix(s,"/.") }
// Token-walk rejects duplicate keys recursively with bounded depth and nodes.
func checkJSON(raw []byte) error {
	d:=json.NewDecoder(bytes.NewReader(raw)); d.UseNumber(); nodes:=0
	var value func(int) error
	value=func(depth int) error { nodes++; if nodes>4096||depth>32{return errors.New("policy complexity limit")}; t,e:=d.Token(); if e!=nil{return e}; switch x:=t.(type) { case json.Delim: if x=='{' { seen:=map[string]bool{}; for d.More(){ k,e:=d.Token(); if e!=nil{return e}; key,ok:=k.(string); if !ok||seen[key]{return errors.New("duplicate or invalid key")}; seen[key]=true; if e=value(depth+1);e!=nil{return e} }; _,e=d.Token();return e }; if x=='[' { for d.More(){if e:=value(depth+1);e!=nil{return e}}; _,e=d.Token();return e }; return fmt.Errorf("invalid delimiter") }; return nil }
	if e:=value(0);e!=nil{return e}; if _,e:=d.Token();e!=io.EOF{return errors.New("trailing policy data")}; return nil
}
