function hubPage(id, tab = 0) {
	if (id === "starfield") return gameStoreDetail("star-game");
	const app = apps[id];
	const game = id === "starfield";
	return `<div class="breadcrumbs"><a href="#home">市场</a><span>/</span><a href="#browse/${game ? "game" : "application"}">${game ? "游戏" : "应用"}</a><span>/</span><span>${esc(app.name)}</span></div>
  ${game ? `<section class="game-space-hero">${art("island", "游戏概念示意封面")}<div class="game-space-shade"></div><div class="game-space-copy"><span>远山工作室 · 独立游戏示例</span><h1>星野<span>余响</span></h1><p>每一座浮岛，都藏着一个故事。</p><div class="genre-tags"><span>探索冒险</span><span>开放世界</span><span>单人</span></div><button class="button primary" data-product="star-game">了解游戏 <span>↗</span></button></div><span class="space-demo">概念画面 · 非实际游戏截图</span></section>` : `<section class="app-space-header"><div class="app-space-identity"><span class="app-icon ${id}">${app.letter}</span><div><span class="space-overline">${app.kind}</span><h1>${app.name}<span>内容空间</span></h1><p>${app.tagline}</p></div></div><div class="app-space-actions"><button class="button secondary" data-product="${app.item}">了解 ${app.name} ↗</button><button class="text-button" data-publish data-host="${id}">为它发布内容 ＋</button></div></section>`}
  <nav class="hub-tabs" aria-label="内容空间栏目">${app.tabs.map((label, index) => `<button data-hub-tab="${index}" aria-current="${tab === index ? "page" : "false"}">${label}</button>`).join("")}</nav><div id="hub-body">${hubBody(id, tab)}</div>`;
}

function hubBody(id, tab) {
	const app = apps[id];
	const content = products.filter(
		(product) =>
			product.app === id && !["application", "game"].includes(product.type),
	);
	if (tab === 3)
		return `<section class="about-space"><h2>${id === "starfield" ? "关于这段旅程" : `关于 ${app.name}`}</h2><p>${esc(app.description)}</p><dl class="detail-facts"><div><dt>作品类型</dt><dd>${app.kind}</dd></div><div><dt>内容空间</dt><dd>本体、相关作品与扩展</dd></div></dl><p class="muted">此处是布局演示，没有真实发布动态、玩家数据或运行状态。</p><button class="button secondary" data-product="${app.item}">查看作品详情 ↗</button></section>`;
	if (tab === 2) {
		const collection = content.filter(
			(product) => product.scale === "复杂方案" || product.type === "asset",
		);
		return `<section class="space-section">${sectionHead("", app.tabs[tab])}<div class="product-grid">${collection.length ? collection.map(productCard).join("") : emptyState("暂无作品", "当前没有玩家作品示例。")}</div></section>`;
	}
	if (tab === 1)
		return `<section class="space-section">${sectionHead("", app.tabs[tab])}<div class="product-grid">${content.map(productCard).join("")}</div></section>`;
	if (id === "starfield") return gameOverview(content);
	return applicationOverview(id, content);
}

function applicationOverview(id, content) {
	const app = apps[id];
	const featured =
		content.find((product) => product.id === "color-transfer") || content[0];
	return `<div class="space-layout"><div class="space-main"><article class="space-editorial"><div class="space-editorial-copy"><h2>${esc(featured?.name || app.name)}</h2><p>${esc(featured?.subtitle || app.tagline)}</p>${featured ? `<button class="text-button" data-product="${featured.id}">查看作品 ↗</button>` : ""}</div>${art(featured?.art || app.artwork)}</article><section class="space-section">${sectionHead("", "推荐扩展")}<div class="space-products">${content.map(productCard).join("")}</div></section></div>
  <aside class="space-sidebar"><div class="space-sidebar-title"><span class="app-icon ${id}">${app.letter}</span><div><strong>${app.name}</strong></div></div><h3>常用入口</h3><div class="space-links">${app.actions
		.slice(0, 3)
		.map(
			(action) =>
				`<button data-custom="${esc(action)}" data-host="${id}">${esc(action)} <span>↗</span></button>`,
		)
		.join(
			"",
		)}</div><div class="space-contribute"><button class="button secondary" data-publish data-host="${id}">发布内容 ＋</button></div></aside></div>`;
}

function gameOverview(content) {
	return gameStoreBody(
		products.find((product) => product.id === "star-game"),
		content,
	);
}

const gameFeatureIds = ["star-game", "mist-game", "neon-game"];
const gameShotLabels = ["全景", "近景", "细节", "横向取景"];

function gameStoreTags(product) {
	return `<span class="gs-tags">${product.gameTags.map((tag) => `<span>${esc(tag)}</span>`).join("")}</span>`;
}

function gameScene(product, index = 0) {
	return `<span class="gs-scene gs-shot-${index}">${art(product.art, `${product.name} · ${gameShotLabels[index]}概念插画`)}</span>`;
}

function gameFeature(index) {
	const product = products.find((item) => item.id === gameFeatureIds[index]);
	return `<button class="gs-feature-art" data-product="${product.id}" aria-label="查看 ${esc(product.name)} 商店页">${gameScene(product)}<span class="gs-cover-title"><small>TROVE / GAME SELECTION</small><strong>${esc(product.name)}</strong><em>走进下一个世界 ↗</em></span></button>
		<div class="gs-feature-info"><div><span class="gs-overline">编辑精选 · 为你发现</span><h2>${esc(product.name)}</h2></div>
	<div class="gs-mini-shots" aria-label="概念画面预览">${gameShotLabels.map((label, shot) => `<div>${gameScene(product, shot)}</div>`).join("")}</div>
	<div>${gameStoreTags(product)}<p class="gs-one-line">${esc(product.subtitle)}</p></div>
	<div class="gs-feature-bottom"><span class="gs-price">${price(product)}<small>示例价格</small></span><button class="button primary" data-product="${product.id}">查看游戏 ↗</button></div></div>`;
}

function gameCapsule(product) {
	return `<button class="gs-capsule" data-product="${product.id}"><span class="gs-capsule-art">${gameScene(product)}</span><span class="gs-capsule-info"><span><strong>${esc(product.name)}</strong><small>${esc(product.gameTags.slice(0, 2).join(" · "))}</small></span><b>${price(product)}</b></span></button>`;
}

function gameStorePage(query = "") {
	return `<section class="gs-store" aria-labelledby="catalog-title"><h1 id="catalog-title" class="visually-hidden">${query ? `搜索游戏“${esc(query)}”` : "游戏"}</h1>
	${
		query
			? `<div class="gs-section-head"><h2>搜索结果</h2><span id="result-count" aria-live="polite"></span></div><div id="catalog-results" class="gs-capsule-grid"></div>`
			: `<div class="gs-section-head"><h2>为你精选</h2><span title="编辑候选与个性化匹配入口的布局示意，未接入真实推荐">编辑推荐 × AI 匹配 · 演示</span></div>
	<section class="gs-feature" id="game-feature" data-index="0" aria-label="精选游戏">${gameFeature(0)}</section>
	<div class="gs-feature-controls" id="game-feature-controls"><button data-feature-step="-1" aria-label="上一款推荐游戏">←</button><div>${gameFeatureIds.map((id, index) => `<button data-feature-index="${index}" aria-label="推荐游戏 ${index + 1}" aria-pressed="${index === 0}"><span></span></button>`).join("")}</div><button data-feature-step="1" aria-label="下一款推荐游戏">→</button></div>
		${gameFeedPage()}`
	}
		</section>`;
}

function gameStoreDetail(id) {
	const product = products.find((item) => item.id === id);
	const isStarfield = product.app === "starfield";
	return `<section class="gs-detail"><header class="gs-detail-heading"><div><a href="#browse/game" class="gs-back">← 游戏商店</a><h1>${esc(product.name)}</h1></div><a class="button secondary" href="#community">玩家社区 ↗</a></header>
	<div class="gs-product-top"><div class="gs-gallery" data-gallery-game="${product.id}"><div class="gs-gallery-stage">${gameScene(product)}</div><div class="gs-thumbnails" aria-label="切换概念画面">${gameShotLabels.map((label, index) => `<button data-game-shot="${index}" aria-label="查看${label}概念画面" aria-pressed="${index === 0}">${gameScene(product, index)}</button>`).join("")}</div><p class="gs-media-note">概念插画 · 非实机截图 <span class="gs-shot-name">全景</span></p></div>
	<aside class="gs-summary"><div class="gs-summary-cover">${gameScene(product)}<strong>${esc(product.name)}</strong></div><p>${esc(product.subtitle)}</p>
	<dl class="gs-facts"><div><dt>玩家评测</dt><dd>暂无真实评测</dd></div><div><dt>开发者</dt><dd>${esc(product.creator)}</dd></div><div><dt>支持平台</dt><dd>${esc(product.platform)}</dd></div><div><dt>发行状态</dt><dd>布局示例</dd></div></dl>${gameStoreTags(product)}<button class="button secondary gs-wishlist" data-game-wishlist>＋ 加入愿望单</button></aside></div>
	${isStarfield ? `<nav class="hub-tabs" aria-label="内容空间栏目">${apps.starfield.tabs.map((label, index) => `<button data-hub-tab="${index}" aria-current="${index === 0 ? "page" : "false"}">${label}</button>`).join("")}</nav><div id="hub-body">${gameOverview(products.filter((item) => item.app === "starfield" && item.type !== "game"))}</div>` : gameStoreBody(product, [])}</section>`;
}

function gameStoreBody(product, content) {
	const isStarfield = product.app === "starfield";
	return `<div class="gs-detail-columns"><div class="gs-detail-main"><section class="gs-purchase" aria-label="获取游戏"><div><h2>${product.price ? "购买" : "获取"} ${esc(product.name)}</h2><span>${esc(product.platform)} · 游戏本体 · 示例价格</span></div><div class="gs-buy"><strong>${price(product)}</strong><button class="button primary" data-acquire="${product.id}">${product.price ? "购买游戏" : "获取游戏"} ↗</button></div></section>
	<section class="gs-about"><h2>关于这款游戏</h2><p>${esc(product.subtitle)}</p>${gameScene(product, 3)}<p class="muted">${esc(product.detail)}</p></section>
	${content.length ? `<section class="gs-expansions"><div class="gs-section-head"><h2>这款游戏的扩展内容</h2><span>需拥有游戏本体</span></div>${content.map((item) => `<button class="gs-expansion-row" data-product="${item.id}">${art(item.art, "扩展内容示意图")}<span><strong>${esc(item.name)}</strong><small>${esc(item.badge)}</small></span><b>${price(item)}</b></button>`).join("")}</section>` : ""}</div>
	<aside class="gs-detail-side"><h3>游戏信息</h3><dl class="gs-facts"><div><dt>版本</dt><dd>${esc(product.version)}</dd></div><div><dt>许可</dt><dd>${esc(product.license)}</dd></div><div><dt>系统需求</dt><dd>待开发者提供</dd></div></dl><p>示例内容，不会扣款、下载或安装。</p>
	${isStarfield ? `<h3>玩家与创作者</h3><div class="space-links"><button data-custom="模组创作指南" data-host="starfield">模组创作指南 ↗</button><button data-custom="存档管理工具" data-host="starfield">存档管理工具 ↗</button><button data-publish data-host="starfield">发布玩家作品 ＋</button></div>` : `<button class="text-button" data-publish>发布你的游戏 ↗</button>`}</aside></div>`;
}

document.addEventListener("click", (event) => {
	const button = event.target.closest("button");
	if (!button) return;
	if (
		button.hasAttribute("data-feature-step") ||
		button.hasAttribute("data-feature-index")
	) {
		const feature = document.querySelector("#game-feature");
		if (!feature) return;
		const next = button.hasAttribute("data-feature-index")
			? Number(button.dataset.featureIndex)
			: Number(feature.dataset.index) + Number(button.dataset.featureStep);
		const index = (next + gameFeatureIds.length) % gameFeatureIds.length;
		feature.dataset.index = String(index);
		feature.innerHTML = gameFeature(index);
		for (const dot of document.querySelectorAll("[data-feature-index]"))
			dot.setAttribute(
				"aria-pressed",
				String(Number(dot.dataset.featureIndex) === index),
			);
	}
	if (button.hasAttribute("data-game-shot")) {
		const gallery = button.closest("[data-gallery-game]");
		if (!gallery) return;
		const product = products.find(
			(item) => item.id === gallery.dataset.galleryGame,
		);
		const index = Number(button.dataset.gameShot);
		if (
			!product ||
			!Number.isInteger(index) ||
			index < 0 ||
			index >= gameShotLabels.length
		)
			return;
		gallery.querySelector(".gs-gallery-stage").innerHTML = gameScene(
			product,
			index,
		);
		gallery.querySelector(".gs-shot-name").textContent = gameShotLabels[index];
		for (const shot of gallery.querySelectorAll("[data-game-shot]"))
			shot.setAttribute("aria-pressed", String(shot === button));
	}
	if (button.hasAttribute("data-game-wishlist"))
		showInfo(
			"登录后加入愿望单",
			"<p>当前原型尚未接入账号服务，不会保存收藏或创建愿望单。</p>",
		);
});
