import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	buildHeadlessEnv,
	DEFAULT_CONFIG,
	EDITOR_GUARD_SCRIPT,
	EDITOR_VARIABLES,
	HEADLESS_MARKER,
	headlessEnvDefaults,
	installEditorGuard,
	normalizeHeadlessConfig,
	PAGER_VARIABLES,
	withBatchMode,
} from "../extensions/headless-env.ts";

test("editors are redirected to the guard", () => {
	const env = buildHeadlessEnv({ editorCommand: "/tmp/guard.sh" });
	for (const name of EDITOR_VARIABLES) {
		assert.equal(env[name], "/tmp/guard.sh", name);
	}
});

test("pagers are disabled", () => {
	const env = buildHeadlessEnv({ editorCommand: "/tmp/guard.sh" });
	for (const name of PAGER_VARIABLES) {
		assert.equal(env[name], "cat", name);
	}
	assert.equal(env.AWS_PAGER, "");
});

test("prompting tools are told not to prompt", () => {
	const env = buildHeadlessEnv();
	assert.equal(env.GIT_TERMINAL_PROMPT, "0");
	assert.equal(env.GH_PROMPT_DISABLED, "1");
	assert.equal(env.PIP_NO_INPUT, "1");
	assert.equal(env.npm_config_yes, "true");
	assert.equal(env.DEBIAN_FRONTEND, "noninteractive");
	assert.equal(env.GIT_MERGE_AUTOEDIT, "no");
	assert.equal(env.SSH_ASKPASS_REQUIRE, "never");
	assert.equal(env[HEADLESS_MARKER], "1");
});

test("CI is not forced, because it changes test results", () => {
	assert.equal(buildHeadlessEnv().CI, undefined);
});

test("the inherited environment survives but its pager does not", () => {
	const env = buildHeadlessEnv({
		baseEnv: { PATH: "/usr/bin", PAGER: "less", EDITOR: "nvim", PI_SESSION_ID: "abc" },
	});
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.PI_SESSION_ID, "abc", "session variables injected by Pi must survive");
	assert.equal(env.PAGER, "cat");
	assert.equal(env.EDITOR, "false");
});

test("overrides win over defaults and null removes a variable", () => {
	const env = buildHeadlessEnv({
		overrides: { CI: "1", PAGER: "most", GIT_TERMINAL_PROMPT: null },
	});
	assert.equal(env.CI, "1");
	assert.equal(env.PAGER, "most");
	assert.equal(env.GIT_TERMINAL_PROMPT, undefined);
});

test("GIT_SSH_COMMAND keeps the user's command and adds BatchMode", () => {
	assert.equal(withBatchMode(undefined), "ssh -o BatchMode=yes");
	assert.equal(withBatchMode(""), "ssh -o BatchMode=yes");
	assert.equal(withBatchMode("ssh -i /key"), "ssh -i /key -o BatchMode=yes");
	assert.equal(
		withBatchMode("ssh -o BatchMode=yes -i /key"),
		"ssh -o BatchMode=yes -i /key",
		"an existing BatchMode must not be duplicated",
	);

	const inherited = buildHeadlessEnv({ baseEnv: { GIT_SSH_COMMAND: "ssh -i /key" } });
	assert.equal(inherited.GIT_SSH_COMMAND, "ssh -i /key -o BatchMode=yes");
});

test("explicit GIT_SSH_COMMAND override is used verbatim", () => {
	const env = buildHeadlessEnv({ overrides: { GIT_SSH_COMMAND: "my-ssh-wrapper" } });
	assert.equal(env.GIT_SSH_COMMAND, "my-ssh-wrapper");
});

test("the guard is executable and explains itself", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-headless-test-"));
	const guard = installEditorGuard(dir);

	assert.equal(readFileSync(guard, "utf8"), EDITOR_GUARD_SCRIPT);
	assert.ok(statSync(guard).mode & 0o111, "guard must be executable");
	assert.match(EDITOR_GUARD_SCRIPT, /^#!\/bin\/sh/);
	assert.match(EDITOR_GUARD_SCRIPT, /-m 'msg'/, "guard should suggest a non-interactive alternative");
	assert.match(EDITOR_GUARD_SCRIPT, /exit 1/);
});

test("headlessEnvDefaults is stable for the same input", () => {
	assert.deepEqual(headlessEnvDefaults("/tmp/g.sh"), headlessEnvDefaults("/tmp/g.sh"));
});

test("normalizeHeadlessConfig accepts the documented shape", () => {
	const config = normalizeHeadlessConfig({
		enabled: false,
		env: { CI: "1", PAGER: null, RETRIES: 3, DEBUG: true },
		timeoutSeconds: 120,
	});
	assert.deepEqual(config, {
		enabled: false,
		env: { CI: "1", PAGER: null, RETRIES: "3", DEBUG: "true" },
		timeoutSeconds: 120,
	});
});

test("normalizeHeadlessConfig falls back on nonsense", () => {
	for (const raw of [undefined, null, 42, "enabled", [], true]) {
		assert.deepEqual(normalizeHeadlessConfig(raw), DEFAULT_CONFIG, String(raw));
	}
	assert.deepEqual(normalizeHeadlessConfig({ enabled: "yes", timeoutSeconds: -5 }), DEFAULT_CONFIG);
	assert.deepEqual(normalizeHeadlessConfig({ timeoutSeconds: Number.NaN }), DEFAULT_CONFIG);
	assert.deepEqual(normalizeHeadlessConfig({ env: "PAGER=cat" }), DEFAULT_CONFIG);
});
