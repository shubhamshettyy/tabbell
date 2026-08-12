import { camelCase } from "scule";
//#region src/core/utils/strings.ts
function kebabCaseAlphanumeric(str) {
	return str.toLowerCase().replace(/[^a-z0-9-\s]/g, "").replace(/\s+/g, "-");
}
/** Return a safe variable name for a given string. */
function safeVarName(str) {
	const name = camelCase(kebabCaseAlphanumeric(str));
	if (name.match(/^[a-z]/)) return name;
	return "_" + name;
}
/**
* Converts a string to a valid filename (NOT path), stripping out invalid
* characters.
*/
function safeFilename(str) {
	return kebabCaseAlphanumeric(str);
}
//#endregion
export { safeFilename, safeVarName };
