import { dedupeDependencies, npm } from "./npm.mjs";
import spawn from "nano-spawn";
//#region src/core/package-managers/bun.ts
const bun = {
	overridesKey: "overrides",
	downloadDependency(...args) {
		return npm.downloadDependency(...args);
	},
	async listDependencies(options) {
		const args = ["pm", "ls"];
		if (options?.all) args.push("--all");
		return dedupeDependencies((await spawn("bun", args, { cwd: options?.cwd })).stdout.split("\n").slice(1).map((line) => line.trim()).map((line) => /.* (@?\S+)@(\S+)$/.exec(line)).filter((match) => !!match).map(([_, name, version]) => ({
			name,
			version
		})));
	}
};
//#endregion
export { bun };
