import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import * as oidc from "openid-client";
import { db } from "../../../packages/database/index.js";
import { config } from "../../../packages/shared/config.js";
import {
  equal,
  hash,
  secret,
  unseal,
} from "../../../packages/shared/crypto.js";
import { logEvent } from "../../../packages/shared/request-context.js";
import { authenticate, admin } from "./auth.js";
import { audit, queue } from "./domain.js";
import { createWebSession } from "./sessions.js";
import { totpStep } from "./totp.js";
import { consumeOnce } from "./consume-once.js";

export const oidcEnabled = () =>
  !!(
    config.APP_URL?.startsWith("https://") &&
    config.OIDC_ISSUER &&
    config.OIDC_CLIENT_ID &&
    config.OIDC_CLIENT_SECRET
  );
const appOrigin = () => new URL(config.APP_URL!).origin;
let discovery: Promise<oidc.Configuration> | undefined;
async function provider() {
  if (!oidcEnabled())
    throw new BadRequestException("Single sign-on is not configured");
  return (discovery ??= oidc
    .discovery(
      new URL(config.OIDC_ISSUER!),
      config.OIDC_CLIENT_ID!,
      config.OIDC_CLIENT_SECRET!,
      undefined,
      { timeout: 10 },
    )
    .catch((e) => {
      discovery = undefined;
      throw e;
    }));
}
const cookie = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/api/auth/oidc",
  maxAge: 300000,
};
const stateKey = (state: string) => "nexus:oidc:" + hash(state);
type State = { browserHash: string; verifier: string; nonce: string };
const principal = (u: {
  id: string;
  organizationId: string;
  role: string;
}) => ({
  id: u.id,
  organizationId: u.organizationId,
  role: u.role,
  kind: "user" as const,
  scopes: [],
});

@Controller("api")
export class OidcController {
  @Get("auth/oidc/options") options() {
    return { enabled: oidcEnabled(), label: config.OIDC_LABEL };
  }
  @Get("auth/oidc/start") async start(@Res() res: Response) {
    const client = await provider();
    const state = oidc.randomState(),
      nonce = oidc.randomNonce(),
      verifier = oidc.randomPKCECodeVerifier(),
      browser = secret();
    const value: State = { browserHash: hash(browser), verifier, nonce };
    await (
      await queue.client
    ).set(stateKey(state), JSON.stringify(value), { EX: 300 });
    res.cookie("nexus_oidc", browser, cookie);
    const url = oidc.buildAuthorizationUrl(client, {
      redirect_uri: appOrigin() + "/api/auth/oidc/callback",
      scope: "openid profile email",
      response_type: "code",
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    });
    res.redirect(url.href);
  }
  @Get("auth/oidc/callback") async callback(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const state = z.string().min(20).max(256).parse(req.query.state);
      const redis = await queue.client;
      const raw = await redis.get(stateKey(state));
      if (!raw || typeof req.cookies?.nexus_oidc !== "string")
        throw new UnauthorizedException();
      const value: State = JSON.parse(raw);
      if (!equal(value.browserHash, hash(req.cookies.nexus_oidc)))
        throw new UnauthorizedException();
      if (!(await consumeOnce(redis, stateKey(state), raw)))
        throw new UnauthorizedException();
      res.clearCookie("nexus_oidc", { path: cookie.path });
      const client = await provider();
      const callback = new URL(appOrigin() + "/api/auth/oidc/callback");
      for (const [key, value] of Object.entries(req.query)) {
        if (typeof value !== "string" || value.length > 16384)
          throw new UnauthorizedException();
        callback.searchParams.set(key, value);
      }
      const tokens = await oidc.authorizationCodeGrant(client, callback, {
        pkceCodeVerifier: value.verifier,
        expectedState: state,
        expectedNonce: value.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims?.sub) throw new UnauthorizedException();
      const mapping = await db.oidcIdentity.findUnique({
        where: {
          issuer_subject: {
            issuer: client.serverMetadata().issuer,
            subject: claims.sub,
          },
        },
      });
      const user =
        mapping &&
        (await db.user.findUnique({ where: { id: mapping.userId } }));
      if (!user || user.disabled) throw new UnauthorizedException();
      if (user.totpSecret) {
        const challenge = secret();
        await redis.set(
          "nexus:oidc:mfa:" + hash(challenge),
          JSON.stringify({ userId: user.id, mappingId: mapping!.id }),
          { EX: 300 },
        );
        res.cookie("nexus_oidc_mfa", challenge, {
          ...cookie,
          sameSite: "strict",
        });
        res.redirect(appOrigin() + "/?sso=mfa");
        return;
      }
      await createWebSession(user.id, req, res, mapping!.id);
      await audit(principal(user), "login_sso", "success");
      res.redirect(appOrigin() + "/");
    } catch {
      logEvent("oidc_login_failed");
      res.clearCookie("nexus_oidc", { path: cookie.path });
      res.redirect((config.APP_URL ? appOrigin() : "") + "/?sso=failed");
    }
  }
  @Post("auth/oidc/complete") async complete(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    if (!oidcEnabled()) throw new UnauthorizedException();
    const { code } = z
      .object({ code: z.string().min(1).max(30) })
      .strict()
      .parse(body);
    const challenge = req.cookies?.nexus_oidc_mfa;
    if (typeof challenge !== "string" || challenge.length > 256)
      throw new UnauthorizedException("Single sign-on challenge expired");
    const redis = await queue.client,
      key = "nexus:oidc:mfa:" + hash(challenge);
    const pending = await redis.get(key);
    const state = pending
      ? z
          .object({ userId: z.uuid(), mappingId: z.uuid() })
          .parse(JSON.parse(pending))
      : null;
    const mapping =
      state &&
      (await db.oidcIdentity.findFirst({
        where: { id: state.mappingId, userId: state.userId },
      }));
    const user =
      mapping && (await db.user.findUnique({ where: { id: mapping.userId } }));
    if (!user || user.disabled || !user.totpSecret)
      throw new UnauthorizedException("Single sign-on challenge expired");
    let used = false;
    if (/^\d{6}$/.test(code)) {
      const step = totpStep(
        unseal<string>(user.totpSecret, config.ENCRYPTION_KEY, user.id),
        code,
      );
      if (step !== null)
        used =
          (
            await db.user.updateMany({
              where: { id: user.id, totpLastStep: { lt: step } },
              data: { totpLastStep: step },
            })
          ).count === 1;
    } else {
      const codes: string[] = JSON.parse(user.recoveryCodes),
        digest = hash(code.replace(/[^a-z0-9]/gi, "").toLowerCase());
      if (codes.includes(digest))
        used =
          (
            await db.user.updateMany({
              where: { id: user.id, recoveryCodes: user.recoveryCodes },
              data: {
                recoveryCodes: JSON.stringify(
                  codes.filter((v) => v !== digest),
                ),
              },
            })
          ).count === 1;
    }
    if (!used) {
      await audit(principal(user), "login_sso", "failed_mfa");
      throw new UnauthorizedException(
        "Valid authenticator or recovery code required",
      );
    }
    if (!pending || !(await consumeOnce(redis, key, pending)))
      throw new UnauthorizedException("Single sign-on challenge expired");
    res.clearCookie("nexus_oidc_mfa", { path: cookie.path });
    await createWebSession(user.id, req, res, mapping.id);
    await audit(principal(user), "login_sso", "success");
    return { authenticated: true };
  }
  @Get("sso-identities") async mappings(@Req() req: Request) {
    const p = await authenticate(req);
    admin(p);
    const users = await db.user.findMany({
      where: { organizationId: p.organizationId },
      select: { id: true },
    });
    return db.oidcIdentity.findMany({
      where: { userId: { in: users.map((u) => u.id) } },
      take: 500,
    });
  }
  @Post("sso-identities") async map(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    if (!oidcEnabled())
      throw new BadRequestException("Configure OIDC before mapping identities");
    const a = z
      .object({ userId: z.uuid(), subject: z.string().min(1).max(255) })
      .strict()
      .parse(body);
    if (
      !(await db.user.findFirst({
        where: {
          id: a.userId,
          organizationId: p.organizationId,
          disabled: false,
        },
      }))
    )
      throw new NotFoundException("User unavailable");
    const client = await provider();
    const result = await db.oidcIdentity.create({
      data: {
        userId: a.userId,
        issuer: client.serverMetadata().issuer,
        subject: a.subject,
      },
    });
    await audit(p, "sso_identity_mapped", "success");
    return result;
  }
  @Delete("sso-identities/:id") async remove(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await authenticate(req);
    admin(p);
    const row = await db.oidcIdentity.findUnique({
      where: { id: z.uuid().parse(id) },
    });
    if (
      !row ||
      !(await db.user.findFirst({
        where: { id: row.userId, organizationId: p.organizationId },
      }))
    )
      throw new NotFoundException("Identity unavailable");
    await db.oidcIdentity.delete({ where: { id } });
    await db.webSession.deleteMany({ where: { userId: row.userId } });
    await audit(p, "sso_identity_removed", "success");
    return { deleted: true };
  }
}
