package main

import (
	"fmt"
	"os"
)

func main() {
	root := "."
	if len(os.Args) == 3 && os.Args[1] == "--root" {
		root = os.Args[2]
	} else if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: tooling-policy [--root PATH]")
		os.Exit(2)
	}
	result, err := check(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, line := range result.Files {
		fmt.Println(line)
	}
	for _, line := range result.Debt {
		fmt.Println("debt: " + line)
	}
	if len(result.Violations) > 0 {
		fmt.Fprintln(os.Stderr, "tooling policy violations:")
		for _, line := range result.Violations {
			fmt.Fprintln(os.Stderr, "- "+line)
		}
		os.Exit(1)
	}
	fmt.Println("tooling policy: audited Git index and baseline; no violations")
}
