/** Types for scripts/build.mjs (imported by the tests). */
export declare const PROJECT_ROOT: string;
export declare const MCPB_STAGE_DIR: string;
/** Exactly the files of the .mcpb, sorted. */
export declare const BUNDLE_FILES: readonly string[];
export declare function projectVersion(): Promise<{ version: string; name: string }>;
export declare function typecheck(): Promise<void>;
export declare function listFiles(dir: string): Promise<string[]>;
export interface BuildOptions {
  outDir?: string;
  typecheck?: boolean;
  /** Progress lines; null for silence. */
  log?: ((line: string) => void) | null;
}
export declare function buildMcpb(options?: BuildOptions): Promise<{ outDir: string; version: string; files: string[] }>;
