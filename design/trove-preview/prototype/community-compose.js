function openCommunityComposer(channelId = communityView.channel) {
	document.querySelector("#share-form").reset();
	for (const field of document.querySelectorAll(
		"#share-name, #share-body, #share-channel",
	))
		field.setCustomValidity("");
	const select = document.querySelector("#share-channel");
	select.innerHTML =
		'<option value="">选择一个频道</option>' +
		["game", "interest"]
			.map(
				(kind) =>
					`<optgroup label="${kind === "game" ? "游戏频道" : "兴趣频道"}">${communityChannels
						.filter((channel) => channel.kind === kind)
						.map(
							(channel) =>
								`<option value="${channel.id}">${esc(channel.name)}</option>`,
						)
						.join("")}</optgroup>`,
			)
			.join("");
	select.value = communityChannel(channelId) ? channelId : "";
	openDialog(document.querySelector("#share-dialog"));
}

function communityDraft() {
	const title = document.querySelector("#share-name").value.trim().slice(0, 80);
	const content = document
		.querySelector("#share-body")
		.value.trim()
		.slice(0, 1500);
	const channel = communityChannel(
		document.querySelector("#share-channel").value,
	);
	for (const [selector, valid, message] of [
		["#share-channel", channel, "请选择一个频道。"],
		["#share-name", title, "请输入帖子标题。"],
		["#share-body", content, "请输入帖子内容。"],
	]) {
		if (valid) continue;
		const field = document.querySelector(selector);
		field.setCustomValidity(message);
		field.reportValidity();
		return null;
	}
	return {
		title,
		content,
		channel,
		plaza: document.querySelector("#share-plaza").checked,
	};
}

function communityLoginPrompt(action) {
	showInfo(
		`请先登录后${action}`,
		'<p>登录 Trove 后参与频道讨论。</p><div class="inline-note">当前是界面原型，尚未连接账号或社区服务。不会发送草稿、发布帖子或提交回复。</div>',
	);
}

document.addEventListener("click", (event) => {
	const button = event.target.closest("button");
	if (!button) return;
	if (button.hasAttribute("data-share"))
		openCommunityComposer(button.dataset.shareChannel || communityView.channel);
	if (button.hasAttribute("data-community-publish"))
		communityLoginPrompt("发帖");
});
document.querySelector("#share-form").addEventListener("input", (event) => {
	if (event.target.matches("input, textarea, select"))
		event.target.setCustomValidity("");
});
document.querySelector("#share-form").addEventListener("change", (event) => {
	if (event.target.matches("select")) event.target.setCustomValidity("");
});
document.querySelector("#share-form").addEventListener("submit", (event) => {
	event.preventDefault();
	const draft = communityDraft();
	if (!draft) return;
	showInfo(
		"帖子预览 · 尚未发表",
		`<span class="eyebrow">c/${esc(draft.channel.name)}${draft.plaza ? " · 同时分享到广场" : " · 仅在频道展示"}</span><h3>${esc(draft.title)}</h3><p class="share-preview-body">${esc(draft.content)}</p><div class="inline-note">仅本地预览，没有保存或发表。发布需要先登录。</div>`,
	);
});
document.addEventListener("submit", (event) => {
	if (event.target.id !== "community-reply-form") return;
	event.preventDefault();
	communityLoginPrompt("回复");
});
