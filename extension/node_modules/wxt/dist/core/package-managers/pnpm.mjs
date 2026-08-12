import { flattenNpmListOutput, npm } from "./npm.mjs";
import spawn from "nano-spawn";
//#region src/core/package-managers/pnpm.ts
const pnpm = {
	overridesKey: "resolutions",
	downloadDependency(...args) {
		return npm.downloadDependency(...args);
	},
	async listDependencies(options) {
		const args = [
			"ls",
			"-r",
			"--json"
		];
		if (options?.all) args.push("--depth", "Infinity");
		if (typeof process !== "undefined" && process.env.WXT_PNPM_IGNORE_WORKSPACE === "true") args.push("--ignore-workspace");
		const res = await spawn("pnpm", args, { cwd: options?.cwd });
		return flattenNpmListOutput(JSON.parse(res.stdout));
	}
};
//#endregion
export { pnpm };
