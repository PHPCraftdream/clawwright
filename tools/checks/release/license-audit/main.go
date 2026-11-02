package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

func cli(args []string, stdout, stderr io.Writer) int {
	root, packageDir, err := parseArgs(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if root == "" {
		_, source, _, ok := runtime.Caller(0)
		if !ok {
			fmt.Fprintln(stderr, "cannot locate source root")
			return 1
		}
		root = filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	}
	if packageDir == "" {
		packageDir = filepath.Join(root, "packages", "clawwright")
	}
	if err := audit(root, packageDir, stdout); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

func parseArgs(args []string) (string, string, error) {
	root, packageDir := "", ""
	for index := 0; index < len(args); index++ {
		argument := args[index]
		if argument != "--root" && argument != "--package-dir" {
			return "", "", fmt.Errorf("unsupported argument: %s", argument)
		}
		if index+1 >= len(args) {
			return "", "", fmt.Errorf("%s requires a path", argument)
		}
		value := args[index+1]
		index++
		if argument == "--root" {
			root = value
		} else {
			packageDir = value
		}
	}
	return root, packageDir, nil
}

func main() {
	os.Exit(cli(os.Args[1:], os.Stdout, os.Stderr))
}
