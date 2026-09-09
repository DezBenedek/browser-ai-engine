import { useState } from "react";
import { useBrowserAI } from "browser-ai-engine/react";

export function ReactExample() {
  const { ready, loading, progress, error, loadModel, chat } = useBrowserAI();
  const [input, setInput] = useState("");
  const [reply, setReply] = useState("");

  return (
    <div style={{ maxWidth: 640 }}>
      <p>
        {loading
          ? `Loading… ${progress?.percent ?? 0}%`
          : ready
            ? "Ready"
            : (error ?? "Idle")}
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => void loadModel("qwen-2.5-0.5b")}>Load</button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask something…"
          style={{ flex: 1 }}
        />
        <button
          onClick={() => {
            if (!input.trim()) return;
            const q = input.trim();
            setInput("");
            void chat([{ role: "user", content: q }]).then(setReply);
          }}
        >
          Send
        </button>
      </div>
      <p style={{ whiteSpace: "pre-wrap" }}>{reply}</p>
    </div>
  );
}
