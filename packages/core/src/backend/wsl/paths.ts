// The single place that maps Windows paths to WSL paths (typescript.instructions.md).

/** Maps an absolute drive path such as `P:\x` to `/mnt/p/x`. UNC and relative paths are rejected. */
export function wslPath(windowsPath: string): string {
  const match = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(windowsPath);
  if (!match)
    throw new Error(`Not an absolute Windows path with drive letter: ${JSON.stringify(windowsPath)}`);
  const drive = match[1]!.toLowerCase();
  const rest = (match[2] ?? "")
    .split(/[\\/]+/)
    .filter((part) => part !== "")
    .join("/");
  return rest === "" ? `/mnt/${drive}` : `/mnt/${drive}/${rest}`;
}
