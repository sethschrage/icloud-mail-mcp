/** Types for scripts/pack.mjs (imported by the bundle smoke test). */
export declare const DIST_DIR: string;
/** Run the mcpb CLI with the given arguments; resolves to its output. */
export declare function runMcpb(args: readonly string[]): Promise<string>;
export declare function listZipEntries(buf: Buffer): string[];
export declare function formatBytes(n: number): string;
export interface PackOptions {
  stageDir?: string;
  /** Defaults to dist/icloud-mail-<version>.mcpb. */
  outFile?: string;
  typecheck?: boolean;
  /** Progress lines; null for silence. */
  log?: ((line: string) => void) | null;
}
export interface PackResult {
  file: string;
  size: number;
  version: string;
  entries: string[];
}
export declare function packMcpb(options?: PackOptions): Promise<PackResult>;
