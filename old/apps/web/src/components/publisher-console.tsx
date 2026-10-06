import Link from "next/link";
import type {
  OwnedPackageSummary,
  PublisherMembership,
  PublisherRole,
} from "@/lib/publisher-contracts";

const roleLabel: Record<PublisherRole, string> = {
  owner: "Owner",
  maintainer: "Maintainer",
  release_manager: "Release Manager",
};

const packageStatusLabel: Record<OwnedPackageSummary["status"], string> = {
  draft: "草稿",
  submitted: "已提交",
  published: "已发布",
  suspended: "已暂停",
  deprecated: "已弃用",
  archived: "已归档",
};

const releaseStatuses = new Set<OwnedPackageSummary["status"]>([
  "draft", "submitted", "published",
]);

function updatedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function PublisherConsole({
  memberships,
  membership,
  packages,
  nextCursor,
}: {
  memberships: PublisherMembership[];
  membership: PublisherMembership;
  packages: OwnedPackageSummary[];
  nextCursor: string | null;
}) {
  const publisher = membership.publisher;
  const canCreate = membership.publisher_status === "active"
    && ["owner", "maintainer"].includes(membership.role);
  const canRelease = membership.publisher_status === "active";

  return (
    <main id="main-content" className="console-layout">
      <aside className="console-rail" aria-label="Publisher 工作区">
        <p className="eyebrow">WORKSPACES</p>
        <div className="console-tool-links">
          <Link className="publisher-moderation-entry" href={`/publisher/signing-keys?publisher=${publisher.id}`}>
            <strong>Signing Keys</strong><span>公钥与供应链信任</span>
          </Link>
          <Link className="publisher-moderation-entry" href="/publisher/moderation">
            <strong>Moderation</strong><span>查看处罚与申诉</span>
          </Link>
        </div>
        <nav>
          {memberships.map((item) => (
            <Link
              aria-current={item.publisher.id === publisher.id ? "page" : undefined}
              href={`/publisher?publisher=${item.publisher.id}`}
              key={item.publisher.id}
            >
              <strong>{item.publisher.display_name}</strong>
              <span>{roleLabel[item.role]} · {item.publisher_status}</span>
            </Link>
          ))}
        </nav>
        <p className="console-boundary">
          身份由外部 Account Service 确认；AssetLibrary 不保存账号凭据。
        </p>
      </aside>

      <section className="console-board" aria-labelledby="publisher-title">
        <header className="console-heading">
          <div>
            <p className="eyebrow">PUBLISHER CONTROL PLANE</p>
            <h1 id="publisher-title">{publisher.display_name}</h1>
            <div className="console-facts" aria-label="当前工作区状态">
              <span>{roleLabel[membership.role]}</span>
              <span data-state={membership.publisher_status}>{membership.publisher_status}</span>
              <code>{publisher.slug}</code>
            </div>
          </div>
          {canCreate ? (
            <Link className="primary-link" href={`/publisher/packages/new?publisher=${publisher.id}`}>
              创建包草稿
            </Link>
          ) : null}
        </header>

        <div className="console-section-heading">
          <div>
            <p className="eyebrow">OWNED PACKAGES</p>
            <h2>包与发布状态</h2>
          </div>
          <span>{packages.length} ITEMS</span>
        </div>

        {packages.length === 0 ? (
          <section className="console-empty">
            <h2>这个工作区还没有 Package</h2>
            <p>这是来自 Publisher API 的真实空结果，不是依赖故障或权限错误。</p>
          </section>
        ) : (
          <div className="owned-package-list">
            {packages.map((item) => {
              const mayRelease = canRelease && releaseStatuses.has(item.status);
              return (
                <article className="owned-package-row" key={item.id}>
                  <div className="owned-package-kind">{item.kind.replace("_", " ")}</div>
                  <div className="owned-package-copy">
                    <div className="owned-package-title">
                      <h3>{item.name}</h3>
                      <span data-state={item.status}>{packageStatusLabel[item.status]}</span>
                    </div>
                    <p>{item.summary || "尚未填写摘要。"}</p>
                    <div className="owned-package-meta">
                      <code>{item.slug}</code>
                      <span>{item.visibility}</span>
                      <time dateTime={item.updated_at}>{updatedAt(item.updated_at)} UTC</time>
                    </div>
                  </div>
                  <div className="owned-package-actions">
                    <Link href={`/publisher/packages/${item.id}`}>管理发布</Link>
                    {mayRelease ? (
                      <Link href={`/publisher/packages/${item.id}/releases/new?publisher=${publisher.id}`}>
                        新建版本
                      </Link>
                    ) : <span>当前状态不可创建版本</span>}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {nextCursor ? (
          <Link className="page-next" href={`/publisher?${new URLSearchParams({
            publisher: publisher.id,
            cursor: nextCursor,
          })}`}>下一页<span aria-hidden="true"> →</span></Link>
        ) : null}
      </section>
    </main>
  );
}

export function NoPublisherMemberships() {
  return (
    <main id="main-content" className="console-state-wrap">
      <section className="console-empty">
        <p className="eyebrow">NO MEMBERSHIP</p>
        <h1>当前账号没有 Publisher 工作区</h1>
        <p>请由独立账号服务和运营流程授予 Publisher 成员资格；商店不会自行创建账号或组织。</p>
        <Link className="secondary-link" href="/">返回公开商店</Link>
      </section>
    </main>
  );
}
