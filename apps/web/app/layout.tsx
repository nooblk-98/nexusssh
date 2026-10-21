import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "NexusSSH · Infrastructure, connected",
  description: "Secure remote access for your team and AI agents",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{if(localStorage.getItem("nexus-theme")==="light")document.documentElement.classList.add("light")}catch(e){}',
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
