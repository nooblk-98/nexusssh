export const consoleHelp = `Kubernetes console

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
help · clear · exit · Up/Down history · Ctrl+C cancel

This console supports the commands above through the saved cluster API.
Shell pipelines, local files, plugins and credential overrides are unavailable.`;

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
