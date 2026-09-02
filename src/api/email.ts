/**
 * Transactional email via Resend's HTTP API -- plain fetch, no SDK, matching the rest of this
 * codebase's "no external dependencies" stance. The only thing Thread sends is a sign-in code.
 *
 * With no RESEND_API_KEY set (local dev, tests), it logs the message instead of sending -- the
 * e2e verification flow reads the code out of the server log.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function emailConfigured(): boolean {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail(msg: { to: string; subject: string; text: string }): Promise<void> {
  if (!emailConfigured()) {
    console.log(`[Thread][email:dev] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n${msg.text}`);
    return;
  }
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  }
}

/** The one email Thread sends. */
export function signInCodeEmail(code: string): { subject: string; text: string } {
  return {
    subject: `Your Thread sign-in code: ${code}`,
    text: [
      `Your Thread sign-in code is ${code}`,
      ``,
      `It expires in 10 minutes. If you didn't ask for this, you can ignore this email.`,
    ].join("\n"),
  };
}
