import Link from "next/link";
import type { PublishedRelease } from "@/lib/public-details";
import type { PublicApiFailure } from "@/lib/public-api";

const productLabels = { loom: "Loom", hook: "Hook" } as const;

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}

export function ReleaseList({ items, markLatest = false }: { items: PublishedRelease[]; markLatest?: boolean }) {
  if (items.length === 0) {
    return (
      <section className="availability-note" aria-labelledby="versions-empty">
        <p className="eyebrow">VERSION / EMPTY</p>
        <h2 id="versions-empty">当前没有可安装版本</h2>
        <p>目录身份仍然有效，但没有同时通过发布、制品、签名密钥和撤销门禁的版本。</p>
      </section>
    );
  }

  return (
    <section className="release-section" aria-labelledby="version-heading">
      <div className="release-heading">
        <div>
          <p className="eyebrow">VERIFIED RELEASES</p>
          <h2 id="version-heading">版本与安装元数据</h2>
        </div>
        <p>按发布时间从新到旧排列。下载前仍需由客户端验证摘要、签名和兼容性。</p>
      </div>
      <div className="release-list">
        {items.map((release, index) => {
          const isLatest = markLatest && index === 0;
          return (
          <article className={`release-row${isLatest ? " release-current" : ""}`} key={release.id}>
            <header className="release-title">
              <div>
                <span className="release-version">v{release.version}</span>
                {isLatest ? <span className="latest-mark">最新公开版本</span> : null}
              </div>
              <time dateTime={release.published_at}>{formatDate(release.published_at)} 发布</time>
            </header>

            <div className="release-facts">
              <section aria-labelledby={`compatibility-${release.id}`}>
                <h3 id={`compatibility-${release.id}`}>宿主兼容性</h3>
                {release.compatibility.products.length === 0 ? (
                  <p className="fact-warning">未声明宿主版本约束；安装端不得自动推断兼容。</p>
                ) : (
                  <ul className="fact-list">
                    {release.compatibility.products.map((product) => (
                      <li key={product.name}>
                        <span>{productLabels[product.name]}</span>
                        <code>{product.version_requirement}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section aria-labelledby={`permissions-${release.id}`}>
                <h3 id={`permissions-${release.id}`}>权限声明</h3>
                {release.permissions.length === 0 ? <p>未声明额外权限。</p> : (
                  <ul className="permission-list">
                    {release.permissions.map((permission) => <li key={permission}><code>{permission}</code></li>)}
                  </ul>
                )}
              </section>
            </div>

            <div className="artifact-list">
              {release.artifacts.map((artifact) => (
                <dl className="artifact-row" key={artifact.artifact_id}>
                  <div><dt>制品</dt><dd>{artifact.file_name}</dd></div>
                  <div><dt>大小 / 类型</dt><dd>{formatBytes(artifact.size_bytes)} · {artifact.media_type}</dd></div>
                  <div><dt>签名密钥</dt><dd><code>{artifact.signing_key_id}</code></dd></div>
                  <div className="digest-field"><dt>SHA-256</dt><dd><code>{artifact.digest}</code></dd></div>
                </dl>
              ))}
            </div>
          </article>
          );
        })}
      </div>
    </section>
  );
}

export function ReleaseFailure({ failure }: { failure: PublicApiFailure }) {
  return (
    <section className="availability-note release-error" role="alert" aria-labelledby="versions-error">
      <p className="eyebrow">VERSION / UNAVAILABLE</p>
      <h2 id="versions-error">版本信息暂时不可用</h2>
      <p>{failure === "invalid_request"
        ? "分页链接已经失效，请返回此包的第一页。"
        : "版本投影未通过读取或合同校验。系统不会用不完整的制品信息提供安装入口。"}</p>
    </section>
  );
}

export function ReleasePagination({ slug, cursor }: { slug: string; cursor: string | null }) {
  return cursor ? (
    <Link className="page-next" href={`/packages/${encodeURIComponent(slug)}?cursor=${encodeURIComponent(cursor)}`} rel="next">
      更早版本<span aria-hidden="true"> →</span>
    </Link>
  ) : null;
}
