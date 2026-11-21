import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "SocialAgent · Your brand, always in motion",
  description:
    "Evidence-led social media planning, creative production, and human review.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
