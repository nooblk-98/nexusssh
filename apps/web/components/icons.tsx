"use client";
import {
  AppWindow,
  Apple,
  BrickWall,
  Cloud,
  Container,
  Database,
  Globe,
  HardDrive,
  Monitor,
  Network,
  Router,
  Server,
  SquareTerminal,
  type LucideProps,
} from "lucide-react";
function Linux(props: LucideProps) {
  const size = props.size ?? 24;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.5c-2.3 0-3.6 1.9-3.6 4.4 0 1.3.3 2.2-.5 3.6C6.6 12.7 5 14.6 5 17.3c0 .6.1 1.1.3 1.6" />
      <path d="M12 2.5c2.3 0 3.6 1.9 3.6 4.4 0 1.3-.3 2.2.5 3.6 1.3 2.2 2.9 4.1 2.9 6.8 0 .6-.1 1.1-.3 1.6" />
      <path d="M8.6 19.6c1 .9 2.1 1.4 3.4 1.4s2.4-.5 3.4-1.4" />
      <path d="M4 18.5c1.2-.6 2.6-.3 3.3.6.6.8.6 2-.3 2.6-.9.6-2.6.3-3.4-.9-.3-.5-.1-1.9.4-2.3ZM20 18.5c-1.2-.6-2.6-.3-3.3.6-.6.8-.6 2 .3 2.6.9.6 2.6.3 3.4-.9.3-.5.1-1.9-.4-2.3Z" />
      <circle cx="10.4" cy="6.6" r=".6" fill="currentColor" />
      <circle cx="13.6" cy="6.6" r=".6" fill="currentColor" />
      <path d="M10.6 8.6 12 9.5l1.4-.9" />
    </svg>
  );
}
// Keep in sync with serverIcons in apps/api/src/controller.ts.
export const serverIcons = {
  linux: ["Linux", Linux],
  windows: ["Windows", AppWindow],
  apple: ["macOS", Apple],
  server: ["Server", Server],
  database: ["Database", Database],
  storage: ["Storage", HardDrive],
  router: ["Router", Router],
  cluster: ["Cluster", Network],
  cloud: ["Cloud", Cloud],
  container: ["Container", Container],
  terminal: ["Terminal", SquareTerminal],
  monitor: ["Workstation", Monitor],
  firewall: ["Firewall", BrickWall],
  globe: ["Web", Globe],
} as const;
export type ServerIconName = keyof typeof serverIcons;
export function ServerIcon({
  name,
  size = 20,
}: {
  name?: string;
  size?: number;
}) {
  const Icon = (serverIcons[name as ServerIconName] || serverIcons.linux)[1];
  return <Icon size={size} strokeWidth={1.5} />;
}
