import { HOSTED_CODING_IMAGE, hostedCodingPath, validateHostedCodingScope, type HostedRepositoryCandidates } from "@mivlet/protocol";

export interface CodingSelection {
  selectedPaths: string[];
  writablePaths: string[];
  newPaths: string;
  checks: string;
}
export const emptyCodingSelection = (): CodingSelection => ({ selectedPaths: [], writablePaths: [], newPaths: "", checks: "" });

export function prepareCodingSelection(value: CodingSelection, candidates: HostedRepositoryCandidates | undefined) {
  if (!candidates || !value.selectedPaths.length) throw new Error("Choose at least one file to share.");
  const available = new Set(candidates.files.map(file => file.path));
  const selectedPaths = value.selectedPaths.map(hostedCodingPath);
  if (new Set(selectedPaths).size !== selectedPaths.length || selectedPaths.some(path => !available.has(path)))
    throw new Error("The file list changed. Refresh files and select them again.");
  const added = value.newPaths.split(/\r?\n/).map(path => path.trim()).filter(Boolean).map(hostedCodingPath);
  if (added.some(path => available.has(path)) || value.writablePaths.some(path => !selectedPaths.includes(path)))
    throw new Error("Share existing files before allowing changes. New file names must be unused.");
  const checks = value.checks.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    let argv: unknown;
    try { argv = JSON.parse(line); } catch { throw new Error("Enter each check as a JSON array of exact arguments."); }
    return { id: `check-${index + 1}`, argv };
  });
  const scope = validateHostedCodingScope({ writablePaths: [...value.writablePaths, ...added], checks, image: HOSTED_CODING_IMAGE, network: "disabled" });
  return { selectedPaths, writablePaths: scope.writablePaths, checks: scope.checks };
}
