const communityBookmarks = new Set();
let communityView = { mode: "plaza", channel: null, filter: "all", q: "" };
let communityDirectoryKind = "all";
const communityChannel = (id) =>
	communityChannels.find((channel) => channel.id === id);
const communityKind = (kind) =>
	communityPostKinds.find(([id]) => id === kind)?.[1] || "分享";

function communityList(view = communityView) {
	const words = view.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return communityPosts.filter((post) => {
		if (view.mode === "plaza" ? !post.plaza : post.channel !== view.channel)
			return false;
		if (view.filter !== "all" && post.kind !== view.filter) return false;
		const text =
			`${post.title} ${post.excerpt} ${post.author} ${communityChannel(post.channel).name}`.toLowerCase();
		return words.every((word) => text.includes(word));
	});
}

function bookmarkButton(id) {
	const saved = communityBookmarks.has(id);
	return `<button class="post-bookmark" data-bookmark="${id}" aria-pressed="${saved}">${saved ? "已收藏（本页）" : "收藏"}</button>`;
}

function communityPostCard(post) {
	const channel = communityChannel(post.channel);
	return `<article class="community-post"><header class="post-author"><span class="creator-avatar">${esc(post.author.slice(0, 1))}</span><div><strong>${esc(post.author)}</strong><small>${communityKind(post.kind)}</small></div><a class="post-channel" href="#community/channel/${channel.id}">c/${esc(channel.name)} ↗</a></header><h2><button data-thread="${post.id}">${esc(post.title)}</button></h2><p class="post-excerpt">${esc(post.excerpt)}</p>${post.art ? `<button class="post-cover" data-thread="${post.id}" aria-label="阅读：${esc(post.title)}">${art(post.art, "帖子概念配图，非实机")}</button>` : ""}<footer class="post-actions"><button data-thread="${post.id}">进入讨论 ↗</button>${bookmarkButton(post.id)}</footer></article>`;
}

function communityChannelLink(channel) {
	return `<a class="cc-channel-link" href="#community/channel/${channel.id}" ${communityView.channel === channel.id ? 'aria-current="page"' : ""}><span class="cc-channel-art">${art(channel.art)}</span><span><strong>${esc(channel.name)}</strong><small>${channel.kind === "game" ? "游戏频道" : "兴趣频道"}</small></span><span aria-hidden="true">↗</span></a>`;
}

function communitySidebar() {
	return `<aside class="community-sidebar"><section><div class="cc-side-heading"><h2>逛逛频道</h2><a href="#community/channels">全部 ↗</a></div><div class="cc-channel-links">${["star-game", "garden-game", "indie-games", "game-dev", "pixel-art"].map((id) => communityChannelLink(communityChannel(id))).join("")}</div></section><section class="cc-boundary-note"><span>同一个爱好，不止一种声音。</span><p>帖子、作者与配图均为布局示例。</p></section></aside>`;
}

function communityFeedToolbar() {
	return `<div class="cc-feed-toolbar"><div class="cc-post-filters" aria-label="帖子类型">${communityPostKinds.map(([id, label]) => `<button data-community-filter="${id}" aria-pressed="${communityView.filter === id}">${label}</button>`).join("")}</div><span id="community-result-count" aria-live="polite">${communityList().length} 篇示例</span></div>`;
}

function communityDirectory() {
	return `<div class="cc-directory-tools"><div class="cc-post-filters" aria-label="频道类型"><button data-channel-kind="all" aria-pressed="true">全部频道</button><button data-channel-kind="game" aria-pressed="false">游戏</button><button data-channel-kind="interest" aria-pressed="false">兴趣</button></div><form id="channel-search-form" class="cc-search" role="search"><input id="channel-query" type="search" maxlength="80" aria-label="搜索频道" placeholder="找游戏，找同好…"><button type="submit">搜索</button></form></div><div id="community-channel-grid" class="cc-channel-grid">${communityChannels.map(communityChannelCard).join("")}</div><p class="cc-demo-note">频道与内容均为演示，未连接真实社区</p>`;
}

function communityChannelCard(channel) {
	return `<a class="cc-channel-card" href="#community/channel/${channel.id}"><div class="cc-card-cover">${art(channel.art)}<span>${channel.kind === "game" ? "游戏频道" : "兴趣频道"}</span></div><div><h2>${esc(channel.name)} <span>↗</span></h2><p>${esc(channel.description)}</p><small>${channel.tags.map(esc).join(" / ")}</small></div></a>`;
}

function communityPage(section, id) {
	const selected = section === "channel" ? communityChannel(id) : null;
	const mode =
		section === "channels" ? "directory" : selected ? "channel" : "plaza";
	communityView = { mode, channel: selected?.id || null, filter: "all", q: "" };
	communityDirectoryKind = "all";
	const channelHeader = selected
		? `<header class="cc-channel-header"><span class="cc-channel-hero-art">${art(selected.art)}</span><div><a href="#community/channels" class="cc-back">← 全部频道</a><span class="cc-channel-type">${selected.kind === "game" ? "游戏频道" : "兴趣频道"}</span><h2>c/${esc(selected.name)}</h2><p>${esc(selected.description)}</p><div class="cc-channel-tags">${selected.tags.map((tag) => `<span>${esc(tag)}</span>`).join("")}</div></div>${selected.product ? `<button class="button secondary" data-product="${selected.product}">游戏详情 ↗</button>` : ""}</header>`
		: "";
	const feed = `<div class="community-layout"><div class="community-feed">${selected ? "" : `<div class="cc-plaza-title"><h2>来看看，大家都在玩什么</h2><span>来自不同频道的分享与讨论</span></div>`}${communityFeedToolbar()}<div id="community-results">${communityList().map(communityPostCard).join("")}</div></div>${communitySidebar()}</div>`;
	return `<section class="community-page" aria-labelledby="community-title"><header class="community-top"><div><span class="cc-overline">TROVE / COMMUNITY</span><h1 id="community-title">社区</h1></div><button class="button primary" data-share>${selected ? "在此频道发帖 ＋" : "发帖 ＋"}</button></header><nav class="cc-main-tabs" aria-label="社区栏目"><a href="#community" ${mode === "plaza" ? 'aria-current="page"' : ""}>广场</a><a href="#community/channels" ${mode !== "plaza" ? 'aria-current="page"' : ""}>频道</a></nav>${channelHeader}${mode === "directory" ? communityDirectory() : feed}</section>`;
}

function updateCommunityFeed() {
	const root = document.querySelector("#community-results");
	if (!root) return;
	const list = communityList();
	root.innerHTML = list.length
		? list.map(communityPostCard).join("")
		: '<div class="cc-empty"><h2>暂时没有这类示例帖子</h2><p>试试其他分类。</p><button data-community-filter="all">查看全部帖子 →</button></div>';
	document.querySelector("#community-result-count").textContent =
		`${list.length} 篇示例`;
	for (const button of document.querySelectorAll("[data-community-filter]"))
		button.setAttribute(
			"aria-pressed",
			String(button.dataset.communityFilter === communityView.filter),
		);
}

function openCommunityPost(id) {
	const post = communityPosts.find((item) => item.id === id);
	if (!post) return;
	const channel = communityChannel(post.channel);
	const product = products.find((item) => item.id === post.product);
	const replies = communityReplies.filter((reply) => reply.post === id);
	document.querySelector("#community-post-content").innerHTML =
		`<div class="dialog-top"><a class="eyebrow" href="#community/channel/${channel.id}">c/${esc(channel.name)} / ${communityKind(post.kind)}</a><button class="close" data-close aria-label="关闭文章">×</button></div><article class="post-reading"><h2 id="community-post-title">${esc(post.title)}</h2><div class="post-reading-author">${esc(post.author)} · 示例作者</div>${post.art ? `<div class="post-reading-cover">${art(post.art, "帖子概念配图，非实机")}</div>` : ""}<p>${esc(post.text)}</p>${product ? `<div class="post-related"><span>关联作品</span><button data-product="${product.id}">${esc(product.name)} ↗</button></div>` : ""}<div class="post-actions">${bookmarkButton(post.id)}<button data-share data-share-channel="${channel.id}">在频道发帖 ↗</button></div><section class="post-discussion"><h3>交流</h3>${replies.length ? replies.map((reply) => `<div class="cc-reply"><strong>${esc(reply.author)} <small>· 示例回复</small></strong><p>${esc(reply.text)}</p></div>`).join("") : "<p>暂无示例回复，聊聊你的看法。</p>"}<form id="community-reply-form"><label for="community-reply">你的看法<textarea id="community-reply" maxlength="500" rows="3" placeholder="说说你的想法…"></textarea></label><button class="button secondary" type="submit">登录后回复 ↗</button></form><p class="cc-demo-note">仅展示交流布局，未接入真实发帖或评论</p></section></article>`;
	const dialog = document.querySelector("#community-dialog");
	openDialog(dialog);
	dialog.scrollTop = 0;
}

function updateCommunityDirectory() {
	const query = document
		.querySelector("#channel-query")
		.value.trim()
		.slice(0, 80)
		.toLowerCase();
	const list = communityChannels.filter(
		(channel) =>
			(communityDirectoryKind === "all" ||
				channel.kind === communityDirectoryKind) &&
			`${channel.name} ${channel.description} ${channel.tags.join(" ")}`
				.toLowerCase()
				.includes(query),
	);
	document.querySelector("#community-channel-grid").innerHTML = list.length
		? list.map(communityChannelCard).join("")
		: '<div class="cc-empty"><h2>没有找到这个频道</h2><p>换个关键词再找找。</p></div>';
}

document.addEventListener("click", (event) => {
	const button = event.target.closest("button");
	if (!button) return;
	if (button.dataset.thread) openCommunityPost(button.dataset.thread);
	if (button.dataset.communityFilter) {
		communityView.filter = button.dataset.communityFilter;
		updateCommunityFeed();
		if (!button.isConnected)
			document
				.querySelector('[data-community-filter="all"]')
				.focus({ preventScroll: true });
	}
	if (button.dataset.channelKind) {
		communityDirectoryKind = button.dataset.channelKind;
		for (const control of document.querySelectorAll("[data-channel-kind]"))
			control.setAttribute("aria-pressed", String(control === button));
		updateCommunityDirectory();
	}
	if (button.dataset.bookmark) {
		const id = button.dataset.bookmark;
		if (!communityPosts.some((post) => post.id === id)) return;
		if (communityBookmarks.has(id)) communityBookmarks.delete(id);
		else communityBookmarks.add(id);
		for (const control of document.querySelectorAll("[data-bookmark]")) {
			if (control.dataset.bookmark !== id) continue;
			control.setAttribute("aria-pressed", String(communityBookmarks.has(id)));
			control.textContent = communityBookmarks.has(id)
				? "已收藏（本页）"
				: "收藏";
		}
	}
});
document.addEventListener("submit", (event) => {
	if (event.target.id !== "channel-search-form") return;
	event.preventDefault();
	updateCommunityDirectory();
});
