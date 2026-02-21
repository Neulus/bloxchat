import { useEffect, useState } from "react";
import { DEFAULT_API_HOST, getApiUrl, setApiUrl } from "../lib/store";

export const SettingsPage = () => {
  const [apiUrl, setApiUrlInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const loadSettings = async () => {
      const currentApiUrl = await getApiUrl();
      setApiUrlInput(currentApiUrl);
      setIsLoading(false);
    };

    loadSettings();
  }, []);

  const save = async () => {
    if (isSaving) return;

    setIsSaving(true);
    try {
      await setApiUrl(apiUrl);
      window.location.reload();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-background text-primary p-6">
      <h1 className="text-xl font-bold mb-4">Settings</h1>

      <div className="max-w-xl space-y-2">
        <label htmlFor="api-url" className="text-sm font-medium">
          API Server URL
        </label>
        <input
          id="api-url"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          value={apiUrl}
          onChange={(event) => setApiUrlInput(event.target.value)}
          disabled={isLoading || isSaving}
          placeholder={DEFAULT_API_HOST}
        />
        <p className="text-xs text-muted-foreground">
          Default: {DEFAULT_API_HOST}. You can enter a full URL or just a host.
          The app reloads after saving.
        </p>
        <button
          className="rounded-md bg-brand px-4 py-2 text-white text-sm font-medium hover:bg-brand/80 disabled:opacity-60"
          onClick={save}
          disabled={isLoading || isSaving}
        >
          {isSaving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
};
