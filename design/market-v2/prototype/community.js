// 仅用于页面布局的虚构帖子，不来自真实账号或社区。
const communityPosts = [
	{
		id: "island-light",
		title: "给漂浮的小岛，留一盏回家的灯",
		author: "远山工作室",
		avatar: "远",
		category: "创作分享",
		topic: "游戏",
		product: "star-game",
		art: "island",
		paragraphs: [
			"这次场景练习从一座塔楼开始。远景里只保留岛屿的轮廓，让瀑布和一扇亮着的窗户把视线带回到落脚点。",
			"给玩家的路径也可以很简单：沿着水流找到小路，再顺着灯光走到塔楼。我们希望场景不仅是背景，也能自然地告诉玩家可以去哪里。",
			"这是一篇虚构创作记录，用于展示游戏内容和开发过程在社区中的关系；配图并非实机截图。",
		],
	},
	{
		id: "color-study",
		title: "两张照片之间，可以借来怎样的颜色？",
		author: "Neuro",
		avatar: "N",
		category: "使用心得",
		topic: "loom",
		product: "color-transfer",
		art: "color",
		paragraphs: [
			"先选择需要处理的图片，再放入一张喜欢的参考图。这个示例关注的是两张图之间的色彩关系，而不是重新生成画面内容。",
			"在真实创作里，可以把颜色迁移作为一个独立步骤，也可以放进完整的素材处理流程。小工具的价值，就在于需要的时候能顺手找到。",
			"本帖是布局示例；这里不会运行 Art，也没有真实处理结果可下载。关联作品提供的是同一份演示商品详情。",
		],
	},
	{
		id: "city-block",
		title: "一套模块，试着搭出不一样的街区",
		author: "Cube Atelier",
		avatar: "C",
		category: "资源制作",
		topic: "素材",
		product: "modular-city",
		art: "city",
		paragraphs: [
			"先统一道路与建筑的尺寸，再考虑组合。相同的基础模块换一个方向、加上一点高低差，就能得到不同的街区轮廓。",
			"作品介绍讲清楚包含什么，社区记录则可以展示怎么用。把两者关联起来，看到创作过程的人也能找到对应的素材。",
			"这些文字和画面仅用于演示内容布局，未提供真实模型文件或商业许可。",
		],
	},
	{
		id: "frame-workspace",
		title: "整理素材，先让工作台清爽一点",
		author: "Frame Studio",
		avatar: "F",
		category: "工作流程",
		topic: "应用",
		product: "frame-app",
		art: "dashboard",
		paragraphs: [
			"素材越积越多以后，找到东西本身也变成了一项工作。这个示例从常用工具、预览区和输出步骤三个位置整理界面。",
			"完整应用、扩展工具和使用经验可以彼此关联，但不需要在一个商品卡片上同时解释所有事情。",
			"FrameLab 是虚构应用，本帖不是正式使用文档，也不代表相关功能已经实现。",
		],
	},
];
const communityBookmarks = new Set();

function bookmarkButton(id) {
	const saved = communityBookmarks.has(id);
	return `<button class="post-bookmark" data-bookmark="${id}" aria-pressed="${saved}">${saved ? "已收藏（本页）" : "收藏（演示）"}</button>`;
}

function communityPostCard(post) {
	const product = products.find((item) => item.id === post.product);
	return `<article class="community-post"><header class="post-author"><span class="creator-avatar">${esc(post.avatar)}</span><div><strong>${esc(post.author)}</strong><small>${esc(post.category)}</small></div><span class="post-topic">${esc(post.topic)}</span></header><h2><button data-thread="${post.id}">${esc(post.title)}</button></h2><button class="post-cover" data-thread="${post.id}" aria-label="阅读：${esc(post.title)}">${art(post.art, "社区帖子示意配图")}</button><div class="post-related"><span>相关作品</span><button data-product="${product.id}">${esc(product.name)} <span>↗</span></button></div><footer class="post-actions"><button data-thread="${post.id}">阅读 ↗</button>${bookmarkButton(post.id)}</footer></article>`;
}

function communityPage() {
	return `<section class="community-page" aria-labelledby="community-title"><h1 id="community-title" class="visually-hidden">社区</h1><div class="community-top"><div><strong>作品与交流</strong><span>示例帖子</span></div><button class="button primary" data-share>分享创作 ＋</button></div><div class="community-layout"><div class="community-feed">${communityPosts.map(communityPostCard).join("")}</div><aside class="community-sidebar"><section><h2>内容空间</h2><div class="community-spaces">${["starfield", "loom", "framelab", "otter"].map((id) => `<a href="#app/${id}"><span class="app-icon ${id}">${apps[id].letter}</span><div><strong>${esc(apps[id].name)}</strong><small>${esc(apps[id].kind)}</small></div><span>↗</span></a>`).join("")}</div></section><section><h2>相关作品</h2><div class="community-works">${[
		"color-transfer",
		"modular-city",
		"frame-app",
	]
		.map((id) => {
			const product = products.find((item) => item.id === id);
			return `<button data-product="${id}"><span>${art(product.art)}</span><div><strong>${esc(product.name)}</strong><small>${price(product)} · 演示内容</small></div></button>`;
		})
		.join("")}</div></section></aside></div></section>`;
}

function openCommunityPost(id) {
	const post = communityPosts.find((item) => item.id === id);
	if (!post) return;
	const product = products.find((item) => item.id === post.product);
	document.querySelector("#community-post-content").innerHTML =
		`<div class="dialog-top"><span class="eyebrow">${esc(post.topic)} / ${esc(post.category)} · 示例帖子</span><button class="close" data-close aria-label="关闭文章">×</button></div><article class="post-reading"><h2 id="community-post-title">${esc(post.title)}</h2><div class="post-reading-author">${esc(post.author)} · 示例作者</div><div class="post-reading-cover">${art(post.art, "文章示意配图")}</div>${post.paragraphs.map((paragraph) => `<p>${esc(paragraph)}</p>`).join("")}<div class="post-related"><span>关联作品</span><button data-product="${product.id}">${esc(product.name)} ↗</button></div><div class="post-actions">${bookmarkButton(post.id)}<button data-share>我也想分享 ↗</button></div><div class="post-discussion"><h3>交流区</h3><p>这里只展示阅读与作品关联的布局，尚未接入真实评论。</p></div></article>`;
	const dialog = document.querySelector("#community-dialog");
	openDialog(dialog);
	dialog.scrollTop = 0;
}

function openCommunityComposer() {
	document.querySelector("#share-form").reset();
	for (const field of document.querySelectorAll("#share-name, #share-body"))
		field.setCustomValidity("");
	document.querySelector("#share-product").innerHTML =
		`<option value="">暂不关联</option>${products.map((product) => `<option value="${product.id}">${esc(product.name)}</option>`).join("")}`;
	openDialog(document.querySelector("#share-dialog"));
}

document.addEventListener("click", (event) => {
	const button = event.target.closest("button");
	if (!button) return;
	if (button.dataset.thread) openCommunityPost(button.dataset.thread);
	if (button.hasAttribute("data-share")) openCommunityComposer();
	if (button.dataset.bookmark) {
		const id = button.dataset.bookmark;
		if (!communityPosts.some((post) => post.id === id)) return;
		if (communityBookmarks.has(id)) communityBookmarks.delete(id);
		else communityBookmarks.add(id);
		for (const control of document.querySelectorAll("[data-bookmark]")) {
			if (control.dataset.bookmark !== id) continue;
			const saved = communityBookmarks.has(id);
			control.setAttribute("aria-pressed", String(saved));
			control.textContent = saved ? "已收藏（本页）" : "收藏（演示）";
		}
	}
});

document.querySelector("#share-form").addEventListener("input", (event) => {
	if (event.target.matches("input, textarea"))
		event.target.setCustomValidity("");
});

document.querySelector("#share-form").addEventListener("submit", (event) => {
	event.preventDefault();
	const title = document.querySelector("#share-name").value.trim();
	const content = document.querySelector("#share-body").value.trim();
	if (!title || !content) {
		const field = document.querySelector(
			!title ? "#share-name" : "#share-body",
		);
		field.setCustomValidity(!title ? "请输入分享标题。" : "请输入分享内容。");
		field.reportValidity();
		return;
	}
	const product = products.find(
		(item) => item.id === document.querySelector("#share-product").value,
	);
	showInfo(
		"分享预览 · 尚未发表",
		`<h3>${esc(title)}</h3><p class="share-preview-body">${esc(content)}</p>${product ? `<p>关联作品：${esc(product.name)}</p>` : ""}<div class="inline-note">仅预览，没有保存、上传或发表。草稿与收藏仅存在于当前页面，刷新后清除。</div>`,
	);
});
