import z from "zod";
import { publicProcedure, t } from "../trpc";
import { TRPCError } from "@trpc/server";
import { env } from "../config/env";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { ExtendedJwtUser, JwtUser } from "../types";
import {
  decryptSessionData,
  encryptSessionData,
} from "../services/sessionCrypto";

const RobloxTokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  token_type: z.string(),
  expires_in: z.number(),
});

const RobloxUserSchema = z.object({
  sub: z.string(),
  preferred_username: z.string(),
  nickname: z.string(),
  picture: z.string(),
});

async function exchangeRobloxToken(params: Record<string, string>) {
  const res = await fetch("https://apis.roblox.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.ROBLOX_CLIENT_ID,
      client_secret: env.ROBLOX_SECRET_KEY,
      ...params,
    }),
  });

  if (!res.ok) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Roblox token exchange failed",
    });
  }

  return RobloxTokenSchema.parse(await res.json());
}

async function fetchRobloxUser(accessToken: string) {
  const res = await fetch("https://apis.roblox.com/oauth/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to fetch Roblox user info",
    });
  }

  return RobloxUserSchema.parse(await res.json());
}

async function createSession(
  tokenParams: Record<string, string>,
  existingRefreshToken?: string,
) {
  const tokenData = await exchangeRobloxToken(tokenParams);
  const userData = await fetchRobloxUser(tokenData.access_token);

  const sensitiveData = {
    at: tokenData.access_token,
    rt: tokenData.refresh_token ?? existingRefreshToken,
  };

  const jwtToken = jwt.sign(
    {
      robloxUserId: userData.sub,
      username: userData.preferred_username,
      displayName: userData.nickname,
      picture: userData.picture,
      data: encryptSessionData(sensitiveData),
    } satisfies ExtendedJwtUser,
    env.JWT_SECRET,
    { expiresIn: "1h" },
  );

  return {
    jwt: jwtToken,
    user: {
      robloxUserId: userData.sub,
      username: userData.preferred_username,
      displayName: userData.nickname,
      picture: userData.picture,
    } satisfies JwtUser,
  };
}

export const authRouter = t.router({
  generateAuthUrl: publicProcedure.query(() => {
    const baseUrl = "https://apis.roblox.com/oauth/v1/authorize";
    const state = crypto.randomBytes(16).toString("hex");
    const params = new URLSearchParams({
      client_id: env.ROBLOX_CLIENT_ID,
      response_type: "code",
      redirect_uri: "bloxchat://auth",
      scope: "openid profile",
      state,
    });

    return {
      url: `${baseUrl}?${params.toString()}`,
      state,
    };
  }),

  login: publicProcedure
    .input(z.object({ code: z.string() }))
    .mutation(async ({ input }) => {
      return createSession({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: "bloxchat://auth",
      });
    }),

  refresh: publicProcedure
    .input(z.object({ jwt: z.string() }))
    .mutation(async ({ input }) => {
      let payload: any;
      try {
        payload = jwt.verify(input.jwt, env.JWT_SECRET, {
          ignoreExpiration: true,
        });
      } catch {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid session",
        });
      }

      const decrypted = decryptSessionData(payload.data);

      if (!decrypted.rt) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "No refresh token",
        });
      }

      return createSession(
        {
          grant_type: "refresh_token",
          refresh_token: decrypted.rt,
        },
        decrypted.rt,
      );
    }),
});
