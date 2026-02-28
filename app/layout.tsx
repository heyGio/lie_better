import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Golden gAI Call Terminal",
  description: "Fictional social persuasion game under time pressure."
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
