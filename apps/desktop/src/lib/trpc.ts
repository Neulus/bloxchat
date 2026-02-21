import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@bloxchat/api";
import { createWSClient, httpBatchLink, wsLink, splitLink } from "@trpc/client";
import { getApiUrl, getAuthSession, toWsUrl } from "./store";

export const trpc = createTRPCReact<AppRouter>();

const apiUrl = await getApiUrl();

const wsClient = createWSClient({
  url: toWsUrl(apiUrl),
});

export const trpcClient = trpc.createClient({
  links: [
    splitLink({
      condition(op) {
        return op.type === "subscription";
      },
      true: wsLink({ client: wsClient }),
      false: httpBatchLink({
        url: apiUrl,
        async headers() {
          const saved = await getAuthSession();
          return saved ? { Authorization: `Bearer ${saved.jwt}` } : {};
        },
      }),
    }),
  ],
});
