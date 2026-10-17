type GetModuleInfo = (id: string) => {
  isEntry: boolean;
  importers: readonly string[];
  dynamicImporters: readonly string[];
} | null;

/** Related deferred views share compression/requests; both names stay common. */
export function commonRouteChunk(id: string): string | undefined {
  const path = id.replace(/\\/g, "/").split("?")[0];
  if (/\/src\/components\/hosted\//.test(path)
    || /\/src\/runtime\/domains\/hosted-tasks\.ts$/.test(path)) return "cloud-tasks";
  if (/\/src\/components\/navigation\/(?:RepositoryFiles|RepositoryCopies|RepositoryCheckpoints|PullRequestReview)\.tsx$/.test(path)
    || /\/src\/components\/navigation\/(?:repository-files|repository-copies|repository-checkpoints|pull-request-review)\.css$/.test(path)) return "repository-inspection";
  // Library setup and the deferred inspection views share these thin native
  // wrappers. Give that shared edge its own home: automatic placement in the
  // Library chunk would make inspection import its own lazy-loading parent.
  if (/\/src\/runtime\/domains\/(?:coding|repository-copies)\.ts$/.test(path)) return "repository-runtime";
  return undefined;
}

const inputDependency = (id: string) => /\/node_modules\/(?:react-textarea-autosize|use-composed-ref|use-latest|use-isomorphic-layout-effect)\//.test(id.replace(/\\/g, "/"));
const assistant = (id: string) => /\/node_modules\/@assistant-ui\//.test(id.replace(/\\/g, "/"));

/** Only move a dependency when EVERY incoming edge belongs to the assistant
 * input chain. Shared hooks stay shared if another consumer ever appears. */
export function assistantInputDependency(id: string, getModuleInfo: GetModuleInfo): boolean {
  if (!inputDependency(id)) return false;
  const pending = [id];
  const seen = new Set<string>();
  let owned = false;
  while (pending.length) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const info = getModuleInfo(next);
    if (!info || info.isEntry) return false;
    const importers = [...info.importers, ...info.dynamicImporters];
    if (!importers.length) return false;
    for (const importer of importers) {
      if (assistant(importer)) owned = true;
      else if (inputDependency(importer)) pending.push(importer);
      else return false;
    }
  }
  return owned;
}
