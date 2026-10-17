import { useId, useState } from "react";
import type { HostedCodingRepository, HostedRepositoryCandidates } from "@mivlet/protocol";
import type { CodingSelection } from "./hosted-coding-selection";

export function HostedCodingSelection({ candidates, value, onChange, onLoad, disabled }: {
  candidates?: HostedRepositoryCandidates; value: CodingSelection; onChange: (value: CodingSelection) => void;
  onLoad: () => void; disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const help = useId();
  const matches = candidates?.files.filter(file => file.path.toLowerCase().includes(query.toLowerCase())) ?? [];
  const selected = new Set(value.selectedPaths);
  const writable = new Set(value.writablePaths);
  const toggle = (path: string, write: boolean, checked: boolean) => {
    const next = new Set(write ? writable : selected);
    if (checked) next.add(path); else next.delete(path);
    onChange(write ? { ...value, writablePaths: [...next] } : { ...value, selectedPaths: [...next], writablePaths: value.writablePaths.filter(name => next.has(name)) });
  };
  return <section className="cloud-panel-coding-selection" aria-label="Files for cloud task">
    <p>Choose what the agent can read and change in an isolated cloud copy. Files are shared only after your next review.</p>
    <button type="button" className="button button--secondary" disabled={disabled} onClick={onLoad}>{candidates ? "Refresh files" : "Choose files from this task’s copy"}</button>
    {candidates && <>
      <label>Find a file<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="cloud-panel-coding-files" role="group" aria-label="Available files">
        {matches.slice(0, 100).map(file => <div className="cloud-panel-coding-file" key={file.path}>
          <code>{file.path}<small>{file.sizeBytes.toLocaleString()} bytes</small></code>
          <label><input type="checkbox" checked={selected.has(file.path)} disabled={disabled} onChange={event => toggle(file.path, false, event.target.checked)} aria-label={`Share ${file.path}`} />Share</label>
          <label><input type="checkbox" checked={writable.has(file.path)} disabled={disabled || !selected.has(file.path)} onChange={event => toggle(file.path, true, event.target.checked)} aria-label={`Allow changes to ${file.path}`} />Allow changes</label>
        </div>)}
        {!matches.length && <p>No matching files.</p>}
      </div>
      {matches.length > 100 && <p className="cloud-panel-muted">Showing 100 matches. Narrow your search to select other files.</p>}
      <p>{selected.size} files selected · {candidates.files.filter(file => selected.has(file.path)).reduce((sum, file) => sum + file.sizeBytes, 0).toLocaleString()} bytes</p>
      {candidates.truncated && <p className="cloud-panel-muted">Some files cannot be shared, including private, binary or unsupported files.</p>}
      <label>New files the agent may create (optional)<textarea rows={2} maxLength={16384} disabled={disabled} value={value.newPaths} onChange={event => onChange({ ...value, newPaths: event.target.value })} placeholder="src/menu.test.ts" aria-describedby={help} /></label>
      <p className="cloud-panel-muted" id={help}>One exact relative file name per line. Folders and wildcards do not grant access.</p>
      <details><summary>Checks to run (optional)</summary><label>Exact check arguments<textarea rows={3} maxLength={16384} spellCheck={false} disabled={disabled} value={value.checks} onChange={event => onChange({ ...value, checks: event.target.value })} placeholder={'["/usr/bin/python3", "-m", "unittest"]'} /></label><p className="cloud-panel-muted">One JSON argument array per line, up to four checks. The program must already exist in the cloud environment. Downloads, network access and shell commands are unavailable.</p></details>
    </>}
  </section>;
}

export function HostedCodingScope({ repository }: { repository: HostedCodingRepository }) {
  const { snapshot, scope } = repository;
  return <section className="cloud-panel-research-scope" aria-label="Reviewed cloud files">
    <h3>Files to share · {snapshot.files.length} files · {snapshot.totalBytes.toLocaleString()} bytes</h3>
    <ul className="cloud-panel-coding-file-summary">{snapshot.files.map(file => <li key={file.path}><code>{file.path}</code><span>{file.sizeBytes.toLocaleString()} bytes</span></li>)}</ul>
    <h3>Files that can be changed</h3><ul>{scope.writablePaths.map(path => <li key={path}><code>{path}</code></li>)}</ul>
    {!scope.writablePaths.length && <p className="cloud-panel-muted">Read only. No file changes allowed.</p>}
    <h3>Checks to run</h3>{scope.checks.length ? scope.checks.map(check => <pre key={check.id}>{JSON.stringify(check.argv)}</pre>) : <p className="cloud-panel-muted">No checks requested.</p>}
    <p>Isolated copy · network disabled. Returned changes need a separate import approval.</p>
    <details><summary>Technical details</summary><pre>{JSON.stringify(repository, null, 2)}</pre></details>
  </section>;
}
