import {
  createContext,
  useContext,
  useEffect,
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
  const utils = trpc.useUtils();

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: async (data) => {
      setUser(data.user);
      setLoading(false);
      await setAuthSession(data);
    },
    onError: (err) => {
      console.error("Login failed", err);
      setLoading(false);
    },
  });

  const verifyMutation = trpc.auth.verify.useMutation({
    onSuccess: async (data) => {
      setUser(data.user);
      setLoading(false);
      await setAuthSession(data);
    },
    onError: () => {
      setUser(null);
      setLoading(false);
    },
  });

  useEffect(() => {
    const loadAuth = async () => {
      const saved = await getAuthSession();
      if (saved) {
        setLoading(true);
        verifyMutation.mutate({ jwt: saved.jwt });
      }
    };
    loadAuth();
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
