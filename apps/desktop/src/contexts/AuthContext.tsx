import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { trpc } from "../lib/trpc";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AuthSession, getAuthSession, setAuthSession } from "../lib/store";

interface AuthContextValue {
  user: AuthSession["user"] | null;
  loading: boolean;
  login: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<AuthContextValue["user"]>(null);
  const [loading, setLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const isRefreshingRef = useRef(false);
  const utils = trpc.useUtils();

  const applyAuthState = async (data: {
    jwt: string;
    user: AuthContextValue["user"];
  }) => {
    if (!data.user) {
      await clearAuthState();
      return;
    }

    setUser(data.user);
    await setAuthSession({
      jwt: data.jwt,
      user: data.user,
    });
  };

  const clearAuthState = async () => {
    setUser(null);
    await setAuthSession(null);
  };

  const refreshMutation = trpc.auth.refresh.useMutation();
  const loginMutation = trpc.auth.login.useMutation();

  const refreshSession = async (clearOnAnyFailure = false) => {
    if (isRefreshingRef.current) return false;

    const saved = await getAuthSession();
    if (!saved?.jwt) {
      await clearAuthState();
      return false;
    }

    try {
      isRefreshingRef.current = true;
      const data = await refreshMutation.mutateAsync({ jwt: saved.jwt });
      await applyAuthState(data);
      return true;
    } catch (err) {
      const isUnauthorized = (err as any)?.data?.code === "UNAUTHORIZED";
      if (clearOnAnyFailure || isUnauthorized) {
        await clearAuthState();
      }
      return false;
    } finally {
      isRefreshingRef.current = false;
    }
  };

  useEffect(() => {
    const initAuth = async () => {
      const saved = await getAuthSession();
      if (saved?.jwt) {
        await refreshSession(true);
      }
      setLoading(false);
      setAuthReady(true);
    };
    initAuth();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const handleUrl = async (urlStr: string) => {
      try {
        const url = new URL(urlStr);
        const code = url.searchParams.get("code");
        if (code) {
          setLoading(true);
          const data = await loginMutation.mutateAsync({ code });
          await applyAuthState(data);
        }
      } catch (err) {
        console.error("Auth callback error:", err);
      } finally {
        setLoading(false);
      }
    };

    const setupDeepLinks = async () => {
      const startUrls = await getCurrent();
      const urls = Array.isArray(startUrls) ? startUrls : [startUrls];
      for (const url of urls) {
        if (url) await handleUrl(url);
      }

      unlisten = await onOpenUrl((urls) => {
        urls.forEach(handleUrl);
      });
    };

    setupDeepLinks();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (!authReady || !user) return;

    const interval = setInterval(
      () => {
        refreshSession();
      },
      45 * 60 * 1000,
    );

    return () => clearInterval(interval);
  }, [authReady, user?.robloxUserId]);

  const login = async () => {
    try {
      const { url } = await utils.auth.generateAuthUrl.fetch();
      await openUrl(url);
    } catch (err) {
      console.error("Failed to start login flow", err);
    }
  };

  return (
    <AuthContext.Provider value={{ user, login, loading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
