export type DiagnosticStep = {
  stage: string;
  status: "passed" | "skipped" | "failed" | "not_run";
  message: string;
  action?: string;
};
export type DiagnosticResult = {
  authenticationVerified: boolean;
  steps: DiagnosticStep[];
};
export function connectionAdvice(category: string) {
  const advice: Record<string, string> = {
    route:
      "Check the VPN peer endpoint and AllowedIPs, then verify the bastion route.",
    policy:
      "Ask an administrator to allow the destination network under Settings → Security.",
    configuration:
      "Compare the saved host fingerprint with the server and check the selected identity.",
    dns: "Check the hostname and the DNS servers in the selected VPN profile.",
    timeout:
      "Check routing, firewall rules and whether the destination port is reachable.",
    network:
      "Check that the server and SSH service are running and reachable on the configured port.",
  };
  return (
    advice[category] || "Check the connection configuration and try again."
  );
}
