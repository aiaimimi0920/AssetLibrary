import { action, element, facts, text } from "./render.client.js";

export function distributionList(name, items, handlers) {
  const container = element(name);
  container.replaceChildren();
  for (const publication of items) {
    const row = text("div", "", "row");
    row.append(text("h4", `${publication.title} · ${publication.label}`));
    row.append(text("p", `发布 ID：${publication.id}`));
    row.append(text("p", `${publication.size} bytes · SHA-256 ${publication.sha256}`, "muted"));
    const toolbar = text("div", "", "toolbar");
    toolbar.append(action("查看公开详情", () => handlers.detail(publication.id), "", false));
    toolbar.append(action("申请授权并下载", () => handlers.download(publication)));
    row.append(toolbar);
    container.append(row);
  }
}

export function management(managed, grant) {
  facts("publication-detail", managed ?? "尚未读取 owner 发布记录。");
  facts("grant-detail", grant ?? "输入主体并查询当前下载授权；不能用目录读成员代替。");
}
