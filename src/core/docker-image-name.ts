import { IncompatibleImageError } from "./errors.js";

/** The pieces a `[registry/]repository[:tag][@digest]` reference decomposes into. */
interface ParsedReference {
  readonly registry: string | undefined;
  readonly repository: string;
  readonly tag: string | undefined;
  readonly digest: string | undefined;
}

/** Splits off a trailing `@sha256:...` digest, if present — always the last `@` in the reference. */
function splitDigest(ref: string): [rest: string, digest: string | undefined] {
  const at = ref.lastIndexOf("@");
  if (at === -1) {
    return [ref, undefined];
  }
  return [ref.slice(0, at), ref.slice(at + 1)];
}

/**
 * Splits a registry host off the front, following the Docker convention:
 * the first path segment is a registry only if it contains a `.` (a domain)
 * or a `:` (an explicit port), or is the literal `localhost` — otherwise
 * it's a namespace segment and stays part of the repository. This is why
 * `quay.io/keycloak/keycloak` strips to repository `keycloak/keycloak`
 * while `floci/floci` stays whole.
 */
function splitRegistry(ref: string): [registry: string | undefined, rest: string] {
  const slash = ref.indexOf("/");
  if (slash === -1) {
    return [undefined, ref];
  }
  const first = ref.slice(0, slash);
  if (first.includes(".") || first.includes(":") || first === "localhost") {
    return [first, ref.slice(slash + 1)];
  }
  return [undefined, ref];
}

/** Splits a trailing `:tag` off the repository — the last `:` counts only when it falls after the last `/`, so a registry-host port (already stripped by `splitRegistry`) is never mistaken for one. */
function splitTag(ref: string): [repository: string, tag: string | undefined] {
  const lastSlash = ref.lastIndexOf("/");
  const lastColon = ref.lastIndexOf(":");
  if (lastColon > lastSlash) {
    return [ref.slice(0, lastColon), ref.slice(lastColon + 1)];
  }
  return [ref, undefined];
}

function parseReference(image: string): ParsedReference {
  const [withoutDigest, digest] = splitDigest(image);
  const [registry, rest] = splitRegistry(withoutDigest);
  const [repository, tag] = splitTag(rest);
  return { registry, repository, tag, digest };
}

/**
 * A parsed `[registry/]repository[:tag][@digest]` image reference, plus the
 * Testcontainers-style compatibility override `asCompatibleSubstituteFor`
 * sets. Every module constructor accepts `string | DockerImageName` and
 * resolves it through `requireCompatible` before calling `super()`:
 *
 * ```ts
 * new PostgresContainer("postgres:16")                                  // checked, common case
 * new PostgresContainer(DockerImageName.parse("mycorp/pg-hardened:16")
 *     .asCompatibleSubstituteFor("postgres"))                           // explicit override
 * ```
 *
 * An explicitly supplied image is always used verbatim — `requireCompatible`
 * only ever checks it and returns it unchanged; it never rewrites a tag or
 * substitutes an image.
 */
export class DockerImageName {
  private constructor(
    /** The image reference exactly as given to `parse()` — what a module passes to the backend, unmodified. */
    readonly raw: string,
    /** The registry host, if the first path segment looked like one (contains `.` or `:`, or is `localhost`). */
    readonly registry: string | undefined,
    /** The repository component: registry, tag, and digest all stripped. */
    readonly repository: string,
    /** The tag component, if the reference carried one. */
    readonly tag: string | undefined,
    /** The digest component (everything after `@`), if the reference carried one. */
    readonly digest: string | undefined,
    private readonly substituteRepository: string | undefined,
  ) {}

  /**
   * Parses a full image reference into its registry/repository/tag/digest
   * components. A pure string decomposition — never validates against a
   * real registry, never performs I/O.
   */
  static parse(image: string): DockerImageName {
    const { registry, repository, tag, digest } = parseReference(image);
    return new DockerImageName(image, registry, repository, tag, digest, undefined);
  }

  /**
   * Declares this image a compatible drop-in for `repository` — the escape
   * hatch for a fork, mirror, or hardened rebuild that doesn't share the
   * expected module's own repository name. From here on,
   * `requireCompatible` treats `repository` as this image's declared
   * identity instead of its own parsed `repository`. Returns a new
   * `DockerImageName`; the original is left untouched.
   */
  asCompatibleSubstituteFor(repository: string): DockerImageName {
    return new DockerImageName(this.raw, this.registry, this.repository, this.tag, this.digest, repository);
  }

  /** The exact reference passed to `parse()`, unmodified. */
  toString(): string {
    return this.raw;
  }

  /**
   * Resolves `image` (parsing it first if it's a plain string) and checks
   * that it names `expectedRepository` — either directly via its own parsed
   * `repository`, or via a prior `asCompatibleSubstituteFor(expectedRepository)`
   * override. Returns the exact image string to pass to `super()`: never
   * rewritten, tag and all. Throws `IncompatibleImageError` — before any
   * backend call, before the module's own constructor body runs — when
   * neither matches.
   */
  static requireCompatible(image: string | DockerImageName, expectedRepository: string): string {
    const name = typeof image === "string" ? DockerImageName.parse(image) : image;
    const declaredRepository = name.substituteRepository ?? name.repository;
    if (declaredRepository !== expectedRepository) {
      throw new IncompatibleImageError(name.repository, expectedRepository);
    }
    return name.raw;
  }
}
