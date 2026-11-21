import { randomBytes, createHash } from "node:crypto";
import { hash } from "bcryptjs";
import { z } from "zod";
import { transaction, audit, pool } from "./db";
import { requireRole } from "./workflow";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export async function inviteMember(org: string, actor: string, input: unknown) {
  const b = z
    .object({
      email: z.email().max(254),
      role: z.enum(["editor", "approver", "viewer"]),
    })
    .parse(input);
  const token = randomBytes(32).toString("base64url");
  await transaction(async (db) => {
    await requireRole(db, org, actor, ["owner"]);
    await db.query(
      "INSERT INTO invitations(org_id,email,role,token_hash,expires_at,created_by) VALUES($1,$2,$3,$4,now()+interval '48 hours',$5)",
      [org, b.email.toLowerCase(), b.role, digest(token), actor],
    );
    await audit(db, org, actor, "member.invited", null, { role: b.role });
  });
  return { token, expiresInHours: 48 };
}
export async function acceptInvite(input: unknown) {
  const b = z
    .object({
      token: z.string().min(32).max(100),
      password: z.string().min(12).max(128),
    })
    .parse(input);
  const password = await hash(b.password, 12);
  return transaction(async (db) => {
    const i = (
      await db.query(
        "SELECT * FROM invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>now() FOR UPDATE",
        [digest(b.token)],
      )
    ).rows[0];
    if (!i) throw Error("Invitation expired or already accepted");
    const existing = (
      await db.query("SELECT id FROM users WHERE email=$1", [i.email])
    ).rows[0];
    if (existing) throw Error("Existing users must accept while signed in");
    const user = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
        [i.email, password],
      )
    ).rows[0];
    await db.query("INSERT INTO memberships VALUES($1,$2,$3)", [
      i.org_id,
      user.id,
      i.role,
    ]);
    await db.query("UPDATE invitations SET accepted_at=now() WHERE id=$1", [
      i.id,
    ]);
    await audit(db, i.org_id, user.id, "member.joined", null);
    return { email: i.email };
  });
}
export async function saveFact(org: string, actor: string, input: unknown) {
  const b = z
    .object({
      id: z.uuid().optional(),
      text: z.string().min(1).max(8000),
      source: z.string().min(1).max(1000),
      category: z.enum(["menu", "about", "hours", "faq", "price"]),
      approved: z.boolean(),
      validUntil: z.iso.datetime().optional(),
    })
    .parse(input);
  return transaction(async (db) => {
    await requireRole(db, org, actor, ["owner", "editor"]);
    if (b.approved) await requireRole(db, org, actor, ["owner", "approver"]);
    if (b.id) {
      const old = (
        await db.query(
          "SELECT * FROM entities WHERE org_id=$1 AND id=$2 AND kind='fact' FOR UPDATE",
          [org, b.id],
        )
      ).rows[0];
      if (!old) throw Error("Fact not found");
      await db.query(
        "INSERT INTO entities(org_id,kind,data) VALUES($1,'fact_revision',$2)",
        [
          org,
          JSON.stringify({ ...old.data, factId: b.id, version: old.version }),
        ],
      );
      await db.query(
        "UPDATE entities SET data=$3,version=version+1,updated_at=now() WHERE org_id=$1 AND id=$2",
        [
          org,
          b.id,
          JSON.stringify({
            ...b,
            owner: actor,
            reviewedAt: new Date().toISOString(),
          }),
        ],
      );
    } else
      await db.query(
        "INSERT INTO entities(org_id,kind,data) VALUES($1,'fact',$2)",
        [
          org,
          JSON.stringify({
            ...b,
            owner: actor,
            reviewedAt: new Date().toISOString(),
          }),
        ],
      );
    await audit(db, org, actor, "fact.saved", b.id ?? null);
  });
}
export async function changeRole(
  org: string,
  actor: string,
  user: string,
  role: string,
) {
  z.enum(["owner", "editor", "approver", "viewer", "remove"]).parse(role);
  return transaction(async (db) => {
    await db.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
      org,
    ]);
    await requireRole(db, org, actor, ["owner"]);
    const owners = (
      await db.query(
        "SELECT user_id FROM memberships WHERE org_id=$1 AND role='owner'",
        [org],
      )
    ).rows;
    if (owners.length === 1 && owners[0].user_id === user && role !== "owner")
      throw Error("Cannot remove the last owner");
    if (role === "remove")
      await db.query("DELETE FROM memberships WHERE org_id=$1 AND user_id=$2", [
        org,
        user,
      ]);
    else
      await db.query(
        "UPDATE memberships SET role=$3 WHERE org_id=$1 AND user_id=$2",
        [org, user, role],
      );
    await audit(db, org, actor, "member.role_changed", null, {
      userId: user,
      role,
    });
  });
}
export async function createWorkspace(actor: string, name: string) {
  z.string().min(1).max(120).parse(name);
  return transaction(async (db) => {
    const o = (
      await db.query(
        "INSERT INTO organizations(name,mode,brand) VALUES($1,$2,$3) RETURNING id",
        [
          name,
          process.env.APP_MODE === "live" ? "live" : "demo",
          JSON.stringify({
            name,
            timezone: "America/Chicago",
            contentPillars: [],
            forbiddenPhrases: [],
            cadence: 3,
          }),
        ],
      )
    ).rows[0];
    await db.query("INSERT INTO memberships VALUES($1,$2,'owner')", [
      o.id,
      actor,
    ]);
    return o;
  });
}
export async function provisionOwner(
  email: string,
  password: string,
  name: string,
) {
  if (process.env.ALLOW_OWNER_PROVISION !== "true")
    throw Error(
      "Set ALLOW_OWNER_PROVISION=true only for local owner provisioning",
    );
  z.email().parse(email);
  z.string().min(12).max(128).parse(password);
  const hashed = await hash(password, 12);
  const u = await pool.query(
    "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
    [email.toLowerCase(), hashed],
  );
  return createWorkspace(u.rows[0].id, name);
}
