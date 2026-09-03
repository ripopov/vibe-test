import { schematicCss, type ThemeColors } from '../render/schematic';

/** Serialize the current schematic to a standalone SVG string. */
export function exportSvg(viewport: SVGGElement, bounds: { width: number; height: number }, theme: ThemeColors, title: string): string {
  const clone = viewport.cloneNode(true) as SVGGElement;
  clone.removeAttribute('transform');
  clone.removeAttribute('id');
  for (const e of clone.querySelectorAll('.hit')) e.remove();
  for (const e of clone.querySelectorAll('.pin')) e.remove();
  for (const e of clone.querySelectorAll('[data-tip]')) e.removeAttribute('data-tip');
  const w = Math.ceil(bounds.width);
  const h = Math.ceil(bounds.height);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="schematic">
<title>${escapeXml(title)}</title>
<style>${schematicCss(theme)}</style>
<rect width="100%" height="100%" fill="${theme.bg}"/>
${new XMLSerializer().serializeToString(clone)}
</svg>`;
  return svg;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export function downloadText(name: string, text: string, mime = 'image/svg+xml') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
