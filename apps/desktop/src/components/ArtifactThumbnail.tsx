import { useEffect, useRef, useState } from "react";
import { previewComputerArtifact } from "../lib/computer-artifacts";
import type { LocalComputerOpenArtifactRequest } from "@mivlet/protocol";

/** Mounted only for image receipts; all bytes still pass native receipt validation. */
export function ArtifactThumbnail({ request, title }: { request: LocalComputerOpenArtifactRequest; title: string }) {
  const root = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<number>();
  useEffect(() => {
    if (!root.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "160px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) { setImage(null); return; }
    setFailed(false);
    let current = true;
    void previewComputerArtifact(request).then(preview => {
      if (!current) return;
      if (preview.artifactId === request.artifactId && /^data:image\/(png|jpeg|gif|webp);base64,/.test(preview.imageDataUrl ?? "")) setImage(preview.imageDataUrl);
      else setFailed(true);
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [visible, request.workspaceId, request.agentId, request.artifactId, request.expectedGeneration]);
  return <span ref={root} className="computer-artifact__thumbnail" style={{ aspectRatio, maxHeight: 440 }}>
    {image && !failed ? <img src={image} alt={title} decoding="async" onLoad={event => setAspectRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)} onError={() => setFailed(true)} />
      : <span className="computer-artifact__placeholder">{failed ? "Preview unavailable · Open file" : "Loading image…"}</span>}
  </span>;
}
