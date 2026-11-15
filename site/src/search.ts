/** Model names use spaces and hyphens interchangeably across catalogue feeds. */
const searchKey = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[\s_\p{Dash_Punctuation}]+/gu, '');

export function matchesModelSearch(model: { name: string; id: string; provider?: string }, query: string): boolean {
  const key = searchKey(query);
  return [model.name, model.id, model.provider ?? ''].some((text) => searchKey(text).includes(key));
}
