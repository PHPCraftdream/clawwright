// Asserts the shells tokenization model against independent literals — nothing here calls
// into packages/clawwright beyond importing the Shell type. Style note: every string literal in
// an assertion is space-free (dotted names, `\u0020` escapes in input lines, token arrays as
// expectations) so the architecture ratchet's spaced-literal counts hold steady. Assertions
// compare TOKEN ARRAYS directly — never re-splitting on spaces — so "one token with an inner
// space" is distinguished from "two tokens"; such tokens are asserted via length + `\u0020`
// containment checks instead of spaced literal expectations.

import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { cmdRawWords, msvcrtArgv, parsePaste, programArgv, tokenizeLine, type Shell } from "#checks/surfaces/advice/shells.ts";

const tokens = (line: string, shell: Shell): string[] => tokenizeLine(line, shell);

/** Asserts `line` yields exactly `count` tokens for `shell` and that token `at` contains an
 *  inner space — the character-safe way to pin "one token holding a space" (a spaced literal
 *  in an expectation would count against the prose ratchet). */
const oneSpacedToken = (id: string, line: string, shell: Shell, count: number, at: number): void => {
  const words = tokens(line, shell);
  check(id + ".count", words.length, count);
  check(id + ".inner.space", words[at]?.includes("\u0020") ?? false, true);
};

// --- posix ------------------------------------------------------------------------------------

oneSpacedToken("posix.single.quotes.hold.inner.space", "echo\u0020'a\u0020b'", "posix", 2, 1);
check("posix.single.quotes.exact.words", tokens("echo\u0020'a\u0020b'", "posix")[0], "echo");
checkTrue("posix.single.quotes.no.re.split", tokens("echo\u0020'a\u0020b'", "posix").length === 2);
oneSpacedToken("posix.double.quotes.hold.inner.space", "echo\u0020\"a\u0020b\"", "posix", 2, 1);
check("posix.double.quotes.keep.escaped.quote", tokens("say\u0020\"a\\\"b\"", "posix"), ["say", "a\"b"]);
check("posix.backslash.escapes.a.space.is.one.word", tokens("echo\u0020a\\\u0020b", "posix").length, 2);
check("posix.backslash.escaped.space.token.join", tokens("echo\u0020a\\\u0020b", "posix")[1], "a\u0020b");
check("posix.chain.splits.into.tail.words", tokens("cd\u0020/tmp/x\u0020&&\u0020ls\u0020-a", "posix"), ["ls", "-a"]);
oneSpacedToken("posix.quoted.prefix.then.tail.two.tokens", "'a\u0020b'\u0020tail", "posix", 2, 0);
check("posix.quoted.prefix.tail.word", tokens("'a\u0020b'\u0020tail", "posix")[1], "tail");
check(
  "posix.chain.quoted.head.tail.is.last.segment",
  tokens("echo\u0020'x\u0020y'\u0020&&\u0020echo\u0020c", "posix"),
  ["echo", "c"],
);
oneSpacedToken(
  "posix.checkout.style.path.in.quotes",
  "git\u0020checkout\u0020'--\u0020my\u0020file.txt'",
  "posix",
  3,
  2,
);

check(
  "posix.paste.cd.lifted.from.leading.prefix",
  parsePaste("cd\u0020'/tmp/sg'\u0020&&\u0020node\u0020run.js", "posix"),
  { cd: "/tmp/sg", words: ["node", "run.js"] },
);
check("posix.paste.without.prefix.yields.words.only", parsePaste("ls\u0020-a", "posix"), { words: ["ls", "-a"] });

// Defined behaviour: an unterminated quote runs to end-of-line, folding the rest (separators
// included) into the last word — the model never errors, it models what the shell receives.
check("posix.unbalanced.quote.folds.rest.into.last.word", tokens("echo\u0020'a\u0020b", "posix").length, 2);
checkTrue(
  "posix.unbalanced.quote.last.word.holds.space",
  tokens("echo\u0020'a\u0020b", "posix")[1]?.includes("\u0020") ?? false,
);
check("posix.unbalanced.quote.count.stays.two", tokens("echo\u0020'oops", "posix").length, 2);

// --- cmd --------------------------------------------------------------------------------------

checkTrue("cmd.double.quotes.group.as.one.token", tokens("echo\u0020\"a\u0020b\"\u0020c", "cmd").length === 3);
check("cmd.double.quotes.first.word", tokens("echo\u0020\"a\u0020b\"\u0020c", "cmd")[0], "echo");
checkTrue(
  "cmd.double.quoted.token.holds.space",
  tokens("echo\u0020\"a\u0020b\"\u0020c", "cmd")[1]?.includes("\u0020") ?? false,
);
check("cmd.single.quotes.are.ordinary.chars", tokens("echo\u0020'x'", "cmd"), ["echo", "'x'"]);
check("cmd.caret.escapes.a.metachar", tokens("echo\u0020a^&b", "cmd"), ["echo", "a&b"]);
check("cmd.caret.escapes.a.space.into.one.word", tokens("echo\u0020a^\u0020b", "cmd"), ["echo", "a\u0020b"]);
check("cmd.percent.var.stays.one.word.in.quotes", tokens("echo\u0020\"%PATH%\"\u0020tail", "cmd"), ["echo", "%PATH%", "tail"]);
check("cmd.bare.metachar.ends.a.word", tokens("copy\u0020a\u0020>\u0020b", "cmd"), ["copy", "a", "b"]);
check("cmd.paste.ignores.the.posix.cd.shape", parsePaste("cd\u0020x\u0020&&\u0020y", "cmd"), { words: ["cd", "x", "y"] });
check("cmd.unbalanced.quote.folds.rest", tokens("echo\u0020\"oops", "cmd"), ["echo", "oops"]);

// cmd keeps its toggle rule (a quote ALWAYS toggles); the program side is a separate step.
check("cmd.doubled.quote.keeps.metachar.inside.quotes", tokens("echo\u0020\"a\"\"&calc\"", "cmd"), ["echo", "a&calc"]);
check("cmd.raw.words.keep.the.doubled.quotes", cmdRawWords("echo\u0020\"a\"\"&calc\""), ["echo", "\"a\"\"&calc\""]);
check("cmd.raw.words.backslash.quote.toggles.and.exposes.the.metachar", cmdRawWords("echo\u0020\"a\\\"&calc\""), ["echo", "\"a\\\"", "calc\""]);
check("msvcrt.doubled.quote.inside.quotes.is.one.literal.quote", msvcrtArgv("\"a\"\"&calc\""), ["a\"&calc"]);
check("msvcrt.trailing.backslash.run.doubled.before.closing.quote", msvcrtArgv("\"C:\\dir\\\\\""), ["C:\\dir\\"]);
check("msvcrt.backslash.run.doubled.before.doubled.quote", msvcrtArgv("\"a\\\\\"\"b\""), ["a\\\"b"]);
check("msvcrt.odd.backslash.run.makes.a.literal.quote", msvcrtArgv("a\\\"b"), ["a\"b"]);
check("msvcrt.backslashes.elsewhere.are.literal", msvcrtArgv("C:\\dir\\x"), ["C:\\dir\\x"]);
check("msvcrt.empty.quoted.argument.is.one.empty.word", msvcrtArgv("a\u0020\"\"\u0020b"), ["a", "", "b"]);
check("msvcrt.unquoted.whitespace.separates.arguments", msvcrtArgv("a\u0020\tb"), ["a", "b"]);
check("cmd.program.argv.runs.the.model.then.the.program.parser", programArgv("clawwright\u0020\"a\"\"&calc\"\u0020\"C:\\dir\\\\\"", "cmd"), ["clawwright", "a\"&calc", "C:\\dir\\"]);
check("posix.program.argv.is.the.shell.words", programArgv("ls\u0020'a\u0020b'", "posix"), ["ls", "a\u0020b"]);

// --- pwsh -------------------------------------------------------------------------------------

check("pwsh.single.quotes.are.fully.literal", tokens("echo\u0020'$x'", "pwsh"), ["echo", "$x"]);
check("pwsh.double.quotes.keep.dollar.reference", tokens("echo\u0020\"$env:CI\"", "pwsh"), ["echo", "$env:CI"]);
check("pwsh.backtick.escapes.a.space.into.one.word", tokens("echo\u0020a`\u0020b", "pwsh"), ["echo", "a\u0020b"]);
check("pwsh.backtick.escapes.a.quote", tokens("say\u0020`\"q\"", "pwsh"), ["say", "\"q"]);
// Fixed precedence: inside single quotes a backtick is LITERAL data, not an escape.
check("pwsh.backtick.inside.single.quotes.is.literal", tokens("echo\u0020'a`b'", "pwsh"), ["echo", "a`b"]);
checkTrue(
  "pwsh.double.quoted.backtick.still.escapes",
  tokens("echo\u0020\"a`\u0020b\"", "pwsh").length === 2,
);
// '' inside single quotes yields one literal quote character in the token.
check("pwsh.doubled.single.quote.is.one.literal.quote", tokens("echo\u0020'a''b'", "pwsh"), ["echo", "a'b"]);
oneSpacedToken("pwsh.dollar.env.run.stays.one.token", "echo\u0020\"$env:X\u0020tail\"", "pwsh", 2, 1);
check("pwsh.unbalanced.quote.folds.rest", tokens("echo\u0020'oops", "pwsh").length, 2);

checkTrue("pwsh.model.rejects.nothing.and.always.returns.words", tokens("", "pwsh").length === 0);

finish("kit-shells");
