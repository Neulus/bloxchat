import { SiRoblox } from "react-icons/si";
import { LuMessageCircle } from "react-icons/lu";
import { useAuth } from "../contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { useEffect, useState } from "react";

export const LoginPage = () => {
  const { user, login, loading } = useAuth();
  const nav = useNavigate();

  const [showLoading, setShowLoading] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setShowLoading(false), 1000);
    return () => clearTimeout(timer);
  }, []);

  if (loading || showLoading)
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <img src="/app-icon.png" className="w-32 h-32 mb-8 animate-bounce" />
      </div>
    );

  if (user) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <img src="/app-icon.png" className="w-32 h-32 mb-8" />
        <h1 className="text-2xl mb-2 font-bold">
          Welcome back, {user.username}!
        </h1>
        <p className="text-muted-foreground text-sm mb-8">You are logged in.</p>
        <Button onClick={() => nav("/")}>
          <LuMessageCircle size={16} />
          Go to chat
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center">
      <img src="/app-icon.png" className="w-32 h-32 mb-8 animate-pulse" />

      <h1 className="text-2xl mb-2 font-bold">Welcome to BloxChat</h1>
      <p className="text-muted-foreground text-sm mb-8">
        Please sign in to continue
      </p>

      <Button onClick={login}>
        <SiRoblox size={16} />
        {loading ? "Logging in..." : "Login with Roblox"}
      </Button>
    </div>
  );
};
