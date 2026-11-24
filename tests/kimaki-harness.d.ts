// Shape of the Kimaki test harness used by the optional e2e test.
export declare function startOpencodeTestServer(options: { matchers?: unknown[] }): Promise<{
  root: string
  projectDirectory: string
  serviceFile: string
  kill(): Promise<void>
}>
