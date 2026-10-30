/** 内联 SVG 片段：避免在多个模块里重复同一段图标。 */

export const micIcon = () =>
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3.5"/></svg>';

/** 记录行缩略图：有纪要（meeting）蓝色，纯转写紫色 */
export const recordThumb = (template) => {
  const cls = template === "meeting" ? "t-blue" : "t-violet";
  return `<span class="rec-thumb ${cls}">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="5" y1="10" x2="5" y2="14"/><line x1="9" y1="7" x2="9" y2="17"/>
      <line x1="12" y1="4" x2="12" y2="20"/><line x1="15" y1="7" x2="15" y2="17"/>
      <line x1="19" y1="10" x2="19" y2="14"/>
    </svg>
  </span>`;
};

export const waveIcon = `<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
  <line x1="5" y1="10" x2="5" y2="14"/><line x1="9" y1="7" x2="9" y2="17"/>
  <line x1="12" y1="4" x2="12" y2="20"/><line x1="15" y1="7" x2="15" y2="17"/>
  <line x1="19" y1="10" x2="19" y2="14"/>
</svg>`;
