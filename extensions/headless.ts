/**
 * pi-headless — make non-user-initiated shell calls headless.
 *
 * Agents hang when a shell command waits for a terminal that does not exist:
 * `jj describe` opens nvim, `git commit` opens an editor, `git rebase -i`
 * waits for one, `gh` starts a device flow, ssh asks for a passphrase. The
 * command never finishes and the tool call blocks with it.
 *
 * This extension replaces the built-in `bash` tool with the same tool plus a
 * spawn hook that rewrites the environment, so anything that would prompt fails
 * immediately with a readable message instead of waiting.
 *
 * User-initiated commands (`!` and `!!` in the TUI) are untouched: they go
 * through the `user_bash` event, which this extension never intercepts.
 */

import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildHeadlessEnv,
	HEADLESS_GUIDELINE,
	installEditorGuard,
	normalizeHeadlessConfig,
	PAGER_VARIABLES,
	EDITOR_VARIABLES,
	type HeadlessConfig,
} from "./headless-env.ts";

const DISABLED_VALUES = /^(0|off|false|no)$/i;

export default function headlessExtension(pi: ExtensionAPI) {
	// Written on first use, not at load: Pi also loads extensions for
	// invocations that never run a session (`pi --list-models`).
	let editorGuard: string | undefined;
	const getEditorGuard = () => (editorGuard ??= installEditorGuard());

	const readConfig = (): HeadlessConfig => {
		const settings = pi.getSettings() as Record<string, unknown>;
		const config = normalizeHeadlessConfig(settings.piHeadless);
		// `--no-headless` and PI_HEADLESS=0 are escape hatches for one run.
		if (pi.getFlag("no-headless") === true) return { ...config, enabled: false };
		if (DISABLED_VALUES.test(process.env.PI_HEADLESS ?? "")) return { ...config, enabled: false };
		return config;
	};

	pi.registerFlag("no-headless", {
		description: "Let agent shell commands use interactive editors, pagers and prompts",
		type: "boolean",
		default: false,
	});

	const bashTool = createBashToolDefinition(process.cwd(), {
		spawnHook: ({ command, cwd, env }) => {
			const config = readConfig();
			if (!config.enabled) return { command, cwd, env };
			return {
				command,
				cwd,
				env: buildHeadlessEnv({
					baseEnv: env,
					editorCommand: getEditorGuard(),
					overrides: config.env,
				}),
			};
		},
	});

	pi.registerTool({
		// Same name, schema and renderer as the built-in; only the environment changes.
		...bashTool,
		promptGuidelines: [...(bashTool.promptGuidelines ?? []), HEADLESS_GUIDELINE],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const config = readConfig();
			const input =
				config.enabled && params.timeout === undefined && config.timeoutSeconds > 0
					? { ...params, timeout: config.timeoutSeconds }
					: params;
			return bashTool.execute(toolCallId, input, signal, onUpdate, ctx);
		},
	});

	pi.registerCommand("headless", {
		description: "Show what pi-headless forces for agent shell commands",
		handler: async (_args, ctx) => {
			const config = readConfig();
			const overrides = Object.entries(config.env).map(
				([name, value]) => `${name}=${value === null ? "<unset>" : value}`,
			);
			const timeout = config.timeoutSeconds > 0 ? `${config.timeoutSeconds}s` : "none";

			ctx.ui.notify(
				[
					`pi-headless: ${config.enabled ? "on" : "off"}`,
					`editors: ${config.enabled ? getEditorGuard() : "inherited"} (${EDITOR_VARIABLES.join(", ")})`,
					`pagers: ${config.enabled ? "cat" : "inherited"} (${PAGER_VARIABLES.join(", ")})`,
					`prompts: ${config.enabled ? "git/ssh/gh/pip fail instead of asking" : "inherited"}`,
					`default timeout: ${timeout}`,
					`overrides: ${overrides.length > 0 ? overrides.join(" ") : "none"}`,
					"user `!` commands are never rewritten",
				].join("\n"),
				"info",
			);
		},
	});
}
