"use client";
import { useCallback, useEffect, useState } from "react";
import Administration from "./Administration";
import Link from "next/link";
import { signOut } from "next-auth/react";
type RecordData = Record<string, any>;
type Workspace = { id: string; name: string; role: string };
const tabs = [
  ["overview", "◫", "Overview"],
  ["trends", "↗", "Opportunities"],
  ["studio", "▧", "Content studio"],
  ["calendar", "▦", "Calendar"],
  ["inbox", "☷", "Inbox"],
  ["brand", "◎", "Brand & connections"],
  ["health", "⌁", "Settings & health"],
];
function Badge({ children }: { children: React.ReactNode }) {
  return <span className="badge">{children}</span>;
}
function when(value: string, zone = "America/Chicago") {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: zone,
    }).format(new Date(value));
  } catch {
    return value;
  }
}
export default function Studio({
  organizations,
  user,
}: {
  organizations: Workspace[];
  user: string;
}) {
  const [org, setOrg] = useState(organizations[0]?.id ?? ""),
    [tab, setTab] = useState("overview"),
    [data, setData] = useState<RecordData | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!org) return;
    try {
      const r = await fetch(`/api/workspace?org=${org}`);
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      setData(d);
    } catch (e) {
      setError(String(e));
    }
  }, [org]);
  useEffect(() => {
    setData(null);
    void refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);
  async function act(action: string, fields: RecordData = {}) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org, action, ...fields }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      setNotice(d.message ?? "Saved.");
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const d = data ?? {},
    variants: RecordData[] = d.variants ?? [],
    trends: RecordData[] = d.trends ?? [],
    deliveries: RecordData[] = d.deliveries ?? [],
    conversations: RecordData[] = d.conversations ?? [],
    brand = d.brand ?? {},
    zone = brand.timezone ?? "America/Chicago";
  const canEdit = ["owner", "editor"].includes(d.role),
    canApprove = ["owner", "approver"].includes(d.role),
    isOwner = d.role === "owner",
    demo = d.organization?.mode === "demo";
  const active = variants.find((v) => v.id === selected) ?? variants[0];
  const title: Record<string, string> = {
    overview: "A good day to make an impression.",
    trends: "Find your next conversation.",
    studio: "Make it unmistakably yours.",
    calendar: "A little planning. A lot of presence.",
    inbox: "Every conversation deserves care.",
    brand: "The details that make you, you.",
    health: "Everything behind the scenes.",
  };
  const renderTrend = (t: RecordData) => (
    <article className="trend-card" key={t.id}>
      <div className="row">
        <Badge>{t.kind ?? t.signalType ?? "Search + editorial"}</Badge>
        <span className="trend-score">
          {Math.round(t.score ?? 82)} <small>/ 100</small>
        </span>
      </div>
      <h3>{t.topic ?? t.title}</h3>
      <p>
        {t.reason ??
          t.summary ??
          "A rising conversation with a relevant angle for your audience."}
      </p>
      <div className="mini-label">EVIDENCE & COVERAGE</div>
      <p className="small">
        {t.region ?? "Owned property / local"} ·{" "}
        {t.coldStart
          ? "Cold-start uncertainty"
          : "Compared with prior equivalent window"}
      </p>
      <details>
        <summary>Why this surfaced</summary>
        <pre>{JSON.stringify(t.evidence ?? t, null, 2)}</pre>
      </details>
      <div className="card-bottom">
        <span className="small muted">{t.status ?? "Ready to explore"}</span>
        <button
          disabled={busy || !canEdit}
          onClick={async () => {
            if (await act("generate", { trendId: t.id })) {
              setTab("studio");
            }
          }}
        >
          Create drafts ↗
        </button>
      </div>
    </article>
  );
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link className="wordmark" href="/">
          ◉ SocialAgent
        </Link>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <select
          aria-label="Organization"
          value={org}
          onChange={(e) => setOrg(e.target.value)}
        >
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <nav>
          {tabs.map(([id, icon, label]) => (
            <button
              key={id}
              className={tab === id ? "nav-item active" : "nav-item"}
              onClick={() => setTab(id)}
            >
              <span>{icon}</span>
              {label}
              {id === "inbox" && conversations.length > 0 && (
                <b>{conversations.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="avatar">{user.slice(0, 1).toUpperCase()}</div>
          <div>
            <b>{user.split("@")[0]}</b>
            <small>{d.role ?? "Member"} workspace</small>
          </div>
          <button
            aria-label="Sign out"
            className="icon-button"
            onClick={() => signOut()}
          >
            ↪
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <Link className="download" href="/demo">
            ▶ Watch the demo
          </Link>
          <span>
            Workspace{" "}
            <span className="muted">
              / {tabs.find((t) => t[0] === tab)?.[2]}
            </span>
          </span>
          <div className="row">
            <Badge>
              {demo ? "DEMO · NO LIVE WRITES" : "LIVE · APPROVAL REQUIRED"}
            </Badge>
            <span className="small">
              {d.organization?.clock_at
                ? when(d.organization.clock_at, zone)
                : "Loading…"}
            </span>
          </div>
        </header>
        <section className="page-head">
          <div>
            <span className="eyebrow">
              {brand.name ?? "YOUR SOCIAL STUDIO"}
            </span>
            <h1>{title[tab]}</h1>
            <p>
              {tab === "overview"
                ? "Your signals, stories, and conversations. All in one place."
                : "Thoughtful automation. You keep the final say."}
            </p>
          </div>
          {demo && (
            <button
              className="secondary"
              disabled={busy || !isOwner}
              onClick={() => act("advance", { seconds: 86400 })}
            >
              Advance demo +1 day ↗
            </button>
          )}
        </section>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="alert success" role="status">
            {notice}
          </div>
        )}
        {!data ? (
          <div className="empty">
            <h3>Opening your studio…</h3>
            <p>Checking the database and workspace membership.</p>
          </div>
        ) : (
          <>
            {tab === "overview" && (
              <>
                <div className="metrics">
                  {[
                    [
                      "Opportunities",
                      trends.length,
                      "Signals worth a closer look",
                    ],
                    [
                      "In the studio",
                      variants.length,
                      "Distinct channel drafts",
                    ],
                    [
                      "Scheduled",
                      deliveries.filter((x) =>
                        ["scheduled", "approved"].includes(x.status),
                      ).length,
                      "Human-approved content",
                    ],
                    [
                      "Conversations",
                      conversations.length,
                      "Replies need your approval",
                    ],
                  ].map(([label, num, sub]) => (
                    <article key={String(label)}>
                      <span>{label}</span>
                      <strong>{num}</strong>
                      <small>{sub}</small>
                    </article>
                  ))}
                </div>
                <div className="hero">
                  <div>
                    <span className="eyebrow">FROM A SIGNAL TO A STORY</span>
                    <h2>
                      Your next great post
                      <br />
                      starts with listening.
                    </h2>
                    <p>
                      See what your audience is asking. Turn a worthwhile
                      <br />
                      conversation into something distinctly your brand.
                    </p>
                    <button onClick={() => setTab("trends")}>
                      Explore opportunities ↗
                    </button>
                  </div>
                  <div className="hero-art">
                    <div className="orbit o1" />
                    <div className="orbit o2" />
                    <div className="coffee">
                      <span>
                        GOOD
                        <br />
                        THINGS
                        <br />
                        <i>brewing.</i>
                      </span>
                    </div>
                    <span className="spark s1">✳</span>
                    <span className="spark s2">✳</span>
                    <div className="floating">
                      <b>↗ A conversation is growing</b>
                      <small>Evidence first. Your voice next.</small>
                    </div>
                  </div>
                </div>
                <div className="section-title">
                  <h2>
                    On your radar <span>{trends.length}</span>
                  </h2>
                  <button
                    className="text-button"
                    onClick={() => setTab("trends")}
                  >
                    View all opportunities →
                  </button>
                </div>
                <div className="grid">
                  {trends.slice(0, 3).map(renderTrend)}
                </div>
                <div className="note">
                  <b>Your review is the last step before delivery.</b>
                  <p>
                    Drafts, edits, and new inbox messages never authorize a post
                    or reply automatically.
                  </p>
                </div>
              </>
            )}
            {tab === "trends" && (
              <>
                <div className="section-title">
                  <h2>Worth a closer look</h2>
                  <Badge>Transparent scoring · evidence included</Badge>
                </div>
                <div className="grid">{trends.map(renderTrend)}</div>
                <SourceImport
                  busy={busy}
                  disabled={!canEdit}
                  onSave={(fields) => act("import", fields)}
                />
              </>
            )}
            {tab === "studio" && (
              <>
                {variants.length === 0 ? (
                  <div className="empty">
                    <span className="empty-icon">▧</span>
                    <h2>A fresh canvas.</h2>
                    <p>
                      Choose an opportunity to generate grounded copy and real
                      branded media.
                      <br />
                      The worker renders your designs and video in the
                      background.
                    </p>
                    <button onClick={() => setTab("trends")}>
                      Find an opportunity →
                    </button>
                    <p className="small">
                      {
                        (d.jobs ?? []).filter(
                          (j: RecordData) => j.status !== "completed",
                        ).length
                      }{" "}
                      jobs waiting or in progress
                    </p>
                  </div>
                ) : (
                  <div className="studio-layout">
                    <div className="draft-list">
                      {variants.map((v) => (
                        <button
                          className={
                            active?.id === v.id
                              ? "draft-item selected"
                              : "draft-item"
                          }
                          key={v.id}
                          onClick={() => setSelected(v.id)}
                        >
                          <Badge>{v.channel}</Badge>
                          <h3>
                            {v.copy?.title ?? v.copy?.hook ?? "Brand story"}
                          </h3>
                          <small>
                            Revision {v.current_revision} · {v.status}
                          </small>
                        </button>
                      ))}
                    </div>
                    {active && (
                      <Draft
                        key={`${active.id}-${active.current_revision}`}
                        variant={active}
                        brand={brand}
                        busy={busy}
                        canEdit={canEdit}
                        canApprove={canApprove}
                        act={act}
                        now={d.organization.clock_at}
                      />
                    )}
                  </div>
                )}
              </>
            )}
            {tab === "calendar" && (
              <>
                <div className="section-title">
                  <h2>Delivery calendar</h2>
                  <Badge>{zone}</Badge>
                </div>
                {deliveries.length === 0 ? (
                  <div className="empty">
                    <h3>Your calendar is clear.</h3>
                    <p>
                      Approve a draft in the studio to schedule its immutable
                      revision.
                    </p>
                    <button onClick={() => setTab("studio")}>
                      Open studio →
                    </button>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Schedule</th>
                          <th>Destination</th>
                          <th>Status</th>
                          <th>Evidence</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deliveries.map((x) => (
                          <tr key={x.id}>
                            <td>
                              {when(x.scheduled_at, zone)}
                              <small>Revision {x.revision}</small>
                            </td>
                            <td>
                              <b>{x.channel}</b>
                              <small>
                                {x.account_name ?? "Connected demo account"}
                              </small>
                            </td>
                            <td>
                              <Badge>{x.status}</Badge>
                              {x.last_error && <small>{x.last_error}</small>}
                            </td>
                            <td>
                              {x.receipt_kind ? (
                                <details>
                                  <summary>
                                    {demo
                                      ? "Simulated receipt"
                                      : "Delivery receipt"}
                                  </summary>
                                  <pre>
                                    {JSON.stringify(
                                      {
                                        kind: x.receipt_kind,
                                        remoteId: x.receipt_remote_id,
                                        visibility: x.visibility,
                                        permalink: x.permalink,
                                      },
                                      null,
                                      2,
                                    )}
                                  </pre>
                                </details>
                              ) : (
                                <span className="muted">Pending</span>
                              )}
                            </td>
                            <td>
                              <button
                                className="secondary"
                                disabled={
                                  busy ||
                                  !canApprove ||
                                  [
                                    "published",
                                    "cancelled",
                                    "dispatching",
                                    "outcome_unknown",
                                  ].includes(x.status)
                                }
                                onClick={() => act("cancel", { id: x.id })}
                              >
                                Cancel
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <aside className="note">
                  <b>Each destination has its own delivery state.</b>
                  <p>
                    A cancelled scheduled job cannot send. An external request
                    already in flight cannot be recalled; unknown outcomes
                    require operator reconciliation.
                  </p>
                </aside>
              </>
            )}
            {tab === "inbox" && (
              <>
                <div className="section-title">
                  <h2>Conversations</h2>
                  {demo && (
                    <button
                      disabled={busy || !canEdit}
                      onClick={() =>
                        act("message", { text: "Are you open tomorrow?" })
                      }
                    >
                      Simulate midnight question +
                    </button>
                  )}
                </div>
                {conversations.length === 0 ? (
                  <div className="empty">
                    <h3>You’re all caught up.</h3>
                    <p>
                      Eligible incoming messages appear here. Live subscriptions
                      require account permission.
                    </p>
                  </div>
                ) : (
                  conversations.map((c) => (
                    <article className="conversation" key={c.id}>
                      <div className="row between">
                        <h3>{c.customer_name ?? "Customer conversation"}</h3>
                        <Badge>
                          {c.kind ?? "Private message"} ·{" "}
                          {c.status ?? "Needs review"}
                        </Badge>
                      </div>
                      {(c.messages ?? []).map((m: RecordData) => (
                        <div
                          className={`message ${m.direction === "outbound" ? "outbound" : ""}`}
                          key={m.id}
                        >
                          <small>
                            {m.direction === "inbound"
                              ? "Customer"
                              : "Your team"}{" "}
                            · {when(m.created_at ?? m.observed_at, zone)}
                          </small>
                          <p>{m.text ?? m.body}</p>
                        </div>
                      ))}
                      {(c.drafts ?? []).map((r: RecordData) => (
                        <div className="reply" key={r.id}>
                          <div className="row between">
                            <b>Suggested reply</b>
                            <Badge>{r.status}</Badge>
                          </div>
                          <p>{r.text ?? r.body}</p>
                          <small>
                            FAQ evidence:{" "}
                            {JSON.stringify(r.evidence ?? r.fact_ids ?? [])} ·
                            Expires {when(r.expires_at, zone)}
                          </small>
                          <div className="row">
                            <button
                              disabled={
                                busy || !canApprove || r.status !== "review"
                              }
                              onClick={() => act("approveReply", { id: r.id })}
                            >
                              Approve reply →
                            </button>
                            {demo && (
                              <button
                                className="secondary"
                                disabled={busy || !canEdit}
                                onClick={() =>
                                  act("humanReply", {
                                    conversationId: c.id,
                                    text: "Thanks for asking. Our team has answered your question.",
                                  })
                                }
                              >
                                Record team response
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </article>
                  ))
                )}
                <aside className="note">
                  <b>Private conversations stay private.</b>
                  <p>
                    They are excluded from public post generation. New messages
                    invalidate stale drafts; complaints and missing information
                    are escalated.
                  </p>
                </aside>
              </>
            )}
            {tab === "brand" && (
              <>
                <BrandEditor
                  key={org}
                  brand={brand}
                  disabled={!canEdit || busy}
                  onSave={(value) => act("brand", { brand: value })}
                />
                <div className="section-title">
                  <h2>Approved knowledge</h2>
                  <Badge>Facts are separate from style examples</Badge>
                </div>
                <div className="grid">
                  {(d.facts ?? []).map((f: RecordData) => (
                    <article className="panel" key={f.id}>
                      <Badge>{f.kind ?? "Approved fact"}</Badge>
                      <h3>{f.title ?? f.key ?? "Brand reference"}</h3>
                      <p>{f.text ?? f.value ?? f.content}</p>
                      <small>
                        Source: {f.source ?? "Brand owner"}
                        <br />
                        Valid until:{" "}
                        {f.validUntil ??
                          f.valid_until ??
                          "No expiration supplied"}
                      </small>
                    </article>
                  ))}
                </div>
                <div className="section-title">
                  <h2>Channel connections</h2>
                </div>
                <div className="grid">
                  {(d.connections ?? []).map((c: RecordData) => (
                    <article className="panel" key={c.id}>
                      <span className="channel-mark">
                        {c.platform?.slice(0, 1).toUpperCase() ??
                          c.channel?.slice(0, 1).toUpperCase()}
                      </span>
                      <h3>{c.platform ?? c.channel}</h3>
                      <p>{c.account_name ?? c.name}</p>
                      <Badge>
                        {demo
                          ? "Demo only"
                          : (c.status ?? "Missing permission")}
                      </Badge>
                      <p className="small">
                        {demo
                          ? "Simulated account. No platform credentials or external writes."
                          : "See docs/providers.md for app, account, role, and scope requirements."}
                      </p>
                    </article>
                  ))}
                </div>
              </>
            )}
            {tab === "health" && (
              <>
                <Administration org={org} owner={isOwner} />
                <details>
                  <summary>Source health and connection identifiers</summary>
                  <pre>
                    {JSON.stringify(
                      { sources: d.sources, connections: d.connections },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <div className="grid">
                  <article className="panel">
                    <Badge>
                      {demo ? "Demo isolation active" : "Live configuration"}
                    </Badge>
                    <h3>Outbound control</h3>
                    <p>Pause prevents new scheduled dispatches.</p>
                    <button
                      disabled={!isOwner || busy}
                      onClick={() =>
                        act("pause", { paused: !d.organization.paused })
                      }
                    >
                      {d.organization.paused
                        ? "Resume workspace"
                        : "Pause workspace"}
                    </button>
                  </article>
                  <article className="panel">
                    <Badge>CPU renderer</Badge>
                    <h3>No GPU required</h3>
                    <p>
                      Sharp makes your stills. FFmpeg makes your MP4. Live text
                      generation uses a configurable hosted model.
                    </p>
                  </article>
                  <article className="panel">
                    <Badge>Account permissions</Badge>
                    <h3>{d.role}</h3>
                    <p>
                      Owners and approvers approve. Editors prepare content.
                      Viewers have read-only access.
                    </p>
                    <a href={`/api/export?org=${org}`} className="download">
                      Export workspace JSON ↓
                    </a>
                  </article>
                </div>
                <div className="section-title">
                  <h2>Worker & queue</h2>
                </div>
                <pre className="panel">{JSON.stringify(d.health, null, 2)}</pre>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Job</th>
                        <th>Status</th>
                        <th>Attempts</th>
                        <th>Last error</th>
                        <th>Recovery</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(d.jobs ?? []).map((j: RecordData) => (
                        <tr key={j.id}>
                          <td>{j.kind ?? j.type}</td>
                          <td>
                            <Badge>{j.status}</Badge>
                          </td>
                          <td>{j.attempts ?? j.attempt_count ?? 0}</td>
                          <td>{j.last_error ?? "—"}</td>
                          <td>
                            <button
                              className="secondary"
                              disabled={!isOwner || busy || j.status !== "dead"}
                              onClick={() => act("retry", { id: j.id })}
                            >
                              Retry job
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="section-title">
                  <h2>Audit trail</h2>
                </div>
                <div className="audit">
                  {(d.audit ?? []).slice(0, 25).map((a: RecordData) => (
                    <div key={a.id ?? a.created_at + a.action}>
                      <Badge>{a.action ?? a.event_type}</Badge>
                      <span>{a.entity_id ?? a.target_id}</span>
                      <small>{when(a.created_at, zone)}</small>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        <footer className="page-footer">
          SocialAgent{" "}
          <span>Made for thoughtful brands. Reviewed by people.</span>
        </footer>
      </main>
    </div>
  );
}
function Draft({
  variant: v,
  brand,
  busy,
  canEdit,
  canApprove,
  act,
  now,
}: {
  variant: RecordData;
  brand: RecordData;
  busy: boolean;
  canEdit: boolean;
  canApprove: boolean;
  act: (a: string, f: RecordData) => Promise<boolean>;
  now: string;
}) {
  const [copy, setCopy] = useState(
      v.copy?.copy ??
        v.copy?.caption ??
        v.copy?.body ??
        v.copy?.description ??
        "",
    ),
    [title, setTitle] = useState(v.copy?.title ?? v.copy?.hook ?? ""),
    [mediaFormat, setMediaFormat] = useState(v.copy?.format ?? "image"),
    [schedule, setSchedule] = useState(() =>
      new Date(new Date(now ?? Date.now()).getTime() + 86400000)
        .toISOString()
        .slice(0, 16),
    );
  const assets: RecordData[] = v.assets ?? [],
    image = assets.find((a) => a.mime === "image/png" || a.kind === "image"),
    video = assets.find((a) => a.mime === "video/mp4" || a.kind === "video");
  const dirty =
    copy !==
      (v.copy?.copy ??
        v.copy?.caption ??
        v.copy?.body ??
        v.copy?.description ??
        "") ||
    title !== (v.copy?.title ?? v.copy?.hook ?? "") ||
    mediaFormat !== (v.copy?.format ?? "image");
  return (
    <article className="draft-editor">
      <div className="row between">
        <div>
          <Badge>{v.channel}</Badge>{" "}
          <Badge>Revision {v.current_revision}</Badge>
        </div>
        <Badge>{v.status}</Badge>
      </div>
      {v.channel === "instagram" && (
        <label>
          Instagram format
          <select
            aria-label="Instagram format"
            value={mediaFormat}
            disabled={!canEdit}
            onChange={(e) => setMediaFormat(e.target.value)}
          >
            <option value="image">Feed image</option>
            <option value="reel">Reel</option>
          </select>
        </label>
      )}
      <div className="preview">
        {(v.channel === "youtube" || mediaFormat === "reel") && video ? (
          <video
            controls
            preload="metadata"
            src={`/api/assets/${video.id}`}
            poster={image ? `/api/assets/${image.id}` : undefined}
          />
        ) : image ? (
          <img alt={v.copy?.altText ?? title} src={`/api/assets/${image.id}`} />
        ) : (
          <div className="empty">
            <h3>Media is rendering</h3>
            <p>Review becomes available when the worker finishes.</p>
          </div>
        )}
      </div>
      <div className="row">
        {assets.map((a) => (
          <a
            key={a.id}
            className="download"
            href={`/api/assets/${a.id}?download=1`}
          >
            {a.mime?.includes("video") ? "MP4" : "Image"} ↓
          </a>
        ))}
      </div>
      <label>
        Headline
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={!canEdit}
        />
      </label>
      <label>
        Post copy
        <textarea
          rows={7}
          value={copy}
          onChange={(e) => setCopy(e.target.value)}
          disabled={!canEdit}
        />
      </label>
      <div className="row">
        <button
          className="secondary"
          disabled={busy || !canEdit || !dirty}
          onClick={() =>
            act("edit", {
              id: v.id,
              revision: v.current_revision,
              copy: {
                ...v.copy,
                title,
                copy,
                caption: copy,
                format: mediaFormat,
                body: copy,
                description: copy,
              },
            })
          }
        >
          Save new revision
        </button>
        <small>Editing invalidates existing approval.</small>
        <button
          className="secondary"
          disabled={busy || !canEdit || dirty}
          onClick={() => act("regenerate", { id: v.id })}
        >
          Regenerate this channel
        </button>
      </div>
      <details>
        <summary>Evidence, brief & revision details</summary>
        <pre>
          {JSON.stringify(
            {
              brief: v.brief,
              facts: v.copy?.factIds ?? v.copy?.fact_ids,
              validation: v.copy?.validation,
              revisions: v.revisions,
            },
            null,
            2,
          )}
        </pre>
      </details>
      <label>
        Schedule (UTC)
        <input
          type="datetime-local"
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
        />
      </label>
      <p className="small">
        {when(schedule + "Z", brand.timezone)} · {brand.timezone}. UTC selection
        is unambiguous during daylight-saving changes.
      </p>
      <button
        className="wide"
        disabled={busy || !canApprove || dirty || assets.length === 0}
        onClick={() =>
          act("approve", {
            id: v.id,
            revision: v.current_revision,
            scheduledAt: new Date(schedule + "Z").toISOString(),
          })
        }
      >
        Approve this revision & schedule →
      </button>
      {dirty && (
        <p className="small error">Save your edits before approving.</p>
      )}
    </article>
  );
}
function BrandEditor({
  brand,
  disabled,
  onSave,
}: {
  brand: RecordData;
  disabled: boolean;
  onSave: (v: RecordData) => Promise<boolean>;
}) {
  const [value, setValue] = useState(brand);
  return (
    <form
      className="panel brand-form"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(value);
      }}
    >
      <h2>Brand foundation</h2>
      <div className="form-grid">
        {[
          "name",
          "industry",
          "audience",
          "timezone",
          "voice",
          "cta",
          "primaryPhotoId",
        ].map((key) => (
          <label key={key}>
            {key}
            <input
              value={typeof value[key] === "string" ? value[key] : ""}
              disabled={disabled}
              onChange={(e) => setValue({ ...value, [key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <label>
        Brand rules, approved style examples, and additional fields
        <textarea
          aria-label="Brand JSON"
          rows={10}
          value={JSON.stringify(value, null, 2)}
          readOnly
        />
      </label>
      <button disabled={disabled}>Save brand revision →</button>
    </form>
  );
}
function SourceImport({
  busy,
  disabled,
  onSave,
}: {
  busy: boolean;
  disabled: boolean;
  onSave: (v: RecordData) => Promise<boolean>;
}) {
  const [csv, setCsv] = useState(
    "query,clicks,impressions,date,country\niced coffee,18,120,2026-11-13,US",
  );
  return (
    <form
      className="panel source-import"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ csv });
      }}
    >
      <h2>Import owned search data</h2>
      <p>
        Search Console CSV covers your property, not all web searches. Repeated
        rows are deduplicated.
      </p>
      <label>
        CSV observations
        <textarea
          rows={5}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
      </label>
      <button disabled={busy || disabled}>Import CSV →</button>
    </form>
  );
}
