export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/**
 * Scene paths are relative Core scenario keys (e.g. scene_blocks/auth.md).
 * Reject traversal, absolute paths, and control characters.
 */
export function validateScenePath(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new PathError("path must be a non-empty string");
  }
  const path = raw.trim();
  if (path.length > 512) {
    throw new PathError("path exceeds 512 characters");
  }
  if (/[\0\r\n]/.test(path)) {
    throw new PathError("path contains illegal control characters");
  }
  if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path)) {
    throw new PathError("path must be relative");
  }
  const parts = path.split(/[/\\]+/);
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      throw new PathError("path must not contain '.' or '..' segments");
    }
  }
  return path.replace(/\\/g, "/");
}
