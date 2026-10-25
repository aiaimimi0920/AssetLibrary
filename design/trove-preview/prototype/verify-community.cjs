const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const handlers = {};
const nodes = new Map();
let info;
let opened;
function node(selector) {
	if (!nodes.has(selector))
		nodes.set(selector, {
			value: "",
			checked: true,
			innerHTML: "",
			textContent: "",
			validation: "",
			reset() {},
			focus() {},
			setAttribute() {},
			reportValidity() {},
			setCustomValidity(message) {
				this.validation = message;
			},
			addEventListener(name, callback) {
				this[name] = callback;
			},
		});
	return nodes.get(selector);
}
const context = vm.createContext({
	document: {
		addEventListener(name, callback) {
			(handlers[name] ||= []).push(callback);
		},
		querySelector: node,
		querySelectorAll: () => [],
	},
	openDialog(dialog) {
		opened = dialog;
	},
	showInfo(title, body) {
		info = { title, body };
	},
});
for (const name of [
	"data.js",
	"collections.js",
	"components.js",
	"community-data.js",
	"community.js",
	"community-compose.js",
])
	vm.runInContext(
		fs.readFileSync(path.join(__dirname, name), "utf8"),
		context,
		{ filename: name },
	);
const evaluate = (source) => vm.runInContext(source, context);
const json = (source) => JSON.parse(evaluate(`JSON.stringify(${source})`));
let passed = 0;
function check(name, callback) {
	try {
		callback();
		passed++;
	} catch (error) {
		error.message = `${name}: ${error.message}`;
		throw error;
	}
}
function click(dataset, attribute) {
	const button = {
		dataset,
		isConnected: true,
		hasAttribute: (name) => name === attribute,
	};
	for (const callback of handlers.click)
		callback({ target: { closest: () => button } });
}
check("ten channels with unique ids", () => {
	assert.equal(evaluate("communityChannels.length"), 10);
	assert.equal(
		evaluate("new Set(communityChannels.map(channel => channel.id)).size"),
		10,
	);
});
check("every game has its own channel", () =>
	assert.equal(
		evaluate(
			"products.filter(product => product.type === 'game').every(product => communityChannel(product.id)?.kind === 'game')",
		),
		true,
	),
);
check("four interest channels", () =>
	assert.equal(
		evaluate(
			"communityChannels.filter(channel => channel.kind === 'interest').length",
		),
		4,
	),
);
check("post and reply references", () =>
	assert.equal(
		evaluate(
			"communityPosts.every(post => communityChannel(post.channel)) && communityReplies.every(reply => communityPosts.some(post => post.id === reply.post))",
		),
		true,
	),
);
check("post ids unique", () =>
	assert.equal(
		evaluate(
			"new Set(communityPosts.map(post => post.id)).size === communityPosts.length",
		),
		true,
	),
);
check("plaza includes multiple channels", () =>
	assert.ok(
		evaluate("new Set(communityList().map(post => post.channel)).size") > 5,
	),
);
check("channel-only posts do not leak into plaza", () =>
	assert.equal(evaluate("communityList().some(post => !post.plaza)"), false),
);
for (const channel of json("communityChannels.map(channel => channel.id)"))
	check(`channel isolation ${channel}`, () => {
		const posts = json(
			`communityList({mode:'channel',channel:'${channel}',filter:'all',q:''})`,
		);
		assert.ok(posts.length);
		assert.ok(posts.every((post) => post.channel === channel));
	});
check("channel includes its non-plaza discussions", () =>
	assert.equal(
		evaluate(
			"communityList({mode:'channel',channel:'star-game',filter:'all',q:''}).some(post => post.id === 'star-route')",
		),
		true,
	),
);
for (const kind of ["share", "discussion", "guide", "creation"])
	check(`post kind ${kind}`, () =>
		assert.equal(
			evaluate(
				`communityList({mode:'plaza',channel:null,filter:'${kind}',q:''}).every(post => post.kind === '${kind}')`,
			),
			true,
		),
	);
check("multiword search", () =>
	assert.deepEqual(
		json(
			"communityList({mode:'plaza',filter:'all',q:'六种 颜色'}).map(post => post.id)",
		),
		["pixel-evening"],
	),
);
check("plaza rendering and link semantics", () => {
	const html = evaluate("communityPage()");
	assert.ok(html.includes('href="#community/channels"'));
	assert.ok(html.includes('href="#community/channel/garden-game"'));
	assert.ok(html.includes("10 篇示例"));
});
check("directory resets state", () => {
	evaluate("communityDirectoryKind = 'interest'; communityPage('channels')");
	assert.equal(evaluate("communityDirectoryKind"), "all");
	assert.equal(evaluate("communityView.mode"), "directory");
});
check("invalid channel falls back safely", () => {
	evaluate("communityPage('channel','does-not-exist')");
	assert.equal(evaluate("communityView.mode"), "plaza");
});
check("game channel has game detail entry", () =>
	assert.ok(
		evaluate("communityPage('channel','star-game')").includes(
			'data-product="star-game"',
		),
	),
);
check("interest channel has no fake game entry", () =>
	assert.equal(
		evaluate("communityPage('channel','pixel-art')").includes(">游戏详情"),
		false,
	),
);
check("directory interest filtering", () => {
	click({ channelKind: "interest" });
	assert.equal(
		(
			node("#community-channel-grid").innerHTML.match(
				/class="cc-channel-card"/g,
			) || []
		).length,
		4,
	);
});
check("directory search and empty state", () => {
	node("#channel-query").value = "像素";
	evaluate("updateCommunityDirectory()");
	assert.equal(
		(
			node("#community-channel-grid").innerHTML.match(
				/class="cc-channel-card"/g,
			) || []
		).length,
		1,
	);
	node("#channel-query").value = "不存在的频道";
	evaluate("updateCommunityDirectory()");
	assert.ok(
		node("#community-channel-grid").innerHTML.includes("没有找到这个频道"),
	);
});
check("bookmarks remain page-local toggles", () => {
	click({ bookmark: "island-light" });
	assert.ok(evaluate("communityBookmarks.has('island-light')"));
	click({ bookmark: "island-light" });
	assert.equal(evaluate("communityBookmarks.has('island-light')"), false);
});
check("discussion renders comments and login reply entry", () => {
	evaluate("openCommunityPost('star-route')");
	assert.equal(opened, node("#community-dialog"));
	assert.equal(
		(node("#community-post-content").innerHTML.match(/class="cc-reply"/g) || [])
			.length,
		2,
	);
	assert.ok(node("#community-post-content").innerHTML.includes("登录后回复"));
});
check("composer preselects channel", () => {
	evaluate("openCommunityComposer('star-game')");
	assert.equal(node("#share-channel").value, "star-game");
	assert.equal(opened, node("#share-dialog"));
});
check("composer rejects invalid channel and whitespace", () => {
	node("#share-channel").value = "invalid";
	assert.equal(evaluate("communityDraft()"), null);
	assert.equal(node("#share-channel").validation, "请选择一个频道。");
	node("#share-channel").value = "pixel-art";
	node("#share-name").value = "   ";
	assert.equal(evaluate("communityDraft()"), null);
	assert.equal(node("#share-name").validation, "请输入帖子标题。");
});
check("preview escapes input and never inserts post", () => {
	const before = evaluate("communityPosts.length");
	node("#share-name").value = "<b>标题</b>";
	node("#share-body").value = '<img src=x onerror="bad()">';
	node("#share-plaza").checked = false;
	node("#share-form").submit({ preventDefault() {} });
	assert.ok(info.body.includes("&lt;b&gt;"));
	assert.equal(info.body.includes("<img src=x"), false);
	assert.ok(info.body.includes("仅在频道展示"));
	assert.equal(evaluate("communityPosts.length"), before);
});
check("plaza share option is reflected in preview", () => {
	node("#share-plaza").checked = true;
	node("#share-form").submit({ preventDefault() {} });
	assert.ok(info.body.includes("同时分享到广场"));
});
check("publish gates on login", () => {
	click({}, "data-community-publish");
	assert.equal(info.title, "请先登录后发帖");
});
check("reply gates on login", () => {
	for (const callback of handlers.submit)
		callback({ target: { id: "community-reply-form" }, preventDefault() {} });
	assert.equal(info.title, "请先登录后回复");
});
check("no storage network telemetry", () => {
	for (const name of ["community.js", "community-compose.js"])
		assert.equal(
			/localStorage|sessionStorage|fetch\(|sendBeacon|XMLHttpRequest/.test(
				fs.readFileSync(path.join(__dirname, name), "utf8"),
			),
			false,
		);
});
console.log(
	JSON.stringify({
		passed,
		prototypeOnly: true,
		kind: "community-channels-unit-contract",
	}),
);
