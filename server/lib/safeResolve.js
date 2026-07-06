import { resolve, sep } from "node:path";

/**
 * Safely resolve a user-supplied relative path against a trusted root directory,
 * guaranteeing the result stays inside that root.
 *
 * This is the primitive that every file-serving endpoint MUST route through.
 * The legacy 2016 Express app served `/images/:id` with unvalidated paths and
 * was flagged for path traversal (e.g. `../../etc/passwd`) by security review.
 *
 * @param {string} root - Trusted base directory (absolute or relative to cwd).
 * @param {string} userPath - Untrusted path segment from a request.
 * @returns {string} An absolute path guaranteed to be inside `root`.
 * @throws {Error} If the resolved path escapes `root`.
 */
export function safeResolve(root, userPath) {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, userPath);

  // The resolved path must be the root itself, or a descendant of it.
  // Appending `sep` prevents a sibling like `/data-evil` from matching `/data`.
  const rootWithSep = resolvedRoot.endsWith(sep)
    ? resolvedRoot
    : resolvedRoot + sep;

  if (resolved !== resolvedRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(
      `Path traversal blocked: "${userPath}" escapes root "${resolvedRoot}"`
    );
  }

  return resolved;
}
