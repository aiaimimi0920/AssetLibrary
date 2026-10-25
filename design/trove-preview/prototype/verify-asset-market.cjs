const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const handlers = {};
let info;
let focused;
let rendering = false;
const nodes = new Map();
function node(selector) {
	if (!nodes.has(selector))
		nodes.set(selector, {
			value: "",
			textContent: "",
			innerHTML: "",
			setAttribute() {},
			querySelector: node,
			querySelectorAll: () => [],
			focus() {
				focused = selector;
			},
		});
	return nodes.get(selector);
}
const context = vm.createContext({
	showInfo(title, body) {
		info = { title, body };
	},
	document: {
		addEventListener(name, callback) {
			handlers[name] = callback;
		},
		querySelector(selector) {
			if (selector === ".asset-market")
				return rendering ? node(selector) : null;
			return node(selector);
		},
	},
	window: { matchMedia: () => ({ matches: false }) },
});
for (const name of [
	"data.js",
	"collections.js",
	"asset-data.js",
	"components.js",
	"asset-market.js",
])
	vm.runInContext(
		fs.readFileSync(path.join(__dirname, name), "utf8"),
		context,
		{ filename: name },
	);
const evaluate = (source) => vm.runInContext(source, context);
const json = (source) => JSON.parse(evaluate(`JSON.stringify(${source})`));
const list = (state = {}) =>
	json(
		`assetMarketList({...assetMarketDefaults(),...${JSON.stringify(state)}}).map(item => item.id)`,
	);
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
function click(dataset = {}, attribute = "") {
	const button = {
		dataset,
		closest: () => ({}),
		hasAttribute: (name) => name === attribute,
	};
	handlers.click({ target: { closest: () => button } });
}
check("fixture count and references", () => {
	assert.equal(evaluate("assetEntries.length"), 13);
	assert.equal(evaluate("assetRequests.length"), 6);
	assert.equal(
		evaluate("assetEntries.every(item => item.product?.id === item.id)"),
		true,
	);
});
check("unique ids", () =>
	assert.equal(
		evaluate(
			"new Set(products.map(item => item.id)).size === products.length && new Set(assetRequests.map(item => item.id)).size === assetRequests.length",
		),
		true,
	),
);
check("all category references valid", () =>
	assert.equal(
		evaluate(
			"[...assetEntries,...assetRequests].every(item => assetCategories.some(category => category.id === item.category))",
		),
		true,
	),
);
for (const category of [
	"models",
	"images",
	"materials",
	"audio",
	"effects",
	"templates",
])
	check(`category ${category}`, () => assert.ok(list({ category }).length > 0));
check("free", () => assert.equal(list({ price: "free" }).length, 3));
check("paid under 50 excludes free", () =>
	assert.equal(
		evaluate(
			"assetMarketList({...assetMarketDefaults(),price:'under50'}).every(item => item.product.price > 0 && item.product.price <= 50)",
		),
		true,
	),
);
check("paid over 50", () => assert.equal(list({ price: "over50" }).length, 3));
check("commercial excludes personal", () =>
	assert.equal(list({ commercial: true }).includes("paper-icons"), false),
);
check("personal remains discoverable", () =>
	assert.ok(list().includes("paper-icons")),
);
check("format filter", () =>
	assert.deepEqual(list({ format: "SVG" }), ["paper-icons"]),
);
check("software filter", () =>
	assert.deepEqual(list({ software: "FrameLab" }), ["cinema-presets"]),
);
check("style filter", () =>
	assert.deepEqual(list({ style: "像素" }), ["pixel-ui", "forest-tiles"]),
);
check("combined filters", () =>
	assert.deepEqual(
		list({
			category: "images",
			format: "PNG",
			software: "Godot",
			style: "像素",
			price: "free",
			commercial: true,
		}),
		["pixel-ui"],
	),
);
check("case insensitive multiword", () =>
	assert.deepEqual(list({ q: "pixel pNg GoDoT" }), ["pixel-ui"]),
);
check("creator search", () =>
	assert.deepEqual(list({ q: "纸上花园" }), ["paper-icons"]),
);
check("empty search", () =>
	assert.deepEqual(list({ q: "没有这个演示素材" }), []),
);
check("requests budget below 1000", () =>
	assert.deepEqual(list({ mode: "requests", price: "under1000" }), [
		"sound-request",
	]),
);
check("requests budget 1000 to 5000", () =>
	assert.equal(list({ mode: "requests", price: "1000to5000" }).length, 4),
);
check("requests budget above 5000", () =>
	assert.deepEqual(list({ mode: "requests", price: "over5000" }), [
		"magic-request",
	]),
);
check("exact price boundaries", () => {
	evaluate(
		"const savedPrice = assetEntries[0].product.price; assetEntries[0].product.price = 50",
	);
	assert.ok(list({ price: "under50" }).includes("modular-city"));
	assert.equal(list({ price: "over50" }).includes("modular-city"), false);
	evaluate("assetEntries[0].product.price = savedPrice");
});
check("exact budget boundaries", () => {
	evaluate(
		"const savedBudget = assetRequests[0].budget; assetRequests[0].budget = 1000",
	);
	assert.equal(
		list({ mode: "requests", price: "under1000" }).includes("forest-request"),
		false,
	);
	assert.ok(
		list({ mode: "requests", price: "1000to5000" }).includes("forest-request"),
	);
	evaluate("assetRequests[0].budget = 5000");
	assert.ok(
		list({ mode: "requests", price: "1000to5000" }).includes("forest-request"),
	);
	assert.equal(
		list({ mode: "requests", price: "over5000" }).includes("forest-request"),
		false,
	);
	evaluate("assetRequests[0].budget = savedBudget");
});
check("ascending and descending without source mutation", () => {
	const before = list();
	for (const mode of ["market", "requests"])
		for (const sort of ["low", "high"])
			assert.equal(
				evaluate(
					`assetMarketList({...assetMarketDefaults(),mode:'${mode}',sort:'${sort}'}).map(item => item.budget ?? item.product.price).every((value,index,values) => !index || ${sort === "low" ? "value >= values[index-1]" : "value <= values[index-1]"})`,
				),
				true,
			);
	assert.deepEqual(list(), before);
});
check("newest reverses source order only", () =>
	assert.deepEqual(list({ sort: "newest" }), list().reverse()),
);
check("page has search filters and two publication entries", () => {
	const html = evaluate("assetMarketPage('<svg>')");
	assert.ok(html.includes('id="asset-search-form"'));
	assert.ok(html.includes('data-am-login="sell"'));
	assert.ok(html.includes('data-am-login="request"'));
	assert.ok(html.includes("&lt;svg&gt;"));
	assert.equal(html.includes('value="<svg>"'), false);
});
check("mode switch clears inapplicable filters", () => {
	evaluate(
		"assetMarketState = {...assetMarketDefaults(), q:'PNG', category:'images', software:'FrameLab', format:'LUT', style:'写实', commercial:true, price:'free', sort:'high', page:2}",
	);
	click({ amMode: "requests" });
	assert.deepEqual(json("assetMarketState"), {
		...json("assetMarketDefaults()"),
		mode: "requests",
		q: "PNG",
		category: "images",
	});
});
check("reset retains current mode and restores focus", () => {
	click({}, "data-am-reset");
	assert.deepEqual(json("assetMarketState"), {
		...json("assetMarketDefaults()"),
		mode: "requests",
	});
	assert.equal(focused, "#asset-query");
});
check("chip clears and restores focus", () => {
	evaluate("assetMarketState.q = 'abc'");
	click({ amClear: "q" });
	assert.equal(evaluate("assetMarketState.q"), "");
	assert.equal(focused, "#asset-query");
});
check("search submit trims and bounds input", () => {
	node("#asset-query").value = `  ${"a".repeat(100)}  `;
	let prevented = false;
	handlers.submit({
		target: { id: "asset-search-form" },
		preventDefault() {
			prevented = true;
		},
	});
	assert.ok(prevented);
	assert.equal(evaluate("assetMarketState.q.length"), 80);
});
for (const [intent, title] of [
	["sell", "发布素材"],
	["request", "发布求购"],
	["respond", "提交方案"],
])
	check(`login gate ${intent}`, () => {
		click({ amLogin: intent });
		assert.equal(info.title, `请先登录后${title}`);
		assert.ok(info.body.includes("尚未接入账号"));
	});
check("request detail provides delivery and licensing", () => {
	click({ amRequest: "forest-request" });
	assert.ok(info.body.includes("交付内容"));
	assert.ok(info.body.includes("授权要求"));
	assert.ok(info.body.includes('data-am-login="respond"'));
	assert.ok(info.body.includes("不存在真实委托"));
});
rendering = true;
check("pagination clamps and renders last page", () => {
	evaluate(
		"assetMarketState = {...assetMarketDefaults(),page:99}; updateAssetMarket()",
	);
	assert.equal(evaluate("assetMarketState.page"), 2);
	assert.equal(
		(node("#asset-results").innerHTML.match(/class="am-product"/g) || [])
			.length,
		4,
	);
	assert.ok(node(".am-pagination").innerHTML.includes("2 / 2"));
});
check("empty state removes obsolete pagination", () => {
	evaluate("assetMarketState.q = '空结果'; updateAssetMarket()");
	assert.equal(evaluate("assetMarketState.page"), 1);
	assert.ok(node("#asset-results").innerHTML.includes("没有匹配的素材"));
	assert.equal(node(".am-pagination").innerHTML, "");
});
check("request sort uses budget labels", () => {
	evaluate(
		"assetMarketState = {...assetMarketDefaults(),mode:'requests'}; updateAssetMarket(true)",
	);
	assert.equal(node('[value="low"]').textContent, "预算从低到高");
	assert.equal(node('[value="high"]').textContent, "预算从高到低");
});
check("no storage network telemetry", () => {
	const source = fs.readFileSync(
		path.join(__dirname, "asset-market.js"),
		"utf8",
	);
	assert.equal(
		/localStorage|sessionStorage|fetch\(|sendBeacon|XMLHttpRequest/.test(
			source,
		),
		false,
	);
});
console.log(
	JSON.stringify({
		passed,
		kind: "asset-market-unit-contract",
		prototypeOnly: true,
	}),
);
