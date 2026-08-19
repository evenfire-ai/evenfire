const NAME_MAX = 255;
/** Control characters (including NUL) are never valid in a resource name. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/; // eslint-disable-line no-control-regex

export class ResourceNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceNameError";
  }
}

/**
 * Normalize and validate one GFS resource-name segment. This primitive is
 * deliberately operation-neutral: resource operations may share the name
 * contract without sharing authorization or mutation semantics.
 */
export function normalizeResourceName(raw: string): string {
  if (typeof raw !== "string") throw new ResourceNameError("name must be a string");
  const name = raw.normalize("NFC");
  if (
    name.length === 0
    || name.length > NAME_MAX
    || name === "."
    || name === ".."
    || name.includes("/")
    || CONTROL_CHARS.test(name)
  ) {
    throw new ResourceNameError(`invalid name: ${JSON.stringify(raw)}`);
  }
  return name;
}
