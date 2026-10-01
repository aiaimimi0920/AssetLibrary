import type { Metadata } from "next";
import type { ReactNode } from "react";
import { publicOrigin } from '@/lib/public-origin';
import "./globals.css";

export function generateMetadata(): Metadata {
  const origin = publicOrigin();
  return {
  ...(origin ? { metadataBase: new URL(origin) } : { robots: { index: false, follow: true } }),
  title: { default: "AssetLibrary", template: "%s | AssetLibrary" },
  description: "浏览经过验证、可独立安装的 Neuro Art 与 Capability 包。",
  };
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main-content">跳至主要内容</a>
        {children}
      </body>
    </html>
  );
}
