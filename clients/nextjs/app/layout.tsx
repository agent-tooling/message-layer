import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Message Layer Team Client",
  description: "Agent-first team messaging example built on message-layer.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
