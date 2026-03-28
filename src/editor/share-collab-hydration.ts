export function normalizeShareCollabHydrationText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function shouldTreatShareCollabAsHydrated(input: {
  fragmentIsStructurallyEmpty: boolean;
  editorIsStructurallyEmpty: boolean;
  fragmentText: string | null;
  editorText: string | null;
  yTextMarkdown: string | null;
}): boolean {
  if (input.fragmentIsStructurallyEmpty) {
    if (!input.editorIsStructurallyEmpty) {
      return true;
    }
    return normalizeShareCollabHydrationText(input.yTextMarkdown ?? '').length === 0;
  }

  if (input.fragmentText === null) {
    return !input.editorIsStructurallyEmpty;
  }

  if (input.editorText === null) {
    return false;
  }

  return input.editorText === input.fragmentText;
}
