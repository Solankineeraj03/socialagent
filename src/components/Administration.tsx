"use client";
import { useState } from "react";
export default function Administration({
  org,
  owner,
}: {
  org: string;
  owner: boolean;
}) {
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function command(action: string, fields: Record<string, unknown>) {
    setBusy(true);
    try {
      const r = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org, action, ...fields }),
      });
      const b = await r.json();
      if (!r.ok) throw Error(b.error);
      setMessage(
        action === "invite"
          ? `Invitation token (share privately; expires in 48 hours): ${b.result.token}. Recipient opens /join.`
          : "Saved.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <div className="section-title">
        <h2>Workspace administration</h2>
      </div>
      <p role="status" className="note" style={{ overflowWrap: "anywhere" }}>
        {message || "Manage approved facts, members, and authorized signals."}
      </p>
      <div className="grid">
        <form
          className="panel"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            form.set("org", org);
            setBusy(true);
            try {
              const r = await fetch("/api/uploads", {
                method: "POST",
                body: form,
              });
              const b = await r.json();
              setMessage(r.ok ? `Asset ID: ${b.id}. ${b.message}` : b.error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h3>Upload owned media</h3>
          <label>
            Photo or clip
            <input
              name="file"
              type="file"
              accept="image/png,image/jpeg,video/mp4"
              required
            />
          </label>
          <label>
            Provenance / license source
            <input name="provenance" required minLength={3} />
          </label>
          <label>
            <input
              type="checkbox"
              name="rights"
              value="owned_or_licensed"
              required
            />{" "}
            I own or license this media for social media use
          </label>
          <button disabled={busy}>Upload media</button>
        </form>
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void command("fact", {
              fact: {
                text: f.get("text"),
                source: f.get("source"),
                category: f.get("category"),
                approved: owner,
                ...(f.get("until")
                  ? {
                      validUntil: new Date(
                        String(f.get("until")),
                      ).toISOString(),
                    }
                  : {}),
              },
            });
          }}
        >
          <h3>Add brand knowledge</h3>
          <label>
            Fact
            <textarea name="text" required />
          </label>
          <label>
            Source
            <input name="source" required />
          </label>
          <label>
            Category
            <select name="category">
              <option>faq</option>
              <option>menu</option>
              <option>about</option>
              <option>hours</option>
              <option>price</option>
            </select>
          </label>
          <label>
            Valid until (UTC)
            <input name="until" type="datetime-local" />
          </label>
          <button disabled={busy}>
            {owner ? "Save approved fact" : "Save for review"}
          </button>
        </form>
        {owner && (
          <>
            <form
              className="panel"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void command("invite", {
                  invitation: { email: f.get("email"), role: f.get("role") },
                });
              }}
            >
              <h3>Invite a teammate</h3>
              <p>
                No email is sent automatically. Share the one-time token
                privately.
              </p>
              <label>
                Email
                <input type="email" name="email" required />
              </label>
              <label>
                Role
                <select aria-label="Role" name="role">
                  <option>editor</option>
                  <option>approver</option>
                  <option>viewer</option>
                </select>
              </label>
              <button disabled={busy}>Create invitation</button>
            </form>
            <form
              className="panel"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void command("source", {
                  config: {
                    kind: "feed",
                    endpoint: f.get("endpoint"),
                    topic: f.get("topic"),
                    intervalSeconds: Number(f.get("interval")),
                    enabled: true,
                  },
                });
              }}
            >
              <h3>Monitor an industry feed</h3>
              <p>
                The operator must allow this exact HTTPS URL. Demo mode never
                polls externally.
              </p>
              <label>
                RSS / Atom endpoint
                <input name="endpoint" type="url" required />
              </label>
              <label>
                Topic
                <input name="topic" required />
              </label>
              <label>
                Polling seconds
                <input
                  name="interval"
                  type="number"
                  min={900}
                  defaultValue={3600}
                />
              </label>
              <button disabled={busy}>Enable recurring source</button>
            </form>
            <form
              className="panel"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const f = new FormData(e.currentTarget);
                  const r = await fetch(`/api/connect/${f.get("channel")}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ org, accountId: f.get("account") }),
                  });
                  const b = await r.json();
                  if (!r.ok) throw Error(b.error);
                  location.assign(b.authorizationUrl);
                } catch (e) {
                  setMessage(
                    e instanceof Error ? e.message : "Connection failed",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <h3>Connect a live account</h3>
              <p>
                Uses provider OAuth. Requires an isolated live workspace and
                configured developer application.
              </p>
              <label>
                Channel
                <select name="channel">
                  <option>instagram</option>
                  <option>youtube</option>
                  <option>linkedin</option>
                </select>
              </label>
              <label>
                Exact account / channel ID / Page URN
                <input name="account" required />
              </label>
              <button disabled={busy}>Authorize account</button>
            </form>
            <form
              className="panel"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void command("enableAccount", {
                  id: f.get("id"),
                  enabled: f.get("enabled") === "yes",
                });
              }}
            >
              <h3>Authorize test publishing</h3>
              <p>
                Owner authorization selects this connected account for live
                writes. Each item still requires approval and the deployment
                kill switch must be off.
              </p>
              <label>
                Connection ID
                <input name="id" required />
              </label>
              <label>
                Permission
                <select name="enabled">
                  <option value="no">Disable live writes</option>
                  <option value="yes">Authorize test-account writes</option>
                </select>
              </label>
              <button disabled={busy}>Save permission</button>
            </form>
            <form
              className="panel"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void command("createWorkspace", { name: f.get("name") });
              }}
            >
              <h3>Create a company workspace</h3>
              <label>
                Company name
                <input name="name" required />
              </label>
              <button disabled={busy}>Create workspace</button>
              <p>
                Refresh after creation to select it. No invitations are
                required.
              </p>
            </form>
          </>
        )}
      </div>
    </section>
  );
}
