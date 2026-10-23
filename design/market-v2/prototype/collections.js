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
