"use client";
import { useState } from "react";
export default function Join() {
  const [message, setMessage] = useState("");
  return (
    <main className="login-form">
      <h1>Join your workspace</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const r = await fetch("/api/invitations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token: f.get("token"),
              password: f.get("password"),
            }),
          });
          const b = await r.json();
          setMessage(
            r.ok
              ? "Account created. Sign in with your invited email."
              : b.error,
          );
        }}
      >
        <label>
          Invitation token
          <input name="token" required />
        </label>
        <label>
          Choose password
          <input name="password" type="password" minLength={12} required />
        </label>
        <button>Accept invitation</button>
      </form>
      <p role="status">{message}</p>
      <a href="/login">Sign in →</a>
    </main>
  );
}
