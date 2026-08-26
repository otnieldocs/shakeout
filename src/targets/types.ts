/** Target = one environment Shakeout is allowed to point at. */
export interface Target {
  /** Short name used on the CLI: `shakeout <module> --target staging`. */
  name: string;
  /** Where flows start. Must itself be inside `allowedOrigins`. */
  baseUrl: string;
  /**
   * Origins this target may NAVIGATE to. Deny-by-default: anything not listed
   * is refused before the request leaves. Include the identity provider and
   * any third-party page a flow legitimately lands on (Auth0, a payment
   * provider's hosted checkout, a sandbox OAuth consent screen).
   */
  allowedOrigins: string[];
  /**
   * Set true ONLY for a genuine production environment. Doing so does not
   * grant access — it additionally requires SHAKEOUT_ALLOW_PRODUCTION=yes in
   * the environment. Two locks, because one is one typo away from a QA agent
   * clicking "delete account" against real customer data.
   */
  production?: boolean;
  /** Sandbox/staging identifiers, surfaced in the report for provenance. */
  integrations?: Record<string, string>;
}

export interface ShakeoutConfig {
  targets: Target[];
  /** Used when --target is omitted. */
  defaultTarget?: string;
  /** Where run folders are written. Default: ./reporting */
  reportingDir?: string;
  /** Where session state is cached. Default: ./.vault */
  vaultDir?: string;
}
