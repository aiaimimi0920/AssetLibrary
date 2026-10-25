const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { TextDecoder } = require("node:util");
const base = process.argv[2] || "http://127.0.0.1:54070/";
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const resources = [
	"index.html",
	...Array.from(
		html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css|svg))"/g),
		(match) => match[1],
	),
	"artwork.svg",
];
const files = [...new Set(resources)];
let checked = 0;
(async () => {
	for (const name of files) {
		const bytes = fs.readFileSync(path.join(__dirname, name));
		assert.equal(
			bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
			false,
			`${name}: BOM`,
		);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (name.endsWith(".js")) new vm.Script(text, { filename: name });
		const response = await fetch(new URL(name, base));
		assert.equal(response.status, 200, name);
		assert.deepEqual(
			Buffer.from(await response.arrayBuffer()),
			bytes,
			`${name}: served bytes`,
		);
		assert.ok(
			response.headers
				.get("content-security-policy")
				.includes("connect-src 'none'"),
		);
		checked++;
	}
	for (const name of [
		"asset-data.js",
		"asset-market.js",
		"asset-market.css",
		"app.js",
		"pages.js",
		"server.cjs",
		"verify-asset-market.cjs",
		"verify-asset-files.cjs",
	]) {
		const bytes = fs.readFileSync(path.join(__dirname, name));
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		assert.equal(
			bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
			false,
		);
		if (/\.(?:js|cjs)$/.test(name))
			new vm.Script(bytes.toString("utf8"), { filename: name });
	}
	assert.equal(
		(await fetch(new URL("asset-market.js", base), { method: "POST" })).status,
		405,
	);
	assert.equal(
		(await fetch(new URL("asset-responsive-proof.json", base))).status,
		404,
	);
	console.log(
		JSON.stringify({
			staticResources: checked,
			utf8WithoutBom: true,
			syntax: true,
			exactHttpBytes: true,
			writesRejected: true,
		}),
	);
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
