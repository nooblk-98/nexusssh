import { Controller, HttpException, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { authenticate, human } from "./auth.js";
import { audit, authorize, connection, sshLimits } from "./domain.js";
import { healthFailureCategory } from "./health.js";
import { connect, resolveAllowed } from "../../../packages/ssh-core/index.js";
import { prepareVpn } from "../../../packages/ssh-core/vpn.js";
import {
  connectionAdvice,
  type DiagnosticResult,
} from "../../../packages/shared/diagnostics.js";
const active = new Set<string>();
@Controller("api/servers")
export class DiagnosticsController {
  @Post(":id/diagnostics") async diagnose(
    @Req() req: Request,
    @Param("id") id: string,
  ): Promise<DiagnosticResult> {
    const p = await authenticate(req);
    human(p);
    await authorize(p, z.uuid().parse(id), "server_test_connection");
    if (active.has(p.id) || active.size >= 8)
      throw new HttpException(
        "A diagnostic is already running. Try again shortly.",
        429,
      );
    active.add(p.id);
    const steps: DiagnosticResult["steps"] = [
      "Configuration",
      "VPN gateway",
      "DNS and destination policy",
      "Bastion authentication",
      "SSH host key and authentication",
    ].map((stage) => ({ stage, status: "not_run", message: "Not tested" }));
    let stage = 0;
    try {
      const c = await connection(id, p.organizationId),
        limits = await sshLimits(p.organizationId);
      if (!c.fingerprint)
        throw new Error(
          "Verify and save the SSH host fingerprint before connecting",
        );
      steps[stage++] = {
        stage: steps[0].stage,
        status: "passed",
        message: "Saved configuration and host fingerprint found",
      };
      const vpn = c.vpn || c.bastion?.vpn;
      const tunnel = vpn ? await prepareVpn(vpn, limits.vpnGateway) : undefined;
      steps[stage] = {
        stage: steps[stage].stage,
        status: vpn ? "passed" : "skipped",
        message: vpn
          ? "Gateway accepted the profile; peer connectivity is tested by SSH below"
          : "Direct route selected",
      };
      stage++;
      await resolveAllowed(
        c.host,
        limits.cidrs,
        vpn?.config.dns.length ? tunnel?.resolve : undefined,
      );
      if (c.bastion)
        await resolveAllowed(
          c.bastion.host,
          limits.cidrs,
          vpn?.config.dns.length ? tunnel?.resolve : undefined,
        );
      steps[stage] = {
        stage: steps[stage].stage,
        status: "passed",
        message: "Hostnames resolve to permitted destinations",
      };
      stage++;
      if (c.bastion) {
        const client = await connect({ ...c.bastion, vpn }, limits);
        client.end();
      }
      steps[stage] = {
        stage: steps[stage].stage,
        status: c.bastion ? "passed" : "skipped",
        message: c.bastion
          ? "Bastion host key and authentication verified"
          : "No bastion selected",
      };
      stage++;
      const client = await connect(c, limits);
      client.end();
      steps[stage] = {
        stage: steps[stage].stage,
        status: "passed",
        message: "SSH host key and credentials verified; no command was run",
      };
      await audit(p, "connection_diagnostics", "success", id);
      return { authenticationVerified: true, steps };
    } catch (e) {
      const category = healthFailureCategory(e);
      steps[stage] = {
        stage: steps[stage].stage,
        status: "failed",
        message: `Connection check failed (${category.replaceAll("_", " ")})`,
        action: connectionAdvice(category),
      };
      await audit(p, "connection_diagnostics", "failed", id);
      return { authenticationVerified: false, steps };
    } finally {
      active.delete(p.id);
    }
  }
}
