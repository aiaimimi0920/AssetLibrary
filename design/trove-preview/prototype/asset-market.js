const assetMarketDefaults = () => ({
	mode: "market",
	category: "all",
	q: "",
	price: "all",
	format: "all",
	software: "all",
	style: "all",
	commercial: false,
	sort: "recommended",
	page: 1,
});
let assetMarketState = assetMarketDefaults();
const assetPageSize = 9;
const assetPriceOptions = {
	market: [
		["all", "不限价格"],
		["free", "免费"],
		["under50", "¥1–50"],
		["over50", "¥50 以上"],
	],
	requests: [
		["all", "不限预算"],
		["under1000", "¥1,000 以下"],
		["1000to5000", "¥1,000–5,000"],
		["over5000", "¥5,000 以上"],
	],
};

function assetMarketList(state = assetMarketState) {
	const requests = state.mode === "requests";
	const source = requests ? assetRequests : assetEntries;
	const words = state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const list = source.filter((item) => {
		const amount = requests ? item.budget : item.product.price;
		if (state.category !== "all" && item.category !== state.category)
			return false;
		if (state.format !== "all" && !item.formats.includes(state.format))
			return false;
		if (state.software !== "all" && !item.software.includes(state.software))
			return false;
		if (state.style !== "all" && item.style !== state.style) return false;
		if (!requests && state.commercial && item.license !== "commercial")
			return false;
		if (state.price === "free" && amount !== 0) return false;
		if (state.price === "under50" && !(amount > 0 && amount <= 50))
			return false;
		if (state.price === "over50" && amount <= 50) return false;
		if (state.price === "under1000" && amount >= 1000) return false;
		if (state.price === "1000to5000" && !(amount >= 1000 && amount <= 5000))
			return false;
		if (state.price === "over5000" && amount <= 5000) return false;
		const text =
			`${requests ? `${item.title} ${item.requester} ${item.description}` : `${item.product.name} ${item.product.subtitle} ${item.product.creator}`} ${item.formats.join(" ")} ${item.software.join(" ")} ${item.style}`.toLowerCase();
		return words.every((word) => text.includes(word));
	});
	if (state.sort === "low" || state.sort === "high")
		list.sort(
			(a, b) =>
				((requests ? a.budget : a.product.price) -
					(requests ? b.budget : b.product.price)) *
				(state.sort === "low" ? 1 : -1),
		);
	if (state.sort === "newest") list.reverse();
	return list;
}

function assetSelect(name, label, values) {
	return `<label class="am-select-label">${label}<select data-am-filter="${name}" aria-label="${label}"><option value="all">不限</option>${values.map((value) => `<option ${assetMarketState[name] === value ? "selected" : ""} value="${esc(value)}">${esc(value)}</option>`).join("")}</select></label>`;
}

function assetFilters() {
	const source =
		assetMarketState.mode === "requests" ? assetRequests : assetEntries;
	const values = (key) =>
		[...new Set(source.flatMap((item) => item[key]))].sort();
	return `<fieldset><legend>${assetMarketState.mode === "requests" ? "项目预算" : "价格范围"}</legend>${assetPriceOptions[assetMarketState.mode].map(([value, label]) => `<label class="am-radio"><input type="radio" name="asset-price" data-am-filter="price" value="${value}" ${assetMarketState.price === value ? "checked" : ""}>${label}</label>`).join("")}</fieldset>
		${assetSelect("format", "文件格式", values("formats"))}${assetSelect("software", "适用软件", values("software"))}${assetSelect("style", "视觉风格", values("style"))}
		${assetMarketState.mode === "market" ? `<label class="am-checkbox"><input type="checkbox" data-am-filter="commercial" ${assetMarketState.commercial ? "checked" : ""}>仅看可商用</label>` : ""}<button class="am-reset" data-am-reset>重置筛选</button>`;
}

function assetMarketPage(query = "") {
	assetMarketState = { ...assetMarketDefaults(), q: query };
	return `<section class="asset-market" aria-labelledby="asset-title"><header class="am-header"><div><span class="am-overline">TROVE / ASSETS</span><h1 id="asset-title">素材</h1></div><div class="am-publish-actions"><button class="button secondary" data-am-login="request">发布求购</button><button class="button primary" data-am-login="sell">发布素材 ↗</button></div></header>
		<div class="am-discovery"><div class="am-modes" aria-label="素材交易栏目"><button data-am-mode="market" aria-pressed="true">素材市场</button><button data-am-mode="requests" aria-pressed="false">求购广场</button></div><form id="asset-search-form" class="am-search" role="search"><span aria-hidden="true">⌕</span><input id="asset-query" type="search" maxlength="80" aria-label="搜索素材或求购" value="${esc(query)}" placeholder="搜索素材、格式、创作者…"><button type="submit">搜索</button></form></div>
		<nav class="am-categories" aria-label="素材分类">${assetCategories.map((category) => `<button data-am-category="${category.id}" aria-pressed="${category.id === "all"}">${icon(category.icon)}<span>${category.label}</span><small data-am-category-count="${category.id}"></small></button>`).join("")}</nav>
		<div class="am-layout"><aside class="am-sidebar"><details class="am-filter-panel" ${window.matchMedia("(max-width: 850px)").matches ? "" : "open"}><summary>筛选 <span>＋</span></summary><div class="am-filters">${assetFilters()}</div></details><div class="am-side-request"><span>找不到合适的？</span><button data-am-login="request">发个求购 ↗</button></div></aside>
		<div class="am-main"><div class="am-results-toolbar"><h2 id="am-result-count" tabindex="-1" aria-live="polite"></h2><label>排序 <select id="asset-sort" aria-label="素材排序"><option value="recommended">默认排序</option><option value="newest">最新示例</option><option value="low">价格从低到高</option><option value="high">价格从高到低</option></select></label></div><div class="am-active-filters"></div><div id="asset-results"></div><nav class="am-pagination" aria-label="素材结果分页"></nav><p class="am-demo-note">商品、需求与价格均为布局示例</p></div></div></section>`;
}

function assetMarketCard(entry) {
	const product = entry.product;
	const category = assetCategories.find((item) => item.id === entry.category);
	return `<article class="am-product"><button class="am-product-cover" data-product="${product.id}" aria-label="查看 ${esc(product.name)}">${art(product.art, `${product.name} · 概念封面`)}<span class="am-product-category">${category.label}</span><span class="am-cover-action">查看素材 ↗</span></button><div class="am-product-body"><div class="am-product-heading"><h3><button data-product="${product.id}">${esc(product.name)}</button></h3><strong class="${product.price ? "" : "am-free"}">${price(product)}</strong></div><p>${esc(product.creator)}</p><div class="am-product-meta"><span>${esc(entry.formats.slice(0, 2).join(" / "))}</span><span>${entry.license === "commercial" ? "可商用" : "个人使用"}</span></div></div></article>`;
}

function assetRequestCard(request) {
	const category = assetCategories.find((item) => item.id === request.category);
	return `<article class="am-request"><div class="am-request-top"><span>${category.label}</span><strong>${request.range}</strong></div><h3><button data-am-request="${request.id}">${esc(request.title)}</button></h3><p>${esc(request.description)}</p><div class="am-request-tags"><span>${esc(request.style)}</span>${request.formats.map((format) => `<span>${format}</span>`).join("")}<span>${esc(request.software.join(" / "))}</span></div><footer><span>${esc(request.requester)} <small>· 示例</small><br><small>交付周期 ${request.period}</small></span><button class="button secondary" data-am-request="${request.id}">查看需求 ↗</button></footer></article>`;
}

function assetActiveFilters() {
	const state = assetMarketState;
	const chips = [];
	if (state.q) chips.push(["q", `搜索：${state.q}`]);
	if (state.category !== "all")
		chips.push([
			"category",
			assetCategories.find((item) => item.id === state.category).label,
		]);
	if (state.price !== "all")
		chips.push([
			"price",
			assetPriceOptions[state.mode].find(([value]) => value === state.price)[1],
		]);
	for (const key of ["format", "software", "style"])
		if (state[key] !== "all") chips.push([key, state[key]]);
	if (state.commercial) chips.push(["commercial", "可商用"]);
	return chips
		.map(
			([key, label]) =>
				`<button data-am-clear="${key}" aria-label="清除${esc(label)}">${esc(label)} <span>×</span></button>`,
		)
		.join("");
}

function updateAssetMarket(rebuildFilters = false) {
	const root = document.querySelector(".asset-market");
	if (!root) return;
	const state = assetMarketState;
	const list = assetMarketList();
	const pages = Math.max(1, Math.ceil(list.length / assetPageSize));
	state.page = Math.min(Math.max(1, state.page), pages);
	root.querySelector("#am-result-count").textContent =
		`${list.length} ${state.mode === "requests" ? "项求购需求" : "件素材"}`;
	root.querySelector("#asset-results").className =
		state.mode === "requests" ? "am-request-list" : "am-product-grid";
	root.querySelector("#asset-results").innerHTML = list.length
		? list
				.slice((state.page - 1) * assetPageSize, state.page * assetPageSize)
				.map(state.mode === "requests" ? assetRequestCard : assetMarketCard)
				.join("")
		: `<div class="am-empty"><span>⌕</span><h3>没有匹配的${state.mode === "requests" ? "需求" : "素材"}</h3><p>调整关键词，或放宽筛选条件。</p><button class="button secondary" data-am-reset>清除筛选</button></div>`;
	root.querySelector(".am-active-filters").innerHTML = assetActiveFilters();
	root.querySelector(".am-pagination").innerHTML =
		pages > 1
			? `<button data-am-page="${state.page - 1}" ${state.page === 1 ? "disabled" : ""} aria-label="上一页素材">←</button><span>${state.page} / ${pages}</span><button data-am-page="${state.page + 1}" ${state.page === pages ? "disabled" : ""} aria-label="下一页素材">→</button>`
			: "";
	for (const button of root.querySelectorAll("[data-am-mode]"))
		button.setAttribute(
			"aria-pressed",
			String(button.dataset.amMode === state.mode),
		);
	const source = state.mode === "requests" ? assetRequests : assetEntries;
	for (const button of root.querySelectorAll("[data-am-category]")) {
		button.setAttribute(
			"aria-pressed",
			String(button.dataset.amCategory === state.category),
		);
		if (button.dataset.amCategory === "all")
			button.querySelector("span").textContent =
				state.mode === "requests" ? "全部需求" : "全部素材";
		button.querySelector("small").textContent =
			button.dataset.amCategory === "all"
				? source.length
				: source.filter((item) => item.category === button.dataset.amCategory)
						.length;
	}
	if (rebuildFilters)
		root.querySelector(".am-filters").innerHTML = assetFilters();
	root.querySelector("#asset-query").value = state.q;
	root.querySelector("#asset-query").placeholder =
		state.mode === "requests"
			? "搜索需求、风格、交付格式…"
			: "搜索素材、格式、创作者…";
	const sort = root.querySelector("#asset-sort");
	sort.value = state.sort;
	sort.setAttribute(
		"aria-label",
		state.mode === "requests" ? "求购排序" : "素材排序",
	);
	for (const [value, direction] of [
		["low", "低到高"],
		["high", "高到低"],
	])
		sort.querySelector(`[value="${value}"]`).textContent =
			`${state.mode === "requests" ? "预算" : "价格"}从${direction}`;
}

function assetLoginPrompt(intent) {
	const labels = { sell: "发布素材", request: "发布求购", respond: "提交方案" };
	if (!labels[intent]) return;
	showInfo(
		`请先登录后${labels[intent]}`,
		`<p>登录 Trove 后${labels[intent]}。</p><div class="inline-note">当前是界面原型，尚未接入账号、发布或交易服务，不会上传文件或发送需求。</div>`,
	);
}

function showAssetRequest(id) {
	const request = assetRequests.find((item) => item.id === id);
	if (!request) return;
	showInfo(
		request.title,
		`<p>${esc(request.description)}</p><dl class="detail-facts"><div><dt>项目预算</dt><dd>${request.range}（示例）</dd></div><div><dt>交付周期</dt><dd>${request.period}</dd></div><div><dt>使用环境</dt><dd>${esc(request.software.join(" / "))}</dd></div><div><dt>交付内容</dt><dd>${esc(request.delivery)}</dd></div><div><dt>授权要求</dt><dd>${esc(request.license)}</dd></div></dl><div class="inline-note">虚构需求，不存在真实委托、报价或交易。</div><button class="button secondary" data-am-login="respond">提交方案 ↗</button>`,
	);
}

document.addEventListener("submit", (event) => {
	if (event.target.id !== "asset-search-form") return;
	event.preventDefault();
	assetMarketState.q = document
		.querySelector("#asset-query")
		.value.trim()
		.slice(0, 80);
	assetMarketState.page = 1;
	updateAssetMarket();
});
document.addEventListener("change", (event) => {
	const filter = event.target.dataset.amFilter;
	if (filter)
		assetMarketState[filter] =
			filter === "commercial" ? event.target.checked : event.target.value;
	else if (event.target.id === "asset-sort")
		assetMarketState.sort = event.target.value;
	else return;
	assetMarketState.page = 1;
	updateAssetMarket();
});
document.addEventListener("click", (event) => {
	const button = event.target.closest("button");
	if (!button) return;
	if (button.dataset.amLogin) return assetLoginPrompt(button.dataset.amLogin);
	if (button.dataset.amRequest)
		return showAssetRequest(button.dataset.amRequest);
	if (!button.closest(".asset-market")) return;
	let rebuild = false;
	let restoreFocus = false;
	if (button.dataset.amMode) {
		assetMarketState = {
			...assetMarketDefaults(),
			mode: button.dataset.amMode,
			q: assetMarketState.q,
			category: assetMarketState.category,
		};
		rebuild = true;
	} else if (button.dataset.amCategory)
		assetMarketState.category = button.dataset.amCategory;
	else if (button.hasAttribute("data-am-reset")) {
		assetMarketState = {
			...assetMarketDefaults(),
			mode: assetMarketState.mode,
		};
		rebuild = true;
		restoreFocus = true;
	} else if (button.dataset.amClear) {
		const key = button.dataset.amClear;
		assetMarketState[key] =
			key === "q" ? "" : key === "commercial" ? false : "all";
		rebuild = true;
		restoreFocus = true;
	} else if (button.dataset.amPage) {
		assetMarketState.page = Number(button.dataset.amPage);
		updateAssetMarket();
		document.querySelector("#am-result-count").focus({ preventScroll: true });
		return;
	} else return;
	assetMarketState.page = 1;
	updateAssetMarket(rebuild);
	if (restoreFocus)
		document.querySelector("#asset-query").focus({ preventScroll: true });
});
