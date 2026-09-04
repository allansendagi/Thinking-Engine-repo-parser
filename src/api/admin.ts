/**
 * Who counts as an operator of this deployment. Driven entirely by the `THREAD_ADMIN_EMAILS`
 * env var (comma-separated) on the API host -- nobody is an admin if it's unset. Used for the
 * /admin metrics endpoint and to lift the Free capture cap for the people running the service
 * (founder / support / dogfooding accounts).
 */

/** The parsed `THREAD_ADMIN_EMAILS` list (lowercased, deduped). Empty if unset. */
export function adminEmails(): string[] {
  return [
    ...new Set(
      (process.env.THREAD_ADMIN_EMAILS ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** Is this email an operator of this deployment? */
export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.toLowerCase());
}
