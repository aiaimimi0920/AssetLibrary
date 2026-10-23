const esc = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				character
			],
	);
const iconPaths = {
	app: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 9h16M9 9v11"/>',
	game: '<path d="M7 8h10c3 0 5 9 3 10-2 1-4-2-5-2H9c-1 0-3 3-5 2-2-1 0-10 3-10Z"/><path d="M8 10v5m-2-2h4m5-1h.1m2 2h.1"/>',
	cube: '<path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10 9-5M12 13 3 8m9 5v9M7 5.8l9 5"/>',
	art: '<path d="m12 3 9 9-9 9-9-9 9-9Z"/><path d="m8 12 4-4 4 4-4 4-4-4Z"/>',
	plug: '<path d="m8 3 8 8m-5-9 8 8M7 8l9 9m-5-13-7 7a5 5 0 0 0 7 7l7-7M7 18l-4 3"/>',
	nodes:
		'<rect x="3" y="4" width="6" height="6" rx="1"/><rect x="15" y="14" width="6" height="6" rx="1"/><path d="M9 7h6a3 3 0 0 1 3 3v4M6 10v7h9"/>',
};
const icon = (name) =>
	`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.cube}</svg>`;
const art = (name, label = "布局示意封面", className = "") =>
	`<svg class="artwork ${className}" viewBox="0 0 800 500" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid slice"><use href="artwork.svg#${name}"></use></svg>`;
const price = (product) =>
	product.price ? `¥${product.price.toFixed(2)}` : "免费";
const appName = (id) => apps[id]?.name || "跨应用通用";

function productCard(product) {
	return `<article class="product-card">
    <button class="product-cover" data-product="${product.id}" aria-label="查看 ${esc(product.name)}">${art(product.art, `${product.name} 示意封面`)}<span class="cover-open">查看作品 ↗</span></button>
    <div class="product-heading"><h3><button data-product="${product.id}">${esc(product.name)}</button></h3><span class="price ${product.price ? "" : "free"}">${price(product)}</span></div>
    <div class="product-byline"><span>${esc(product.creator)}</span><span>·</span><span>${esc(product.badge)}</span></div>
  </article>`;
}

function appTile(id) {
	const app = apps[id];
	return `<a class="app-tile" href="#app/${id}"><span class="app-icon ${id}">${app.letter}</span><div><strong>${esc(app.name)}</strong><small>${esc(app.kind)}</small></div><span class="tile-arrow">↗</span></a>`;
}

function sectionHead(kicker, title, subtitle = "", route = "") {
	return `<header class="section-heading"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ""}</div>${route ? `<a class="text-link" href="#${route}">查看全部 <span>↗</span></a>` : ""}</header>`;
}

function emptyState(title, subtitle) {
	return `<div class="empty-state"><span>⌕</span><h3>${title}</h3><p>${subtitle}</p><button class="button secondary" data-route="browse/all">浏览全部内容</button></div>`;
}

function productDetail(product) {
	return `<div class="detail-visual">${art(product.art, `${product.name} 示意封面`)}<span class="cover-type">${esc(product.badge)} · 演示内容</span><button class="close" data-close aria-label="关闭详情">×</button></div>
  <div class="detail-body"><div class="detail-heading"><div><span class="eyebrow">${esc(product.creator)} / ${types[product.type].label}</span><h2 id="detail-title">${esc(product.name)}</h2></div><strong class="detail-price">${price(product)}<small>${product.price ? "演示价格" : "演示获取方式"}</small></strong></div>
  <p class="detail-intro">${esc(product.detail)}</p><dl class="detail-facts"><div><dt>适用环境</dt><dd>${esc(product.platform)}</dd></div><div><dt>版本</dt><dd>${esc(product.version)}</dd></div><div><dt>内容形态</dt><dd>${esc(product.scale)}</dd></div><div><dt>许可说明</dt><dd>${esc(product.license)}</dd></div></dl>
  ${apps[product.app] ? `<a class="related-app" href="#app/${product.app}" data-close-route><span class="app-icon ${product.app}">${apps[product.app].letter}</span><div><strong>${esc(appName(product.app))} 专区</strong><small>查看相关扩展、作品与专属入口</small></div><span>→</span></a>` : '<div class="inline-note">跨应用资产：一个资源条目，可以关联多个兼容应用。</div>'}
  <div class="detail-bottom"><p>仅演示 · 不会交易、下载或安装</p><button class="button primary" data-acquire="${product.id}">${product.price ? "预览购买入口" : "获取（演示）"} <span>→</span></button></div></div>`;
}

const infoContent = {
	design: [
		"V2：先逛市场，再进入作品自己的世界。",
		"<p>作品市场与应用内容空间的独立 HTML 原型。</p><p>内容、作者、价格与封面均为示例，未接入账号、上传、交易或安装服务。社区收藏与草稿仅保留在当前页面，刷新后清除。</p><p>V1 保留，正式项目未修改。</p>",
	],
	platform: [
		"一个市场，多种作品，多处使用。",
		"<p>AssetLibrary 的目标不止是插件商店：它可以分发独立应用和游戏，承载他人发布的作品，提供资产下载与交易，并为 Loom 等应用提供 Art、MCP 和能力包。</p><p>统一资产后端负责资源、版本、授权与分发；每个应用可以拥有自己的前台专区和扩展入口。这里展示的是目标关系，不代表后台已经实现。</p>",
	],
	account: [
		"当前是原型访客",
		"<p>本页面没有连接真实账号，不读取现有登录状态。你可以自由试用分类、空间、详情和发布预览。</p>",
	],
};
