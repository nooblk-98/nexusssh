"use client";
import type { ReactNode } from "react";
import {
  Bot,
  CircleArrowLeft,
  CirclePlay,
  History,
  Info,
  Plug,
  ScrollText,
  ShieldCheck,
  ShieldHalf,
  SlidersHorizontal,
  User,
  Users,
  UsersRound,
  Wallet,
} from "lucide-react";
import type { Row } from "../../lib/api";
import { navigate } from "../../lib/router";
import { Logo } from "../ui";
import { Account, Identities, Preferences } from "./personal";
import {
  ActiveSessions,
  Security,
  SessionHistory,
  Teams,
  UsersPage,
} from "./admin";
import { Agents, Approvals, AuditLog, McpServer } from "./mcp";
import { VpnProfiles } from "./vpn";
import { Network } from "lucide-react";
import { About } from "./about";

type Page = {
  slug: string;
  label: string;
  icon: typeof User;
  admin?: boolean;
  render: (me: Row) => ReactNode;
};
const sections: { label: string; pages: Page[] }[] = [
  {
    label: "My Settings",
    pages: [
      {
        slug: "account",
        label: "Account",
        icon: User,
        render: (me) => <Account me={me} />,
      },
      {
        slug: "preferences",
        label: "Preferences",
        icon: SlidersHorizontal,
        render: () => <Preferences />,
      },
      {
        slug: "identities",
        label: "Identities",
        icon: Wallet,
        admin: true,
        render: () => <Identities />,
      },
    ],
  },
  {
    label: "Administration",
    pages: [
      {
        slug: "vpn",
        label: "VPN",
        icon: Network,
        admin: true,
        render: () => <VpnProfiles />,
      },
      {
        slug: "users",
        label: "Users",
        icon: Users,
        admin: true,
        render: (me) => <UsersPage me={me} />,
      },
      {
        slug: "teams",
        label: "Teams",
        icon: UsersRound,
        admin: true,
        render: () => <Teams />,
      },
      {
        slug: "active-sessions",
        label: "Active Sessions",
        icon: CirclePlay,
        render: () => <ActiveSessions />,
      },
      {
        slug: "history",
        label: "History",
        icon: History,
        render: () => <SessionHistory />,
      },
      {
        slug: "security",
        label: "Security",
        icon: ShieldHalf,
        admin: true,
        render: () => <Security />,
      },
    ],
  },
  {
    label: "AI & MCP",
    pages: [
      {
        slug: "mcp",
        label: "MCP Server",
        icon: Plug,
        render: () => <McpServer />,
      },
      {
        slug: "agents",
        label: "AI Agents",
        icon: Bot,
        admin: true,
        render: () => <Agents />,
      },
      {
        slug: "approvals",
        label: "Approvals",
        icon: ShieldCheck,
        admin: true,
        render: () => <Approvals />,
      },
      {
        slug: "audit",
        label: "Audit Log",
        icon: ScrollText,
        admin: true,
        render: () => <AuditLog />,
      },
    ],
  },
  {
    label: "Application",
    pages: [
      {
        slug: "about",
        label: "About",
        icon: Info,
        render: () => <About />,
      },
    ],
  },
];
export function Settings({ me, slug }: { me: Row; slug: string }) {
  const admin = ["owner", "administrator"].includes(me.role);
  const visible = sections
    .map((s) => ({ ...s, pages: s.pages.filter((p) => admin || !p.admin) }))
    .filter((s) => s.pages.length);
  const page =
    visible.flatMap((s) => s.pages).find((p) => p.slug === slug) ||
    visible[0].pages[0];
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings">
        <Logo />
        <button className="nav-item" onClick={() => navigate("/")}>
          <CircleArrowLeft size={18} />
          <span>Back</span>
        </button>
        {visible.map((s) => (
          <div key={s.label}>
            <div className="nav-label">{s.label}</div>
            {s.pages.map((p) => (
              <button
                key={p.slug}
                className={"nav-item" + (p.slug === page.slug ? " active" : "")}
                aria-current={p.slug === page.slug ? "page" : undefined}
                title={p.label}
                onClick={() => navigate("/settings/" + p.slug)}
              >
                <p.icon size={18} />
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="settings-main">{page.render(me)}</div>
    </div>
  );
}
