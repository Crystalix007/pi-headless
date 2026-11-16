/**
 * These tests reproduce the failures the extension exists for: commands that
 * wait for a terminal, run the way Pi runs them (no TTY, detached, stdin
 * closed). Each must terminate promptly under the headless environment instead
 * of hanging.
 *
 * The commands are real, so they are skipped when the binary is missing.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

import { buildHeadlessEnv, installEditorGuard } from "../extensions/headless-env.ts";

const PATIENCE_MS = 20_000;
const guard = installEditorGuard();

function available(binary: string): boolean {
	return spawnSync("sh", ["-c", `command -v ${binary}`], { stdio: "ignore" }).status === 0;
}

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
	elapsedMs: number;
	timedOut: boolean;
}

/** Run a command the way Pi's bash tool does, with the headless environment. */
function run(
	command: string,
	cwd: string,
	options: { headless?: boolean; baseEnv?: NodeJS.ProcessEnv } = {},
): Promise<Run> {
	const baseEnv = { ...process.env, ...options.baseEnv };
	const env =
		options.headless === false ? baseEnv : buildHeadlessEnv({ baseEnv, editorCommand: guard });

	return new Promise((resolve) => {
		const started = Date.now();
		const child = spawn("bash", ["-c", command], {
			cwd,
			env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, PATIENCE_MS);

		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, elapsedMs: Date.now() - started, timedOut });
		});
	});
}

function tempRepo(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `pi-headless-${prefix}-`));
}

function assertFastFailure(result: Run, command: string) {
	assert.equal(result.timedOut, false, `\`${command}\` hung waiting for input`);
	assert.notEqual(result.code, 0, `\`${command}\` should fail without a terminal`);
	assert.match(result.stderr, /pi-headless/, `\`${command}\` should explain why`);
}

function assertSuccess(result: Run, command: string) {
	assert.equal(result.timedOut, false, `\`${command}\` hung`);
	assert.equal(result.code, 0, `\`${command}\` failed: ${result.stderr}`);
}

const jjAvailable = available("jj");
const gitAvailable = available("git");

const jjConfig = ["--config", "user.name=Test", "--config", "user.email=test@example.com"];

/**
 * Tests must not inherit this machine's git config: a global `commit.gpgsign`
 * waits ~30s for someone to touch a hardware key, which is a different hang.
 */
const gitEnv: NodeJS.ProcessEnv = {
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: "commit.gpgsign",
	GIT_CONFIG_VALUE_0: "false",
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

before(() => {
	assert.ok(guard.endsWith("pi-headless-editor.sh"));
});

test(
	"jj describe fails fast instead of opening nvim",
	{ skip: jjAvailable ? false : "jj not installed" },
	async () => {
		const repo = tempRepo("jj");
		spawnSync("jj", ["git", "init"], { cwd: repo, stdio: "ignore" });
		writeFileSync(join(repo, "file.txt"), "content\n");
		// --config ui.editor documents intent: even a configured editor is refused.
		spawnSync("jj", [...jjConfig, "--config", "ui.editor=nvim", "file", "track", "file.txt"], {
			cwd: repo,
			stdio: "ignore",
		});

		assertFastFailure(await run("jj describe", repo), "jj describe");
		assertFastFailure(await run("jj commit", repo), "jj commit");
	},
);

test(
	"jj commands that pass text explicitly still work",
	{ skip: jjAvailable ? false : "jj not installed" },
	async () => {
		const repo = tempRepo("jj-ok");
		spawnSync("jj", ["git", "init"], { cwd: repo, stdio: "ignore" });
		writeFileSync(join(repo, "file.txt"), "content\n");
		spawnSync("jj", ["file", "track", "file.txt"], { cwd: repo, stdio: "ignore" });

		assertSuccess(
			await run(`jj ${jjConfig.map((part) => `'${part}'`).join(" ")} describe -m 'described'`, repo),
			"jj describe -m",
		);
		assertSuccess(await run("jj log", repo), "jj log");
	},
);

test(
	"git commit and rebase -i fail fast instead of opening an editor",
	{ skip: gitAvailable ? false : "git not installed" },
	async () => {
		const repo = tempRepo("git");
		const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, env: { ...process.env, ...gitEnv }, stdio: "ignore" });

		git("init", "-q");
		writeFileSync(join(repo, "file.txt"), "one\n");
		git("add", "file.txt");

		assertFastFailure(await run("git commit", repo, { baseEnv: gitEnv }), "git commit");

		assertSuccess(await run("git commit -m 'first'", repo, { baseEnv: gitEnv }), "git commit -m");
		writeFileSync(join(repo, "file.txt"), "two\n");
		git("commit", "-qam", "second");

		assertFastFailure(await run("git rebase -i HEAD~1", repo, { baseEnv: gitEnv }), "git rebase -i");
		assertSuccess(await run("git log --oneline", repo, { baseEnv: gitEnv }), "git log");
	},
);

test(
	"a pager that would wait for a keyboard is disabled",
	{ skip: available("less") ? false : "less not installed" },
	async () => {
		const dir = tempRepo("pager");
		const result = await run("printf 'a\\nb\\nc\\n' | less", dir);
		assert.equal(result.timedOut, false, "less hung");
		assertSuccess(await run("MANPAGER=cat man less | head -1", dir), "man through cat");
	},
);

test("unpiped commands see the marker", async () => {
	const dir = tempRepo("marker");
	const result = await run('test "$PI_HEADLESS" = 1 && echo headless', dir);
	assertSuccess(result, "PI_HEADLESS check");
	assert.match(result.stdout, /headless/);
});
