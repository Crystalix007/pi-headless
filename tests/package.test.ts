/**
 * The manifest is installed with `pnpm install --prod` when someone runs
 * `pi install <git-url>`. Any entry that pulls packages into that resolution
 * breaks the install: even a `peerDependencies` entry, which
 * `auto-install-peers=false` does not skip, drags in Pi's whole dependency
 * tree, and pnpm 12 then aborts with ERR_PNPM_IGNORED_BUILDS for build scripts
 * it refuses to run.
 *
 * Pi maps `@earendil-works/pi-*` imports at load time, so nothing needs to be
 * declared. devDependencies cover local typechecking and are never installed
 * for users.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<
	string,
	Record<string, string> | undefined
>;

test("the manifest declares no install-time dependencies", () => {
	assert.deepEqual(pkg.dependencies ?? {}, {}, "dependencies would be installed for users");
	assert.deepEqual(pkg.optionalDependencies ?? {}, {});
	assert.equal(
		pkg.peerDependencies,
		undefined,
		"a peer on @earendil-works/pi-coding-agent makes `pi install` fail with ERR_PNPM_IGNORED_BUILDS",
	);
});

test("devDependencies stay available for local typechecking", () => {
	assert.ok(pkg.devDependencies?.typescript);
	assert.ok(pkg.devDependencies["@earendil-works/pi-coding-agent"]);
});
