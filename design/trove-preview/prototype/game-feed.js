const gameFeedItems = [
	{
		id: "garden-game",
		clips: ["把荒地种成自己的小院", "朋友来串门的午后", "雨停之后，收获刚刚好"],
	},
	{
		id: "neon-game",
		clips: ["最后一个弯，刚好超越", "换条街道，再跑一圈", "属于夜晚的速度"],
	},
	{
		id: "star-game",
		clips: ["下一座浮岛，比想象中更远", "在云海边搭一个家", "这条小路通向哪里"],
	},
	{
		id: "mist-game",
		clips: ["跟着灯火，走进森林", "藏在树屋里的小秘密", "终于找到那封信"],
	},
	{
		id: "orbit-game",
		clips: ["第一次掠过行星环", "一起飞向星光深处", "一段意料之外的航线"],
	},
	{
		id: "dunes-game",
		clips: [
			"翻过沙丘，遗迹就在眼前",
			"换个角度，谜题有了答案",
			"留给日落的一点时间",
		],
	},
];
const gameFeedState = { gameIndex: 0, clipIndex: 0, likes: new Set() };

function gameFeedCurrent() {
	const entry = gameFeedItems[gameFeedState.gameIndex];
	return { entry, product: products.find((item) => item.id === entry.id) };
}

function gameFeedHeart() {
	return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>';
}

function gameFeedScreen() {
	const { entry, product } = gameFeedCurrent();
	const liked = gameFeedState.likes.has(entry.id);
	const clip = gameFeedState.clipIndex;
	return `<div class="gf-poster" data-game-id="${product.id}" data-clip-index="${clip}" aria-hidden="true">${gameScene(product, clip)}</div><div class="gf-shade"></div>
		<span class="gf-disclosure">概念占位 · 非实机</span>
		<div class="gf-placeholder" aria-hidden="true">▷</div>
		<button class="gf-clip-arrow gf-previous" data-feed-action="previous-clip" aria-label="上一个玩家片段">‹</button>
		<button class="gf-clip-arrow gf-next" data-feed-action="next-clip" aria-label="下一个玩家片段">›</button>
		<button class="gf-like" data-feed-action="like" aria-pressed="${liked}" aria-label="${liked ? "取消偏好" : "喜欢这类游戏"}">${gameFeedHeart()}</button>
		<div class="gf-clip-indicators" aria-hidden="true">${entry.clips.map((_, index) => `<span class="${index === clip ? "is-current" : ""}"></span>`).join("")}</div>`;
}

function gameFeedPage() {
	return `<section class="gf-section" aria-labelledby="game-feed-title"><div class="gs-section-head"><h2 id="game-feed-title">看一段，就想玩</h2><span title="展示推荐入口，尚未接入 AI 或真实行为分析">精彩片段 × AI 发现 · 演示</span></div>
		<div class="gf-layout"><div class="gf-card"><div class="gf-screen" tabindex="0" role="group" aria-label="游戏片段浏览器" aria-describedby="game-feed-help game-feed-status">${gameFeedScreen()}</div></div>
		<div class="gf-game-controls"><button data-feed-action="previous-game" aria-label="上一款片段推荐游戏">↑</button><button data-feed-action="next-game" aria-label="下一款片段推荐游戏">↓</button></div></div>
		<div class="gf-bottom"><p id="game-feed-help" class="visually-hidden">上下滑动换游戏，左右滑动换同款片段。也可拖动或用方向键，短按画面或 Enter 查看游戏。</p><button class="gf-exit" data-feed-action="back-to-picks" aria-label="返回精选">↑</button><p id="game-feed-status" class="gf-status visually-hidden" aria-live="polite">爱心表达游戏偏好，仅本页演示</p></div></section>`;
}

function updateGameFeed(message) {
	const root = document.querySelector(".gf-section");
	if (!root) return;
	const focused = root.contains(document.activeElement)
		? document.activeElement.dataset.feedAction
		: undefined;
	root.querySelector(".gf-screen").innerHTML = gameFeedScreen();
	root.querySelector(".gf-status").textContent = message;
	if (focused)
		root
			.querySelector(`[data-feed-action="${focused}"]`)
			?.focus({ preventScroll: true });
}

function moveGameFeed(axis, step) {
	if (axis === "game") {
		gameFeedState.gameIndex =
			(gameFeedState.gameIndex + step + gameFeedItems.length) %
			gameFeedItems.length;
		gameFeedState.clipIndex = 0;
	} else {
		const count = gameFeedCurrent().entry.clips.length;
		gameFeedState.clipIndex = (gameFeedState.clipIndex + step + count) % count;
	}
	const { entry, product } = gameFeedCurrent();
	updateGameFeed(
		`${product.name} · 玩家片段 ${gameFeedState.clipIndex + 1} / ${entry.clips.length}`,
	);
}

document.addEventListener("click", (event) => {
	const button = event.target.closest("[data-feed-action]");
	if (!button) return;
	const action = button.dataset.feedAction;
	if (action === "back-to-picks") {
		cancelGameFeedDrag();
		const feature = document.querySelector("#game-feature");
		feature?.scrollIntoView({ block: "start", behavior: "auto" });
		feature?.querySelector("button")?.focus({ preventScroll: true });
		return;
	}
	if (action === "like") {
		const { entry, product } = gameFeedCurrent();
		const liked = gameFeedState.likes.has(entry.id);
		if (liked) gameFeedState.likes.delete(entry.id);
		else gameFeedState.likes.add(entry.id);
		updateGameFeed(
			liked
				? "已取消偏好 · 仅本页演示"
				: `偏好：${product.gameTags.slice(0, 2).join("、")} · 仅本页演示，不影响真实推荐`,
		);
	} else
		moveGameFeed(
			action.endsWith("game") ? "game" : "clip",
			action.startsWith("next") ? 1 : -1,
		);
});

document.addEventListener("keydown", (event) => {
	if (
		!event.target.closest(".gf-screen") ||
		event.altKey ||
		event.ctrlKey ||
		event.metaKey ||
		event.shiftKey
	)
		return;
	if (event.key === "Enter" && event.target.matches(".gf-screen")) {
		event.preventDefault();
		if (!event.repeat) openProduct(gameFeedCurrent().entry.id);
		return;
	}
	const movement = {
		ArrowUp: ["game", -1],
		ArrowDown: ["game", 1],
		ArrowLeft: ["clip", -1],
		ArrowRight: ["clip", 1],
	}[event.key];
	if (!movement) return;
	event.preventDefault();
	if (!event.repeat) moveGameFeed(...movement);
});

function gameFeedSwipe(dx, dy) {
	const x = Math.abs(dx);
	const y = Math.abs(dy);
	if (Math.max(x, y) < 45 || Math.max(x, y) < Math.min(x, y) * 1.25)
		return null;
	return y > x ? ["game", dy < 0 ? 1 : -1] : ["clip", dx < 0 ? 1 : -1];
}

let gameFeedDrag;
document.addEventListener("pointerdown", (event) => {
	const screen = event.target.closest(".gf-screen");
	if (!event.isPrimary) {
		cancelGameFeedDrag();
		return;
	}
	if (
		!screen ||
		!event.isPrimary ||
		event.button !== 0 ||
		event.target.closest("button, a")
	)
		return;
	gameFeedDrag = {
		screen,
		pointer: event.pointerId,
		x: event.clientX,
		y: event.clientY,
	};
	screen.setPointerCapture(event.pointerId);
	screen.focus({ preventScroll: true });
});
document.addEventListener("pointerup", (event) => {
	if (!gameFeedDrag || event.pointerId !== gameFeedDrag.pointer) return;
	const { screen, pointer, x, y } = gameFeedDrag;
	gameFeedDrag = undefined;
	if (screen.hasPointerCapture(pointer)) screen.releasePointerCapture(pointer);
	const movement = gameFeedSwipe(event.clientX - x, event.clientY - y);
	if (screen.isConnected && movement) moveGameFeed(...movement);
	else if (
		screen.isConnected &&
		Math.hypot(event.clientX - x, event.clientY - y) < 8
	)
		openProduct(gameFeedCurrent().entry.id);
});
function cancelGameFeedDrag() {
	if (gameFeedDrag?.screen.hasPointerCapture(gameFeedDrag.pointer))
		gameFeedDrag.screen.releasePointerCapture(gameFeedDrag.pointer);
	gameFeedDrag = undefined;
}
document.addEventListener("pointercancel", cancelGameFeedDrag);
document.addEventListener("lostpointercapture", () => {
	gameFeedDrag = undefined;
});
window.addEventListener("blur", cancelGameFeedDrag);
window.addEventListener("hashchange", cancelGameFeedDrag);
