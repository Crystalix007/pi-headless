/**
 * Environment plumbing and editor guard for pi-headless.
 *
 * No Pi imports live here on purpose: the policy is plain data plus pure
 * functions, so it can be exercised directly with `node --test` (see
 * `tests/headless-env.test.ts`). The extension entry point in `headless.ts`
 * does the wiring.
 *
 * Why this exists: Pi runs agent shell commands without a TTY. Any program that
 * insists on a terminal — an editor, a pager, a credential prompt — then waits
 * forever for input that never arrives, and the agent hangs with it. Every
 * variable below turns one of those hangs into an immediate, readable failure.
 */

import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Marker set on every headless command so scripts can detect a non-interactive run. */
export const HEADLESS_MARKER = "PI_HEADLESS";

/** Editor variables, in the order tools consult them. */
export const EDITOR_VARIABLES = [
	"EDITOR", // the generic fallback almost everything honours
	"VISUAL", // many tools prefer VISUAL over EDITOR
	"GIT_EDITOR", // git commit --amend, git rebase, git tag -a
	"GIT_SEQUENCE_EDITOR", // git rebase -i, git add -p
	"JJ_EDITOR", // jj's own preference, ahead of VISUAL and EDITOR
	"SUDO_EDITOR", // sudoedit, crontab -e
] as const;

/** Pager variables; a pager without a TTY reads a keyboard that is not there. */
export const PAGER_VARIABLES = [
	"PAGER", // the generic fallback
	"GIT_PAGER",
	"MANPAGER",
	"GH_PAGER", // gh
	"SYSTEMD_PAGER", // systemctl, journalctl
	"BAT_PAGER",
] as const;

/**
 * The script installed as every editor variable. It fails instead of waiting
 * for a keyboard, and tells the model how to do the same thing explicitly.
 */
export const EDITOR_GUARD_SCRIPT = `#!/bin/sh
# Installed by the pi-headless Pi extension.
#
# Pi runs agent shell commands without a TTY, so an editor that waits for
# keyboard input blocks until the command is killed. Fail loudly instead.
printf '%s\\n' \\
	'pi-headless: refusing to open an interactive editor.' \\
	'Agent shell commands run without a TTY. Pass the text explicitly instead' \\
	"(e.g. jj describe -m 'msg', git commit -m 'msg', jj commit -m 'msg'), or" \\
	'start Pi with --no-headless if an editor is really intended here.' >&2
exit 1
`;

/** Appended to the bash tool's system-prompt guidelines. */
export const HEADLESS_GUIDELINE =
	"Shell commands run without a TTY: editors, pagers and credential prompts fail immediately instead of waiting. Pass text explicitly (-m, --stdin) and prefer non-interactive flags (-y, --no-pager, --batch) over relying on a prompt.";

export type EnvOverride = string | null;

export interface HeadlessEnvOptions {
	/** Environment the command would otherwise inherit. */
	baseEnv?: NodeJS.ProcessEnv;
	/** Command installed for every editor variable. Defaults to `false`. */
	editorCommand?: string;
	/** User overrides: a string sets a variable, `null` removes one. */
	overrides?: Readonly<Record<string, EnvOverride>>;
}

/**
 * Variables forced for every headless command, before user overrides.
 *
 * `CI` is deliberately absent: tools such as Jest and Vitest change behaviour
 * (new snapshots stop being written) when they see it, so headless-by-default
 * must not alter commands that would otherwise have succeeded. Add it through
 * configuration when that trade-off is wanted.
 */
export function headlessEnvDefaults(
	editorCommand: string,
	baseEnv: NodeJS.ProcessEnv = {},
): Record<string, string> {
	const env: Record<string, string> = {
		[HEADLESS_MARKER]: "1",

		// Credentials: fail rather than ask somebody who is not watching.
		GIT_TERMINAL_PROMPT: "0",
		GIT_SSH_COMMAND: withBatchMode(baseEnv.GIT_SSH_COMMAND),
		SSH_ASKPASS_REQUIRE: "never", // no GUI askpass fallback either
		GH_PROMPT_DISABLED: "1", // gh auth login would sit in a device flow
		PIP_NO_INPUT: "1", // pip aborts instead of prompting
		npm_config_yes: "true", // npx/npm install confirmations
		DEBIAN_FRONTEND: "noninteractive", // apt/dpkg debconf
		GIT_MERGE_AUTOEDIT: "no", // git merge never opens an editor

		// Pagers: a page of output is unreadable in a transcript anyway.
		AWS_PAGER: "", // the aws cli treats an empty value as "no pager"

		// Editors: never launch a keyboard UI.
		SUDO_EDITOR: editorCommand,
	};

	for (const name of PAGER_VARIABLES) {
		env[name] = "cat";
	}
	for (const name of EDITOR_VARIABLES) {
		env[name] = editorCommand;
	}
	return env;
}

/**
 * Merge defaults and user overrides over a base environment.
 *
 * Precedence, lowest first: inherited environment, headless defaults, user
 * overrides. Defaults beat the inherited environment (a `PAGER=less` in the
 * shell must not survive), and an override of `null` removes a variable.
 */
export function buildHeadlessEnv(options: HeadlessEnvOptions = {}): NodeJS.ProcessEnv {
	const { baseEnv = {}, editorCommand = "false", overrides = {} } = options;
	const resolved = headlessEnvDefaults(editorCommand, baseEnv);

	for (const [name, value] of Object.entries(overrides)) {
		if (value === null) {
			delete resolved[name];
		} else {
			resolved[name] = value;
		}
	}

	return { ...baseEnv, ...resolved };
}

/** Append `-o BatchMode=yes` so ssh fails instead of prompting for a secret. */
export function withBatchMode(sshCommand: string | undefined): string {
	const command = sshCommand?.trim() ?? "";
	if (command === "") return "ssh -o BatchMode=yes";
	if (/\bBatchMode\b/.test(command)) return command;
	return `${command} -o BatchMode=yes`;
}

/**
 * Write the editor guard and return its path. Atomic, so two Pi sessions
 * starting at once cannot leave a half-written script behind.
 */
export function installEditorGuard(dir: string = tmpdir()): string {
	const scriptPath = join(dir, "pi-headless-editor.sh");
	const tempPath = `${scriptPath}.${process.pid}.tmp`;
	writeFileSync(tempPath, EDITOR_GUARD_SCRIPT, { mode: 0o755 });
	renameSync(tempPath, scriptPath);
	return scriptPath;
}

export interface HeadlessConfig {
	/** Whether agent shell commands are made headless. */
	enabled: boolean;
	/** Extra or overriding environment variables; `null` removes one. */
	env: Record<string, EnvOverride>;
	/** Timeout in seconds for commands that set none. 0 disables it. */
	timeoutSeconds: number;
}

export const DEFAULT_CONFIG: HeadlessConfig = { enabled: true, env: {}, timeoutSeconds: 0 };

/**
 * Read the `piHeadless` settings object defensively. Settings files are edited
 * by hand, so anything unexpected falls back to the default rather than
 * disabling the extension or throwing at spawn time.
 */
export function normalizeHeadlessConfig(
	raw: unknown,
	fallback: HeadlessConfig = DEFAULT_CONFIG,
): HeadlessConfig {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback;
	const input = raw as Record<string, unknown>;

	const enabled = typeof input.enabled === "boolean" ? input.enabled : fallback.enabled;
	const timeoutSeconds =
		typeof input.timeoutSeconds === "number" &&
		Number.isFinite(input.timeoutSeconds) &&
		input.timeoutSeconds > 0
			? input.timeoutSeconds
			: fallback.timeoutSeconds;

	const env: Record<string, EnvOverride> = {};
	if (typeof input.env === "object" && input.env !== null && !Array.isArray(input.env)) {
		for (const [name, value] of Object.entries(input.env as Record<string, unknown>)) {
			if (value === null) {
				env[name] = null;
			} else if (typeof value === "string") {
				env[name] = value;
			} else if (typeof value === "number" || typeof value === "boolean") {
				env[name] = String(value);
			}
		}
	}

	return { enabled, env: { ...fallback.env, ...env }, timeoutSeconds };
}
