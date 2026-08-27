export function safeDownloadFileName(value: string): string {
  const cleaned = value.normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
  const bounded = cleaned.slice(0, 120).replace(/[. ]+$/gu, "");
  return bounded && bounded !== "." && bounded !== ".." ? bounded : "download.bin";
}
