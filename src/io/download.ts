// Artifact-aware file save, copied from Datum Atlas (src/io.ts) so every Datum app saves files the same way.
// When hosted as a claude.ai artifact, files go through the viewer's `downloads`
// capability (plain download links are inert there). Elsewhere, a normal link.
type Saver = { save(r: { filename: string; data: Blob }): Promise<unknown> } | null;
let saver: Promise<Saver> | null = null;
function hostSaver(): Promise<Saver> {
  const c = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude;
  if (!c?.use) return Promise.resolve(null);
  return (saver ??= c.use("downloads").then((d) => (d as Saver) ?? null, () => null));
}

export function download(name: string, content: string | Blob, type = "application/octet-stream") {
  const blob = typeof content === "string" ? new Blob([content], { type }) : content;
  hostSaver().then((d) => {
    if (d) d.save({ filename: name, data: blob }).catch(() => {});
    else linkDownload(name, blob);
  });
}

function linkDownload(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "layer";
