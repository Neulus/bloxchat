import crypto from "crypto";
import { env } from "../config/env";

const ALGORITHM = "aes-256-cbc";
const IV_LENGTH = 16;
const ENCRYPTION_KEY = Buffer.from(env.ENCRYPTION_KEY, "hex");

export type SessionData = {
  at: string;
  rt?: string;
};

export function encryptSessionData(data: SessionData): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(JSON.stringify(data));
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export function decryptSessionData(text: string): SessionData {
  const textParts = text.split(":");
  const iv = Buffer.from(textParts.shift()!, "hex");
  const encryptedText = Buffer.from(textParts.join(":"), "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  const parsed = JSON.parse(decrypted.toString()) as {
    at?: unknown;
    rt?: unknown;
  };

  if (typeof parsed.at !== "string") {
    throw new Error("Invalid encrypted session data");
  }

  if (parsed.rt !== undefined && typeof parsed.rt !== "string") {
    throw new Error("Invalid encrypted session data");
  }

  return { at: parsed.at, rt: parsed.rt };
}
