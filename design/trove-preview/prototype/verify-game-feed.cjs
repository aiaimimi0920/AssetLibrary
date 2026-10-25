const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const handlers = {};
const windowHandlers = {};
let opened;
const context = vm.createContext({
	openProduct(id) {
		opened = id;
	},
	document: {
		addEventListener(name, callback) {
			(handlers[name] ||= []).push(callback);
		},
		querySelector() {
			return null;
		},
	},
	window: {
		addEventListener(name, callback) {
			windowHandlers[name] = callback;
		},
	},
});
for (const name of [
	"data.js",
	"collections.js",
	"components.js",
	"spaces.js",
	"game-feed.js",
]) {
	vm.runInContext(
		fs.readFileSync(path.join(__dirname, name), "utf8"),
		context,
		{ filename: name },
	);
}
const evaluate = (source) => vm.runInContext(source, context);
const state = () =>
	JSON.parse(
		evaluate(
			"JSON.stringify({game:gameFeedCurrent().entry.id,clip:gameFeedState.clipIndex,liked:gameFeedState.likes.has(gameFeedCurrent().entry.id)})",
		),
	);
let passed = 0;
function check(name, callback) {
	callback();
	passed++;
}
function action(name) {
	handlers.click.at(-1)({
		target: { closest: () => ({ dataset: { feedAction: name } }) },
	});
}
check("one recommendation slot", () =>
	assert.equal(
		(evaluate("gameStorePage()").match(/class="gf-screen"/g) || []).length,
		1,
	),
);
check("old discovery cards removed", () =>
	assert.equal(evaluate("gameStorePage().includes('gs-capsule-grid')"), false),
);
check("game search remains independent", () =>
	assert.equal(evaluate("gameStorePage('雾林').includes('gf-screen')"), false),
);
check("six games have clip examples", () =>
	assert.equal(
		evaluate(
			"gameFeedItems.length === 6 && gameFeedItems.every(item => item.clips.length === 3)",
		),
		true,
	),
);
check("truthful placeholder", () =>
	assert.equal(evaluate("gameFeedScreen().includes('非实机')"), true),
);
check("no fabricated playback", () =>
	assert.equal(evaluate("gameFeedScreen().includes('<video')"), false),
);
for (const removed of [
	"gf-game-bar",
	"gf-game-identity",
	"gf-caption",
	"gf-player",
	"gf-pill",
	"玩家视角",
]) {
	check(`removed visual content: ${removed}`, () =>
		assert.equal(
			evaluate(`gameFeedPage().includes(${JSON.stringify(removed)})`),
			false,
		),
	);
}
check("no visible detail CTA in feed", () =>
	assert.equal(evaluate("gameFeedPage().includes('>查看游戏')"), false),
);
check("poster identifies current game and clip", () =>
	assert.equal(
		evaluate(
			'gameFeedScreen().includes(\'data-game-id="garden-game" data-clip-index="0"\')',
		),
		true,
	),
);
for (const [dx, dy, expected] of [
	[0, -80, ["game", 1]],
	[0, 80, ["game", -1]],
	[-80, 0, ["clip", 1]],
	[80, 0, ["clip", -1]],
	[10, 20, null],
	[80, 80, null],
]) {
	check(`swipe ${dx},${dy}`, () =>
		assert.deepEqual(
			JSON.parse(evaluate(`JSON.stringify(gameFeedSwipe(${dx},${dy}))`)),
			expected,
		),
	);
}
action("like");
check("like attaches to current game", () =>
	assert.deepEqual(state(), { game: "garden-game", clip: 0, liked: true }),
);
action("next-clip");
check("same-game clip keeps like", () =>
	assert.deepEqual(state(), { game: "garden-game", clip: 1, liked: true }),
);
action("next-game");
check("next game resets clip not like ownership", () =>
	assert.deepEqual(state(), { game: "neon-game", clip: 0, liked: false }),
);
action("previous-game");
check("return restores game preference", () =>
	assert.deepEqual(state(), { game: "garden-game", clip: 0, liked: true }),
);
action("like");
check("unlike works", () => assert.equal(state().liked, false));
action("previous-game");
check("game boundary wraps", () => assert.equal(state().game, "dunes-game"));
action("previous-clip");
check("clip boundary wraps", () => assert.equal(state().clip, 2));
let prevented = false;
handlers.keydown.at(-1)({
	target: { closest: () => null },
	key: "ArrowDown",
	preventDefault() {
		prevented = true;
	},
});
check("outside keyboard not intercepted", () => assert.equal(prevented, false));
handlers.keydown.at(-1)({
	target: { closest: () => ({}) },
	key: "ArrowDown",
	repeat: false,
	preventDefault() {
		prevented = true;
	},
});
check("inside keyboard advances game", () =>
	assert.deepEqual(state(), { game: "garden-game", clip: 0, liked: false }),
);
check("keyboard default prevented inside", () => assert.equal(prevented, true));
let captured = false;
const screen = {
	isConnected: true,
	setPointerCapture() {
		captured = true;
	},
	hasPointerCapture() {
		return captured;
	},
	releasePointerCapture() {
		captured = false;
	},
	focus() {},
};
const pointer = (x, y) => ({
	target: {
		closest(selector) {
			return selector === ".gf-screen" ? screen : null;
		},
	},
	isPrimary: true,
	button: 0,
	pointerId: 1,
	clientX: x,
	clientY: y,
});
handlers.pointerdown.at(-1)(pointer(200, 200));
handlers.pointerup.at(-1)(pointer(200, 100));
check("pointer swipe advances once", () =>
	assert.equal(state().game, "neon-game"),
);
check("pointer capture released", () => assert.equal(captured, false));
handlers.pointerdown.at(-1)(pointer(200, 200));
handlers.pointercancel.at(-1)();
handlers.pointerup.at(-1)(pointer(200, 100));
check("cancelled swipe has no effect", () =>
	assert.equal(state().game, "neon-game"),
);
check("cancelled capture released", () => assert.equal(captured, false));
handlers.pointerdown.at(-1)(pointer(200, 200));
windowHandlers.hashchange();
check("route change releases capture", () => assert.equal(captured, false));
check("swipes never opened detail", () => assert.equal(opened, undefined));
handlers.pointerdown.at(-1)(pointer(200, 200));
handlers.pointerup.at(-1)(pointer(202, 201));
check("short tap opens current game", () => assert.equal(opened, "neon-game"));
opened = undefined;
handlers.pointerdown.at(-1)(pointer(200, 200));
handlers.pointerdown.at(-1)({
	...pointer(220, 200),
	isPrimary: false,
	pointerId: 2,
});
handlers.pointerup.at(-1)(pointer(200, 100));
check("second touch cancels swipe", () =>
	assert.equal(state().game, "neon-game"),
);
check("second touch releases capture", () => assert.equal(captured, false));
handlers.keydown.at(-1)({
	target: { closest: () => ({}), matches: () => true },
	key: "Enter",
	preventDefault() {},
});
check("Enter opens current game", () => assert.equal(opened, "neon-game"));
const source = fs.readFileSync(path.join(__dirname, "game-feed.js"), "utf8");
check("no storage or telemetry", () =>
	assert.equal(
		/localStorage|sessionStorage|fetch\(|sendBeacon|XMLHttpRequest/.test(
			source,
		),
		false,
	),
);
check("no wheel interception", () =>
	assert.equal(source.includes('"wheel"'), false),
);
console.log(
	JSON.stringify({
		passed,
		prototypeOnly: true,
		kind: "unit-contract",
		browserVerifiedSeparately: true,
	}),
);
