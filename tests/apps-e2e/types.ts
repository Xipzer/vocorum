export type Launch = { app: string; link: string; env?: Record<string, string> }

// One running app under test, driven through its own page.
export type AppRun = {
  dir: string
  // Evaluates an expression in the app's page (awaited if it is a promise).
  eval<T = unknown>(expression: string): Promise<T>
  // Memory (the system's own figure) and CPU of the app and its webview processes.
  measure(seconds: number): Promise<{ memoryMB: number; cpuPercent: number }>
  // Whether the system was asked to show a notification with this text.
  notified(text: string): Promise<boolean>
  stop(): Promise<void>
}
