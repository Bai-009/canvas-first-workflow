/* 卡上的图标,按节点类型取。这是纯长相,不进节点表:
   加一个节点不给图标也能画(落到 fallback),给了更好看。 */
const S = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const ICONS: Readonly<Record<string, string>> = {
  schedule: S('<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>'),
  readFile: S('<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6H10l2 2h6.5A1.5 1.5 0 0 1 20 9.5v8A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z"/>'),
  parseDocument: S('<path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M14 3.5V8h4M9 12h6M9 15.5h6"/>'),
  ocr: S('<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M7 12h10"/>'),
  splitText: S('<path d="M4 6.5h16M4 12h16M4 17.5h16"/><path d="M9 4v16" stroke-dasharray="2 2.5"/>'),
  embedText: S('<circle cx="6" cy="6" r="1.6"/><circle cx="18" cy="8" r="1.6"/><circle cx="9" cy="17" r="1.6"/><circle cx="17" cy="16" r="1.6"/><path d="M7.4 6.8l9-0.5M7 8l1.6 7.4M10.6 17l4.8-0.7M17.6 9.6l-0.4 4.8"/>'),
  writeVectorStore: S('<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/><path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"/>'),
  llm: S('<path d="M8 4.5H6.5A2 2 0 0 0 4.5 6.5v11a2 2 0 0 0 2 2H8M16 4.5h1.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H16"/><path d="M9.5 9.5h5M9.5 12.5h5M9.5 15.5h3"/>'),
  writeDatabase: S('<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/><path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"/>'),
  condition: S('<path d="M6 4v5a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v5M6 4v16"/><circle cx="6" cy="4" r="1.4"/><circle cx="18" cy="20" r="1.4"/><circle cx="6" cy="20" r="1.4"/>'),
  code: S('<path d="M9 7.5 4.5 12 9 16.5M15 7.5l4.5 4.5-4.5 4.5M13.5 5l-3 14"/>'),
};

export const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

export const icon = (type: string) => ICONS[type] ?? S('<circle cx="12" cy="12" r="7.5"/>');
