import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lie Better: 120 Seconds",
  description: "Voice persuasion thriller game under intense time pressure."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
