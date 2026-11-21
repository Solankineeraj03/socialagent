"use client";
import { signIn } from "next-auth/react";
import { useState } from "react";
export default function Login() {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <section className="login-art">
        <span className="wordmark">◉ SocialAgent</span>
        <div>
          <span className="eyebrow">GOOD WORK. EVEN WHILE YOU SLEEP.</span>
          <h1>
            Your brand.
            <br />A little more
            <br />
            <em>in motion.</em>
          </h1>
          <p>
            Find the conversation. Make something worth sharing.
            <br />
            Keep the final say.
          </p>
        </div>
        <small>OBSERVE → CREATE → REVIEW → PUBLISH</small>
      </section>
      <section className="login-form">
        <div className="pill">HUMAN APPROVAL, BUILT IN</div>
        <h2>Welcome to your studio.</h2>
        <p>Sign in to your company workspace.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const f = new FormData(e.currentTarget);
            const result = await signIn("credentials", {
              email: f.get("email"),
              password: f.get("password"),
              redirect: false,
            });
            if (result?.ok) location.href = "/";
            else {
              setError("Sign-in failed. Check your email and password.");
              setBusy(false);
            }
          }}
        >
          <label>
            Email
            <input
              name="email"
              type="email"
              defaultValue="demo@local.test"
              required
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              defaultValue="demo-social-2026"
              required
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button disabled={busy}>
            {busy ? "Signing in…" : "Open workspace →"}
          </button>
        </form>
        <aside className="note">
          <b>Explore the local demo</b>
          <p>
            Fictional café. Real rendered media. Simulated publishing.
            <br />
            No social account or paid service needed.
          </p>
        </aside>
      </section>
    </main>
  );
}
