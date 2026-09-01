import { afterEach, expect, test } from "bun:test";
import { dataDir } from "./tenancy";

const saved = {
  THREAD_DATA_DIR: process.env.THREAD_DATA_DIR,
  RAILWAY_VOLUME_MOUNT_PATH: process.env.RAILWAY_VOLUME_MOUNT_PATH,
};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("dataDir prefers an explicit THREAD_DATA_DIR override", () => {
  process.env.THREAD_DATA_DIR = "/custom/path";
  process.env.RAILWAY_VOLUME_MOUNT_PATH = "/data";
  expect(dataDir()).toBe("/custom/path");
});

test("dataDir uses the Railway volume mount when present and no explicit override", () => {
  delete process.env.THREAD_DATA_DIR;
  process.env.RAILWAY_VOLUME_MOUNT_PATH = "/data";
  expect(dataDir()).toBe("/data/users");
});

test("dataDir falls back to the local ephemeral default", () => {
  delete process.env.THREAD_DATA_DIR;
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  expect(dataDir()).toBe("data/users");
});
