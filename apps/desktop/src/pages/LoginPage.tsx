import { SiRoblox } from "react-icons/si";
import { LuMessageCircle } from "react-icons/lu";
import { useAuth } from "../contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";

export const LoginPage = () => {
  const { user, login, loading } = useAuth();
  const nav = useNavigate();

  if (user) {
    return (
      <div className="flex flex-col items-center justify-center h-full space-y-6 p-8 text-center">
        <h1 className="text-2xl font-bold">Welcome back, {user.name}!</h1>
        <p className="text-muted-foreground text-sm">You are logged in.</p>
        <Button onClick={() => nav("/")}>
          <LuMessageCircle size={16} />
          Go to chat
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full space-y-6 p-8 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Welcome to BloxChat</h1>
        <p className="text-muted-foreground text-sm">
          Please sign in to continue
        </p>
      </div>
      <Button onClick={login}>
        <SiRoblox size={16} />
        {loading ? "Logging in..." : "Login with Roblox"}
      </Button>
    </div>
  );
};
