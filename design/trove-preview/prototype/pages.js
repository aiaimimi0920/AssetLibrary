const selectedProducts = (ids) =>
	ids.map((id) => products.find((product) => product.id === id));

function homePage() {
	return `<section class="market-hero"><div class="market-hero-copy"><h1 title="Fun stuff. Useful stuff. All right here!">好玩的，<br>好用的，<br>都在这！</h1><a class="button primary" href="#browse/all">探索作品 <span>↗</span></a></div><div class="market-mosaic" aria-label="不同作品的示意封面"><button class="mosaic-main" data-product="modular-city" aria-label="查看微缩城市">${art("city")}</button><button class="mosaic-color" data-product="color-transfer" aria-label="查看颜色迁移">${art("color")}</button><button class="mosaic-game" data-product="star-game" aria-label="查看星野余响">${art("island")}</button></div></section>
  <nav class="discovery-categories" aria-label="按兴趣浏览">${discoveryCategories.map((category) => `<a href="#${category.route}"><span class="category-picture">${art(category.art, `${category.title} 分类示意`)}</span><strong>${category.title}</strong><span class="category-arrow">↗</span></a>`).join("")}</nav>
	  <section class="market-section first-products">${sectionHead("", "新作推荐", "", "browse/all")}<div class="product-grid">${selectedProducts(["star-game", "frame-app", "modular-city", "studio-flow"]).map(productCard).join("")}</div></section>
  <section class="editorial-section"><a class="editorial-card scene-collection" href="#browse/3d"><div><h2>3D 与场景</h2><b>探索素材 ↗</b></div>${art("city")}</a><a class="editorial-card color-collection" href="#browse/design"><div><h2>图像与设计</h2><b>查看作品 ↗</b></div>${art("color")}</a></section>
  <section class="market-section">${sectionHead("", "创作工具", "", "browse/all")}<div class="product-grid">${selectedProducts(["color-transfer", "files-mcp", "rename", "cinema-presets"]).map(productCard).join("")}</div></section>
  <section class="worlds-section">${sectionHead("", "内容空间", "", "browse/application")}<div class="worlds-grid">${["loom", "starfield", "framelab", "otter"].map((id) => `<a class="world-card" href="#app/${id}"><div class="world-art">${art(apps[id].artwork)}<span class="app-icon ${id}">${apps[id].letter}</span></div><div class="world-caption"><strong>${esc(apps[id].name)}</strong><span>${id === "starfield" ? "扩展 · 模组" : id === "loom" ? "Art · 工具 · 工作流" : id === "otter" ? "桌面扩展" : "滤镜 · 预设"}</span><b>进入空间 ↗</b></div></a>`).join("")}</div></section>
  <section class="creator-strip"><h2>发布你的作品</h2><button class="button secondary" data-publish>开始发布 ↗</button></section>`;
}

function catalogPage(scope, query = "") {
	if (scope === "game") return gameStorePage(query);
	if (scope === "asset") return assetMarketPage(query);
	const titles = {
		application: "应用",
		loom: "loom",
		game: "游戏",
		asset: "素材",
		all: "所有作品",
	};
	const title =
		titles[scope] ||
		collections[scope]?.title ||
		types[scope]?.title ||
		"所有作品";
	return `<section class="catalog-page" aria-labelledby="catalog-title"><h1 id="catalog-title" class="visually-hidden">${query ? `搜索“${esc(query)}”` : title}</h1><div class="catalog-result-head"><span id="result-count" aria-live="polite"></span><span>演示作品与价格</span></div><div id="catalog-results" class="product-grid"></div></section>`;
}

function libraryPage() {
	return `<div class="breadcrumbs"><a href="#home">市场</a><span>/</span><span>我的资源库</span></div><div class="catalog-heading"><h1>你的作品收藏。</h1><p>领取或购买的内容，一处查看。下方为演示条目，不代表真实授权。</p></div><div class="library-list">${selectedProducts(
		["loom-app", "color-transfer", "files-mcp", "star-game"],
	)
		.map(
			(product) =>
				`<article class="library-row"><div class="library-cover">${art(product.art)}</div><div><span class="eyebrow">${types[product.type].label} · 示例</span><h2>${esc(product.name)}</h2><p>${esc(appName(product.app))}</p></div><button class="button secondary" data-product="${product.id}">查看内容 ↗</button></article>`,
		)
		.join("")}</div>`;
}
