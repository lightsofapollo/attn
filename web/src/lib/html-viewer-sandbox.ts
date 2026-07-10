/** Empty sandbox tokens disable scripts; native/local mode opts in explicitly. */
export function htmlViewerSandbox(allowScripts: boolean): string {
  return allowScripts ? 'allow-scripts' : '';
}
