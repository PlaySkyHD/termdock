// SDDL reading (unit) and the real ACL of the core pipe (Windows only). Spec core-ipc, change secure-core-pipe.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FakeBackend } from "../backend/fake.js";
import { SessionRegistry } from "../session/registry.js";
import { foreignAllowEntries, grantsWrite, parseDacl } from "./pipe-acl.js";
import { CoreServer } from "./server.js";

const OWN = "S-1-5-21-1-2-3-1001";
const OTHER = "S-1-5-21-1-2-3-1002";
// What libuv/Node produce on Windows 11 (measured, see design.md of secure-core-pipe).
const DEFAULT_SDDL = `O:${OWN}G:${OWN}D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${OWN})(A;;FR;;;WD)(A;;FR;;;AN)`;

describe("parseDacl", () => {
  it("expands rights codes and keeps the order", () => {
    expect(parseDacl(DEFAULT_SDDL).map((entry) => [entry.type, entry.sid, entry.rights])).toEqual([
      ["A", "SY", 0x1f01ff],
      ["A", "BA", 0x1f01ff],
      ["A", OWN, 0x1f01ff],
      ["A", "WD", 0x120089],
      ["A", "AN", 0x120089],
    ]);
  });

  it("reads hex masks, combined codes and ignores the SACL", () => {
    const entries = parseDacl(`D:PAI(A;;0x12019f;;;WD)(D;;FW;;;${OTHER})(A;;GRGX;;;AU)S:(AU;SA;FA;;;WD)`);
    expect(entries.map((entry) => [entry.type, entry.rights])).toEqual([
      ["A", 0x12019f],
      ["D", 0x120116],
      ["A", 0xa0000000],
    ]);
  });

  it("reports a missing DACL and a NULL DACL as unrestricted instead of as empty", () => {
    expect(() => parseDacl(`O:${OWN}G:${OWN}`)).toThrow(/unrestricted/);
    expect(() => parseDacl(`O:${OWN}G:${OWN}D:NO_ACCESS_CONTROL`)).toThrow(/unrestricted/);
    expect(() => foreignAllowEntries(`O:${OWN}D:NO_ACCESS_CONTROL`, OWN)).toThrow(/unrestricted/);
  });

  it("treats an empty DACL as no entries (nobody has access)", () => {
    expect(parseDacl(`O:${OWN}D:`)).toEqual([]);
    expect(parseDacl(`O:${OWN}D:P`)).toEqual([]);
  });

  it("accepts DACL flags before the ACEs", () => {
    expect(parseDacl("D:PAIAR(A;;FR;;;WD)")).toHaveLength(1);
    expect(parseDacl("D:AI(A;;FR;;;WD)")).toHaveLength(1);
  });

  it("throws on text between or after the ACEs and on unknown flags", () => {
    expect(() => parseDacl("D:(A;;FR;;;WD)garbage")).toThrow(/Unreadable SDDL/);
    expect(() => parseDacl("D:(A;;FR;;;WD)X(A;;FR;;;AN)")).toThrow(/Unreadable SDDL/);
    expect(() => parseDacl("D:ZZ(A;;FR;;;WD)")).toThrow(/Unreadable SDDL/);
  });

  it("throws on callback, object and other ACE types it cannot judge", () => {
    expect(() => parseDacl("D:(XA;;FA;;;WD;(Member_of{SID(BA)}))")).toThrow(/Unreadable SDDL/);
    expect(() => parseDacl("D:(OA;;FA;guid;;WD)")).toThrow(/Unreadable SDDL ACE/);
  });

  it("throws on rights or ACEs it cannot read instead of skipping them", () => {
    expect(() => parseDacl("D:(A;;ZZ;;;WD)")).toThrow(/Unknown SDDL rights/);
    expect(() => parseDacl("D:(A;;FA;;SY)")).toThrow(/Unreadable SDDL ACE/);
  });

  it("maps the single-right codes to their bit values", () => {
    const mask = (code: string) => parseDacl(`D:(A;;${code};;;WD)`)[0]?.rights;
    const expected: Record<string, number> = {
      CC: 0x1,
      DC: 0x2,
      LC: 0x4,
      SW: 0x8,
      RP: 0x10,
      WP: 0x20,
      DT: 0x40,
      LO: 0x80,
      CR: 0x100,
      SD: 0x10000,
      RC: 0x20000,
      WD: 0x40000,
      WO: 0x80000,
      KA: 0xf003f,
      KR: 0x20019,
      KW: 0x20006,
      KX: 0x20019,
      NR: 0x1,
      NW: 0x2,
      NX: 0x4,
    };
    for (const [code, value] of Object.entries(expected)) expect(mask(code), code).toBe(value);
  });
});

describe("foreignAllowEntries and grantsWrite", () => {
  it("lists Everyone and Anonymous from the libuv default, both read-only", () => {
    const foreign = foreignAllowEntries(DEFAULT_SDDL, OWN);
    expect(foreign.map((entry) => entry.sid)).toEqual(["WD", "AN"]);
    expect(foreign.some(grantsWrite)).toBe(false);
  });

  it("treats the own SID, SYSTEM, Administrators and Creator Owner as not foreign", () => {
    const sddl = `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;CO)(A;;FA;;;${OWN})`;
    expect(foreignAllowEntries(sddl, OWN)).toEqual([]);
  });

  it("detects write access of another user, also through generic and hex rights", () => {
    for (const rights of ["FA", "FW", "GA", "GW", "0x2", "0x4", "WD", "WO"]) {
      const foreign = foreignAllowEntries(`D:(A;;FA;;;${OWN})(A;;${rights};;;${OTHER})`, OWN);
      expect(foreign.some(grantsWrite), rights).toBe(true);
    }
  });

  it("assigns write rights correctly for single-right codes and hex masks", () => {
    const writes = (rights: string) =>
      foreignAllowEntries(`D:(A;;${rights};;;${OTHER})`, OWN).some(grantsWrite);
    for (const rights of ["DC", "LC", "KA", "KW", "NW", "0x120196", "0x12019f", "0x6"]) {
      expect(writes(rights), rights).toBe(true);
    }
    for (const rights of ["CC", "RP", "KR", "KX", "NR", "RC", "SD", "0x120089", "0x1200a0"]) {
      expect(writes(rights), rights).toBe(false);
    }
  });

  it("does not count deny entries and read-only rights as write", () => {
    const sddl = `D:(D;;FA;;;${OTHER})(A;;FR;;;${OTHER})(A;;FX;;;WD)`;
    expect(foreignAllowEntries(sddl, OWN).some(grantsWrite)).toBe(false);
  });
});

/** Opens the pipe with READ_CONTROL only (no data access) and prints own SID and SDDL, one per line. */
const READ_SDDL_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PipeProbe {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("advapi32.dll")]
  static extern uint GetSecurityInfo(SafeFileHandle h, int objType, uint info, out IntPtr owner, out IntPtr grp, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr sd, uint rev, uint info, out IntPtr str, out uint len);
  public static string Sddl(string path) {
    SafeFileHandle h = CreateFile(path, 0x20000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h.IsInvalid) throw new Exception("open failed " + Marshal.GetLastWin32Error());
    IntPtr o, g, d, s, sd;
    uint r = GetSecurityInfo(h, 6, 7, out o, out g, out d, out s, out sd);
    if (r != 0) throw new Exception("GetSecurityInfo " + r);
    IntPtr str; uint len;
    ConvertSecurityDescriptorToStringSecurityDescriptor(sd, 1, 7, out str, out len);
    return Marshal.PtrToStringUni(str);
  }
}
'@
[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
[PipeProbe]::Sddl($env:TERMDOCK_TEST_PIPE)
`;

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe.skipIf(process.platform !== "win32")("ACL of the real core pipe (Windows)", () => {
  it("gives no other user write access and no other trustee than the default read-only ones", async () => {
    const pipePath = `\\\\.\\pipe\\termdock-test-${randomUUID()}`;
    const registry = new SessionRegistry({ backends: [new FakeBackend()] });
    const server = await CoreServer.start({ registry, pipePath });
    closers.push(() => server.close());

    const { stdout } = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(READ_SDDL_SCRIPT, "utf16le").toString("base64"),
      ],
      { env: { ...process.env, TERMDOCK_TEST_PIPE: pipePath }, windowsHide: true },
    );
    const [ownSid, sddl] = stdout.trim().split(/\r?\n/);
    expect(ownSid).toMatch(/^S-1-5-/);
    expect(sddl).toBeTruthy();

    const entries = parseDacl(sddl!);
    // The current user can use the pipe (explicit ACE with full control).
    expect(entries.some((entry) => entry.sid === ownSid && grantsWrite(entry))).toBe(true);
    // Everyone and Anonymous are the only foreign trustees and may not write (nor change the DACL).
    const foreign = foreignAllowEntries(sddl!, ownSid!);
    expect(foreign.length).toBeGreaterThan(0);
    expect(foreign.filter(grantsWrite)).toEqual([]);
    expect(foreign.every((entry) => entry.sid === "WD" || entry.sid === "AN")).toBe(true);
  }, 30000);
});
