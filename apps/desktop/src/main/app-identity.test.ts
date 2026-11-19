import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_USER_MODEL_ID, appUserDataDir } from "./app-identity.js";

describe("appUserDataDir", () => {
  it("is the same fixed folder below %APPDATA% for the repo and the package", () => {
    expect(appUserDataDir("C:\\Users\\u\\AppData\\Roaming")).toBe(
      "C:\\Users\\u\\AppData\\Roaming\\@termdock\\desktop",
    );
  });

  it("is not the data folder of the core", () => {
    expect(appUserDataDir("C:\\Users\\u\\AppData\\Roaming")).not.toMatch(/\\TermDock$/i);
  });
});

describe("APP_USER_MODEL_ID", () => {
  it("is the appId of the installer", () => {
    const desktop = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const config = JSON.parse(readFileSync(path.join(desktop, "electron-builder.json"), "utf8")) as {
      appId: string;
    };

    expect(APP_USER_MODEL_ID).toBe(config.appId);
  });
});
