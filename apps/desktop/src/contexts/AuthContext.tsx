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
import { getAuthSession, setAuthSession } from "../lib/store";

interface AuthContextValue {
  user: { id: string; name: string; picture: string } | null;
  loading: boolean;
  login: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<AuthContextValue["user"]>(null);
  const [loading, setLoading] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const isRefreshingRef = useRef(false);
  const utils = trpc.useUtils();

  const applyAuthState = async (data: {
    jwt: string;
    user: { id: string; name: string; picture: string };
  }) => {
    setUser(data.user);
    await setAuthSession(data);
  };

  const clearAuthState = async () => {
    setUser(null);
    await setAuthSession(null);
  };

  const refreshMutation = trpc.auth.refresh.useMutation();

  const refreshSession = async ({
    clearOnAnyFailure = false,
  }: {
    clearOnAnyFailure?: boolean;
  } = {}) => {
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
      const code = (err as { data?: { code?: string } })?.data?.code;
      if (clearOnAnyFailure || code === "UNAUTHORIZED") {
        await clearAuthState();
      }
      return false;
    } finally {
      isRefreshingRef.current = false;
    }
  };

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: async (data) => {
      await applyAuthState(data);
      await refreshSession();
      setLoading(false);
    },
    onError: (err) => {
      console.error("Login failed", err);
      setLoading(false);
    },
  });

  const verifyMutation = trpc.auth.verify.useMutation();

  useEffect(() => {
    const loadAuth = async () => {
      const saved = await getAuthSession();
      if (!saved?.jwt) {
        setAuthReady(true);
        return;
      }

      try {
        setLoading(true);
        const data = await verifyMutation.mutateAsync({ jwt: saved.jwt });
        await applyAuthState(data);
      } catch {
        await refreshSession({ clearOnAnyFailure: true });
      } finally {
        setLoading(false);
        setAuthReady(true);
      }
    };

    loadAuth().catch((err) => {
      console.error("Failed to load auth session", err);
      setLoading(false);
      setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    const setup = async () => {
      const handleUrl = (urlStr: string) => {
        const url = new URL(urlStr);
        const code = url.searchParams.get("code");
        if (code) {
          setLoading(true);
          loginMutation.mutate({ code });
        }
      };

      const startUrls = await getCurrent();
      (Array.isArray(startUrls) ? startUrls : [startUrls]).forEach((url) => {
        if (url) handleUrl(url);
      });

      cleanup = await onOpenUrl((urls) => {
        urls.forEach((url) => handleUrl(url));
      });
    };

    setup();

    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    if (!authReady || !user) return;

    const interval = setInterval(() => {
      refreshSession().catch((err) => {
        console.error("Failed to refresh auth session", err);
      });
    }, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, [authReady, user?.id]);

  const login = () => {
    return utils.auth.generateAuthUrl
      .fetch()
      .then(({ url }) => openUrl(url))
      .catch((err) => {
        console.error("Failed to generate auth URL", err);
      });
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
