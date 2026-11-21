import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { getServerSession } from "next-auth";
import { query } from "./db";
import { getConfig } from "./config";
const attempts = new Map<string, { count: number; until: number }>();
export const authOptions: NextAuthOptions = {
  secret: getConfig().NEXTAUTH_SECRET,
  session: { strategy: "jwt", maxAge: 8 * 3600 },
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Workspace credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (
          !credentials?.email ||
          !credentials.password ||
          credentials.email.length > 254 ||
          credentials.password.length > 256
        )
          return null;
        const email = credentials.email.toLowerCase().trim();
        const bucket = attempts.get(email);
        if (bucket && bucket.until > Date.now() && bucket.count >= 10)
          return null;
        const result = await query<{
          id: string;
          email: string;
          password_hash: string;
        }>("SELECT id,email,password_hash FROM users WHERE email=$1", [email]);
        const user = result[0];
        const ok = await bcrypt.compare(
          credentials.password,
          user?.password_hash ??
            "$2b$10$abcdefghijklmnopqrstuuT/0Umpy5kICn7xU0j3Jfp3v/WqZGIHS",
        );
        if (!user || !ok) {
          attempts.set(email, {
            count:
              (bucket?.until ?? 0) > Date.now() ? (bucket?.count ?? 0) + 1 : 1,
            until: Date.now() + 15 * 60000,
          });
          return null;
        }
        attempts.delete(email);
        return {
          id: user.id,
          email: user.email,
          name: user.email.split("@")[0],
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.uid = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.id = String(token.uid);
      return session;
    },
  },
};
export type Role = "owner" | "editor" | "approver" | "viewer";
export async function requireMember(
  orgId: string,
  roles: Role[] = ["owner", "editor", "approver", "viewer"],
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) throw new Error("UNAUTHENTICATED");
  const r = await query<{ role: Role }>(
    "SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2",
    [orgId, session.user.id],
  );
  if (!r[0] || !roles.includes(r[0].role)) throw new Error("FORBIDDEN");
  return { userId: session.user.id, role: r[0].role };
}
