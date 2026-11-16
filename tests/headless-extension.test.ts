/**
 * Smoke test for the extension wiring itself: load the extension with a stub
 * Pi API, take the registered `bash` tool, and run it the way Pi would.
 *
 * The unit tests pin the environment policy; this file pins the four things
 * that wire it up — the tool override, the settings key, `--no-headless`, and
 * the `/headless` command.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import headlessExtension from "../extensions/headless.ts";

interface Command {
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

/** Minimal Pi API: records registrations and replays canned settings. */
function loadExtension(settings: Record<string, unknown> = {}, flags: Record<string, unknown> = {}) {
	const tools: Record<string, { execute: (...args: any[]) => Promise<any> }> = {};
	const commands: Record<string, Command> = {};
	const registeredFlags: string[] = [];
	const notifications: string[] = [];

	const pi = {
		registerTool: (tool: { name: string }) => {
			tools[tool.name] = tool as never;
		},
		registerCommand: (name: string, command: Command) => {
			commands[name] = command;
		},
		registerFlag: (name: string) => {
			registeredFlags.push(name);
		},
		getFlag: (name: string) => flags[name],
		getSettings: () => settings,
	} as unknown as ExtensionAPI;

	headlessExtension(pi);

	return {
		flags: registeredFlags,
		tools,
		commands,
		notifications,
		bash: (command: string, cwd: string) =>
			tools.bash!.execute("call-1", { command }, undefined, undefined, {
				cwd,
				model: undefined,
				thinkingLevel: undefined,
				sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
			}),
	};
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-headless-ext-"));
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

test("registers a bash override, a flag and a command", () => {
	const ext = loadExtension();
	assert.deepEqual(Object.keys(ext.tools), ["bash"]);
	assert.deepEqual(ext.flags, ["no-headless"]);
	assert.ok(ext.commands.headless);
});

test("the bash override keeps the built-in prompt metadata", () => {
	const tool = loadExtension().tools.bash as unknown as {
		promptSnippet?: string;
		promptGuidelines?: string[];
		description: string;
	};
	assert.match(tool.description, /Execute a bash command/);
	assert.ok(tool.promptSnippet, "the override must keep its system-prompt snippet");
	assert.ok(
		tool.promptGuidelines?.some((line) => /without a TTY/.test(line)),
		"the override should tell the model that commands are non-interactive",
	);
});

test("commands run with the headless environment", async () => {
	const ext = loadExtension();
	const result = await ext.bash('printf "%s|%s|%s" "$PI_HEADLESS" "$PAGER" "$EDITOR"', tempDir());
	assert.notEqual(result.isError, true, text(result));
	assert.match(text(result), /^1\|cat\|\/.*pi-headless-editor\.sh$/m);
});

test("an interactive editor fails fast with an explanation", async (t) => {
	if (spawnSync("sh", ["-c", "command -v jj"], { stdio: "ignore" }).status !== 0) {
		t.skip("jj not installed");
		return;
	}
	const repo = tempDir();
	spawnSync("jj", ["git", "init"], { cwd: repo, stdio: "ignore" });
	writeFileSync(join(repo, "file.txt"), "content\n");
	spawnSync("jj", ["file", "track", "file.txt"], { cwd: repo, stdio: "ignore" });

	const started = Date.now();
	const result = await loadExtension().bash("jj describe", repo);

	assert.equal(result.isError, true, "jj describe must not succeed without a terminal");
	assert.match(text(result), /pi-headless: refusing to open an interactive editor/);
	assert.ok(Date.now() - started < 15_000, "the command must not wait for a keyboard");
});

test("settings can turn headless mode off", async () => {
	const ext = loadExtension({ piHeadless: { enabled: false } });
	const result = await ext.bash('printf "%s" "${PI_HEADLESS-unset}"', tempDir());
	assert.equal(text(result).trim(), "unset");
});

test("settings can add and remove variables", async () => {
	const ext = loadExtension({ piHeadless: { env: { CI: "1", GIT_TERMINAL_PROMPT: null } } });
	const result = await ext.bash(
		'printf "%s|%s" "$CI" "${GIT_TERMINAL_PROMPT-unset}"',
		tempDir(),
	);
	assert.match(text(result), /1\|unset/);
});

test("--no-headless turns headless mode off", async () => {
	const ext = loadExtension({}, { "no-headless": true });
	const result = await ext.bash('printf "%s" "${PI_HEADLESS-unset}"', tempDir());
	assert.equal(text(result).trim(), "unset");
});

test("settings can cap a command that would otherwise never return", async () => {
	const ext = loadExtension({ piHeadless: { timeoutSeconds: 1 } });
	const started = Date.now();

	// Pi turns this rejection into the tool's error result.
	await assert.rejects(() => ext.bash("sleep 30", tempDir()), /timed out/i);
	assert.ok(Date.now() - started < 15_000);
});

test("no default timeout is imposed without configuration", async () => {
	const result = await loadExtension().bash("sleep 1 && echo done", tempDir());
	assert.notEqual(result.isError, true, text(result));
	assert.match(text(result), /done/);
});

test("/headless reports the active configuration", async () => {
	const ext = loadExtension({ piHeadless: { env: { CI: "1" }, timeoutSeconds: 60 } });
	const messages: string[] = [];
	await ext.commands.headless!.handler("", {
		ui: { notify: (message: string) => messages.push(message) },
	});

	const report = messages.join("\n");
	assert.match(report, /pi-headless: on/);
	assert.match(report, /pi-headless-editor\.sh/);
	assert.match(report, /default timeout: 60s/);
	assert.match(report, /CI=1/);
});
