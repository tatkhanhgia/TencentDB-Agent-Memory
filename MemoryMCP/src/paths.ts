export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/**
 * Scene paths are relative Core scenario keys (e.g. auth.md).
 * Reject traversal, absolute paths, and control characters.
 *
 * Core's scenario API addresses scenes by bare filename, but the scene
 * index that engineering appends to persona.md (scene-navigation.ts)
 * renders paths with a `scene_blocks/` storage prefix for other consumers
 * (read/tdai_read_cos). Accept and strip that prefix so agents can pass
 * either form.
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
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("scene_blocks/")
    ? normalized.slice("scene_blocks/".length)
    : normalized;
}
