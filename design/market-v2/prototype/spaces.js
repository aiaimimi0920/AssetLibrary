function hubPage(id, tab = 0) {
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
	return `<div class="space-layout game-layout"><div class="space-main"><section class="game-story"><h2>探索浮岛</h2><p>沿着风和星光探索群岛，收集旧日回声，搭起自己的落脚点。</p><small>示例故事</small></section><section class="space-section">${sectionHead("", "扩展内容")}<div class="space-products">${content.map(productCard).join("")}</div></section></div><aside class="space-sidebar game-sidebar"><h3>星野：余响</h3><p>独立探索游戏 · 演示作品</p><dl><div><dt>开发者</dt><dd>远山工作室（示例）</dd></div><div><dt>平台</dt><dd>Windows</dd></div><div><dt>玩法</dt><dd>单人 · 探索 · 建造</dd></div></dl><button class="button secondary" data-product="star-game">查看游戏本体 ↗</button><h3>玩家与创作者</h3><div class="space-links"><button data-custom="模组创作指南" data-host="starfield">模组创作指南 <span>↗</span></button><button data-custom="存档管理工具" data-host="starfield">存档管理工具 <span>↗</span></button><button data-publish data-host="starfield">发布玩家作品 <span>＋</span></button></div></aside></div>`;
}
