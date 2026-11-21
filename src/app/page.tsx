import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "../server/auth";
import { query } from "../server/db";
import Studio from "../components/Studio";
export const dynamic = "force-dynamic";
export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  const r = await query<{ id: string; name: string; role: string }>(
    "SELECT o.id,o.name,m.role FROM organizations o JOIN memberships m ON o.id=m.org_id WHERE m.user_id=$1 ORDER BY o.name",
    [session.user.id],
  );
  return <Studio organizations={r} user={session.user.email ?? ""} />;
}
