// 五个一级分类；包类型保留在详情和发布表单中。
const collections = {
	"3d": { title: "3D 与场景", ids: ["modular-city"] },
	design: {
		title: "图像与设计",
		ids: ["frame-app", "color-transfer", "cinema-presets"],
	},
	audio: { title: "声音与音乐", ids: ["ambient-sounds"] },
};
const discoveryCategories = [
	{ title: "游戏", route: "browse/game", art: "island" },
	{ title: "应用", route: "browse/application", art: "dashboard" },
	{ title: "loom", route: "browse/loom", art: "workflow" },
	{ title: "素材", route: "browse/asset", art: "city" },
	{ title: "社区", route: "community", art: "studio" },
];
products.push({
	id: "ambient-sounds",
	name: "山野回声 · 自然环境声",
	subtitle: "风吹树林、清晨鸟鸣与远处的溪流。",
	type: "asset",
	app: "any",
	creator: "Field Notes",
	price: 19,
	art: "sound",
	badge: "声音素材",
	scale: "资源合集",
	version: "1.0.0",
	platform: "通用 · WAV",
	license: "商业创作许可（示例）",
	detail:
		"环境声音素材包的展示示例，可用于游戏、影像和其他创作。没有真实音频文件，也没有播放或下载接口。",
});
apps.loom.tabs = ["精选内容", "Art 与工具", "工作流方案", "关于 Loom"];
apps.starfield.tabs = ["游戏与世界", "扩展内容", "玩家创作", "游戏资料"];
apps.otter.tabs = ["精选内容", "桌面扩展", "自动化方案", "关于 Otter"];
apps.framelab.tabs = ["精选内容", "滤镜与扩展", "创作方案", "关于 FrameLab"];

// 游戏商店布局夹具：名称、价格与概念插画均为示例，不是真实商品。
const gameExamples = [
	{
		id: "mist-game",
		name: "雾林来信",
		creator: "林间电台",
		price: 36,
		art: "game-forest",
		gameTags: ["探索冒险", "叙事", "解谜"],
		subtitle: "沿着林间的灯火，找回一封没有寄出的信。",
	},
	{
		id: "neon-game",
		name: "午夜回路",
		creator: "Night Loop",
		price: 58,
		art: "game-neon",
		gameTags: ["竞速", "街机", "单人"],
		subtitle: "在城市醒来之前，跑完属于你的最后一圈。",
	},
	{
		id: "garden-game",
		name: "小小晴天",
		creator: "Tiny Days",
		price: 0,
		art: "game-garden",
		gameTags: ["休闲", "建造", "治愈"],
		subtitle: "种一片花园，把平凡的一天过成喜欢的样子。",
	},
	{
		id: "orbit-game",
		name: "远星航线",
		creator: "Pale Blue",
		price: 42,
		art: "game-orbit",
		gameTags: ["太空", "策略", "探索"],
		subtitle: "穿过安静的星海，寻找下一处停泊的港湾。",
	},
	{
		id: "dunes-game",
		name: "沙海旅人",
		creator: "Windward",
		price: 28,
		art: "game-dunes",
		gameTags: ["冒险", "解谜", "氛围"],
		subtitle: "追随风的方向，听见沙丘之下的古老回响。",
	},
];
products.push(
	...gameExamples.map((game) => ({
		...game,
		type: "game",
		app: "any",
		badge: "示例游戏",
		scale: "完整作品",
		version: "演示版本",
		platform: "Windows",
		license: "个人使用许可（示例）",
		detail: `${game.subtitle} 此条目仅用于游戏商店布局演示，没有可购买或运行的游戏包。`,
	})),
);
