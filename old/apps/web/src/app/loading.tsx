export default function Loading() {
  return (
    <main id="main-content" className="loading-main" aria-busy="true" aria-label="正在加载目录">
      <p className="eyebrow">CATALOG / LOADING</p>
      <h1>正在读取已发布目录</h1>
      <div className="loading-lines" aria-hidden="true"><i /><i /><i /></div>
    </main>
  );
}
