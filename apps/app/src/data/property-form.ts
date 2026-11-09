// Analyser un bien form (docs/features/020-sidebar-filters/spec.md): typed amounts and what still blocks "Analyser".

/** A typed amount: spaces (also narrow no-break) are thousand separators, the comma is the decimal mark; 0 when unreadable. */
export const parseAmount = (text: string): number => {
  const value = Number.parseFloat(text.replace(/[\s  ]/g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : 0;
};

export type AnalysisFields = { address: string; hasCommune: boolean; surface: string; price: string };

/** What the user still has to fill before the analysis can run, in the order of the form. */
export const missingForAnalysis = ({ address, hasCommune, surface, price }: AnalysisFields): string[] => [
  ...(address.trim() || hasCommune ? [] : ['une adresse ou une commune']),
  ...(parseAmount(price) > 0 ? [] : ['le prix']),
  ...(parseAmount(surface) > 0 ? [] : ['la surface']),
];
