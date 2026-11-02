import type { Request, Response } from "express";
import { db } from "../../../packages/database/index.js";
import { config } from "../../../packages/shared/config.js";
import { hash, secret } from "../../../packages/shared/crypto.js";

export async function createWebSession(
  userId: string,
  req: Request,
  res: Response,
  oidcIdentityId?: string,
) {
  const token = secret();
  await db.webSession.create({
    data: {
      userId,
      oidcIdentityId,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + 28800000),
    },
  });
  res.cookie("nexus_session", token, {
    httpOnly: true,
    secure: config.APP_URL
      ? new URL(config.APP_URL).protocol === "https:"
      : req.headers.origin?.startsWith("https://") === true,
    sameSite: "strict",
    path: "/",
    maxAge: 28800000,
  });
}
