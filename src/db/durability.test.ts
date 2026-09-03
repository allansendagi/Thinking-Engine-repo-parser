import { afterEach, describe, expect, test } from "bun:test";
import { assertDurableStorage, storageMode } from "./durability";

const ENV_KEYS = [
  "THREAD_REGISTRY_PATH",
  "THREAD_DATA_DIR",
  "RAILWAY_VOLUME_MOUNT_PATH",
  "RAILWAY_ENVIRONMENT",
  "RAILWAY_SERVICE_ID",
  "RENDER",
  "FLY_APP_NAME",
  "KUBERNETES_SERVICE_HOST",
  "DYNO",
  "THREAD_ALLOW_EPHEMERAL",
] as const;

const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
function setEnv(patch: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(patch)) process.env[k] = v;
}

describe("storageMode", () => {
  test("explicit override wins", () => {
    setEnv({ THREAD_REGISTRY_PATH: "/data/registry.db", RAILWAY_VOLUME_MOUNT_PATH: "/vol" });
    expect(storageMode()).toBe("explicit");
  });
  test("railway volume when only the mount path is set", () => {
    setEnv({ RAILWAY_VOLUME_MOUNT_PATH: "/vol" });
    expect(storageMode()).toBe("railway-volume");
  });
  test("local when nothing is set", () => {
    setEnv({});
    expect(storageMode()).toBe("local");
  });
});

describe("assertDurableStorage", () => {
  test("no-op off a container host, even with local storage", () => {
    setEnv({});
    expect(() => assertDurableStorage()).not.toThrow();
  });
  test("THROWS on a container host with local storage", () => {
    setEnv({ RAILWAY_ENVIRONMENT: "production" });
    expect(() => assertDurableStorage()).toThrow(/EPHEMERAL/);
  });
  test("passes on a container host once a volume is attached", () => {
    setEnv({ RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: "/vol" });
    expect(() => assertDurableStorage()).not.toThrow();
  });
  test("passes on a container host with an explicit durable path", () => {
    setEnv({ FLY_APP_NAME: "thread", THREAD_REGISTRY_PATH: "/data/registry.db", THREAD_DATA_DIR: "/data/users" });
    expect(() => assertDurableStorage()).not.toThrow();
  });
  test("THREAD_ALLOW_EPHEMERAL=1 is the explicit opt-out", () => {
    setEnv({ RAILWAY_ENVIRONMENT: "production", THREAD_ALLOW_EPHEMERAL: "1" });
    expect(() => assertDurableStorage()).not.toThrow();
  });
});
