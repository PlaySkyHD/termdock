// Reads the DACL of a Windows named pipe from its SDDL text (design: openspec change secure-core-pipe).
// Pure logic: the SDDL comes from GetSecurityInfo + ConvertSecurityDescriptorToStringSecurityDescriptor.

export interface DaclEntry {
  /** SDDL ACE type: `A` allow, `D` deny, `OA`, `AU`, ... */
  readonly type: string;
  /** Access mask; SDDL rights codes (FA, FR, GA, ...) are expanded to their numeric value. */
  readonly rights: number;
  /** SDDL SID: a string SID (`S-1-5-...`) or a two-letter alias (`SY`, `BA`, `WD`, `AN`, ...). */
  readonly sid: string;
}

const RIGHTS: Readonly<Record<string, number>> = {
  // generic
  GA: 0x10000000,
  GX: 0x20000000,
  GW: 0x40000000,
  GR: 0x80000000,
  // standard
  SD: 0x00010000,
  RC: 0x00020000,
  WD: 0x00040000,
  WO: 0x00080000,
  // directory service, single bits (Windows writes them for masks that match no combined code)
  CC: 0x1,
  DC: 0x2,
  LC: 0x4,
  SW: 0x8,
  RP: 0x10,
  WP: 0x20,
  DT: 0x40,
  LO: 0x80,
  CR: 0x100,
  // registry key
  KA: 0x000f003f,
  KR: 0x00020019,
  KW: 0x00020006,
  KX: 0x00020019,
  // mandatory label
  NR: 0x1,
  NW: 0x2,
  NX: 0x4,
  // file
  FA: 0x001f01ff,
  FR: 0x00120089,
  FW: 0x00120116,
  FX: 0x001200a0,
};

/** FILE_WRITE_DATA, FILE_APPEND_DATA, WRITE_DAC, WRITE_OWNER, GENERIC_WRITE, GENERIC_ALL. */
const WRITE_MASK = 0x2 | 0x4 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000;

/** Aliases that may hold write access without being a foreign user: LocalSystem, Administrators, Creator Owner. */
const PRIVILEGED_ALIASES: readonly string[] = ["SY", "BA", "CO"];

/** Only plain allow ACEs are read. Object (OA) and callback (XA) ACEs are errors, not silently judged. */
const ALLOW_TYPES: readonly string[] = ["A"];

function parseRights(text: string): number {
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16) >>> 0;
  if (text.length === 0 || text.length % 2 !== 0) throw new Error(`Unreadable SDDL rights: ${text}`);
  let mask = 0;
  for (let i = 0; i < text.length; i += 2) {
    const value = RIGHTS[text.slice(i, i + 2)];
    if (value === undefined) throw new Error(`Unknown SDDL rights code: ${text.slice(i, i + 2)}`);
    mask |= value;
  }
  return mask >>> 0;
}

/** DACL flags (protected, auto-inherited, auto-inherit-required) followed by plain ACEs, nothing else. */
const DACL_TEXT = /^(?:P|AI|AR)*((?:\([^()]*\))*)$/;

/**
 * The ACEs of the DACL (`D:` part) in order. A missing DACL or a NULL DACL (`NO_ACCESS_CONTROL`) gives
 * everyone full access and throws, so it is never mistaken for "no foreign entries". An empty DACL
 * (`D:`) is valid and has no entries. Any text it cannot read, also outside the ACEs, throws.
 */
export function parseDacl(sddl: string): DaclEntry[] {
  const start = sddl.indexOf("D:");
  if (start < 0) throw new Error("SDDL has no DACL: the object is unrestricted");
  const end = sddl.indexOf("S:", start);
  const text = sddl.slice(start + 2, end < 0 ? undefined : end);
  if (text.startsWith("NO_ACCESS_CONTROL"))
    throw new Error("SDDL has a NULL DACL: the object is unrestricted");
  const parts = DACL_TEXT.exec(text);
  if (!parts) throw new Error(`Unreadable SDDL DACL: ${text}`);
  const entries: DaclEntry[] = [];
  for (const match of (parts[1] ?? "").matchAll(/\(([^()]*)\)/g)) {
    const fields = (match[1] ?? "").split(";");
    const [type, , rights, , , sid] = fields;
    if (fields.length !== 6 || !type || !["A", "D"].includes(type) || rights === undefined || !sid) {
      throw new Error(`Unreadable SDDL ACE: ${match[0]}`);
    }
    entries.push({ type, rights: parseRights(rights), sid });
  }
  return entries;
}

export function grantsWrite(entry: DaclEntry): boolean {
  return (entry.rights & WRITE_MASK) !== 0;
}

/**
 * Allow-ACEs for trustees other than the pipe's user, SYSTEM, Administrators and Creator Owner. Windows
 * gives a pipe without explicit security descriptor read access to Everyone and Anonymous; this lists them.
 */
export function foreignAllowEntries(sddl: string, ownSid: string): DaclEntry[] {
  return parseDacl(sddl).filter(
    (entry) =>
      ALLOW_TYPES.includes(entry.type) && entry.sid !== ownSid && !PRIVILEGED_ALIASES.includes(entry.sid),
  );
}
