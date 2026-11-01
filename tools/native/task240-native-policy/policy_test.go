package policy

import (
	"strings"
	"testing"
)

const configured = "registry.example/clawwright:stable"
const good = `{"format":"clawwright-native-initial-v1","selectedImage":"registry.example/clawwright:stable","indexDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","platformDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","configDigest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","sourceCommit":"dddddddddddddddddddddddddddddddddddddddd","roots":[{"path":"/srv/gateway","manifestSHA256":"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","mountID":"root-a"}],"gatewayArgv":["gateway","--config","/srv/gateway/config.json"],"configSHA256":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","providerSHA256":"sha256:1111111111111111111111111111111111111111111111111111111111111111","stubSHA256":"sha256:2222222222222222222222222222222222222222222222222222222222222222","purpose":"gateway.auth.token","nativeProvider":"clawwright-ssjack","nativeID":"gateway-token"}`

func TestParseConfiguredSelectionPreserved(t *testing.T) {
	p, err := ParsePolicy([]byte(good), configured)
	if err != nil || p.SelectedImage != configured { t.Fatalf("policy=%+v err=%v", p, err) }
}
func TestRejectsSelectionChangeAndNoSubstitution(t *testing.T) {
	if _,err:=ParsePolicy([]byte(good),"registry.example/clawwright:other");err==nil { t.Fatal("accepted changed configured selection") }
	changed:=strings.Replace(good,configured,"registry.example/clawwright@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",1)
	if _,err:=ParsePolicy([]byte(changed),configured);err==nil { t.Fatal("substituted image reference") }
}
func TestClosedAndBoundedJSON(t *testing.T) {
	cases:=[]string{
		strings.Replace(good,`"format":`,`"extra":true,"format":`,1),
		strings.Replace(good,`"format":`,`"format":"clawwright-native-initial-v1","format":`,1),
		strings.Replace(good,`"purpose":"gateway.auth.token"`,`"purpose":"other"`,1),
		strings.Replace(good,`"nativeID":"gateway-token"`,`"nativeID":"other"`,1),
		strings.Replace(good,"/srv/gateway","/srv/../gateway",1),
		strings.Replace(good,"/srv/gateway","/srv/gateway\u0000",1),
		strings.Replace(good,"sha256:aaaaaaaa","sha256:zzzzzzzz",1),
		strings.Replace(good,"dddddddddddddddddddddddddddddddddddddddd","bad",1),
		strings.Repeat(" ",64<<10)+good,
	}
	for i,raw:=range cases { if _,err:=ParsePolicy([]byte(raw),configured);err==nil { t.Errorf("case %d accepted",i) } }
}
func TestWhitespaceAndDuplicateNestedKeys(t *testing.T) {
	if _,err:=ParsePolicy([]byte(" \n\t"+good+" \n"),configured);err!=nil { t.Fatalf("legal whitespace rejected: %v",err) }
	dup:=strings.Replace(good,`"mountID":"root-a"`,`"mountID":"root-a","mountID":"root-b"`,1)
	if _,err:=ParsePolicy([]byte(dup),configured);err==nil { t.Fatal("accepted nested duplicate") }
}
