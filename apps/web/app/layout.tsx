import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "NexusSSH",
  description: "Remote access to your servers for your team and AI agents",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the saved UI theme before first paint; preferences confirm it after sign-in. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{var t=localStorage.getItem("nexus-theme")||"auto";if(t==="dark"||(t==="auto"&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}',
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
