const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const allowed = new Set([
	"index.html",
	"beaver.svg",
	"tokens.css",
	"base.css",
	"market.css",
	"spaces.css",
	"dialogs.css",
	"community.css",
	"community-channels.css",
	"responsive.css",
	"game-feed.css",
	"asset-market.css",
	"data.js",
	"collections.js",
	"components.js",
	"pages.js",
	"spaces.js",
	"game-feed.js",
	"asset-data.js",
	"asset-market.js",
	"community.js",
	"community-data.js",
	"community-compose.js",
	"app.js",
	"artwork.svg",
]);
const mime = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
};
const server = http.createServer((request, response) => {
	let name;
	try {
		name =
			decodeURIComponent(
				new URL(request.url, "http://127.0.0.1").pathname,
			).slice(1) || "index.html";
	} catch {
		response.writeHead(400).end();
		return;
	}
	if (!["GET", "HEAD"].includes(request.method)) {
		response.writeHead(405).end();
		return;
	}
	if (name === "favicon.ico") {
		response.writeHead(204).end();
		return;
	}
	if (!allowed.has(name)) {
		response.writeHead(404).end();
		return;
	}
	const target = path.join(__dirname, name);
	fs.stat(target, (error, info) => {
		if (error || !info.isFile()) {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, {
			"Content-Type": mime[path.extname(name)],
			"Content-Length": info.size,
			"Cache-Control": "no-cache",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			"Content-Security-Policy":
				"default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		});
		if (request.method === "HEAD") {
			response.end();
			return;
		}
		const stream = fs.createReadStream(target);
		stream.on("error", () => response.destroy());
		response.on("close", () => stream.destroy());
		stream.pipe(response);
	});
});
server.listen(Number(process.argv[2] || 0), "127.0.0.1", () => {
	console.log(`PROTOTYPE_URL=http://127.0.0.1:${server.address().port}/`);
});
