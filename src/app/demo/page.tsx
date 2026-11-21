import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions, requireMember } from "../../server/auth";
import DemoPlayer from "../../components/DemoPlayer";
export const dynamic = "force-dynamic";
export default async function DemoPage() {
  if (!(await getServerSession(authOptions))?.user) redirect("/login");
  try {
    await requireMember("11111111-1111-4111-8111-111111111111");
  } catch {
    redirect("/");
  }
  return <DemoPlayer />;
}
