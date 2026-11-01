export const consoleHelp = `Kubernetes console

kubectl config set-context --current --namespace=apps
kubectl get pods -A
kubectl get deployments -n apps
kubectl describe pod/api-1 -n apps
kubectl logs api-1 -c api --tail=200
kubectl scale deployment/api --replicas=3
kubectl rollout restart deployment/api
kubectl delete pod/api-1
kubectl patch deployment/api --type=merge -p '{"spec":{"replicas":2}}'
kubectl apply -f -    (paste one manifest, then Ctrl+D)
kubectl version

Use -o json or -o yaml for resource output. Lists contain up to 100 items;
use --continue with the returned cursor for another page.
set-context changes this console tab's default namespace; -n overrides one command.
help · clear · exit · Up/Down history · Ctrl+C cancel

This console supports the commands above through the saved cluster API.
Shell pipelines, local files, plugins and credential overrides are unavailable.`;

// Namespace selection is local to one console tab. Never read or modify the
// saved kubeconfig, accept another context, or send config commands to the API.
export function consoleNamespace(command: string[]): string | null {
  const args = command[0] === "kubectl" ? command.slice(1) : command;
  if (args[0] !== "config" || args[1] !== "set-context") return null;
  let current = false,
    namespace: string | undefined;
  const invalid = () =>
    new Error(
      "Use kubectl config set-context --current --namespace=NAME to switch this console's namespace.",
    );
  for (let i = 2; i < args.length; i++) {
    const part = args[i];
    if (part === "--current" && !current) current = true;
    else if (namespace === undefined && ["--namespace", "-n"].includes(part))
      namespace = args[++i];
    else if (namespace === undefined && part.startsWith("--namespace="))
      namespace = part.slice(12);
    else throw invalid();
  }
  if (
    !current ||
    !namespace ||
    namespace.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(namespace)
  )
    throw invalid();
  return namespace;
}

// Split shell-style quotes for a single argv array. Nothing is evaluated by a
// local shell, including substitutions inside quotes or remote output.
export function splitConsoleCommand(line: string): string[] {
  if (line.length > 16384 || /[\r\n\x00]/.test(line))
    throw new Error("Enter one command of at most 16 KB.");
  const argv: string[] = [];
  let word = "",
    quote = "",
    escaped = false,
    started = false;
  for (const char of line) {
    if (escaped) {
      word += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        argv.push(word);
        word = "";
        started = false;
      }
    } else if (/[|;&<>`$]/.test(char))
      throw new Error(
        "Enter one kubectl command. Shell operators and substitutions are unavailable.",
      );
    else {
      word += char;
      started = true;
    }
  }
  if (quote || escaped)
    throw new Error("Close the command's quotes or escape sequence.");
  if (started) argv.push(word);
  if (!argv.length || argv.length > 64)
    throw new Error("Enter a command with at most 64 arguments.");
  return argv;
}
