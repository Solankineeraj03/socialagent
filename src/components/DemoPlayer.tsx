"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
type Manifest = {
  title: string;
  audioReady: boolean;
  narration: string;
  captionsBurned?: boolean;
  duration: number;
  disclosure: string;
  chapters: {
    id: string;
    title: string;
    start: number;
    duration: number;
    text: string;
  }[];
};
const timestamp = (n: number) =>
  `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
export default function DemoPlayer() {
  const [manifest, setManifest] = useState<Manifest | null>(null),
    [error, setError] = useState(""),
    [current, setCurrent] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    fetch("/api/demo-tour/manifest")
      .then(async (r) => {
        if (!r.ok)
          throw Error(
            "The guided recording is being prepared. Refresh when it is ready.",
          );
        setManifest(await r.json());
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <main style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 24px" }}>
      <header className="row between">
        <Link className="wordmark" href="/">
          ◉ SocialAgent
        </Link>
        <Link className="download" href="/">
          Open the live workspace →
        </Link>
      </header>
      <section className="page-head">
        <div>
          <span className="eyebrow">A REAL APPLICATION WALKTHROUGH</span>
          <h1>From a signal to a story.</h1>
          <p>
            Watch a fictional café’s day run through SocialAgent—from trend
            evidence to a reviewed customer reply.
          </p>
        </div>
        <span className="badge">SIMULATED PUBLISHING</span>
      </section>
      {error && (
        <p role="alert" className="note">
          {error}
        </p>
      )}
      {manifest && (
        <>
          <div className="row" style={{ marginBottom: 16 }}>
            <span className="badge">
              {manifest.audioReady
                ? `${manifest.narration} AI narration`
                : "Captioned preview · voice pending"}
            </span>
            <small>{timestamp(manifest.duration)} · 8 chapters</small>
          </div>
          {!manifest.audioReady && (
            <aside className="note">
              <b>Narration is not generated yet.</b>
              <p>
                The screen recording is ready. The narrated version will appear
                here once voice generation and audio checks finish.
              </p>
            </aside>
          )}
          <video
            ref={video}
            controls
            preload="metadata"
            poster="/api/demo-tour/poster"
            onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
            style={{
              display: "block",
              width: "100%",
              borderRadius: 14,
              background: "#18382a",
            }}
          >
            <source src="/api/demo-tour/video" type="video/mp4" />
            <track
              src="/api/demo-tour/captions"
              kind="subtitles"
              srcLang="en"
              label="English transcript"
              default={!manifest.captionsBurned}
            />
          </video>
          <div className="row" style={{ marginTop: 18 }}>
            <a
              download
              className="download"
              href="/api/demo-tour/video?download=1"
            >
              Download walkthrough MP4 ↓
            </a>
            <a
              download
              className="download"
              href="/api/demo-tour/transcript?download=1"
            >
              Download transcript ↓
            </a>
            <a
              download
              className="download"
              href="/api/demo-tour/captions?download=1"
            >
              Download captions ↓
            </a>
          </div>
          <div className="section-title">
            <h2>Explore the workflow</h2>
          </div>
          <div className="grid">
            {manifest.chapters.map((c, i) => (
              <button
                key={c.id}
                className={`draft-item ${current >= c.start && current < c.start + c.duration ? "selected" : ""}`}
                onClick={() => {
                  if (video.current) {
                    video.current.currentTime = c.start;
                    void video.current.play();
                  }
                }}
              >
                <span className="badge">
                  {String(i + 1).padStart(2, "0")} · {timestamp(c.start)}
                </span>
                <h3>{c.title}</h3>
                <small>{c.text}</small>
              </button>
            ))}
          </div>
          <aside className="note">
            <b>What you’re watching</b>
            <p>{manifest.disclosure}</p>
            <p>
              The recording uses the actual review queue, rendered media,
              calendar, and inbox. Platform deliveries are simulated; live
              integrations require account permissions and verification.
            </p>
          </aside>
        </>
      )}
    </main>
  );
}
