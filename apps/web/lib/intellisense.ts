// Command-line suggestions: the user's own command history per server plus a
// curated Linux command library plus the user's command history per server.
const HISTORY_KEY = (serverId: string) => "nexus-history-" + serverId;
export function loadHistory(serverId: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY(serverId)) || "[]");
  } catch {
    return [];
  }
}
export function remember(serverId: string, command: string) {
  const c = command.trim();
  if (!c || c.length > 500) return;
  const next = [c, ...loadHistory(serverId).filter((h) => h !== c)].slice(
    0,
    500,
  );
  try {
    localStorage.setItem(HISTORY_KEY(serverId), JSON.stringify(next));
  } catch {}
}
const commands: Record<string, string[]> = {
  ls: ["-l", "-a", "-la", "-lh", "-lah", "-R", "-t", "-S", "--color=auto"],
  cd: ["..", "~", "-", "/var/log", "/etc"],
  pwd: ["-P", "-L"],
  touch: ["-a", "-m", "-c"],
  stat: ["-c", "-f", "-L"],
  file: ["-b", "-i", "-L"],
  tree: ["-a", "-d", "-L 2", "-h"],
  cp: ["-r", "-a", "-v", "-i", "-p"],
  mv: ["-i", "-v", "-n"],
  rm: ["-r", "-f", "-i", "-v"],
  mkdir: ["-p", "-v"],
  chmod: ["-R", "+x", "644", "755", "600"],
  chown: ["-R"],
  cat: ["-n"],
  tac: [],
  nl: ["-ba"],
  wc: ["-l", "-w", "-c", "-m"],
  sort: ["-n", "-r", "-u", "-k", "-t"],
  uniq: ["-c", "-d", "-u"],
  cut: ["-d", "-f", "-c"],
  paste: ["-d", "-s"],
  tr: ["-d", "-s"],
  diff: ["-u", "-r", "-w"],
  xargs: ["-0", "-n 1", "-P", "-I {}"],
  tail: ["-f", "-n 100", "-F"],
  head: ["-n 20"],
  less: ["+F", "-N", "-S"],
  grep: ["-r", "-i", "-n", "-v", "-E", "-l", "--color=auto"],
  rg: ["-n", "-i", "-l", "-g", "--hidden", "--glob '!node_modules'"],
  sed: ["-n", "-E", "-i", "-e"],
  awk: ["-F", "-v"],
  jq: [".", "-r", "-c", "-s"],
  find: [". -name", ". -type f", ". -type d", "-mtime -1", "-size +100M"],
  du: ["-sh", "-h --max-depth=1", "-sh *"],
  ncdu: ["-x", "--exclude"],
  lsblk: ["-f", "-o NAME,SIZE,FSTYPE,MOUNTPOINT"],
  mount: ["-a", "-t", "-o"],
  findmnt: ["-t", "-o TARGET,SOURCE,FSTYPE"],
  lsof: ["-i", "-p", "-u"],
  df: ["-h", "-i", "-T"],
  ps: ["aux", "-ef", "-efH", "aux --sort=-%mem"],
  top: ["-o %MEM", "-c"],
  htop: [],
  kill: ["-9", "-15", "-HUP"],
  pkill: ["-f", "-u"],
  pgrep: ["-a", "-f", "-u"],
  nice: ["-n"],
  renice: ["-n", "-p"],
  free: ["-h", "-m"],
  tar: ["-czvf", "-xzvf", "-xvf", "-tvf"],
  gzip: ["-k", "-d", "-c"],
  gunzip: ["-k", "-c"],
  xz: ["-k", "-d", "-T0"],
  zstd: ["-T0", "-d", "-k"],
  zip: ["-r"],
  unzip: ["-l", "-d"],
  ssh: ["-p", "-i", "-L", "-J"],
  scp: ["-r", "-P"],
  rsync: ["-avz", "-avz --progress", "--delete"],
  curl: ["-I", "-L", "-s", "-o", "-X POST", "-H"],
  wget: ["-O", "-c", "-q"],
  ping: ["-c 4"],
  dig: ["+short", "+trace", "-x"],
  nslookup: [],
  traceroute: ["-m", "-n"],
  mtr: ["-rw", "-c 10"],
  hostname: ["-I", "-f"],
  iptables: ["-L -n -v"],
  nft: ["list ruleset"],
  ip: ["a", "r", "link"],
  ss: ["-tulpn", "-s"],
  netstat: ["-tulpn"],
  systemctl: [
    "status",
    "start",
    "stop",
    "restart",
    "reload",
    "enable",
    "disable",
    "daemon-reload",
    "list-units --failed",
  ],
  journalctl: ["-u", "-f", "-xe", "--since today", "-n 100"],
  dmesg: ["-T", "-w", "-l err,warn"],
  timedatectl: ["status", "list-timezones"],
  hostnamectl: ["status"],
  loginctl: ["list-sessions", "user-status"],
  apt: ["update", "upgrade", "install", "remove", "search", "list --installed"],
  "apt-get": ["update", "upgrade", "install", "remove", "autoremove"],
  dnf: ["install", "update", "remove", "search"],
  yum: ["install", "update", "remove", "search"],
  pacman: ["-S", "-Ss", "-Q", "-R"],
  zypper: ["refresh", "update", "install", "search"],
  apk: ["update", "add", "del", "search", "info"],
  git: [
    "status",
    "pull",
    "push",
    "log --oneline",
    "diff",
    "checkout",
    "branch",
    "fetch",
    "clone",
    "commit -m",
    "stash",
  ],
  docker: [
    "ps",
    "ps -a",
    "images",
    "logs -f",
    "exec -it",
    "compose up -d",
    "compose down",
    "compose logs -f",
    "stats",
  ],
  podman: ["ps", "ps -a", "images", "logs -f", "exec -it", "compose up -d"],
  kubectl: [
    "get pods",
    "get pods -A",
    "get svc",
    "describe pod",
    "logs -f",
    "apply -f",
    "delete -f",
    "get nodes",
  ],
  helm: ["list", "status", "get values", "history", "upgrade --install"],
  terraform: ["init", "validate", "plan", "apply", "fmt -check", "state list"],
  ansible: ["-i", "--syntax-check", "--check", "-m ping"],
  env: ["-i"],
  printenv: [],
  watch: ["-n 2", "-d"],
  timeout: ["30s"],
  time: [],
  date: ["-Is", "+%F %T %Z"],
  seq: [],
  xxd: ["-l", "-g 1"],
  base64: ["-d", "-w 0"],
  openssl: ["version", "s_client -connect", "x509 -in"],
  "ssh-keygen": ["-lf", "-t ed25519", "-R"],
  nano: [],
  vim: [],
  sudo: ["-i", "-u"],
  tmux: ["new -s", "attach -t", "ls"],
  crontab: ["-l", "-e"],
  uname: ["-a", "-r"],
  whoami: [],
  uptime: [],
  history: [],
  clear: [],
  exit: [],
  echo: ["-e", "-n"],
  printf: [],
  man: ["-k"],
  which: ["-a"],
  whereis: [],
  type: ["-a"],
  help: [],
};
export type Suggestion = {
  text: string;
  kind: "history" | "command" | "option";
};
export function suggest(
  line: string,
  history: string[],
  useHistory: boolean,
  useArgs: boolean,
  limit: number,
): Suggestion[] {
  if (!line.trim()) return [];
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (text: string, kind: Suggestion["kind"]) => {
    if (text !== line && text.startsWith(line) && !seen.has(text)) {
      seen.add(text);
      out.push({ text, kind });
    }
  };
  if (useHistory) for (const h of history) add(h, "history");
  if (useArgs) {
    const words = line.split(" ");
    if (words.length === 1)
      for (const c of Object.keys(commands)) add(c, "command");
    else if (words[0] === "sudo" && words.length === 2)
      for (const c of Object.keys(commands)) add("sudo " + c, "command");
    else {
      const base = words[0] === "sudo" ? words[1] : words[0];
      const prefix = line.slice(0, line.lastIndexOf(" ") + 1);
      for (const o of commands[base] || []) add(prefix + o, "option");
    }
  }
  return out.slice(0, limit);
}
