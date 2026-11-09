// Phone layout (docs/features/023-phone/spec.md): read once when a component module loads; the phone shell
// itself follows live width changes.
export const PHONE_QUERY = '(max-width: 700px)';

export const isPhone = (): boolean => typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches;

/** Charts are shorter on a phone: half their desktop height, never under 130 px. */
export const phoneHeight = (height: number): number => (isPhone() ? Math.max(130, Math.round(height * 0.5)) : height);

/** Map legend classes on a phone: no unit on each class (the legend title says it), so five fit in one row. */
export const legendLabel = (label: string): string => (isPhone() ? label.replace(/\s?€\/m²/g, '').replace(/\s?€/g, '') : label);
