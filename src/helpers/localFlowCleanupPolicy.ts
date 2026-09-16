// ponytail: length-based budget; tune from measured daily dictations if needed.
export const cleanupBudgetMs = (length: number): number => (length <= 1200 ? 1200 : 7500);

// Preserve technical text verbatim instead of asking a model to interpret symbols.
// ponytail: hyphenated prose also skips cleanup; narrow this only if that matters.
export const isTechnicalTranscript = (text: string): boolean =>
  /[-/\\@#$%^&*+=<>_|~`{}\[\]]|\b[\p{L}\p{N}]+\.[\p{L}\p{N}]+|![\p{L}\p{N}]/u.test(text);

// Nova already adds punctuation. Avoid another model/network trip when there is nothing obvious to fix.
// ponytail: checks formatting and standalone fillers, not grammar; grammar rewrites are unsupported.
export const isAlreadyCleanTranscript = (text: string): boolean =>
  /[.!?。！？।]["'”’»)\]]*\s*$/u.test(text) &&
  !/^\s*["“'‘(]*\p{Ll}/u.test(text) &&
  !/(?:^|[^\p{L}\p{N}])(?:um|uh|er|ah)(?=$|[^\p{L}\p{N}])/iu.test(text) &&
  !/\s{2,}/u.test(text.trim());
