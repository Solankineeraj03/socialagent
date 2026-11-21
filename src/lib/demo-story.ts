export const DEMO_STORY = [
  {
    id: "overview",
    title: "Your brand, always in motion",
    text: "Meet SocialAgent. This is a real walkthrough of the application, using a fictional neighborhood café. We will turn a rising conversation into three channel drafts, review real media, simulate delivery, and answer a customer. Nothing in this demonstration publishes to a real social account.",
  },
  {
    id: "signals",
    title: "Listen before you post",
    text: "First, the agent looks for a worthwhile conversation. Iced coffee is gaining interest in our demo data. The evidence panel explains the recent count, the baseline, and the sources. Stale or irrelevant topics can be skipped. This is a reason to create something useful, not a quota to fill.",
  },
  {
    id: "create",
    title: "From evidence to a draft",
    text: "We choose Create drafts. A background worker uses the café’s approved facts and brand voice, then creates separate Instagram, YouTube, and LinkedIn versions. It also renders an actual image and video. A draft remains in review until a person approves it.",
  },
  {
    id: "instagram",
    title: "A real design. Your final say.",
    text: "Here is the Instagram draft, with a real branded design and editable copy. The copy draws on approved brand knowledge rather than an invented offer. The reviewer can inspect the references and save a new revision. Editing the content invalidates its previous approval, so an old approval cannot publish a new draft.",
  },
  {
    id: "youtube",
    title: "Video that is ready to preview",
    text: "The YouTube version includes a playable vertical video. This is a real MP4, rendered on the CPU, with text and scene timing. No graphics card is required. Each destination has its own copy and assets, and the video is available to download.",
  },
  {
    id: "review",
    title: "Approve exactly what goes out",
    text: "Now we review the LinkedIn version and approve tomorrow’s schedule for each channel. Approval binds the account, content revision, assets, visibility, and time. Each destination is handled independently. YouTube visibility remains explicit; a private upload is never presented as public publication.",
  },
  {
    id: "delivery",
    title: "A receipt for every destination",
    text: "Advancing the demo clock lets the worker process the approved schedules. The calendar now shows a separate simulated receipt for every channel. In live operation, provider checkpoints help recover uploads. An uncertain publication outcome stops for inspection instead of blindly reposting.",
  },
  {
    id: "inbox",
    title: "The midnight question",
    text: "Finally, a customer asks whether the café is open tomorrow. The agent prepares a dated reply using the brand’s local timezone and approved hours. The person reviewing it still presses Approve before it sends. New messages invalidate stale replies. The result is less routine work, with people keeping control.",
  },
] as const;
