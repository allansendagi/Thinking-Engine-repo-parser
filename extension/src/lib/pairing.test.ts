import { afterEach, describe, expect, test } from "bun:test";
import { fetchDesktopPairing, parsePairingString, PAIRING_URL } from "./pairing";

const VALID_ID = "user_" + "a".repeat(24);
const VALID_TOKEN = "b".repeat(64);

describe("parsePairingString", () => {
  test("accepts a well-formed user:token pair", () => {
    expect(parsePairingString(`${VALID_ID}:${VALID_TOKEN}`)).toEqual({
      userId: VALID_ID,
      token: VALID_TOKEN,
    });
  });

  test("trims surrounding whitespace", () => {
    expect(parsePairingString(`  ${VALID_ID}:${VALID_TOKEN}\n`)).toEqual({
      userId: VALID_ID,
      token: VALID_TOKEN,
    });
  });

  test("rejects wrong lengths, missing colon, and junk", () => {
    expect(parsePairingString("")).toBeNull();
    expect(parsePairingString(VALID_ID)).toBeNull();
    expect(parsePairingString(`${VALID_ID}:short`)).toBeNull();
    expect(parsePairingString(`user_xyz:${VALID_TOKEN}`)).toBeNull();
    expect(parsePairingString(`${VALID_ID}:${VALID_TOKEN}:extra`)).toBeNull();
  });
});

describe("fetchDesktopPairing", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns null when the app isn't running (connection refused)", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await fetchDesktopPairing()).toBeNull();
  });

  test("returns null on 404 (app up, pairing window closed)", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchDesktopPairing()).toBeNull();
  });

  test("adopts credentials and apiBaseUrl from a valid response", async () => {
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe(PAIRING_URL);
      return new Response(
        JSON.stringify({ userId: VALID_ID, token: VALID_TOKEN, apiBaseUrl: "http://localhost:8787" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    expect(await fetchDesktopPairing()).toEqual({
      credentials: { userId: VALID_ID, token: VALID_TOKEN },
      apiBaseUrl: "http://localhost:8787",
    });
  });

  test("throws on a malformed response from the app", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ userId: "nope", token: "nope" }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchDesktopPairing()).rejects.toThrow(/malformed/);
  });
});
