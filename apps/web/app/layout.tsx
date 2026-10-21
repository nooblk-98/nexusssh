import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "NexusSSH · Infrastructure, connected",
  description: "Secure remote access for your team and AI agents",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
