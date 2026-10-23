const main = document.querySelector("#main");
const queryInput = document.querySelector("#query");
const dialogFocus = new Map();
let catalogState;
let activeHub;
let activeTab = 0;

function navigate(path) {
	const hash = `#${path}`;
	if (location.hash === hash) renderRoute();
	else location.hash = hash;
}

function openDialog(dialog) {
	dialogFocus.set(dialog, document.activeElement);
	dialog.showModal();
	document.body.style.overflow = "hidden";
}

function showInfo(title, body) {
	document.querySelector("#info-title").textContent = title;
	document.querySelector("#info-body").innerHTML = body;
	openDialog(document.querySelector("#info-dialog"));
}

function openProduct(id) {
	const product = products.find((item) => item.id === id);
	if (!product) return;
	document.querySelector("#detail-content").innerHTML = productDetail(product);
	const dialog = document.querySelector("#detail-dialog");
	openDialog(dialog);
	dialog.scrollTop = 0;
}

function updateCatalog() {
	const { scope, q } = catalogState;
	const list = products.filter((product) => {
		if (collections[scope] && !collections[scope].ids.includes(product.id))
			return false;
		if (
			scope === "loom" &&
			(product.app !== "loom" ||
				!["art", "mcp", "capability"].includes(product.type))
		)
			return false;
		if (types[scope] && product.type !== scope) return false;
		return (
			!q ||
			`${product.name} ${product.subtitle} ${product.creator} ${types[product.type].label} ${appName(product.app)}`
				.toLowerCase()
				.includes(q.toLowerCase())
		);
	});
	document.querySelector("#result-count").textContent =
		`${list.length} 个匹配内容`;
	document.querySelector("#catalog-results").innerHTML = list.length
		? list.map(productCard).join("")
		: emptyState(
				"没有找到匹配内容",
				"试试其他关键词，或返回全部作品继续浏览。",
			);
}

function renderRoute() {
	for (const dialog of document.querySelectorAll("dialog[open]"))
		dialog.close();
	const [path = "home", search = ""] = location.hash.slice(1).split("?");
	const [section, id] = path.split("/");
	let nav = "home";
	activeHub = undefined;
	queryInput.value = "";
	if (section === "app" && apps[id]) {
		activeHub = id;
		activeTab = 0;
		main.innerHTML = hubPage(id);
		nav = id === "starfield" ? "games" : id === "loom" ? "loom" : "apps";
	} else if (section === "browse") {
		const category =
			id === "extensions" ? "loom" : id === "apps" ? "application" : id;
		const scope =
			types[category] ||
			collections[category] ||
			["loom", "all"].includes(category)
				? category
				: "all";
		const q = new URLSearchParams(search).get("q")?.slice(0, 80) || "";
		catalogState = { scope, q };
		main.innerHTML = catalogPage(scope, q);
		queryInput.value = q;
		updateCatalog();
		nav =
			scope === "game"
				? "games"
				: scope === "application"
					? "apps"
					: ["loom", "art", "mcp", "capability"].includes(scope)
						? "loom"
						: scope === "all"
							? ""
							: "asset";
	} else if (section === "community") {
		main.innerHTML = communityPage();
		nav = "community";
	} else if (section === "library") {
		main.innerHTML = libraryPage();
		nav = "library";
	} else main.innerHTML = homePage();
	for (const link of document.querySelectorAll("[data-nav]")) {
		if (link.dataset.nav === nav) link.setAttribute("aria-current", "page");
		else link.removeAttribute("aria-current");
	}
	document.title = `${activeHub ? `${apps[activeHub].name} 内容空间` : section === "library" ? "我的资源库" : main.querySelector("h1")?.textContent || "发现作品"} · AssetLibrary V2 原型`;
	window.scrollTo(0, 0);
	main.focus({ preventScroll: true });
}

document.addEventListener("click", (event) => {
	const button = event.target.closest("button, a");
	if (!button) return;
	if (button.hasAttribute("data-close-route")) {
		event.preventDefault();
		navigate(button.getAttribute("href").slice(1));
	}
	if (button.hasAttribute("data-close")) button.closest("dialog").close();
	if (button.dataset.route) navigate(button.dataset.route);
	if (button.dataset.product) openProduct(button.dataset.product);
	if (button.dataset.info) showInfo(...infoContent[button.dataset.info]);
	if (button.hasAttribute("data-hub-tab") && activeHub) {
		activeTab = Number(button.dataset.hubTab);
		document.querySelector("#hub-body").innerHTML = hubBody(
			activeHub,
			activeTab,
		);
		for (const tab of document.querySelectorAll("[data-hub-tab]"))
			tab.setAttribute(
				"aria-current",
				Number(tab.dataset.hubTab) === activeTab ? "page" : "false",
			);
	}
	if (button.dataset.custom)
		showInfo(
			`${apps[button.dataset.host].name} · ${button.dataset.custom}`,
			`<p>这是由应用专区提供的自定义入口示例。正式接入后，可以打开应用内功能、专属 Web 工具或相关扩展。</p><div class="inline-note">当前仅展示入口关系，不会启动程序、连接设备或修改环境。</div>`,
		);
	if (button.hasAttribute("data-publish")) {
		document.querySelector("#publish-form").reset();
		if (button.dataset.host) {
			document.querySelector("#publish-kind").value = "capability";
			const target = document.querySelector("#publish-target");
			target.selectedIndex = [...target.options].findIndex((option) =>
				option.textContent.startsWith(apps[button.dataset.host].name),
			);
		}
		openDialog(document.querySelector("#publish-dialog"));
	}
	if (button.dataset.acquire) {
		const product = products.find((item) => item.id === button.dataset.acquire);
		showInfo(
			product.price ? "购买入口 · 布局演示" : "获取入口 · 布局演示",
			`<p><strong>${esc(product.name)}</strong></p><p>${product.price ? `演示价格：${price(product)}。正式流程需要确认许可、适用应用与支付方式。` : "正式流程将在确认适配与授权后，提供下载或前往应用的入口。"}</p><div class="inline-note">没有创建订单、扣款、领取授权、下载或安装任何内容。</div>`,
		);
	}
});

document.querySelector("#search-form").addEventListener("submit", (event) => {
	event.preventDefault();
	const value = queryInput.value.trim();
	navigate(`browse/all${value ? `?q=${encodeURIComponent(value)}` : ""}`);
});
document.querySelector("#publish-form").addEventListener("submit", (event) => {
	event.preventDefault();
	const name = document.querySelector("#publish-name").value.trim();
	const type = document.querySelector("#publish-kind").value;
	if (!name) return;
	showInfo(
		"发布信息预览",
		`<p><strong>${esc(name)}</strong></p><p>内容类型：${types[type].label}<br>目标专区：${esc(document.querySelector("#publish-target").value)}</p><div class="inline-note">预览到此为止：没有上传、保存、审核或发布到真实平台。</div>`,
	);
});

for (const dialog of document.querySelectorAll("dialog")) {
	dialog.addEventListener("close", () => {
		if (!document.querySelector("dialog[open]"))
			document.body.style.overflow = "";
		const previous = dialogFocus.get(dialog);
		if (previous?.isConnected) previous.focus({ preventScroll: true });
	});
	dialog.addEventListener("click", (event) => {
		if (event.target !== dialog) return;
		const rect = dialog.getBoundingClientRect();
		if (
			event.clientX < rect.left ||
			event.clientX > rect.right ||
			event.clientY < rect.top ||
			event.clientY > rect.bottom
		)
			dialog.close();
	});
}
document.addEventListener("keydown", (event) => {
	if (
		event.key === "/" &&
		!event.target.closest("input, textarea, select") &&
		!document.querySelector("dialog[open]")
	) {
		event.preventDefault();
		queryInput.focus();
	}
});
window.addEventListener("hashchange", renderRoute);
renderRoute();
