import type { RouterOutputs } from "@bloxchat/api";
import { load } from "@tauri-apps/plugin-store";

export type AuthSession = RouterOutputs["auth"]["login"];

type StoreSchema = {
  auth: AuthSession | null;
  apiUrl: string;
};

export const DEFAULT_API_HOST = "bloxchat.logix.lol";
export const DEFAULT_API_URL = `https://${DEFAULT_API_HOST}`;

const defaults: StoreSchema = {
  auth: null,
  apiUrl: DEFAULT_API_URL,
};

const storePromise = load("store.json", {
  autoSave: true,
  defaults,
});

const getStore = () => storePromise;

const storeGet = async <K extends keyof StoreSchema>(key: K) => {
  const store = await getStore();
  const value = await store.get(key);
  return (value as StoreSchema[K]) ?? defaults[key];
};

const storeSet = async <K extends keyof StoreSchema>(
  key: K,
  value: StoreSchema[K],
) => {
  const store = await getStore();
  await store.set(key, value);
  await store.save();
};

export const normalizeApiUrl = (value: string | null | undefined) => {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return DEFAULT_API_URL;

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  return withProtocol.replace(/\/+$/, "");
};

export const toWsUrl = (apiUrl: string) =>
  apiUrl.replace(/^https/i, "wss").replace(/^http/i, "ws");

export const getApiUrl = async () => normalizeApiUrl(await storeGet("apiUrl"));

export const setApiUrl = async (value: string) => {
  const normalized = normalizeApiUrl(value);
  await storeSet("apiUrl", normalized);
  return normalized;
};

export const getAuthSession = async () => storeGet("auth");

export const setAuthSession = async (session: AuthSession | null) => {
  await storeSet("auth", session);
};
