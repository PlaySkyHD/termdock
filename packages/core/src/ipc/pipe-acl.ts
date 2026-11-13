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
  GA: 0x10000000,
  GX: 0x20000000,
  GW: 0x40000000,
  GR: 0x80000000,
  RC: 0x00020000,
  SD: 0x00010000,
  WD: 0x00040000,
  WO: 0x00080000,
  FA: 0x001f01ff,
  FR: 0x00120089,
  FW: 0x00120116,
  FX: 0x001200a0,
};

/** FILE_WRITE_DATA, FILE_APPEND_DATA, WRITE_DAC, WRITE_OWNER, GENERIC_WRITE, GENERIC_ALL. */
const WRITE_MASK = 0x2 | 0x4 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000;

/** Aliases that may hold write access without being a foreign user: LocalSystem, Administrators, Creator Owner. */
const PRIVILEGED_ALIASES: readonly string[] = ["SY", "BA", "CO"];

/** Access allowed, object access allowed, callback access allowed. */
const ALLOW_TYPES: readonly string[] = ["A", "OA", "XA"];

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

/** The ACEs of the DACL (`D:` part) in order. Throws on an ACE it cannot read, so nothing is overlooked. */
export function parseDacl(sddl: string): DaclEntry[] {
  const start = sddl.indexOf("D:");
  if (start < 0) return [];
  const end = sddl.indexOf("S:", start);
  const text = sddl.slice(start + 2, end < 0 ? undefined : end);
  const entries: DaclEntry[] = [];
  for (const match of text.matchAll(/\(([^()]*)\)/g)) {
    const fields = (match[1] ?? "").split(";");
    const [type, , rights, , , sid] = fields;
    if (fields.length !== 6 || !type || rights === undefined || !sid) {
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
