import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "St. John Fisher University — Catalog",
  description:
    "Interactive academic catalog for St. John Fisher University. Programs, courses, prerequisites, and requirement pathways.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
